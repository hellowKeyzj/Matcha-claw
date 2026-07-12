export type LocalProcessRestartPolicyInput = {
  readonly autoRestartOnCrash: boolean;
  readonly shouldKeepAlive: boolean;
  readonly hasRestartTimer: boolean;
  readonly hasChildProcess: boolean;
  readonly nowMs: number;
  readonly crashTimestamps: readonly number[];
  readonly windowMs: number;
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
};

export type LocalProcessRestartDecision =
  | { readonly action: 'skip'; readonly reason: 'disabled' | 'stopped' | 'already-scheduled' | 'process-alive' }
  | { readonly action: 'halt'; readonly crashTimestamps: readonly number[]; readonly maxAttempts: number; readonly windowMs: number }
  | { readonly action: 'schedule'; readonly delayMs: number; readonly attempt: number; readonly crashTimestamps: readonly number[] };

export function getLocalProcessRestartDecision(input: LocalProcessRestartPolicyInput): LocalProcessRestartDecision {
  if (!input.autoRestartOnCrash) {
    return { action: 'skip', reason: 'disabled' };
  }
  if (!input.shouldKeepAlive) {
    return { action: 'skip', reason: 'stopped' };
  }
  if (input.hasRestartTimer) {
    return { action: 'skip', reason: 'already-scheduled' };
  }
  if (input.hasChildProcess) {
    return { action: 'skip', reason: 'process-alive' };
  }

  const crashTimestamps = input.crashTimestamps
    .filter((timestampMs) => input.nowMs - timestampMs <= input.windowMs)
    .concat(input.nowMs);

  if (crashTimestamps.length > input.maxAttempts) {
    return {
      action: 'halt',
      crashTimestamps,
      maxAttempts: input.maxAttempts,
      windowMs: input.windowMs,
    };
  }

  const attempt = crashTimestamps.length;
  const delayMs = Math.min(
    input.baseDelayMs * (2 ** Math.max(0, attempt - 1)),
    input.maxDelayMs,
  );

  return {
    action: 'schedule',
    delayMs,
    attempt,
    crashTimestamps,
  };
}
