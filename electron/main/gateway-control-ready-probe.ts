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

const CONTROL_READY_RETRY_DELAYS_MS = [1000, 2000, 3000] as const;

function resolveControlReadyRetryDelayMs(attempt: number): number {
  return CONTROL_READY_RETRY_DELAYS_MS[Math.min(attempt, CONTROL_READY_RETRY_DELAYS_MS.length - 1)]!;
}

export async function waitForGatewayControlReady(
  deps: GatewayControlReadyProbeDeps,
  timeoutMs: number,
): Promise<void> {
  const startedAt = deps.nowMs();
  let lastError = 'Gateway control ready probe failed';
  let attempt = 0;
  while (deps.nowMs() - startedAt < timeoutMs) {
    const remainingMs = Math.max(100, timeoutMs - (deps.nowMs() - startedAt));
    const requestTimeoutMs = Math.min(15000, remainingMs);
    const endpoint = await resolveRuntimeHostEndpoint(deps.runtimeHostManager);
    const result = await deps.runtimeHostManager.request<GatewayControlReadyResponse>(
      'POST',
      '/api/capabilities/execute',
      await createRuntimeHostCapabilityPayload(deps.runtimeHostManager, 'runtimeHost.gatewayReady', { timeoutMs: requestTimeoutMs }, { endpoint }),
      { timeoutMs: requestTimeoutMs },
    );
    if (result.data?.success === true) {
      return;
    }
    const missingMethods = Array.isArray(result.data?.missingMethods) && result.data.missingMethods.length > 0
      ? ` missingMethods=${result.data.missingMethods.join(',')}`
      : '';
    lastError = result.data?.error || result.data?.code || `Gateway control ready probe failed${missingMethods}`;
    if (result.data?.retryable !== true) {
      throw new Error(lastError);
    }
    const retryAfterMs = resolveControlReadyRetryDelayMs(attempt);
    attempt += 1;
    await deps.delay(Math.min(retryAfterMs, Math.max(100, timeoutMs - (deps.nowMs() - startedAt))));
  }
  throw new Error(lastError);
}
