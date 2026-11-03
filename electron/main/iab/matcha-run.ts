import { isIabInvocationId, type RuntimeHostJsonValue } from '../runtime-host-delivery/control';
import type { RuntimeHostLifecycle } from '../runtime-host-delivery/lifecycle-owner';

type Runtime = Pick<RuntimeHostLifecycle, 'command' | 'onDisconnect'>;
type Receipt = { sessionId: string; instanceId: string; runId: string; executorId: string; principalId: string };
type RunState = 'current' | 'terminal' | 'revoked';
type Run = {
  receipt: Receipt;
  controller: AbortController;
  releases: Set<Promise<void>>;
  releaseFailure?: unknown;
  ready: Promise<void>;
  done: Promise<void>;
};
const reasons = new Set(['instance_closing', 'instance_replaced', 'native_exit', 'native_identity_changed', 'server_shutdown']);
function failure(kind: 'PROTOCOL' | 'DISCONNECTED' | 'WAIT_FAILED' | 'RELEASE_FAILED' | 'ENDED' | 'CLOSED'): Error {
  return Object.assign(new Error(`Matcha browser run ${kind.toLowerCase().replaceAll('_', ' ')}`), { code: `IAB_RUN_${kind}` });
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function state(value: RuntimeHostJsonValue, receipt: Receipt): RunState {
  if (!record(value) || value.sessionId !== receipt.sessionId || value.instanceId !== receipt.instanceId || value.runId !== receipt.runId
    || !(value.state === 'current' && Object.keys(value).length === 4
      || value.state === 'terminal' && (Object.keys(value).length === 4 || Object.keys(value).length === 5 && typeof value.status === 'string')
      || value.state === 'revoked' && Object.keys(value).length === 5 && typeof value.reason === 'string' && reasons.has(value.reason))) {
    throw failure('PROTOCOL');
  }
  return value.state;
}

/** Run ownership outlives invocation leases; only native receipts can start this watch. */
export class IabMatchaRuns {
  private readonly runs = new Map<string, Run>();
  private closed = false;

  constructor(private readonly cleanupSession: (executorId: string, principalId: string, scope: 'group') => Promise<void>) {}

  async admit(receipt: Receipt, runtime: Runtime, released: Promise<void>): Promise<{ signal: AbortSignal; assertCurrent(): void }> {
    if (!isIabInvocationId(receipt.runId)) throw failure('PROTOCOL');
    let run = this.runs.get(receipt.sessionId);
    while (run && (run.receipt.runId !== receipt.runId || run.receipt.instanceId !== receipt.instanceId)) {
      await run.done;
      if (this.runs.get(receipt.sessionId) === run) break;
      run = this.runs.get(receipt.sessionId);
    }
    if (this.closed) throw failure('CLOSED');
    if (!run || run.receipt.runId !== receipt.runId || run.receipt.instanceId !== receipt.instanceId) {
      run = { receipt, controller: new AbortController(), releases: new Set(), ready: Promise.resolve(), done: Promise.resolve() };
      this.runs.set(receipt.sessionId, run);
      this.trackRelease(run, released);
      this.start(run, runtime);
    } else {
      if (run.receipt.executorId !== receipt.executorId || run.receipt.principalId !== receipt.principalId) throw failure('PROTOCOL');
      this.trackRelease(run, released);
    }
    await run.ready;
    const signal = run.controller.signal;
    signal.throwIfAborted();
    return { signal, assertCurrent: () => signal.throwIfAborted() };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) run.controller.abort(failure('CLOSED'));
    const outcomes = await Promise.allSettled([...this.runs.values()].map((run) => run.done));
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map((outcome) => outcome.reason);
    if (failures.length) throw new AggregateError(failures, 'Matcha browser runs did not finish cleanup');
  }

  private trackRelease(run: Run, released: Promise<void>): void {
    run.releases.add(released);
    void released.then(() => run.releases.delete(released), (error: unknown) => {
      run.releaseFailure ??= error;
      run.releases.delete(released);
    });
  }

  private start(run: Run, runtime: Runtime): void {
    const { sessionId, instanceId, runId, executorId, principalId } = run.receipt;
    const tuple = { sessionId, instanceId, runId };
    let disconnected = false;
    // Sticky across LifecycleOwner replacement, exactly as for the invocation lease.
    const stopDisconnect = runtime.onDisconnect(() => {
      disconnected = true;
      run.controller.abort(failure('DISCONNECTED'));
    });
    const wait = async (longPoll: boolean): Promise<RunState> => {
      if (disconnected) throw failure('DISCONNECTED');
      const outcome = await runtime.command({ name: 'iab.run.wait', input: { ...tuple, wait: longPoll } }, { timeoutMs: 25_000 });
      if (disconnected) throw failure('DISCONNECTED');
      if (outcome.kind !== 'succeeded') throw failure('WAIT_FAILED');
      return state(outcome.result, run.receipt);
    };
    // The immediate subscription ACK arms native cleanup before any browser effect.
    const initial = wait(false).then((current) => {
      if (current !== 'current') run.controller.abort(failure('ENDED'));
      return current;
    });
    run.ready = initial.then(() => { run.controller.signal.throwIfAborted(); });
    run.done = (async () => {
      let current: RunState | undefined;
      let failed: unknown;
      let admissionFailed: unknown;
      try {
        try { current = await initial; }
        catch (error) {
          failed = error;
          admissionFailed = error;
          run.controller.abort(error);
          // A lost adopt ACK may already have armed native cleanup. Keep observing
          // this fixed peer, but never turn the failed admission into page authority.
          if (!disconnected && !this.closed) current = await wait(true);
        }
        while (current === 'current' && !this.closed) current = await wait(true);
      } catch (error) { failed ??= error; }
      run.controller.abort(failure('ENDED'));
      try {
        // This authority is cleanup-only: no invalid context is made operable again.
        await this.cleanupSession(executorId, principalId, 'group');
        while (run.releases.size) await Promise.allSettled([...run.releases]);
        if (!disconnected) {
          if (failed && !admissionFailed) throw failed;
          if (run.releaseFailure) throw run.releaseFailure;
          if (current !== 'terminal' && current !== 'revoked') throw failure(this.closed ? 'CLOSED' : 'WAIT_FAILED');
          if (current === 'terminal' || current === 'revoked') {
            const outcome = await runtime.command({ name: 'iab.run.release', input: { ...tuple, drained: true } }, { timeoutMs: 5_000 });
            if (disconnected) return;
            if (outcome.kind !== 'succeeded' || !record(outcome.result) || Object.keys(outcome.result).length !== 4
              || outcome.result.sessionId !== sessionId || outcome.result.instanceId !== instanceId
              || outcome.result.runId !== runId || outcome.result.released !== true) throw failure('RELEASE_FAILED');
          }
          if (admissionFailed) throw admissionFailed;
        }
      } finally { stopDisconnect(); }
    })();
    // Admission/close observe errors; a completed invocation must not orphan rejection.
    void run.ready.catch(() => {});
    void run.done.catch(() => {});
  }
}
