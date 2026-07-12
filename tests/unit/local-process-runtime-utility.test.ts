import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LocalProcessRuntime } from '../../electron/main/process-runtime/local-process-runtime';
import type {
  LocalProcessAdapter,
  LocalProcessLaunchPlan,
  LocalProcessLogger,
  LocalProcessRuntimeOptions,
  LocalProcessUtilityLauncher,
  LocalProcessUtilityProcess,
} from '../../electron/main/process-runtime/contracts';

class FakeUtilityProcess implements LocalProcessUtilityProcess {
  private readonly emitter = new EventEmitter();

  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(readonly pid: number) {}

  kill(): boolean {
    this.emitter.emit('exit', 0);
    return true;
  }

  once(eventName: 'exit', listener: (code: number) => void): this;
  once(eventName: 'error', listener: (type: string, location: string, report: string) => void): this;
  once(
    eventName: 'exit' | 'error',
    listener: ((code: number) => void) | ((type: string, location: string, report: string) => void),
  ): this {
    this.emitter.once(eventName, listener);
    return this;
  }

  on(eventName: 'exit', listener: (code: number) => void): this;
  on(eventName: 'error', listener: (type: string, location: string, report: string) => void): this;
  on(
    eventName: 'exit' | 'error',
    listener: ((code: number) => void) | ((type: string, location: string, report: string) => void),
  ): this {
    this.emitter.on(eventName, listener);
    return this;
  }

  emitStdout(chunk: string | Buffer): void {
    this.stdout.emit('data', chunk);
  }

  emitStderr(chunk: string | Buffer): void {
    this.stderr.emit('data', chunk);
  }

  emitExitWithoutSignal(code: number): void {
    this.emitter.emit('exit', code);
  }

  emitError(type: string, location: string, report: string): void {
    this.emitter.emit('error', type, location, report);
  }
}

const modulePath = 'E:/matcha/runtime-host/utility-entry.js';
const launchArgs = ['--runtime-host', '--port=51234'];
const launchEnv = {
  MATCHA_RUNTIME_MODE: 'utility',
  MATCHA_RUNTIME_PORT: '51234',
} satisfies NodeJS.ProcessEnv;

const utilityLaunchPlan: LocalProcessLaunchPlan = {
  kind: 'utility',
  command: modulePath,
  args: launchArgs,
  cwd: 'E:/matcha/workspace',
  env: launchEnv,
  stdio: 'pipe',
  serviceName: 'Matcha Local Process Utility',
};

function createLogger(): Required<LocalProcessLogger> {
  return {
    debug: vi.fn<(message: string) => void>(),
    info: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string, error?: unknown) => void>(),
    error: vi.fn<(message: string, error?: unknown) => void>(),
  };
}

function createUtilityAdapter(
  plan: LocalProcessLaunchPlan,
  overrides: Partial<Pick<LocalProcessAdapter, 'classifyLog' | 'onCrashed'>> = {},
): LocalProcessAdapter {
  return {
    id: 'utility-runtime',
    displayName: 'Utility Runtime',
    prepareLaunch: vi.fn<LocalProcessAdapter['prepareLaunch']>(async () => plan),
    probeReadiness: vi.fn<LocalProcessAdapter['probeReadiness']>(async () => ({ status: 'ready' })),
    ...overrides,
  };
}

function createRuntime(options: {
  readonly adapter?: LocalProcessAdapter;
  readonly logger?: Required<LocalProcessLogger>;
  readonly utilityProcess?: FakeUtilityProcess;
} = {}): {
  readonly runtime: LocalProcessRuntime;
  readonly adapter: LocalProcessAdapter;
  readonly logger: Required<LocalProcessLogger>;
  readonly utilityFork: ReturnType<typeof vi.fn<LocalProcessUtilityLauncher['fork']>>;
  readonly utilityProcess: FakeUtilityProcess;
} {
  const adapter = options.adapter ?? createUtilityAdapter(utilityLaunchPlan);
  const logger = options.logger ?? createLogger();
  const utilityProcess = options.utilityProcess ?? new FakeUtilityProcess(42_424);
  const utilityFork = vi.fn<LocalProcessUtilityLauncher['fork']>(() => utilityProcess);
  const utilityLauncher = { fork: utilityFork } satisfies LocalProcessUtilityLauncher;
  const runtimeOptions = {
    adapter,
    logger,
    utilityLauncher,
    autoRestartOnCrash: false,
    startTimeoutMs: 100,
    stopTimeoutMs: 10,
  } satisfies LocalProcessRuntimeOptions;

  return {
    runtime: new LocalProcessRuntime(runtimeOptions),
    adapter,
    logger,
    utilityFork,
    utilityProcess,
  };
}

describe('LocalProcessRuntime utility launch kind', () => {
  it('launches utility plans through the injected launcher and keeps the pid in running state', async () => {
    const { runtime, utilityFork, utilityProcess } = createRuntime();

    await runtime.start();

    expect(utilityFork).toHaveBeenCalledOnce();
    expect(utilityFork).toHaveBeenCalledWith(modulePath, launchArgs, {
      cwd: utilityLaunchPlan.cwd,
      env: launchEnv,
      stdio: 'pipe',
      serviceName: 'Matcha Local Process Utility',
    });
    expect(runtime.getState()).toMatchObject({
      id: 'utility-runtime',
      displayName: 'Utility Runtime',
      lifecycle: 'running',
      pid: utilityProcess.pid,
    });
    await expect(runtime.checkReadiness()).resolves.toEqual({ status: 'ready' });
  });

  it('binds utility stdout and stderr to log tail classification and logger output', async () => {
    const logger = createLogger();
    const classifyLog = vi.fn<NonNullable<LocalProcessAdapter['classifyLog']>>((line, stream) => ({
      level: stream === 'stderr' ? 'error' : 'info',
      message: `${stream}:${line}`,
    }));
    const adapter = createUtilityAdapter(utilityLaunchPlan, { classifyLog });
    const { runtime, utilityProcess } = createRuntime({ adapter, logger });

    await runtime.start();
    utilityProcess.emitStdout(Buffer.from('ready from stdout\n'));
    utilityProcess.emitStderr('warn from stderr\n');

    expect(classifyLog).toHaveBeenCalledWith('ready from stdout', 'stdout');
    expect(logger.info).toHaveBeenCalledWith('[Utility Runtime] stdout:ready from stdout');
    expect(classifyLog).toHaveBeenCalledWith('warn from stderr', 'stderr');
    expect(logger.error).toHaveBeenCalledWith('[Utility Runtime:stderr] stderr:warn from stderr');
  });

  it('does not write process output when the adapter drops a classified log line', async () => {
    const logger = createLogger();
    const classifyLog = vi.fn<NonNullable<LocalProcessAdapter['classifyLog']>>(() => ({
      level: 'drop',
      message: 'dropped',
    }));
    const adapter = createUtilityAdapter(utilityLaunchPlan, { classifyLog });
    const { runtime, utilityProcess } = createRuntime({ adapter, logger });

    await runtime.start();
    utilityProcess.emitStdout(Buffer.from('noisy stdout\n'));
    utilityProcess.emitStderr('noisy stderr\n');

    expect(classifyLog).toHaveBeenCalledWith('noisy stdout', 'stdout');
    expect(classifyLog).toHaveBeenCalledWith('noisy stderr', 'stderr');
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      '[Utility Runtime] utility start requested (module="E:/matcha/runtime-host/utility-entry.js", port=n/a)',
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('marks utility exit without signal as a crash without throwing', async () => {
    const onCrashed = vi.fn<NonNullable<LocalProcessAdapter['onCrashed']>>(async () => undefined);
    const adapter = createUtilityAdapter(utilityLaunchPlan, { onCrashed });
    const { runtime, utilityProcess } = createRuntime({ adapter });

    await runtime.start();

    expect(() => utilityProcess.emitExitWithoutSignal(7)).not.toThrow();
    expect(runtime.getState()).toMatchObject({
      lifecycle: 'error',
      lastError: 'Utility Runtime exited unexpectedly (code=7, signal=null)',
    });
    expect(onCrashed).toHaveBeenCalledWith({
      id: 'utility-runtime',
      displayName: 'Utility Runtime',
      pid: utilityProcess.pid,
      code: 7,
      signal: null,
      message: 'Utility Runtime exited unexpectedly (code=7, signal=null)',
    });
  });

  it('records utility process error events in state and logger error output', async () => {
    const logger = createLogger();
    const { runtime, utilityProcess } = createRuntime({ logger });

    await runtime.start();
    utilityProcess.emitError('launch-failed', 'utility-entry.js', 'utility pipe closed');

    expect(runtime.getState()).toMatchObject({
      lifecycle: 'error',
      lastError: 'Utility Runtime process error: launch-failed utility-entry.js utility pipe closed',
    });
    expect(logger.error).toHaveBeenCalledWith(
      '[Utility Runtime] process error',
      'launch-failed utility-entry.js utility pipe closed',
    );
  });
});
