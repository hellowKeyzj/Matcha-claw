import { ok } from '../../common/application-response';
import {
  DEFAULT_GATEWAY_BASE_METHODS,
  normalizeGatewayMethods,
  type GatewayConnectionPort,
} from '../../gateway/gateway-runtime-port';

export interface GatewayReadinessWorkflowDeps {
  readonly gateway: Pick<GatewayConnectionPort, 'inspectGatewayControlReadiness' | 'readGatewayConnectionState'>;
}

export class GatewayReadinessWorkflow {
  constructor(private readonly deps: GatewayReadinessWorkflowDeps) {}

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
    const readiness = await this.deps.gateway.inspectGatewayControlReadiness(
      requiredMethods.length > 0 ? requiredMethods : DEFAULT_GATEWAY_BASE_METHODS,
      timeoutMs,
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
