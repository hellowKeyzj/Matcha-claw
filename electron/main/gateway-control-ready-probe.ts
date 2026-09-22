import type {
  RuntimeControlReadyResponse,
  RuntimeControlTransport,
} from './runtime-host-delivery/transport/runtime-control';

export type GatewayControlReadyResponse = RuntimeControlReadyResponse;

export interface GatewayControlReadyProbeDeps {
  readonly runtimeControlTransport: Pick<RuntimeControlTransport, 'controlReady'>;
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

function resolveControlReadyRetryDelayMs(attempt: number): number {
  return CONTROL_READY_RETRY_DELAYS_MS[Math.min(attempt, CONTROL_READY_RETRY_DELAYS_MS.length - 1)]!;
}

export async function waitForGatewayControlReady(
  deps: GatewayControlReadyProbeDeps,
  timeoutMs: number,
): Promise<void> {
  const startedAt = deps.nowMs();
  const deadlineMs = startedAt + timeoutMs;
  const budgetExhaustedError = new GatewayControlReadinessBudgetError();
  let attempt = 0;
  while (deps.nowMs() < deadlineMs) {
    const remainingMs = deadlineMs - deps.nowMs();
    if (remainingMs <= 0) {
      break;
    }
    const status = await readGatewayControlReadyStatus(
      deps.runtimeControlTransport,
      Math.min(CONTROL_READY_REQUEST_TIMEOUT_MS, remainingMs),
    );
    if (status.ready) {
      if (status.phase !== 'ready' || status.retryable) {
        throw new Error('Gateway control readiness response was invalid.');
      }
      return;
    }
    if (status.phase === 'ready') {
      throw new Error('Gateway control readiness response was invalid.');
    }
    if (status.phase !== 'starting' || status.retryable !== true) {
      throw new Error('Gateway control is unavailable.');
    }
    const delayRemainingMs = deadlineMs - deps.nowMs();
    if (delayRemainingMs <= 0) {
      throw budgetExhaustedError;
    }
    const retryDelayMs = resolveControlReadyRetryDelayMs(attempt);
    attempt += 1;
    await deps.delay(Math.min(retryDelayMs, delayRemainingMs));
  }
  throw budgetExhaustedError;
}

async function readGatewayControlReadyStatus(
  runtimeControlTransport: Pick<RuntimeControlTransport, 'controlReady'>,
  timeoutMs: number,
): Promise<GatewayControlReadyResponse> {
  const response = await runtimeControlTransport.controlReady({ timeoutMs });
  if (response.status !== 200) {
    throw new Error('Gateway control readiness command was rejected.');
  }
  if (!isGatewayControlReadyResponse(response.body)) {
    throw new Error('Gateway control readiness response was invalid.');
  }
  return response.body;
}

function isGatewayControlReadyResponse(value: unknown): value is GatewayControlReadyResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const response = value as Record<string, unknown>;
  const keys = Object.keys(response);
  return keys.length === 3
    && keys.includes('ready')
    && keys.includes('phase')
    && keys.includes('retryable')
    && typeof response.ready === 'boolean'
    && (response.phase === 'ready' || response.phase === 'starting' || response.phase === 'unavailable')
    && typeof response.retryable === 'boolean';
}
