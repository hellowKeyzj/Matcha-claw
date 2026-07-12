import WebSocket from 'ws';
import { ensureError } from './client-errors';
import { createGatewayTransportIssue, type GatewayConnectionStatePayload } from './client-state';
import type { GatewayPendingRpcRequests } from './client-pending-rpc';
import { GatewayClientFrameHandler, type GatewayClientFrameHandlerDeps } from './client-frame-handler';
import type { GatewayTransportIssue } from '../shared/gateway-error';
import type { RuntimeClockPort, RuntimeIdGeneratorPort, RuntimeSchedulerPort } from '../application/common/runtime-ports';

export interface GatewaySocketSessionDeps extends Omit<
  GatewayClientFrameHandlerDeps,
  | 'getConnectRequestId'
  | 'setConnectRequestId'
  | 'sendRaw'
  | 'settleConnectSuccess'
  | 'settleConnectFailure'
  | 'markAlive'
  | 'pendingRpcRequests'
> {
  wsUrl: string;
  timeoutMs: number;
  expectedEpoch: number;
  scheduler: RuntimeSchedulerPort;
  idGenerator: RuntimeIdGeneratorPort;
  clock: RuntimeClockPort;
  getSocket(): WebSocket | null;
  setSocket(socket: WebSocket | null): void;
  getTransportEpoch(): number;
  updateConnectionSnapshot(
    patch: Partial<Omit<GatewayConnectionStatePayload, 'updatedAt'>>,
  ): GatewayConnectionStatePayload;
  getDiagnostics(): GatewayConnectionStatePayload['diagnostics'];
  markAlive(source: 'message' | 'pong' | 'rpc'): void;
  recordConnectSuccess(expectedEpoch: number): void;
  recordSocketClose(code: number): void;
  clearSocketTimers(): void;
  clearConnectionState(): void;
  rejectAllPending(error: Error): void;
  consumeClosingSocketFlag(): boolean;
  reportGatewayError(error: unknown, issue?: GatewayTransportIssue): void;
  scheduleReconnect(reason: string): void;
  pendingRpcRequests: GatewayPendingRpcRequests;
}

export function connectGatewaySocketSession(deps: GatewaySocketSessionDeps): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let connectRequestId: string | null = null;
    let connectSettled = false;
    const ws = new WebSocket(deps.wsUrl);
    deps.setSocket(ws);

    const connectTimer = deps.scheduler.schedule(Math.max(1000, deps.timeoutMs), () => {
      if (connectSettled) {
        return;
      }
      connectSettled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      const timeoutError = new Error('Gateway connect timeout');
      deps.updateConnectionSnapshot({
        state: 'disconnected',
        gatewayReady: false,
        transportEpoch: deps.getTransportEpoch(),
        lastError: timeoutError.message,
        lastIssue: createGatewayTransportIssue({
          message: timeoutError.message,
          source: 'connect',
          clock: deps.clock,
          code: 'GATEWAY_HANDSHAKE_TIMEOUT',
          retryable: true,
          retryAfterMs: 2_000,
        }),
        diagnostics: deps.getDiagnostics(),
      });
      reject(timeoutError);
    });

    const settleConnectSuccess = () => {
      if (connectSettled) {
        return;
      }
      if (deps.getSocket() !== ws) {
        return;
      }
      connectSettled = true;
      connectTimer.cancel();
      deps.recordConnectSuccess(deps.expectedEpoch);
      resolve();
    };

    const settleConnectFailure = (
      error: unknown,
      issuePatch?: Pick<GatewayTransportIssue, 'code' | 'details' | 'retryable' | 'retryAfterMs'>,
    ) => {
      if (connectSettled) {
        return;
      }
      if (deps.getSocket() !== ws) {
        return;
      }
      connectSettled = true;
      connectTimer.cancel();
      try {
        ws.close();
      } catch {
        // ignore
      }
      const failure = ensureError(error, 'Gateway connect failed');
      deps.updateConnectionSnapshot({
        state: 'disconnected',
        gatewayReady: false,
        transportEpoch: deps.getTransportEpoch(),
        lastError: failure.message,
        lastIssue: createGatewayTransportIssue({
          message: failure.message,
          source: 'connect',
          clock: deps.clock,
          ...(issuePatch?.code ? { code: issuePatch.code } : {}),
          ...(issuePatch?.details !== undefined ? { details: issuePatch.details } : {}),
          ...(issuePatch?.retryable !== undefined ? { retryable: issuePatch.retryable } : {}),
          ...(issuePatch?.retryAfterMs !== undefined ? { retryAfterMs: issuePatch.retryAfterMs } : {}),
        }),
        diagnostics: deps.getDiagnostics(),
      });
      reject(failure);
    };

    const frameHandler = new GatewayClientFrameHandler({
      isConnected: deps.isConnected,
      getConnectRequestId: () => connectRequestId,
      setConnectRequestId: (requestId) => {
        connectRequestId = requestId;
      },
      sendRaw: (payload) => {
        ws.send(payload);
      },
      settleConnectSuccess,
      settleConnectFailure,
      markConnected: deps.markConnected,
      markAlive: deps.markAlive,
      markGatewayReady: deps.markGatewayReady,
      updateCapabilities: deps.updateCapabilities,
      recordRpcSuccess: deps.recordRpcSuccess,
      recordRpcFailure: deps.recordRpcFailure,
      pendingRpcRequests: deps.pendingRpcRequests,
      idGenerator: deps.idGenerator,
      clock: deps.clock,
      logger: deps.logger,
      authService: deps.authService,
      onGatewayNotification: deps.onGatewayNotification,
      onGatewayConversationEvent: deps.onGatewayConversationEvent,
      onGatewayChannelStatus: deps.onGatewayChannelStatus,
    });

    ws.on('open', () => {
      if (deps.getSocket() !== ws) {
        return;
      }
      deps.updateConnectionSnapshot({
        state: 'reconnecting',
        portReachable: true,
        transportEpoch: deps.getTransportEpoch(),
        lastError: '',
      });
    });

    ws.on('message', (rawData: unknown) => {
      if (deps.getSocket() !== ws) {
        return;
      }
      frameHandler.handleRawMessage(rawData);
    });

    ws.on('pong', () => {
      if (deps.getSocket() !== ws || !deps.isConnected()) {
        return;
      }
      deps.markAlive('pong');
    });

    ws.on('error', (error: unknown) => {
      if (deps.getSocket() !== ws) {
        return;
      }
      if (!deps.isConnected()) {
        settleConnectFailure(error);
        return;
      }
      deps.reportGatewayError(error, createGatewayTransportIssue({
        message: ensureError(error, 'Gateway socket error').message,
        source: 'runtime',
        clock: deps.clock,
      }));
    });

    ws.on('close', (code: number, reason: unknown) => {
      if (deps.getSocket() !== ws) {
        return;
      }
      deps.clearSocketTimers();
      deps.recordSocketClose(code);
      const closeError = new Error(
        `Gateway socket closed: code=${String(code)} reason=${String(reason ?? '') || 'unknown'}`,
      );
      const closedDuringConnect = !deps.isConnected();
      const closedByClient = deps.consumeClosingSocketFlag();
      if (closedDuringConnect && connectSettled) {
        return;
      }
      deps.clearConnectionState();
      deps.rejectAllPending(closeError);
      const issue = createGatewayTransportIssue({
        message: closeError.message,
        source: 'socket-close',
        clock: deps.clock,
        code: String(code),
        details: { reason: String(reason ?? '') || 'unknown' },
      });
      deps.updateConnectionSnapshot({
        state: 'disconnected',
        gatewayReady: false,
        transportEpoch: deps.getTransportEpoch(),
        lastError: closeError.message,
        lastIssue: issue,
        diagnostics: deps.getDiagnostics(),
      });
      if (closedDuringConnect) {
        settleConnectFailure(closeError);
        return;
      }
      if (!closedByClient) {
        deps.reportGatewayError(closeError, issue);
        deps.scheduleReconnect('socket-close');
      }
    });
  });
}
