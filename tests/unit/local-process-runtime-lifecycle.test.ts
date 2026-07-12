import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LocalProcessRuntime } from '../../electron/main/process-runtime/local-process-runtime';
import type {
  LocalProcessAdapter,
  LocalProcessLaunchPlan,
  LocalProcessLogger,
  LocalProcessReadiness,
  LocalProcessRuntimeOptions,
  LocalProcessStartFailureRecovery,
  LocalProcessUtilityLauncher,
  LocalProcessUtilityProcess,
} from '../../electron/main/process-runtime/contracts';

class FakeUtilityProcess implements LocalProcessUtilityProcess {
  private readonly emitter = new EventEmitter();

  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn<() => boolean>(() => {
    if (this.emitExitOnKill) {
      this.emitExitWithoutSignal(0);
    }
    return true;
  });

  constructor(
    readonly pid: number,
    private readonly emitExitOnKill = true,
  ) {}

  once(eventName: 'exit', listener: (code: number) => void): this;
  once(eventName: 'error', listener: (type: string, location: string, report: string) => void): this;
  once(
    eventName: 'exit' | 'error',
    listener: ((code: number) => void) | ((type: string, location: string, report: string) => void),
  ): this {
    this.emitter.once(eventName, listener);
    return this;
  }

  emitExitWithoutSignal(code: number): void {
    this.emitter.emit('exit', code);
  }

  emitError(message: string): void {
    this.emitter.emit('error', message, '', '');
  }
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason?: unknown) => void;
};

const utilityLaunchPlan: LocalProcessLaunchPlan = {
  kind: 'utility',
  command: 'E:/matcha/runtime-host/utility-entry.js',
  args: ['--runtime-host', '--port=51234'],
  cwd: 'E:/matcha/workspace',
  env: {
    MATCHA_RUNTIME_MODE: 'utility',
    MATCHA_RUNTIME_PORT: '51234',
  },
  stdio: 'pipe',
  serviceName: 'Matcha Local Process Utility',
  port: 51_234,
};

const externalLaunchPlan: LocalProcessLaunchPlan = {
  kind: 'external',
  port: 61_234,
  pid: 99_001,
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(cycles = 8): Promise<void> {
  for (let index = 0; index < cycles; index += 1) {
    await Promise.resolve();
  }
}

async function flushUntil(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createLogger(): Required<LocalProcessLogger> {
  return {
    debug: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string, error?: unknown) => void>(),
    error: vi.fn<(message: string, error?: unknown) => void>(),
  };
}

function createAdapter(overrides: Partial<LocalProcessAdapter> = {}): LocalProcessAdapter {
  return {
    id: 'lifecycle-runtime',
    displayName: 'Lifecycle Runtime',
    prepareLaunch: vi.fn<LocalProcessAdapter['prepareLaunch']>(async () => utilityLaunchPlan),
    probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(async () => ({ status: 'ready' })),
    ...overrides,
  };
}

function createRuntime(options: {
  readonly adapter?: LocalProcessAdapter;
  readonly utilityProcesses?: FakeUtilityProcess[];
  readonly logger?: Required<LocalProcessLogger>;
  readonly autoRestartOnCrash?: boolean;
  readonly autoRestartBaseDelayMs?: number;
  readonly autoRestartMaxDelayMs?: number;
  readonly autoRestartMaxAttempts?: number;
  readonly startTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
} = {}): {
  readonly runtime: LocalProcessRuntime;
  readonly adapter: LocalProcessAdapter;
  readonly logger: Required<LocalProcessLogger>;
  readonly utilityFork: ReturnType<typeof vi.fn<LocalProcessUtilityLauncher['fork']>>;
} {
  const adapter = options.adapter ?? createAdapter();
  const logger = options.logger ?? createLogger();
  const utilityProcesses = [...(options.utilityProcesses ?? [new FakeUtilityProcess(42_424)])];
  const utilityFork = vi.fn<LocalProcessUtilityLauncher['fork']>(() => {
    const process = utilityProcesses.shift();
    if (!process) {
      throw new Error('No fake utility process available');
    }
    return process;
  });
  const runtimeOptions = {
    adapter,
    logger,
    utilityLauncher: { fork: utilityFork },
    autoRestartOnCrash: options.autoRestartOnCrash ?? false,
    autoRestartBaseDelayMs: options.autoRestartBaseDelayMs,
    autoRestartMaxDelayMs: options.autoRestartMaxDelayMs,
    autoRestartMaxAttempts: options.autoRestartMaxAttempts,
    startTimeoutMs: options.startTimeoutMs ?? 100,
    stopTimeoutMs: options.stopTimeoutMs ?? 10,
  } satisfies LocalProcessRuntimeOptions;

  return {
    runtime: new LocalProcessRuntime(runtimeOptions),
    adapter,
    logger,
    utilityFork,
  };
}

describe('LocalProcessRuntime lifecycle guards', () => {
  it('does not become running after stop resolves while prepareLaunch is still pending', async () => {
    const prepareLaunch = createDeferred<LocalProcessLaunchPlan>();
    const onStarted = vi.fn<NonNullable<LocalProcessAdapter['onStarted']>>(async () => undefined);
    const adapter = createAdapter({
      prepareLaunch: vi.fn<LocalProcessAdapter['prepareLaunch']>(() => prepareLaunch.promise),
      onStarted,
    });
    const { runtime } = createRuntime({
      adapter,
      utilityProcesses: [new FakeUtilityProcess(101)],
    });

    const startPromise = runtime.start().catch(() => undefined);
    await flushUntil(() => adapter.prepareLaunch.mock.calls.length === 1, 'prepareLaunch call');

    await runtime.stop();
    expect(runtime.getState().lifecycle).toBe('stopped');

    prepareLaunch.resolve(utilityLaunchPlan);
    await flushMicrotasks();

    expect(runtime.getState().lifecycle).toBe('stopped');
    expect(onStarted).not.toHaveBeenCalled();
    void startPromise;
  });

  it('does not become running after stop resolves while readiness is still pending', async () => {
    const readiness = createDeferred<LocalProcessReadiness>();
    const onStarted = vi.fn<NonNullable<LocalProcessAdapter['onStarted']>>(async () => undefined);
    const adapter = createAdapter({
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(() => readiness.promise),
      onStarted,
    });
    const { runtime } = createRuntime({
      adapter,
      utilityProcesses: [new FakeUtilityProcess(102)],
    });

    const startPromise = runtime.start().catch(() => undefined);
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 1, 'readiness probe');

    await runtime.stop();
    expect(runtime.getState().lifecycle).toBe('stopped');

    readiness.resolve({ status: 'ready' });
    await flushMicrotasks();

    expect(runtime.getState().lifecycle).toBe('stopped');
    expect(onStarted).not.toHaveBeenCalled();
    void startPromise;
  });

  it('does not retry startup recovery after stop resolves during the recovery delay', async () => {
    const recovery = createDeferred<LocalProcessStartFailureRecovery>();
    const recoverStartFailure = vi
      .fn<NonNullable<LocalProcessAdapter['recoverStartFailure']>>()
      .mockImplementationOnce(() => recovery.promise)
      .mockResolvedValue({ action: 'fail' });
    const adapter = createAdapter({
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(async () => ({
        status: 'error',
        error: 'transient startup failure',
      })),
      recoverStartFailure,
    });
    const { runtime, utilityFork } = createRuntime({
      adapter,
      utilityProcesses: [new FakeUtilityProcess(201), new FakeUtilityProcess(202)],
    });

    const startPromise = runtime.start().catch(() => undefined);
    await flushUntil(
      () => recoverStartFailure.mock.calls.length === 1,
      'startup recovery hook',
    );

    await runtime.stop();
    expect(runtime.getState().lifecycle).toBe('stopped');

    recovery.resolve({ action: 'retry' });
    await flushMicrotasks();

    expect(adapter.prepareLaunch).toHaveBeenCalledTimes(1);
    expect(utilityFork).toHaveBeenCalledTimes(1);
    expect(runtime.getState().lifecycle).toBe('stopped');
    await startPromise;
  });

  it('force terminates a utility child while stop is waiting for exit', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess(251);
      const { runtime } = createRuntime({
        utilityProcesses: [child],
        stopTimeoutMs: 100,
      });

      await runtime.start();

      const stopPromise = runtime.stop();
      await flushUntil(() => child.kill.mock.calls.length === 1, 'ordinary stop termination');
      expect(runtime.getState().lifecycle).toBe('stopping');

      const forceTerminatePromise = runtime.forceTerminate();
      await flushUntil(() => child.kill.mock.calls.length >= 2, 'emergency force termination');
      expect(child.kill).toHaveBeenCalledTimes(2);

      await expect(forceTerminatePromise).resolves.toBeUndefined();
      expect(runtime.getState().lifecycle).toBe('stopped');
      expect(runtime.getState()).not.toHaveProperty('pid');

      await vi.runAllTimersAsync();
      await expect(stopPromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a late exit from the old child after a new child has started', async () => {
    const oldChild = new FakeUtilityProcess(301);
    const newChild = new FakeUtilityProcess(302);
    const onCrashed = vi.fn<NonNullable<LocalProcessAdapter['onCrashed']>>(async () => undefined);
    const adapter = createAdapter({ onCrashed });
    const { runtime } = createRuntime({
      adapter,
      utilityProcesses: [oldChild, newChild],
      stopTimeoutMs: 1,
    });

    await runtime.start();
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: oldChild.pid });

    await runtime.restart();
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: newChild.pid });

    oldChild.emitExitWithoutSignal(7);

    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: newChild.pid });
    expect(onCrashed).not.toHaveBeenCalled();
  });

  it('marks external stop failures as error state', async () => {
    const adapter = createAdapter({
      prepareLaunch: vi.fn<LocalProcessAdapter['prepareLaunch']>(async () => externalLaunchPlan),
      externalController: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => {
          throw new Error('external stop failed');
        }),
      },
    });
    const { runtime } = createRuntime({ adapter });

    await runtime.start();
    await expect(runtime.stop()).rejects.toThrow('external stop failed');

    expect(runtime.getState().lifecycle).toBe('error');
    expect(runtime.getState().lastError).toContain('external stop failed');
  });

  it('marks external restart failures as error state', async () => {
    const adapter = createAdapter({
      prepareLaunch: vi.fn<LocalProcessAdapter['prepareLaunch']>(async () => externalLaunchPlan),
      externalController: {
        start: vi.fn(async () => undefined),
        restart: vi.fn(async () => {
          throw new Error('external restart failed');
        }),
      },
    });
    const { runtime } = createRuntime({ adapter });

    await runtime.start();
    await expect(runtime.restart()).rejects.toThrow('external restart failed');

    expect(runtime.getState().lifecycle).toBe('error');
    expect(runtime.getState().lastError).toContain('external restart failed');
  });

  it('warns with exit context for an unexpected child exit', async () => {
    const logger = createLogger();
    const child = new FakeUtilityProcess(351, false);
    const { runtime } = createRuntime({
      logger,
      utilityProcesses: [child],
    });

    await runtime.start();
    child.emitExitWithoutSignal(7);

    expect(logger.warn).toHaveBeenCalledWith(
      '[Lifecycle Runtime] exited unexpectedly (code=7, signal=null, previousLifecycle=running)',
    );
  });

  it('does not warn about an unexpected exit during intentional stop', async () => {
    const logger = createLogger();
    const child = new FakeUtilityProcess(352);
    const { runtime } = createRuntime({
      logger,
      utilityProcesses: [child],
    });

    await runtime.start();
    await runtime.stop();

    expect(runtime.getState().lifecycle).toBe('stopped');
    expect(
      logger.warn.mock.calls.some(([message]) => message.includes('exited unexpectedly')),
    ).toBe(false);
  });

  it('continues auto-restart policy after a crash-driven relaunch failure', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
      let readinessAttempt = 0;
      const onAutoRestartScheduled = vi.fn<NonNullable<LocalProcessAdapter['onAutoRestartScheduled']>>(
        async () => undefined,
      );
      const adapter = createAdapter({
        probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(async () => {
          readinessAttempt += 1;
          return readinessAttempt === 2
            ? { status: 'error', error: 'relaunch readiness failed' }
            : { status: 'ready' };
        }),
        onAutoRestartScheduled,
      });
      const firstChild = new FakeUtilityProcess(401, false);
      const failedRelaunchChild = new FakeUtilityProcess(402);
      const retryChild = new FakeUtilityProcess(403);
      const { runtime } = createRuntime({
        adapter,
        utilityProcesses: [firstChild, failedRelaunchChild, retryChild],
        autoRestartOnCrash: true,
        autoRestartBaseDelayMs: 10,
        autoRestartMaxDelayMs: 10,
        autoRestartMaxAttempts: 5,
      });

      await runtime.start();
      expect(adapter.prepareLaunch).toHaveBeenCalledTimes(1);

      firstChild.emitExitWithoutSignal(9);
      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();
      expect(adapter.prepareLaunch).toHaveBeenCalledTimes(2);

      expect(onAutoRestartScheduled).toHaveBeenNthCalledWith(1, {
        reason: 'child-exit',
        attempt: 1,
        delayMs: 10,
      });
      expect(onAutoRestartScheduled).toHaveBeenNthCalledWith(2, {
        reason: 'auto-restart-failed',
        attempt: 2,
        delayMs: 10,
      });

      await vi.advanceTimersByTimeAsync(10);
      await flushMicrotasks();

      expect(adapter.prepareLaunch).toHaveBeenCalledTimes(3);
      expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: retryChild.pid });
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a new operation immediately after stop aborts a pending start', async () => {
    const firstReadiness = createDeferred<LocalProcessReadiness>();
    const firstChild = new FakeUtilityProcess(451);
    const secondChild = new FakeUtilityProcess(452);
    const adapter = createAdapter({
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>()
        .mockImplementationOnce(() => firstReadiness.promise)
        .mockResolvedValue({ status: 'ready' }),
    });
    const { runtime } = createRuntime({
      adapter,
      utilityProcesses: [firstChild, secondChild],
    });

    const firstStart = runtime.start().catch((error: unknown) => error);
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 1, 'first readiness probe');
    await runtime.stop();

    await expect(runtime.start()).resolves.toBeUndefined();
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: secondChild.pid });
    expect(adapter.prepareLaunch).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 1 }));

    firstReadiness.resolve({ status: 'ready' });
    expect(await firstStart).toBeInstanceOf(Error);
  });

  it('waits for an in-flight stop before starting a replacement child', async () => {
    vi.useFakeTimers();
    try {
      const firstChild = new FakeUtilityProcess(453, false);
      const secondChild = new FakeUtilityProcess(454);
      const { runtime } = createRuntime({
        utilityProcesses: [firstChild, secondChild],
        stopTimeoutMs: 100,
      });

      await runtime.start();
      const stopPromise = runtime.stop();
      await flushUntil(() => firstChild.kill.mock.calls.length === 1, 'SIGTERM request');
      const startPromise = runtime.start();

      expect(runtime.getState().lifecycle).toBe('stopping');
      expect(secondChild.kill).not.toHaveBeenCalled();

      firstChild.emitExitWithoutSignal(0);
      await expect(stopPromise).resolves.toBeUndefined();
      await expect(startPromise).resolves.toBeUndefined();
      expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: secondChild.pid });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails start when its child exits before readiness settles', async () => {
    const readiness = createDeferred<LocalProcessReadiness>();
    const child = new FakeUtilityProcess(455, false);
    const adapter = createAdapter({
      probeReadiness: vi.fn(() => readiness.promise),
      recoverStartFailure: vi.fn(async () => ({ action: 'fail' as const })),
    });
    const { runtime } = createRuntime({ adapter, utilityProcesses: [child] });

    const startPromise = runtime.start();
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 1, 'readiness probe');
    child.emitExitWithoutSignal(9);
    readiness.resolve({ status: 'ready' });

    await expect(startPromise).rejects.toThrow('exited unexpectedly');
    expect(runtime.getState()).toMatchObject({ lifecycle: 'error' });
    expect(runtime.getState()).not.toHaveProperty('pid');
  });

  it('ignores a late error event from an old child', async () => {
    const oldChild = new FakeUtilityProcess(456);
    const newChild = new FakeUtilityProcess(457);
    const { runtime } = createRuntime({ utilityProcesses: [oldChild, newChild] });

    await runtime.start();
    await runtime.restart();
    oldChild.emitError('late old child error');

    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: newChild.pid });
    expect(runtime.getState()).not.toHaveProperty('lastError');
  });

  it('joins an in-flight restart instead of aborting it with start', async () => {
    const restartReadiness = createDeferred<LocalProcessReadiness>();
    const firstChild = new FakeUtilityProcess(458);
    const restartChild = new FakeUtilityProcess(459);
    const adapter = createAdapter({
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>()
        .mockResolvedValueOnce({ status: 'ready' })
        .mockImplementationOnce(() => restartReadiness.promise),
    });
    const { runtime, utilityFork } = createRuntime({
      adapter,
      utilityProcesses: [firstChild, restartChild],
    });

    await runtime.start();
    const restartPromise = runtime.restart();
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 2, 'restart readiness probe');
    const startPromise = runtime.start();
    restartReadiness.resolve({ status: 'ready' });

    await expect(restartPromise).resolves.toBeUndefined();
    await expect(startPromise).resolves.toBeUndefined();
    expect(utilityFork).toHaveBeenCalledTimes(2);
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: restartChild.pid });
  });

  it('waits for asynchronous exit after escalating stop to SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeUtilityProcess(460, false);
      child.kill.mockImplementation(() => {
        if (child.kill.mock.calls.length === 2) {
          setTimeout(() => child.emitExitWithoutSignal(0), 1);
        }
        return true;
      });
      const { runtime } = createRuntime({
        utilityProcesses: [child],
        stopTimeoutMs: 10,
      });

      await runtime.start();
      const stopPromise = runtime.stop();
      const stopResult = expect(stopPromise).resolves.toBeUndefined();
      await vi.runAllTimersAsync();

      await stopResult;
      expect(child.kill).toHaveBeenNthCalledWith(1);
      expect(child.kill).toHaveBeenNthCalledWith(2);
      expect(runtime.getState().lifecycle).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a new restart after the previous restart was aborted by stop', async () => {
    const firstRestartReadiness = createDeferred<LocalProcessReadiness>();
    const firstChild = new FakeUtilityProcess(471);
    const firstRestartChild = new FakeUtilityProcess(472);
    const secondRestartChild = new FakeUtilityProcess(473);
    const adapter = createAdapter({
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>()
        .mockResolvedValueOnce({ status: 'ready' })
        .mockImplementationOnce(() => firstRestartReadiness.promise)
        .mockResolvedValue({ status: 'ready' }),
    });
    const { runtime, utilityFork } = createRuntime({
      adapter,
      utilityProcesses: [firstChild, firstRestartChild, secondRestartChild],
    });

    await runtime.start();
    const firstRestart = runtime.restart().catch((error: unknown) => error);
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 2, 'first restart probe');
    await runtime.stop();

    await expect(runtime.restart()).resolves.toBeUndefined();
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: secondRestartChild.pid });
    expect(utilityFork).toHaveBeenCalledTimes(3);

    firstRestartReadiness.resolve({ status: 'ready' });
    expect(await firstRestart).toBeInstanceOf(Error);
  });

  it('rejects an explicit restart child crash without scheduling crash recovery', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
      const restartReadiness = createDeferred<LocalProcessReadiness>();
      const onAutoRestartScheduled = vi.fn<NonNullable<LocalProcessAdapter['onAutoRestartScheduled']>>(
        async () => undefined,
      );
      const adapter = createAdapter({
        probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>()
          .mockResolvedValueOnce({ status: 'ready' })
          .mockImplementationOnce(() => restartReadiness.promise),
        recoverStartFailure: vi.fn(async () => ({ action: 'fail' as const })),
        onAutoRestartScheduled,
      });
      const firstChild = new FakeUtilityProcess(461);
      const restartChild = new FakeUtilityProcess(462, false);
      const thirdChild = new FakeUtilityProcess(463);
      const { runtime, utilityFork } = createRuntime({
        adapter,
        utilityProcesses: [firstChild, restartChild, thirdChild],
        autoRestartOnCrash: true,
        autoRestartBaseDelayMs: 10,
        autoRestartMaxDelayMs: 10,
      });

      await runtime.start();
      const restartPromise = runtime.restart();
      await flushUntil(() => adapter.probeReadiness.mock.calls.length === 2, 'restart readiness probe');
      restartChild.emitExitWithoutSignal(9);
      restartReadiness.resolve({ status: 'error', error: 'readiness aborted after child exit' });

      await expect(restartPromise).rejects.toThrow('exited unexpectedly');
      expect(runtime.getState()).toMatchObject({ lifecycle: 'error' });
      expect(onAutoRestartScheduled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      expect(utilityFork).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an explicit restart failure without scheduling auto-restart', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-07-07T00:00:00.000Z'));
      const prepareLaunch = vi
        .fn<LocalProcessAdapter['prepareLaunch']>()
        .mockResolvedValueOnce(utilityLaunchPlan)
        .mockRejectedValueOnce(new Error('explicit restart prepare failed'));
      const onAutoRestartScheduled = vi.fn<NonNullable<LocalProcessAdapter['onAutoRestartScheduled']>>(
        async () => undefined,
      );
      const adapter = createAdapter({
        prepareLaunch,
        onAutoRestartScheduled,
      });
      const firstChild = new FakeUtilityProcess(501);
      const { runtime } = createRuntime({
        adapter,
        utilityProcesses: [firstChild],
        autoRestartOnCrash: true,
        autoRestartBaseDelayMs: 10,
        autoRestartMaxDelayMs: 10,
        autoRestartMaxAttempts: 5,
      });

      await runtime.start();
      await expect(runtime.restart()).rejects.toThrow('explicit restart prepare failed');

      expect(firstChild.kill).toHaveBeenCalledOnce();
      expect(runtime.getState()).toMatchObject({
        lifecycle: 'error',
        lastError: 'explicit restart prepare failed',
      });
      expect(runtime.getState()).not.toHaveProperty('pid');
      expect(onAutoRestartScheduled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_000);
      await flushMicrotasks();

      expect(prepareLaunch).toHaveBeenCalledTimes(2);
      expect(runtime.getState().lifecycle).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });
});
