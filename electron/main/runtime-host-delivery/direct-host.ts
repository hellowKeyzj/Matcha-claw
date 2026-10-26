import { logger } from '../../utils/logger';
import { traceDebug, isTraceEnabled } from '../../utils/trace-logger';
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
import { createRuntimeHostProcessScope, type RuntimeHostProcessScope } from './process-scope';
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const MAX_READY_TIMEOUT_MS = 2_147_483_647;
const MAX_STDERR_CODE_UNITS = 4_096;

export interface DirectRuntimeHostLaunch {
  readonly executablePath: string;
  readonly workingDirectory: string;
  /** Exact bootstrap payload bytes from the delivery bootstrap builder. */
  readonly bootstrapBytes: Uint8Array;
  readonly environment: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly onSpawn?: (host: DirectRuntimeHost, closed: Promise<void>) => void;
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
  readonly on: (event: 'error', listener: (error: Error) => void) => unknown;
  readonly once: (event: 'exit' | 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void) => unknown;
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
  | 'LAUNCH_ABORTED'
  | 'PROCESS_SCOPE_FAILED'
  | 'PROCESS_TREE_UNCONFIRMED'
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
    readonly startupFailure?: 'provider-migration-failed',
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
  readonly onDisconnect: (handler: (error: RuntimeHostControlError) => void) => () => void;
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
  if (launch.signal?.aborted) throw new DirectRuntimeHostDeliveryError('LAUNCH_ABORTED');
  const child = spawnDirectRuntimeHost(launch, dependencies.spawn ?? directRuntimeHostSpawn);
  traceDebug(() => ['[startup-trace]', {
    source: 'runtime-host',
    phase: 'spawn',
    detail: 'process spawned',
    ...(child.pid === undefined ? {} : { pid: child.pid }),
  }]);
  const stderr = captureLaunchStderr(child.stderr);
  streamWorldStoreDiagnostics(child.stderr);
  streamRuntimeHostStartupTrace(child.stderr);
  const cronProviderTrace = captureE2ECronProviderTrace(child.stderr);
  const controlClient = new RuntimeHostControlClient({
    stdin: child.stdin,
    stdout: child.stdout,
  });
  const exit = monitorChildExit(child, stderr, () => controlClient.close());
  // Publish disconnect before lifecycle observers detach this child's subscriptions.
  exit.onExit(() => controlClient.close());

  let processScope: RuntimeHostProcessScope | undefined;
  let gracefulStop: Promise<void> | undefined;
  let forceTermination: Promise<void> | undefined;
  const closed = exit.completion.then(async () => {
    if (!processScope) return;
    await processScope.close();
    logger.info('[RuntimeHost] process scope closed:', { pid: child.pid, activeProcesses: 0 });
  });
  void closed.catch(() => undefined);
  const host: DirectRuntimeHost = {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    command: (command, options) => controlClient.command(command, options),
    onSafeEvent: (handler) => controlClient.onSafeEvent(handler),
    onDisconnect: (handler) => controlClient.onDisconnect(handler),
    onExit: (handler) => exit.onExit(handler),
    readE2ECronProviderTrace: cronProviderTrace,
    stop: () => {
      controlClient.close();
      if (forceTermination) return forceTermination;
      gracefulStop ??= (async () => {
        try { await stopDirectRuntimeHost(child, exit); }
        finally { await closed; }
      })();
      return gracefulStop;
    },
    forceKill: () => {
      controlClient.close();
      forceTermination ??= (async () => {
        if (processScope) await processScope.terminate();
        await forceTerminateDirectRuntimeHost(child, exit);
        await closed;
        if (!dependencies.spawn && process.platform !== 'win32') {
          throw new DirectRuntimeHostDeliveryError('PROCESS_TREE_UNCONFIRMED');
        }
      })();
      return forceTermination;
    },
  };
  launch.onSpawn?.(host, closed);

  try {
    if (!dependencies.spawn && process.platform === 'win32' && child.pid !== undefined) {
      try { processScope = createRuntimeHostProcessScope(child.pid, launch.executablePath); }
      catch (error) {
        logger.error('[RuntimeHost] process scope setup failed:', error);
        throw new DirectRuntimeHostDeliveryError('PROCESS_SCOPE_FAILED');
      }
    }
    await writeBootstrapFrame(child.stdin, frameBootstrapBytes(launch.bootstrapBytes));
    await waitUntilReady(controlClient, exit, readyTimeoutMs, stderr.markReady);
    traceDebug(() => ['[startup-trace]', {
      source: 'runtime-host',
      phase: 'ready',
      detail: 'control channel ready',
      ...(child.pid === undefined ? {} : { pid: child.pid }),
    }]);
  } catch (error) {
    controlClient.close();
    await processScope?.terminate();
    await terminateFailedLaunch(child, exit);
    await closed;
    if (error instanceof DirectRuntimeHostDeliveryError) {
      if (!error.diagnostic) throw error;
      throw new DirectRuntimeHostDeliveryError(error.code, {
        kind: error.diagnostic.kind,
        stderr: stderr.read(),
      }, error.startupFailure);
    }
    if (error instanceof RuntimeHostControlError) {
      if (error.kind === 'provider-migration-failed') {
        throw new DirectRuntimeHostDeliveryError('CHILD_FAILED', undefined, error.kind);
      }
      throw exit.controlFailure();
    }
    throw new DirectRuntimeHostDeliveryError('CHILD_FAILED');
  }

  return host;
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
    traceDebug(() => ['[startup-trace]', {
      source: 'runtime-host',
      phase: 'spawn',
      detail: 'process spawn failed',
    }]);
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
  stderr: ReturnType<typeof captureLaunchStderr>,
  onError: () => void,
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
    for (const listener of listeners) listener(exit);
    listeners.clear();
  };
  child.once('exit', (code, signal) => {
    traceDebug(() => ['[startup-trace]', {
      source: 'runtime-host',
      phase: 'exit',
      detail: 'process exited',
      code,
      signal,
    }]);
    finish({ kind: 'exited', code, signal });
  });
  child.on('error', () => {
    traceDebug(() => ['[startup-trace]', {
      source: 'runtime-host',
      phase: 'exit',
      detail: 'process failed',
    }]);
    onError();
  });
  child.once('close', (code, signal) => {
    const completion: DirectRuntimeHostExit = child.pid === undefined
      ? { kind: 'failed' }
      : { kind: 'exited', code, signal };
    if (stderr.isReady() && (code !== 0 || signal !== null)) {
      logger.error('[RuntimeHost] process exit diagnostic:', {
        code,
        signal,
        stderr: stderr.read(),
      });
    }
    finish(completion);
    resolveCompletion(completion);
  });
  return {
    completion,
    isFinished: () => finished,
    launchError: (completion) => new DirectRuntimeHostDeliveryError(
      completion.kind === 'exited' ? 'CHILD_EXITED' : 'CHILD_FAILED',
      {
        kind: completion.kind === 'exited' ? 'child-exited' : 'child-failed',
        stderr: stderr.read(),
      },
    ),
    controlFailure: () => new DirectRuntimeHostDeliveryError('CHILD_FAILED', {
      kind: 'child-failed',
      stderr: stderr.read(),
    }),
    readyTimeout: () => new DirectRuntimeHostDeliveryError('READY_TIMEOUT', {
      kind: 'child-failed',
      stderr: stderr.read(),
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
  if (exit.isFinished() || child.pid === undefined) {
    await exit.completion;
    return;
  }

  try {
    child.kill('SIGKILL');
  } catch {
    // A failed kill is not evidence that the child's stdio has drained.
  }
  await exit.completion;
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
  onReady: () => void,
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
      onReady();
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

    stopWaitingForDisconnect = controlClient.onDisconnect((error) => {
      if (!exit.isFinished()) rejectWhenPending(error);
    });
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

function captureLaunchStderr(output: RuntimeHostControlOutput) {
  let captured = '';
  let ready = false;
  let startsAtLineStart = true;
  let endsAtLineStart = true;
  output.on('data', (chunk: unknown) => {
    const text = Buffer.from(chunk as Uint8Array).toString('utf8');
    if (!ready) {
      captured += text.slice(0, MAX_STDERR_CODE_UNITS - captured.length);
    } else {
      const combined = captured + text;
      const offset = Math.max(0, combined.length - MAX_STDERR_CODE_UNITS);
      if (offset > 0) startsAtLineStart = combined[offset - 1] === '\n';
      captured = combined.slice(offset);
    }
    if (text.length > 0) endsAtLineStart = text.endsWith('\n');
  });
  return {
    markReady: () => {
      ready = true;
      captured = '';
      startsAtLineStart = endsAtLineStart;
    },
    isReady: () => ready,
    read: () => {
      const newline = ready && !startsAtLineStart ? captured.indexOf('\n') : -1;
      const value = ready && !startsAtLineStart
        ? (newline === -1 ? '' : captured.slice(newline + 1))
        : captured;
      const redacted = redactLaunchStderr(value);
      return ready
        ? redacted.slice(-MAX_STDERR_CODE_UNITS)
        : redacted.slice(0, MAX_STDERR_CODE_UNITS);
    },
  };
}

function streamWorldStoreDiagnostics(output: RuntimeHostControlOutput): void {
  let buffered = '';
  let discarding = false;
  output.on('data', (chunk: unknown) => {
    const fragments = Buffer.from(chunk as Uint8Array).toString('utf8').split('\n');
    for (let index = 0; index < fragments.length; index++) {
      if (!discarding) {
        if (buffered.length + fragments[index].length > 8192) {
          buffered = '';
          discarding = true;
        } else buffered += fragments[index];
      }
      if (index === fragments.length - 1) continue;
      if (!discarding && buffered.startsWith('{') && buffered.includes('"world-store-diagnostic"')) {
        try { logWorldStoreDiagnostic(JSON.parse(buffered)); } catch { /* Non-diagnostic stderr is not a log payload. */ }
      }
      buffered = '';
      discarding = false;
    }
  });
}

function logWorldStoreDiagnostic(value: unknown): void {
  const object = (item: unknown): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item);
  const identifier = (item: unknown): item is string => typeof item === 'string' && /^store-[0-9]{1,10}-[0-9]{1,20}$/.test(item);
  const code = (item: unknown): item is string => typeof item === 'string' && /^world\.[a-z_]{1,96}$/.test(item);
  const stage = (item: unknown): item is string => typeof item === 'string' && ['decode', 'admission', 'read', 'parse', 'generate', 'resolve', 'validate', 'compile', 'prepare', 'execute', 'verify', 'commit', 'activate', 'migrate', 'drain', 'stop', 'recover', 'disclose'].includes(item);
  if (!object(value) || value.prefix !== 'world-store-diagnostic' || !identifier(value.diagnosticId)
    || !code(value.code) || !stage(value.stage) || !Array.isArray(value.causes) || value.causes.length > 8) return;
  const causes: Record<string, unknown>[] = [];
  for (const cause of value.causes) {
    if (!object(cause)) return;
    if (cause.kind === 'store' && identifier(cause.diagnosticId) && code(cause.code) && stage(cause.stage)) {
      causes.push({ kind: cause.kind, diagnosticId: cause.diagnosticId, code: cause.code, stage: cause.stage });
    } else if (cause.kind === 'postgres' && typeof cause.closed === 'boolean'
      && (cause.sqlstate === null || (typeof cause.sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(cause.sqlstate)))) {
      causes.push({ kind: cause.kind, sqlstate: cause.sqlstate, closed: cause.closed });
    } else if (typeof cause.kind === 'string' && ['io_connection_refused', 'io_connection_reset', 'io_connection_aborted', 'io_not_connected', 'io_timed_out', 'io_permission_denied', 'io_other', 'pool_closed', 'pool_timeout', 'pool_backend', 'pool_other', 'timeout', 'postgres_parameter_type', 'json', 'unclassified'].includes(cause.kind)) {
      causes.push({ kind: cause.kind });
    } else return;
  }
  logger.warn('[World] Storage diagnostic', { diagnosticId: value.diagnosticId, code: value.code, stage: value.stage, causes });
}

function streamRuntimeHostStartupTrace(output: RuntimeHostControlOutput): void {
  if (!isTraceEnabled()) return;
  let buffered = '';
  output.on('data', (chunk: unknown) => {
    if (!isTraceEnabled()) return;
    buffered += Buffer.from(chunk as Uint8Array).toString('utf8');
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? '';
    for (const line of lines) {
      const sessionTrace = line.includes('"prefix":"session-trace"');
      if (!sessionTrace && !line.includes('[startup-trace]')) continue;
      traceDebug(() => {
        const trace = /^\[startup-trace\] source=openclaw-channel traceId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?= )/i.exec(line);
        return trace
          ? `${trace[0]}${redactLaunchStderr(line.slice(trace[0].length))}`
          : redactLaunchStderr(line, sessionTrace);
      });
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

function redactLaunchStderr(value: string, preserveSessionTrace = false): string {
  const sanitized = value.replace(/(token|authorization|secret|password)=\S+/gi, '$1=[REDACTED]');
  const trace = preserveSessionTrace
    ? /"traceId":"session-trace:[A-Za-z0-9_.:-]{1,128}:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i.exec(sanitized)
    : null;
  const traceOffset = trace ? trace.index + trace[0].length - trace[1].length - 1 : -1;
  return sanitized.replace(/[A-Za-z0-9_-]{32,}/g, (match, offset: number) => (
    offset === traceOffset && match === trace?.[1] ? match : '[REDACTED]'
  ));
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
    case 'LAUNCH_ABORTED':
      return 'Runtime-host launch was cancelled during application shutdown.';
    case 'PROCESS_SCOPE_FAILED':
      return 'Runtime-host process tree could not be contained.';
    case 'PROCESS_TREE_UNCONFIRMED':
      return 'Runtime-host exited but descendant termination could not be confirmed on this platform.';
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
