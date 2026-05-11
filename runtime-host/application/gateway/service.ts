import {
  normalizeSendWithMediaInput,
  sendWithMediaViaGateway,
} from '../chat/send-media';
import {
  badRequest,
  ok,
  serverError,
} from '../common/application-response';
import type { RuntimeFileSystemPort } from '../common/runtime-ports';
import {
  DEFAULT_GATEWAY_BASE_METHODS,
  normalizeGatewayMethods,
  type GatewayChatPort,
  type GatewayConnectionPort,
  type GatewayRpcPort,
} from './gateway-runtime-port';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface GatewayServiceDeps {
  readonly gateway: GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'> & Pick<GatewayConnectionPort, 'ensureGatewayReady' | 'inspectGatewayMethodReadiness' | 'readGatewayConnectionState'>;
  readonly fileSystem: RuntimeFileSystemPort;
}

export class GatewayService {
  constructor(private readonly deps: GatewayServiceDeps) {}

  async status() {
    return ok({
      success: true,
      status: await this.deps.gateway.readGatewayConnectionState(),
    });
  }

  async ready(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0
      ? body.timeoutMs
      : undefined;
    const requiredMethods = normalizeGatewayMethods(body.requiredMethods);
    try {
      if (requiredMethods.length > 0) {
        const readiness = await this.deps.gateway.inspectGatewayMethodReadiness(requiredMethods, timeoutMs);
        if (!readiness.ready) {
          return ok({
            success: false,
            code: 'GATEWAY_METHODS_UNAVAILABLE',
            missingMethods: readiness.missingMethods,
          });
        }
      } else {
        await this.deps.gateway.ensureGatewayReady(timeoutMs);
      }
      return ok({
        success: true,
        requiredMethods: requiredMethods.length > 0 ? requiredMethods : DEFAULT_GATEWAY_BASE_METHODS,
      });
    } catch (error) {
      return ok({ success: false, error: String(error) });
    }
  }

  async sendMedia(payload: unknown) {
    const input = normalizeSendWithMediaInput(payload);
    if (!input) {
      return badRequest('Invalid send-with-media payload');
    }
    const result = await sendWithMediaViaGateway(this.deps.fileSystem, this.deps.gateway, input);
    if (!result.success) {
      return serverError(result.error ?? 'Send-with-media failed');
    }
    return ok({ success: true, result: result.result });
  }

  async agentWait(payload: unknown) {
    const body = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    const method = typeof body.method === 'string' ? body.method.trim() : '';
    if (method !== 'agent.wait') {
      return badRequest('Only agent.wait is allowed');
    }
    const params = body.params && typeof body.params === 'object' && !Array.isArray(body.params)
      ? body.params as Record<string, unknown>
      : {};
    const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs)
      ? Math.max(1000, Math.floor(params.timeoutMs)) + 10000
      : 40000;
    return ok(await this.deps.gateway.gatewayRpc('agent.wait', params, timeoutMs));
  }
}
