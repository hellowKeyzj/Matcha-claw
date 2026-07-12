import type { LocalProcessAdapter, LocalProcessLaunchPlan, LocalProcessReadiness } from './contracts';

export const DEFAULT_LOCAL_PROCESS_READINESS_POLL_MS = 120;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function waitForLocalProcessReadiness(input: {
  readonly adapter: LocalProcessAdapter;
  readonly plan: LocalProcessLaunchPlan;
  readonly timeoutMs: number;
  readonly nowMs: () => number;
  readonly signal?: AbortSignal;
}): Promise<LocalProcessReadiness> {
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal) {
    if (input.signal.aborted) {
      return { status: 'error', error: 'readiness wait aborted' };
    }
    input.signal.addEventListener('abort', abort, { once: true });
  }

  const startedAt = input.nowMs();
  const timeout = setTimeout(() => controller.abort(new Error('readiness wait timed out')), input.timeoutMs);
  let lastReadiness: LocalProcessReadiness = { status: 'not-ready', detail: 'starting' };

  try {
    while (input.nowMs() - startedAt < input.timeoutMs) {
      if (controller.signal.aborted) {
        return { status: 'error', error: 'readiness wait aborted' };
      }

      lastReadiness = await input.adapter.probeReadiness(input.plan, {
        nowMs: input.nowMs,
        signal: controller.signal,
      });

      if (lastReadiness.status === 'ready' || lastReadiness.status === 'error') {
        return lastReadiness;
      }

      await sleep(DEFAULT_LOCAL_PROCESS_READINESS_POLL_MS, controller.signal);
    }

    return lastReadiness.status === 'not-ready'
      ? { status: 'error', error: lastReadiness.detail ?? 'process readiness timed out' }
      : lastReadiness;
  } finally {
    clearTimeout(timeout);
    if (input.signal) {
      input.signal.removeEventListener('abort', abort);
    }
  }
}
