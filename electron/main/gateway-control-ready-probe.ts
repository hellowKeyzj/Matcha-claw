import type {
  RuntimeHostControlCommandOptions,
  RuntimeHostControlOutcome,
} from './runtime-host-delivery/control';

export interface GatewayControlReadyResponse {
  readonly ready: boolean;
  readonly phase: 'ready' | 'starting' | 'unavailable';
  readonly retryable: boolean;
}

export interface GatewayControlReadyCommandHost {
  readonly command: (
    command: { readonly name: 'openclaw.control.ready' },
    options?: RuntimeHostControlCommandOptions,
  ) => Promise<RuntimeHostControlOutcome>;
}

export interface GatewayControlReadyProbeDeps {
  readonly directHost: GatewayControlReadyCommandHost;
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
      deps.directHost,
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
  directHost: GatewayControlReadyCommandHost,
  timeoutMs: number,
): Promise<GatewayControlReadyResponse> {
  const outcome = await directHost.command(
    { name: 'openclaw.control.ready' },
    { timeoutMs },
  );
  if (outcome.kind === 'timed-out') {
    throw new Error('Gateway control readiness command timed out.');
  }
  if (outcome.kind === 'rejected') {
    throw new Error('Gateway control readiness command was rejected.');
  }
  if (!isGatewayControlReadyResponse(outcome.result)) {
    throw new Error('Gateway control readiness response was invalid.');
  }
  return outcome.result;
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
