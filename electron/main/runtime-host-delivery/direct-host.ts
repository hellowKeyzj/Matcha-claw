import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import {
  RuntimeHostControlClient,
  RuntimeHostControlError,
  type RuntimeHostControlCommand,
  type RuntimeHostControlCommandOptions,
  type RuntimeHostControlInput,
  type RuntimeHostControlOutcome,
  type RuntimeHostControlOutput,
  type RuntimeHostSafeEvent,
} from './control';

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const MAX_READY_TIMEOUT_MS = 2_147_483_647;
const MAX_LAUNCH_STDERR_BYTES = 4_096;

export interface DirectRuntimeHostLaunch {
  readonly executablePath: string;
  readonly workingDirectory: string;
  /** Exact bootstrap payload bytes from the delivery bootstrap builder. */
  readonly bootstrapBytes: Uint8Array;
  readonly environment: Readonly<Record<string, string>>;
}

export type DirectRuntimeHostSpawnOptions = Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  shell: false;
  stdio: 'pipe';
}>;

export interface DirectRuntimeHostChild {
  readonly pid?: number;
  readonly stdin: RuntimeHostControlInput & {
    end(): void;
  };
  readonly stdout: RuntimeHostControlOutput;
  readonly stderr: RuntimeHostControlOutput;
  readonly kill: (signal: NodeJS.Signals) => boolean;
  readonly once: {
    (event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    (event: 'error', listener: (error: Error) => void): unknown;
  };
}

export type DirectRuntimeHostSpawner = (
  executablePath: string,
  args: readonly string[],
  options: DirectRuntimeHostSpawnOptions,
) => DirectRuntimeHostChild;

export interface DirectRuntimeHostDependencies {
  readonly spawn?: DirectRuntimeHostSpawner;
  readonly readyTimeoutMs?: number;
}

export type DirectRuntimeHostDeliveryErrorCode =
  | 'SPAWN_FAILED'
  | 'READY_TIMEOUT'
  | 'CHILD_EXITED'
  | 'CHILD_FAILED'
  | 'STOP_FAILED'
  | 'FORCE_TERMINATION_FAILED';

type DirectRuntimeHostLaunchDiagnostic = Readonly<{
  kind: 'child-exited' | 'child-failed';
  stderr: string;
}>;

export class DirectRuntimeHostDeliveryError extends Error {
  constructor(
    readonly code: DirectRuntimeHostDeliveryErrorCode,
    readonly diagnostic?: DirectRuntimeHostLaunchDiagnostic,
  ) {
    super(directRuntimeHostDeliveryErrorMessage(code));
    this.name = 'DirectRuntimeHostDeliveryError';
  }
}

export type DirectRuntimeHostExit =
  | {
    readonly kind: 'exited';
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }
  | {
    readonly kind: 'failed';
  };

export interface DirectRuntimeHost {
  readonly pid?: number;
  readonly command: (
    command: RuntimeHostControlCommand,
    options?: RuntimeHostControlCommandOptions,
  ) => Promise<RuntimeHostControlOutcome>;
  readonly onSafeEvent: (handler: (event: RuntimeHostSafeEvent) => void) => () => void;
  readonly onExit: (handler: (exit: DirectRuntimeHostExit) => void) => () => void;
  readonly readE2ECronProviderTrace: () => readonly string[];
  readonly stop: () => Promise<void>;
  readonly forceKill: () => Promise<void>;
}

type ChildExitMonitor = {
  readonly completion: Promise<DirectRuntimeHostExit>;
  readonly isFinished: () => boolean;
  readonly launchError: (exit: DirectRuntimeHostExit) => DirectRuntimeHostDeliveryError;
  readonly controlFailure: () => DirectRuntimeHostDeliveryError;
  readonly readyTimeout: () => DirectRuntimeHostDeliveryError;
  readonly onExit: (handler: (exit: DirectRuntimeHostExit) => void) => () => void;
};

const directRuntimeHostSpawn: DirectRuntimeHostSpawner = (
  executablePath,
  args,
  options,
): ChildProcessWithoutNullStreams => spawn(executablePath, args, options);

export async function launchDirectRuntimeHost(
  launch: DirectRuntimeHostLaunch,
  dependencies: DirectRuntimeHostDependencies = {},
): Promise<DirectRuntimeHost> {
  const readyTimeoutMs = resolveReadyTimeoutMs(dependencies.readyTimeoutMs);
  const child = spawnDirectRuntimeHost(launch, dependencies.spawn ?? directRuntimeHostSpawn);
  console.info('[startup-trace]', {
    source: 'runtime-host',
    phase: 'spawn',
    detail: 'process spawned',
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  });
  const stderr = captureLaunchStderr(child.stderr);
  streamRuntimeHostStartupTrace(child.stderr);
  const cronProviderTrace = captureE2ECronProviderTrace(child.stderr);
  const exit = monitorChildExit(child, stderr);
  const controlClient = new RuntimeHostControlClient({
    stdin: child.stdin,
    stdout: child.stdout,
  });
  void exit.completion.then(
    () => controlClient.close(),
    () => controlClient.close(),
  );

  try {
    await writeBootstrapFrame(child.stdin, frameBootstrapBytes(launch.bootstrapBytes));
    await waitUntilReady(controlClient, exit, readyTimeoutMs);
    console.info('[startup-trace]', {
      source: 'runtime-host',
      phase: 'ready',
      detail: 'control channel ready',
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    });
  } catch (error) {
    await terminateFailedLaunch(child, exit);
    if (error instanceof DirectRuntimeHostDeliveryError) throw error;
    if (error instanceof RuntimeHostControlError) throw exit.controlFailure();
    throw new DirectRuntimeHostDeliveryError('CHILD_FAILED');
  }

  let gracefulStop: Promise<void> | undefined;
  let forceTermination: Promise<void> | undefined;

  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    command: (command, options) => controlClient.command(command, options),
    onSafeEvent: (handler) => controlClient.onSafeEvent(handler),
    onExit: (handler) => exit.onExit(handler),
    readE2ECronProviderTrace: cronProviderTrace,
    stop: () => {
      if (forceTermination) return forceTermination;
      gracefulStop ??= stopDirectRuntimeHost(child, exit);
      return gracefulStop;
    },
    forceKill: () => {
      forceTermination ??= forceTerminateDirectRuntimeHost(child, exit);
      return forceTermination;
    },
  };
}

function spawnDirectRuntimeHost(
  launch: DirectRuntimeHostLaunch,
  createChild: DirectRuntimeHostSpawner,
): DirectRuntimeHostChild {
  try {
    return createChild(launch.executablePath, [], {
      cwd: launch.workingDirectory,
      env: buildDirectRuntimeHostEnvironment(launch.environment),
      shell: false,
      stdio: 'pipe',
    });
  } catch {
    console.info('[startup-trace]', {
      source: 'runtime-host',
      phase: 'spawn',
      detail: 'process spawn failed',
    });
    throw new DirectRuntimeHostDeliveryError('SPAWN_FAILED');
  }
}

function buildDirectRuntimeHostEnvironment(
  environment: DirectRuntimeHostLaunch['environment'],
): Readonly<Record<string, string>> {
  const inheritedEnvironment: Record<string, string> = {};
  const launchEnvironmentNames = new Set(Object.keys(environment).map(normalizeEnvironmentName));
  for (const [name, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !launchEnvironmentNames.has(normalizeEnvironmentName(name))) {
      inheritedEnvironment[name] = value;
    }
  }
  return { ...inheritedEnvironment, ...environment };
}

function normalizeEnvironmentName(name: string): string {
  return process.platform === 'win32' ? name.toUpperCase() : name;
}

function monitorChildExit(
  child: DirectRuntimeHostChild,
  stderr: () => string,
): ChildExitMonitor {
  let finished = false;
  let observed: DirectRuntimeHostExit | undefined;
  const listeners = new Set<(exit: DirectRuntimeHostExit) => void>();
  let resolveCompletion: (exit: DirectRuntimeHostExit) => void = () => {};
  const completion = new Promise<DirectRuntimeHostExit>((resolve) => {
    resolveCompletion = resolve;
  });
  const finish = (exit: DirectRuntimeHostExit): void => {
    if (finished) return;

    finished = true;
    observed = exit;
    resolveCompletion(exit);
    for (const listener of listeners) listener(exit);
    listeners.clear();
  };
  child.once('exit', (code, signal) => {
    const abnormalExit = code !== 0 || signal !== null;
    console.info('[startup-trace]', {
      source: 'runtime-host',
      phase: 'exit',
      detail: 'process exited',
      code,
      signal,
      ...(abnormalExit ? { stderr: stderr() } : {}),
    });
    finish({ kind: 'exited', code, signal });
  });
  child.once('error', () => {
    console.info('[startup-trace]', {
      source: 'runtime-host',
      phase: 'exit',
      detail: 'process failed',
    });
    finish({ kind: 'failed' });
  });
  return {
    completion,
    isFinished: () => finished,
    launchError: (completion) => new DirectRuntimeHostDeliveryError(
      completion.kind === 'exited' ? 'CHILD_EXITED' : 'CHILD_FAILED',
      {
        kind: completion.kind === 'exited' ? 'child-exited' : 'child-failed',
        stderr: stderr(),
      },
    ),
    controlFailure: () => new DirectRuntimeHostDeliveryError('CHILD_FAILED', {
      kind: 'child-failed',
      stderr: stderr(),
    }),
    readyTimeout: () => new DirectRuntimeHostDeliveryError('READY_TIMEOUT', {
      kind: 'child-failed',
      stderr: stderr(),
    }),
    onExit: (handler) => {
      if (observed) {
        handler(observed);
        return () => {};
      }
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
}

async function terminateFailedLaunch(
  child: DirectRuntimeHostChild,
  exit: ChildExitMonitor,
): Promise<void> {
  if (exit.isFinished()) return;

  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  try {
    await exit.completion;
  } catch {
    return;
  }
}

async function stopDirectRuntimeHost(
  child: DirectRuntimeHostChild,
  exit: ChildExitMonitor,
): Promise<void> {
  try {
    if (!exit.isFinished()) child.stdin.end();
    const completion = await exit.completion;
    if (completion.kind !== 'exited' || completion.code !== 0 || completion.signal !== null) {
      throw new DirectRuntimeHostDeliveryError('STOP_FAILED');
    }
  } catch (error) {
    if (error instanceof DirectRuntimeHostDeliveryError) throw error;
    throw new DirectRuntimeHostDeliveryError('STOP_FAILED');
  }
}

async function forceTerminateDirectRuntimeHost(
  child: DirectRuntimeHostChild,
  exit: ChildExitMonitor,
): Promise<void> {
  try {
    if (!exit.isFinished()) child.kill('SIGKILL');
    if ((await exit.completion).kind !== 'exited') {
      throw new DirectRuntimeHostDeliveryError('FORCE_TERMINATION_FAILED');
    }
  } catch (error) {
    if (error instanceof DirectRuntimeHostDeliveryError) throw error;
    throw new DirectRuntimeHostDeliveryError('FORCE_TERMINATION_FAILED');
  }
}

function writeBootstrapFrame(input: RuntimeHostControlInput, frame: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      input.write(frame, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function waitUntilReady(
  controlClient: RuntimeHostControlClient,
  exit: ChildExitMonitor,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopWaitingForReady: (() => void) | undefined;
    let stopWaitingForDisconnect: (() => void) | undefined;
    let stopWaitingForExit: (() => void) | undefined;
    const timer = setTimeout(() => {
      rejectWhenPending(exit.readyTimeout());
    }, timeoutMs);
    const resolveWhenReady = (): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      stopWaitingForReady?.();
      stopWaitingForDisconnect?.();
      stopWaitingForExit?.();
      resolve();
    };
    const rejectWhenPending = (error: Error): void => {
      if (settled) return;

      settled = true;
      clearTimeout(timer);
      stopWaitingForReady?.();
      stopWaitingForDisconnect?.();
      stopWaitingForExit?.();
      reject(error);
    };

    stopWaitingForExit = exit.onExit((completion) => {
      rejectWhenPending(exit.launchError(completion));
    });
    if (settled) {
      stopWaitingForExit();
      return;
    }

    stopWaitingForDisconnect = controlClient.onDisconnect(rejectWhenPending);
    if (settled) {
      stopWaitingForDisconnect();
      return;
    }

    stopWaitingForReady = controlClient.onReady(resolveWhenReady);
    if (settled) {
      stopWaitingForReady();
    }
  });
}

function captureLaunchStderr(output: RuntimeHostControlOutput): () => string {
  let captured = '';
  output.on('data', (chunk: unknown) => {
    if (captured.length >= MAX_LAUNCH_STDERR_BYTES) return;
    captured += Buffer.from(chunk as Uint8Array).toString('utf8').slice(0, MAX_LAUNCH_STDERR_BYTES - captured.length);
  });
  return () => redactLaunchStderr(captured);
}

function streamRuntimeHostStartupTrace(output: RuntimeHostControlOutput): void {
  let buffered = '';
  output.on('data', (chunk: unknown) => {
    buffered += Buffer.from(chunk as Uint8Array).toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      if (line.includes('[startup-trace]') || line.includes('"prefix":"session-trace"')) {
        const trace = /^\[startup-trace\] source=openclaw-channel traceId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?= )/i.exec(line);
        console.info(trace
          ? `${trace[0]}${redactLaunchStderr(line.slice(trace[0].length))}`
          : redactLaunchStderr(line));
      }
    }
  });
}

function captureE2ECronProviderTrace(output: RuntimeHostControlOutput): () => readonly string[] {
  const entries: string[] = [];
  let pending = '';
  output.on('data', (chunk: unknown) => {
    pending += Buffer.from(chunk as Uint8Array).toString('utf8');
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^\[DEBUG-cron-provider\] ([A-Za-z_]+)=([A-Za-z_]+)$/.exec(line);
      if (!match) continue;
      entries.push(`${match[1]}=${match[2]}`);
      if (entries.length > 12) entries.shift();
    }
  });
  return () => [...entries];
}

function redactLaunchStderr(value: string): string {
  return value
    .replace(/(token|authorization|secret|password)=\S+/gi, '$1=[REDACTED]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[REDACTED]');
}

function resolveReadyTimeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_READY_TIMEOUT_MS;
  if (Number.isSafeInteger(value) && value > 0 && value <= MAX_READY_TIMEOUT_MS) return value;
  throw new RangeError(`readyTimeoutMs must be a positive safe integer no greater than ${MAX_READY_TIMEOUT_MS}`);
}

function frameBootstrapBytes(bootstrapBytes: Uint8Array): Uint8Array {
  const lengthPrefixBytes = 4;
  const frame = new Uint8Array(lengthPrefixBytes + bootstrapBytes.byteLength);
  new DataView(frame.buffer).setUint32(0, bootstrapBytes.byteLength);
  frame.set(bootstrapBytes, lengthPrefixBytes);
  return frame;
}

function directRuntimeHostDeliveryErrorMessage(code: DirectRuntimeHostDeliveryErrorCode): string {
  switch (code) {
    case 'SPAWN_FAILED':
      return 'Runtime-host process could not be started.';
    case 'READY_TIMEOUT':
      return 'Runtime-host process did not become ready.';
    case 'CHILD_EXITED':
      return 'Runtime-host process exited before readiness.';
    case 'CHILD_FAILED':
      return 'Runtime-host process failed.';
    case 'STOP_FAILED':
      return 'Runtime-host process did not stop cleanly.';
    case 'FORCE_TERMINATION_FAILED':
      return 'Runtime-host process could not be force-terminated.';
  }
}
