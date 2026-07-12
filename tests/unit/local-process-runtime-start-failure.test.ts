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

function createRecoverStartFailure(decision: LocalProcessStartFailureRecovery): NonNullable<LocalProcessAdapter['recoverStartFailure']> {
  return vi.fn<NonNullable<LocalProcessAdapter['recoverStartFailure']>>(async () => decision);
}

function createAdapter(overrides: Partial<LocalProcessAdapter> = {}): LocalProcessAdapter {
  return {
    id: 'start-failure-runtime',
    displayName: 'Start Failure Runtime',
    prepareLaunch: vi.fn<LocalProcessAdapter['prepareLaunch']>(async () => utilityLaunchPlan),
    probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(async () => ({ status: 'ready' })),
    ...overrides,
  };
}

function createRuntime(options: {
  readonly adapter?: LocalProcessAdapter;
  readonly utilityProcesses?: FakeUtilityProcess[];
  readonly logger?: Required<LocalProcessLogger>;
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
    autoRestartOnCrash: false,
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

describe('LocalProcessRuntime start failure cleanup recovery', () => {
  it('retries readiness without preparing a new launch when recovery requests keep-current cleanup', async () => {
    const firstChild = new FakeUtilityProcess(501);
    const retryChild = new FakeUtilityProcess(502);
    const recoverStartFailure = createRecoverStartFailure({ action: 'retry', cleanup: 'keep-current' });
    const adapter = createAdapter({
      recoverStartFailure,
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>()
        .mockResolvedValueOnce({ status: 'error', error: 'first readiness failed' })
        .mockResolvedValue({ status: 'ready' }),
    });
    const { runtime, utilityFork } = createRuntime({
      adapter,
      utilityProcesses: [firstChild, retryChild],
    });

    await runtime.start();

    expect(recoverStartFailure).toHaveBeenCalledOnce();
    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(adapter.prepareLaunch).toHaveBeenCalledOnce();
    expect(adapter.probeReadiness).toHaveBeenCalledTimes(2);
    expect(utilityFork).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: firstChild.pid });

    await runtime.stop();
    expect(firstChild.kill).toHaveBeenCalledTimes(1);
    expect(retryChild.kill).not.toHaveBeenCalled();
  });

  it.each([
    ['default cleanup', { action: 'retry' }],
    ['explicit stop-current cleanup', { action: 'retry', cleanup: 'stop-current' }],
  ] satisfies readonly [string, LocalProcessStartFailureRecovery][])('stops the current child before retrying when recovery uses %s', async (_label, recovery) => {
    const firstChild = new FakeUtilityProcess(601);
    const retryChild = new FakeUtilityProcess(602);
    const recoverStartFailure = createRecoverStartFailure(recovery);
    const adapter = createAdapter({
      recoverStartFailure,
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>()
        .mockResolvedValueOnce({ status: 'error', error: 'first readiness failed' })
        .mockResolvedValue({ status: 'ready' }),
    });
    const { runtime, utilityFork } = createRuntime({
      adapter,
      utilityProcesses: [firstChild, retryChild],
    });

    await runtime.start();

    expect(recoverStartFailure).toHaveBeenCalledOnce();
    expect(firstChild.kill).toHaveBeenCalledTimes(1);
    expect(adapter.prepareLaunch).toHaveBeenCalledTimes(2);
    expect(adapter.probeReadiness).toHaveBeenCalledTimes(2);
    expect(utilityFork).toHaveBeenCalledTimes(2);
    expect(runtime.getState()).toMatchObject({ lifecycle: 'running', pid: retryChild.pid });
  });

  it('keeps the current child alive and rejects when recovery fails with keep-current cleanup', async () => {
    const firstChild = new FakeUtilityProcess(701);
    const recoverStartFailure = createRecoverStartFailure({ action: 'fail', cleanup: 'keep-current' });
    const adapter = createAdapter({
      recoverStartFailure,
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(async () => ({
        status: 'error',
        error: 'fatal readiness failed',
      })),
    });
    const { runtime, utilityFork } = createRuntime({
      adapter,
      utilityProcesses: [firstChild],
    });

    await expect(runtime.start()).rejects.toThrow('fatal readiness failed');

    expect(recoverStartFailure).toHaveBeenCalledOnce();
    expect(firstChild.kill).not.toHaveBeenCalled();
    expect(adapter.prepareLaunch).toHaveBeenCalledTimes(1);
    expect(adapter.probeReadiness).toHaveBeenCalledTimes(1);
    expect(utilityFork).toHaveBeenCalledTimes(1);
    expect(runtime.getState()).toMatchObject({
      lifecycle: 'error',
      pid: firstChild.pid,
      lastError: 'fatal readiness failed',
    });
  });

  it('still cleans up the launched child when an in-flight start is aborted', async () => {
    const readiness = createDeferred<LocalProcessReadiness>();
    const firstChild = new FakeUtilityProcess(801);
    const recoverStartFailure = createRecoverStartFailure({ action: 'retry', cleanup: 'keep-current' });
    const adapter = createAdapter({
      recoverStartFailure,
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(() => readiness.promise),
    });
    const { runtime } = createRuntime({
      adapter,
      utilityProcesses: [firstChild],
    });

    const startPromise = runtime.start().catch(() => undefined);
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 1, 'readiness probe');

    await runtime.stop();
    expect(firstChild.kill).toHaveBeenCalledTimes(1);
    expect(recoverStartFailure).not.toHaveBeenCalled();
    expect(runtime.getState().lifecycle).toBe('stopped');

    readiness.resolve({ status: 'ready' });
    await flushMicrotasks();
    await startPromise;

    expect(runtime.getState().lifecycle).toBe('stopped');
  });

  it('aborts deferred readiness and rejects start immediately when the launched child exits', async () => {
    const readinessAborted = createDeferred<void>();
    const child = new FakeUtilityProcess(901, false);
    let readinessSignal: AbortSignal | undefined;
    const adapter = createAdapter({
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>((_plan, { signal }) => {
        readinessSignal = signal;
        return new Promise<LocalProcessReadiness>((resolve) => {
          signal.addEventListener('abort', () => {
            readinessAborted.resolve();
            resolve({ status: 'not-ready', detail: 'readiness probe interrupted' });
          }, { once: true });
        });
      }),
    });
    const { runtime } = createRuntime({
      adapter,
      utilityProcesses: [child],
      startTimeoutMs: 60_000,
    });

    const startPromise = runtime.start();
    void startPromise.catch(() => undefined);
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 1, 'readiness probe');

    child.emitExitWithoutSignal(17);

    await readinessAborted.promise;
    expect(readinessSignal?.aborted).toBe(true);
    await expect(startPromise).rejects.toThrow(
      'Start Failure Runtime exited unexpectedly (code=17, signal=null)',
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('preserves the child-exit error when aborted readiness rejects with AbortError', async () => {
    const readinessAborted = createDeferred<void>();
    const child = new FakeUtilityProcess(902, false);
    const adapter = createAdapter({
      probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>((_plan, { signal }) => {
        return new Promise<LocalProcessReadiness>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            readinessAborted.resolve();
            const error = new Error('readiness probe interrupted');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      }),
    });
    const { runtime } = createRuntime({
      adapter,
      utilityProcesses: [child],
      startTimeoutMs: 60_000,
    });

    const startPromise = runtime.start();
    void startPromise.catch(() => undefined);
    await flushUntil(() => adapter.probeReadiness.mock.calls.length === 1, 'readiness probe');

    child.emitExitWithoutSignal(17);

    await readinessAborted.promise;
    await expect(startPromise).rejects.toThrow(
      'Start Failure Runtime exited unexpectedly (code=17, signal=null)',
    );
    expect(child.kill).not.toHaveBeenCalled();
  });
});
