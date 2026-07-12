import { describe, expect, it, vi } from 'vitest';
import type { LocalProcessRunner } from '../../electron/main/process-runtime/contracts';
import { LocalProcessRegistry } from '../../electron/main/process-runtime/process-registry';

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (reason?: unknown) => void;
};

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createRunner(overrides: Partial<LocalProcessRunner> = {}): LocalProcessRunner {
  return {
    start: vi.fn<LocalProcessRunner['start']>(async () => undefined),
    stop: vi.fn<LocalProcessRunner['stop']>(async () => undefined),
    restart: vi.fn<LocalProcessRunner['restart']>(async () => undefined),
    forceTerminate: vi.fn<LocalProcessRunner['forceTerminate']>(async () => undefined),
    checkReadiness: vi.fn<LocalProcessRunner['checkReadiness']>(async () => ({ status: 'ready' })),
    getState: vi.fn<LocalProcessRunner['getState']>(() => ({
      id: 'test-process',
      displayName: 'Test Process',
      lifecycle: 'idle',
    })),
    onStateChange: vi.fn<LocalProcessRunner['onStateChange']>(() => () => undefined),
    ...overrides,
  };
}

async function getRejection(promise: Promise<void>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('Expected operation to reject');
    },
    (error: unknown) => error,
  );
}

describe('LocalProcessRegistry', () => {
  it('stopAll attempts every registered process and rejects only after all stops settle', async () => {
    const firstFailure = new Error('first stop failed');
    const pendingStop = createDeferred();
    const firstStop = vi.fn<LocalProcessRunner['stop']>(async () => {
      throw firstFailure;
    });
    const secondStop = vi.fn<LocalProcessRunner['stop']>(() => pendingStop.promise);
    const registry = new LocalProcessRegistry();
    registry.register({ id: 'first', runner: createRunner({ stop: firstStop }) });
    registry.register({ id: 'second', runner: createRunner({ stop: secondStop }) });

    const stopAllPromise = registry.stopAll();
    let stopAllSettled = false;
    void stopAllPromise.then(
      () => { stopAllSettled = true; },
      () => { stopAllSettled = true; },
    );
    await Promise.resolve();

    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledOnce();
    expect(stopAllSettled).toBe(false);

    pendingStop.resolve();
    const error = await getRejection(stopAllPromise);

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.message).toBe('Failed to stop 1 local process(es)');
    expect(error.errors).toHaveLength(1);
    expect(error.errors[0]).toHaveProperty('message', 'Failed to stop local process first');
    expect(error.errors[0]).toHaveProperty('cause', firstFailure);
  });

  it('forceTerminateAll attempts every registered process and aggregates all failures after settlement', async () => {
    const firstFailure = new Error('first force termination failed');
    const secondFailure = new Error('second force termination failed');
    const pendingForceTerminate = createDeferred();
    const firstForceTerminate = vi.fn<LocalProcessRunner['forceTerminate']>(async () => {
      throw firstFailure;
    });
    const secondForceTerminate = vi.fn<LocalProcessRunner['forceTerminate']>(
      () => pendingForceTerminate.promise,
    );
    const thirdForceTerminate = vi.fn<LocalProcessRunner['forceTerminate']>(async () => undefined);
    const registry = new LocalProcessRegistry();
    registry.register({
      id: 'first',
      runner: createRunner({ forceTerminate: firstForceTerminate }),
    });
    registry.register({
      id: 'second',
      runner: createRunner({ forceTerminate: secondForceTerminate }),
    });
    registry.register({
      id: 'third',
      runner: createRunner({ forceTerminate: thirdForceTerminate }),
    });

    const forceTerminateAllPromise = registry.forceTerminateAll();
    let forceTerminateAllSettled = false;
    void forceTerminateAllPromise.then(
      () => { forceTerminateAllSettled = true; },
      () => { forceTerminateAllSettled = true; },
    );
    await Promise.resolve();

    expect(firstForceTerminate).toHaveBeenCalledOnce();
    expect(secondForceTerminate).toHaveBeenCalledOnce();
    expect(thirdForceTerminate).toHaveBeenCalledOnce();
    expect(forceTerminateAllSettled).toBe(false);

    pendingForceTerminate.reject(secondFailure);
    const error = await getRejection(forceTerminateAllPromise);

    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw error;
    expect(error.message).toBe('Failed to force terminate 2 local process(es)');
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0]).toHaveProperty('message', 'Failed to force terminate local process first');
    expect(error.errors[0]).toHaveProperty('cause', firstFailure);
    expect(error.errors[1]).toHaveProperty('message', 'Failed to force terminate local process second');
    expect(error.errors[1]).toHaveProperty('cause', secondFailure);
  });

  it('registerRunnerLike delegates force termination to the runner-like owner', async () => {
    const forceTerminate = vi.fn<LocalProcessRunner['forceTerminate']>(async () => undefined);
    const registry = new LocalProcessRegistry();
    registry.registerRunnerLike({
      id: 'runner-like',
      displayName: 'Runner Like',
      runner: {
        start: vi.fn<LocalProcessRunner['start']>(async () => undefined),
        stop: vi.fn<LocalProcessRunner['stop']>(async () => undefined),
        restart: vi.fn<LocalProcessRunner['restart']>(async () => undefined),
        forceTerminate,
        checkReadiness: vi.fn<LocalProcessRunner['checkReadiness']>(async () => ({ status: 'ready' })),
        getState: vi.fn(() => ({ lifecycle: 'running' as const })),
        onStateChange: vi.fn(() => () => undefined),
      },
    });

    await registry.forceTerminateAll();

    expect(forceTerminate).toHaveBeenCalledOnce();
  });
});
