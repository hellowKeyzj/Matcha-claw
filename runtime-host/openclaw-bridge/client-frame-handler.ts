import { dispatchGatewayProtocolEvent, type GatewayConversationEvent } from './events';
import {
  isGatewayEventFrame,
  isGatewayResponseFrame,
  type GatewayNotification,
  type GatewayResponseFrame,
} from './protocol';
import { normalizeGatewayMethods, type GatewayCapabilitiesSnapshot } from './capabilities';
import {
  type GatewayAuthService,
} from './client-auth';
import {
  extractGatewayErrorCode,
  extractGatewayErrorDetails,
  extractGatewayErrorMessageFromResponse,
  extractGatewayErrorRetryable,
  extractGatewayErrorRetryAfterMs,
  isRecord,
} from './client-errors';
import {
  createGatewayTransportIssue,
} from './client-state';
import type { GatewayPendingRpcRequests } from './client-pending-rpc';
import type { GatewayTransportIssue } from '../shared/gateway-error';
import type { RuntimeClockPort, RuntimeIdGeneratorPort } from '../application/common/runtime-ports';

export interface GatewayClientFrameHandlerDeps {
  isConnected(): boolean;
  getConnectRequestId(): string | null;
  setConnectRequestId(requestId: string | null): void;
  sendRaw(payload: string): void;
  settleConnectSuccess(): void;
  settleConnectFailure(
    error: unknown,
    issuePatch?: Pick<GatewayTransportIssue, 'code' | 'details' | 'retryable' | 'retryAfterMs'>,
  ): void;
  markConnected(): void;
  markAlive(source: 'message' | 'rpc'): void;
  markGatewayReady(): void;
  updateCapabilities(capabilities: GatewayCapabilitiesSnapshot): void;
  recordRpcSuccess(): void;
  recordRpcFailure(method: string, issue?: GatewayTransportIssue): void;
  pendingRpcRequests: GatewayPendingRpcRequests;
  idGenerator: RuntimeIdGeneratorPort;
  clock: RuntimeClockPort;
  authService: Pick<GatewayAuthService, 'buildGatewayConnectRequest'>;
  onGatewayNotification?: (notification: GatewayNotification) => void;
  onGatewayConversationEvent?: (payload: GatewayConversationEvent) => void;
  onGatewayChannelStatus?: (payload: { channelId: string; status: string }) => void;
}

function parseGatewayFrame(rawData: unknown): unknown | null {
  try {
    return JSON.parse(String(rawData));
  } catch {
    return null;
  }
}

function isExpectedGatewayBusinessError(method: string, response: GatewayResponseFrame): boolean {
  if (method !== 'agents.delete') {
    return false;
  }
  const message = extractGatewayErrorMessageFromResponse(response);
  return message.includes('agent "') && message.includes('" not found');
}

export class GatewayClientFrameHandler {
  constructor(private readonly deps: GatewayClientFrameHandlerDeps) {}

  handleRawMessage(rawData: unknown): void {
    const parsed = parseGatewayFrame(rawData);
    if (parsed === null) {
      return;
    }

    if (this.handleConnectChallenge(parsed)) {
      return;
    }
    if (this.handleConnectResponse(parsed)) {
      return;
    }
    if (this.handleRpcResponse(parsed)) {
      return;
    }
    this.handleGatewayEvent(parsed);
  }

  private handleConnectChallenge(parsed: unknown): boolean {
    if (
      !isGatewayEventFrame(parsed)
      || this.deps.isConnected()
      || parsed.event !== 'connect.challenge'
    ) {
      return false;
    }

    const payload = isRecord(parsed.payload) ? parsed.payload : {};
    const challengeNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
    if (!challengeNonce) {
      this.deps.settleConnectFailure(new Error('Gateway connect.challenge missing nonce'));
      return true;
    }

    const requestId = `connect-${this.deps.idGenerator.randomId()}`;
    this.deps.setConnectRequestId(requestId);
    void (async () => {
      try {
        this.deps.sendRaw(JSON.stringify(await this.deps.authService.buildGatewayConnectRequest(requestId, challengeNonce)));
      } catch (error) {
        this.deps.settleConnectFailure(error);
      }
    })();
    return true;
  }

  private handleConnectResponse(parsed: unknown): boolean {
    if (
      !isGatewayResponseFrame(parsed)
      || this.deps.isConnected()
      || parsed.id !== this.deps.getConnectRequestId()
    ) {
      return false;
    }

    if (parsed.ok === false || parsed.error) {
      this.deps.settleConnectFailure(
        new Error(`Gateway connect failed: ${extractGatewayErrorMessageFromResponse(parsed)}`),
        {
          code: extractGatewayErrorCode({ error: parsed.error }),
          details: extractGatewayErrorDetails({ error: parsed.error }),
          retryable: extractGatewayErrorRetryable({ error: parsed.error }),
          retryAfterMs: extractGatewayErrorRetryAfterMs({ error: parsed.error }),
        },
      );
      return true;
    }

    const payload = isRecord(parsed.payload) ? parsed.payload : {};
    const features = isRecord(payload.features) ? payload.features : {};
    this.deps.updateCapabilities({
      methods: normalizeGatewayMethods(features.methods),
      updatedAt: this.deps.clock.nowMs(),
    });
    this.deps.markConnected();
    this.deps.setConnectRequestId(null);
    this.deps.settleConnectSuccess();
    return true;
  }

  private handleRpcResponse(parsed: unknown): boolean {
    if (!isGatewayResponseFrame(parsed)) {
      return false;
    }

    this.deps.markAlive('rpc');
    const pending = this.deps.pendingRpcRequests.take(parsed.id);
    if (!pending) {
      return true;
    }
    if (parsed.ok === false || parsed.error) {
      const issue = createGatewayTransportIssue({
        message: `Gateway RPC failed (${pending.method}): ${extractGatewayErrorMessageFromResponse(parsed)}`,
        source: 'rpc',
        clock: this.deps.clock,
        code: extractGatewayErrorCode({ error: parsed.error }),
        details: extractGatewayErrorDetails({ error: parsed.error }),
        retryable: extractGatewayErrorRetryable({ error: parsed.error }),
        retryAfterMs: extractGatewayErrorRetryAfterMs({ error: parsed.error }),
      });
      if (!isExpectedGatewayBusinessError(pending.method, parsed)) {
        this.deps.recordRpcFailure(pending.method, issue);
      }
      pending.reject(new Error(issue.message));
      return true;
    }

    this.deps.recordRpcSuccess();
    pending.resolve(parsed.payload ?? {});
    return true;
  }

  private handleGatewayEvent(parsed: unknown): void {
    if (!isGatewayEventFrame(parsed)) {
      return;
    }

    this.deps.markAlive('message');
    if (parsed.event === 'gateway.ready' || parsed.event === 'presence' || parsed.event === 'health') {
      this.deps.markGatewayReady();
    }
    dispatchGatewayProtocolEvent(
      {
        emitNotification: (notification) => {
          this.deps.onGatewayNotification?.(notification);
        },
        emitConversationEvent: (payload) => {
          this.deps.onGatewayConversationEvent?.(payload);
        },
        emitChannelStatus: (payload) => {
          this.deps.onGatewayChannelStatus?.(payload);
        },
      },
      parsed.event,
      parsed.payload,
    );
  }
}
