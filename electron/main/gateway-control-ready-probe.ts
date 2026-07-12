import { createRuntimeHostCapabilityPayload, resolveRuntimeHostEndpoint } from './runtime-host-capabilities';
import type { RuntimeHostManager } from './runtime-host-manager';

export interface GatewayControlReadyResponse {
  readonly success?: boolean;
  readonly phase?: string;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
  readonly error?: string;
  readonly code?: string;
  readonly missingMethods?: readonly string[];
}

export interface GatewayControlReadyProbeDeps {
  readonly runtimeHostManager: RuntimeHostManager;
  readonly nowMs: () => number;
  readonly delay: (ms: number) => Promise<void>;
}

const CONTROL_READY_REQUEST_TIMEOUT_MS = 3_000;
const CONTROL_READY_RETRY_DELAYS_MS = [1000, 2000, 3000] as const;

export class GatewayControlReadinessBudgetError extends Error {
  constructor() {
    super('Gateway control readiness budget exhausted');
    this.name = 'GatewayControlReadinessBudgetError';
  }
}

function resolveControlReadyRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (Number.isFinite(retryAfterMs) && (retryAfterMs ?? 0) > 0) {
    return Number(retryAfterMs);
  }
  return CONTROL_READY_RETRY_DELAYS_MS[Math.min(attempt, CONTROL_READY_RETRY_DELAYS_MS.length - 1)]!;
}

export async function waitForGatewayControlReady(
  deps: GatewayControlReadyProbeDeps,
  timeoutMs: number,
  port: number,
  externalToken?: string,
): Promise<void> {
  const startedAt = deps.nowMs();
  const deadlineMs = startedAt + timeoutMs;
  const budgetExhaustedError = new GatewayControlReadinessBudgetError();
  let attempt = 0;
  while (deps.nowMs() < deadlineMs) {
    let remainingMs = deadlineMs - deps.nowMs();
    if (remainingMs <= 0) {
      break;
    }
    const endpoint = await resolveRuntimeHostEndpoint(deps.runtimeHostManager, {
      timeoutMs: Math.min(CONTROL_READY_REQUEST_TIMEOUT_MS, remainingMs),
    });
    remainingMs = deadlineMs - deps.nowMs();
    if (remainingMs <= 0) {
      break;
    }
    const input: Record<string, unknown> = {
      port,
      ...(externalToken ? { externalToken } : {}),
    };
    const payload = await createRuntimeHostCapabilityPayload(
      deps.runtimeHostManager,
      'runtimeHost.gatewayReady',
      input,
      { endpoint },
    );
    remainingMs = deadlineMs - deps.nowMs();
    if (remainingMs <= 0) {
      break;
    }
    const requestTimeoutMs = Math.min(CONTROL_READY_REQUEST_TIMEOUT_MS, remainingMs);
    const result = await deps.runtimeHostManager.request<GatewayControlReadyResponse>(
      'POST',
      '/api/capabilities/execute',
      payload,
      { timeoutMs: requestTimeoutMs },
    );
    if (result.data?.success === true) {
      return;
    }
    const missingMethods = Array.isArray(result.data?.missingMethods) && result.data.missingMethods.length > 0
      ? ` missingMethods=${result.data.missingMethods.join(',')}`
      : '';
    const errorMessage = result.data?.error || result.data?.code || `Gateway control ready probe failed${missingMethods}`;
    if (result.data?.phase !== 'starting' || result.data.retryable !== true) {
      throw new Error(errorMessage);
    }
    const retryAfterMs = resolveControlReadyRetryDelayMs(attempt, result.data?.retryAfterMs);
    attempt += 1;
    const delayRemainingMs = deadlineMs - deps.nowMs();
    if (delayRemainingMs <= 0) {
      throw budgetExhaustedError;
    }
    await deps.delay(Math.min(retryAfterMs, delayRemainingMs));
  }
  throw budgetExhaustedError;
}
