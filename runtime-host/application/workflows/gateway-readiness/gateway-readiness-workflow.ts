import { ok } from '../../common/application-response';
import {
  DEFAULT_GATEWAY_BASE_METHODS,
  normalizeGatewayMethods,
  type GatewayConnectionPort,
  type GatewayControlReadinessOptions,
  type GatewayRpcPort,
} from '../../gateway/gateway-runtime-port';

const CONTROL_UI_BROWSER_CLIENT_ID = 'openclaw-control-ui';

export interface GatewayReadinessWorkflowDeps {
  readonly gateway: Pick<GatewayConnectionPort, 'inspectGatewayControlReadiness' | 'readGatewayConnectionState' | 'recoverGatewayConnection'> & Pick<GatewayRpcPort, 'gatewayRpc'>;
}

type PendingDevicePairingRequest = {
  requestId?: unknown;
  clientId?: unknown;
};

export class GatewayReadinessWorkflow {
  constructor(private readonly deps: GatewayReadinessWorkflowDeps) {}

  async status() {
    return ok({
      success: true,
      status: await this.deps.gateway.readGatewayConnectionState(),
    });
  }

  async recover(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const reason = typeof body.reason === 'string' && body.reason.trim()
      ? body.reason.trim()
      : 'manual';
    const timeoutMs = typeof body.timeoutMs === 'number' && body.timeoutMs > 0
      ? body.timeoutMs
      : undefined;
    return ok({
      success: true,
      status: await this.deps.gateway.recoverGatewayConnection(reason, timeoutMs),
    });
  }

  async ready(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const readinessOptions = toGatewayControlReadinessOptions(body);
    const requiredMethods = normalizeGatewayMethods(body.requiredMethods);
    const readiness = await this.deps.gateway.inspectGatewayControlReadiness(
      requiredMethods.length > 0 ? requiredMethods : DEFAULT_GATEWAY_BASE_METHODS,
      readinessOptions,
    );
    return ok({
      success: readiness.ready,
      phase: readiness.phase,
      retryable: readiness.retryable,
      requiredMethods: readiness.requiredMethods,
      missingMethods: readiness.missingMethods,
      ...(readiness.code ? { code: readiness.code } : {}),
      ...(readiness.error ? { error: readiness.error } : {}),
      ...(readiness.details !== undefined ? { details: readiness.details } : {}),
      ...(readiness.retryAfterMs !== undefined ? { retryAfterMs: readiness.retryAfterMs } : {}),
    });
  }

  async approvePendingControlUiPairingRequests() {
    const list = await this.deps.gateway.gatewayRpc('device.pair.list', {}, 10_000);
    const pending = isRecord(list) && Array.isArray(list.pending)
      ? list.pending
      : [];
    const approvedRequestIds: string[] = [];

    for (const request of pending) {
      const pairingRequest = isRecord(request) ? request as PendingDevicePairingRequest : null;
      const requestId = typeof pairingRequest?.requestId === 'string' ? pairingRequest.requestId.trim() : '';
      const clientId = typeof pairingRequest?.clientId === 'string' ? pairingRequest.clientId.trim() : '';
      if (!requestId || clientId !== CONTROL_UI_BROWSER_CLIENT_ID) {
        continue;
      }
      await this.deps.gateway.gatewayRpc('device.pair.approve', { requestId }, 15_000);
      approvedRequestIds.push(requestId);
    }

    return ok({ success: true, approvedRequestIds });
  }
}

function toGatewayControlReadinessOptions(
  body: Record<string, unknown>,
): GatewayControlReadinessOptions | undefined {
  const handshakeTimeoutMs = isPositiveFiniteNumber(body.handshakeTimeoutMs)
    ? body.handshakeTimeoutMs
    : undefined;
  const livenessProbeTimeoutMs = isPositiveFiniteNumber(body.livenessProbeTimeoutMs)
    ? body.livenessProbeTimeoutMs
    : undefined;
  if (handshakeTimeoutMs === undefined && livenessProbeTimeoutMs === undefined) {
    return undefined;
  }
  return {
    ...(handshakeTimeoutMs !== undefined ? { handshakeTimeoutMs } : {}),
    ...(livenessProbeTimeoutMs !== undefined ? { livenessProbeTimeoutMs } : {}),
  };
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
