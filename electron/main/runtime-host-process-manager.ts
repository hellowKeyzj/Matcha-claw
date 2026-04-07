import { fork, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getPort } from '../utils/config';

type RuntimeHostProcessLifecycle = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

interface RuntimeHostProcessHealth {
  readonly ok: boolean;
  readonly lifecycle: string;
  readonly pid?: number;
  readonly uptimeSec?: number;
  readonly error?: string;
}

export interface RuntimeHostProcessState {
  readonly lifecycle: RuntimeHostProcessLifecycle;
  readonly port: number;
  readonly pid?: number;
  readonly lastError?: string;
}

export interface RuntimeHostProcessManager {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly restart: () => Promise<void>;
  readonly checkHealth: () => Promise<RuntimeHostProcessHealth>;
  readonly getState: () => RuntimeHostProcessState;
}

interface RuntimeHostProcessLogger {
  readonly info: (message: string) => void;
  readonly warn: (message: string, error?: unknown) => void;
  readonly error: (message: string, error?: unknown) => void;
}

export interface RuntimeHostProcessManagerOptions {
  readonly scriptPath?: string;
  readonly port?: number;
  readonly startTimeoutMs?: number;
  readonly autoRestartOnCrash?: boolean;
  readonly autoRestartBaseDelayMs?: number;
  readonly autoRestartMaxDelayMs?: number;
  readonly autoRestartWindowMs?: number;
  readonly autoRestartMaxAttempts?: number;
  readonly parentApiBaseUrl: string;
  readonly parentDispatchToken: string;
  readonly childEnv?: () => Record<string, string>;
  readonly logger?: RuntimeHostProcessLogger;
}

const DEFAULT_START_TIMEOUT_MS = 15000;
const HEALTH_PATH = '/health';
const DEFAULT_AUTO_RESTART_BASE_DELAY_MS = 300;
const DEFAULT_AUTO_RESTART_MAX_DELAY_MS = 5000;
const DEFAULT_AUTO_RESTART_WINDOW_MS = 60000;
const DEFAULT_AUTO_RESTART_MAX_ATTEMPTS = 6;
const REBUILD_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function getDefaultScriptPathCandidates(): string[] {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const workspaceCandidates = [
    join(process.cwd(), 'runtime-host', 'host-process.cjs'),
    resolve(__dirname, '../../runtime-host/host-process.cjs'),
    resolve(__dirname, '../../../runtime-host/host-process.cjs'),
  ];
  const packagedCandidates = resourcesPath
    ? [
        join(resourcesPath, 'app.asar', 'runtime-host', 'host-process.cjs'),
        join(resourcesPath, 'runtime-host', 'host-process.cjs'),
      ]
    : [];
  const isElectronDevResources = /node_modules[\\/]+electron[\\/]+dist[\\/]+resources$/i.test(resourcesPath);
  if (isElectronDevResources) {
    return [...workspaceCandidates, ...packagedCandidates];
  }
  return [...packagedCandidates, ...workspaceCandidates];
}

function resolveScriptPath(explicitPath?: string): string | null {
  const candidates = explicitPath ? [explicitPath] : getDefaultScriptPathCandidates();
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveRuntimeHostDirFromScriptPath(scriptPath: string | null): string | null {
  if (!scriptPath) {
    return null;
  }
  const normalized = resolve(scriptPath);
  const scriptDir = dirname(normalized);
  const wrapperEntry = join(scriptDir, 'host-process.cjs');
  if (!existsSync(wrapperEntry)) {
    return null;
  }
  return scriptDir;
}

function resolveProjectRootForRuntimeHostBuild(): string | null {
  const candidates = [
    resolve(__dirname, '../..'),
    resolve(__dirname, '../../..'),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    const packageJsonPath = join(candidate, 'package.json');
    const buildScriptPath = join(candidate, 'scripts', 'build-runtime-host-process.mjs');
    if (existsSync(packageJsonPath) && existsSync(buildScriptPath)) {
      return candidate;
    }
  }
  return null;
}

function collectLatestMtimeMs(rootDir: string, options?: {
  skipDir?: (dirPath: string) => boolean;
  skipFile?: (filePath: string) => boolean;
}): number {
  if (!existsSync(rootDir)) {
    return 0;
  }

  let latest = 0;
  const queue: string[] = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }
    const entries = readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (options?.skipDir?.(fullPath)) {
          continue;
        }
        queue.push(fullPath);
        continue;
      }
      if (options?.skipFile?.(fullPath)) {
        continue;
      }
      const mtimeMs = statSync(fullPath).mtimeMs;
      if (mtimeMs > latest) {
        latest = mtimeMs;
      }
    }
  }
  return latest;
}

function runtimeHostBuildArtifactStale(runtimeHostDir: string): boolean {
  const buildDir = join(runtimeHostDir, 'build');
  const buildMain = join(buildDir, 'main.js');
  if (!existsSync(buildMain)) {
    return true;
  }

  const latestSourceMtime = collectLatestMtimeMs(runtimeHostDir, {
    skipDir: (dirPath) => dirPath === buildDir,
    skipFile: (filePath) => filePath.endsWith('host-process.cjs'),
  });
  const latestBuildMtime = collectLatestMtimeMs(buildDir);
  return latestSourceMtime > latestBuildMtime;
}

function shouldAutoRebuildRuntimeHost(scriptPath: string | null, explicitScriptPath?: string): boolean {
  if (explicitScriptPath) {
    return false;
  }
  if (process.env.VITEST) {
    return false;
  }
  const runtimeHostDir = resolveRuntimeHostDirFromScriptPath(scriptPath);
  if (!runtimeHostDir) {
    return false;
  }
  return true;
}

function normalizeProcessOutputChunk(output: string | Buffer | null | undefined): string[] {
  const raw = typeof output === 'string'
    ? output
    : Buffer.isBuffer(output)
      ? output.toString('utf8')
      : '';
  if (!raw) {
    return [];
  }
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
}

function logRebuildOutput(
  logger: RuntimeHostProcessLogger | undefined,
  stream: 'stdout' | 'stderr',
  output: string | Buffer | null | undefined,
): void {
  const lines = normalizeProcessOutputChunk(output);
  for (const line of lines) {
    if (stream === 'stderr') {
      logger?.warn?.(`[runtime-host-child:build:stderr] ${line}`);
      continue;
    }
    logger?.info?.(`[runtime-host-child:build] ${line}`);
  }
}

function rebuildRuntimeHostProcess(logger?: RuntimeHostProcessLogger): void {
  logger?.info?.('[runtime-host-child] runtime-host build is stale, rebuilding...');
  const projectRoot = resolveProjectRootForRuntimeHostBuild();
  if (!projectRoot) {
    throw new Error('Unable to locate project root for runtime-host build');
  }
  const result = spawnSync('pnpm', ['run', 'build:runtime-host-process'], {
    cwd: projectRoot,
    stdio: 'pipe',
    encoding: 'utf8',
    maxBuffer: REBUILD_OUTPUT_MAX_BUFFER,
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      NO_COLOR: '1',
      npm_config_color: 'false',
    },
    shell: process.platform === 'win32',
  });
  logRebuildOutput(logger, 'stdout', result.stdout);
  logRebuildOutput(logger, 'stderr', result.stderr);
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    throw new Error(`build:runtime-host-process failed with exit code ${String(result.status ?? 1)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function probeHealth(port: number): Promise<RuntimeHostProcessHealth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 800);
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        lifecycle: 'error',
        error: `HTTP ${response.status}`,
      };
    }
    const payload = await response.json() as RuntimeHostProcessHealth;
    return payload;
  } catch (error) {
    return {
      ok: false,
      lifecycle: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealthReady(port: number, timeoutMs: number): Promise<RuntimeHostProcessHealth> {
  const startedAt = Date.now();
  let lastHealth: RuntimeHostProcessHealth = { ok: false, lifecycle: 'starting' };
  while (Date.now() - startedAt < timeoutMs) {
    lastHealth = await probeHealth(port);
    if (lastHealth.ok) {
      return lastHealth;
    }
    await sleep(120);
  }
  return lastHealth;
}

export function createRuntimeHostProcessManager(
  options: RuntimeHostProcessManagerOptions,
): RuntimeHostProcessManager {
  const port = Number.isFinite(options.port) && (options.port ?? 0) > 0
    ? Number(options.port)
    : getPort('MATCHACLAW_RUNTIME_HOST');
  const startTimeoutMs = Number.isFinite(options.startTimeoutMs) && (options.startTimeoutMs ?? 0) > 0
    ? Number(options.startTimeoutMs)
    : DEFAULT_START_TIMEOUT_MS;
  const logger = options.logger;
  const parentApiBaseUrl = options.parentApiBaseUrl.trim().replace(/\/+$/, '');
  const parentDispatchToken = options.parentDispatchToken.trim();
  if (!parentApiBaseUrl) {
    throw new Error('runtime-host process manager requires parentApiBaseUrl');
  }
  if (!parentDispatchToken) {
    throw new Error('runtime-host process manager requires parentDispatchToken');
  }
  const childEnv = options.childEnv;
  const autoRestartOnCrash = options.autoRestartOnCrash !== false;
  const autoRestartBaseDelayMs = Number.isFinite(options.autoRestartBaseDelayMs) && (options.autoRestartBaseDelayMs ?? 0) > 0
    ? Number(options.autoRestartBaseDelayMs)
    : DEFAULT_AUTO_RESTART_BASE_DELAY_MS;
  const autoRestartMaxDelayMs = Number.isFinite(options.autoRestartMaxDelayMs) && (options.autoRestartMaxDelayMs ?? 0) > 0
    ? Number(options.autoRestartMaxDelayMs)
    : DEFAULT_AUTO_RESTART_MAX_DELAY_MS;
  const autoRestartWindowMs = Number.isFinite(options.autoRestartWindowMs) && (options.autoRestartWindowMs ?? 0) > 0
    ? Number(options.autoRestartWindowMs)
    : DEFAULT_AUTO_RESTART_WINDOW_MS;
  const autoRestartMaxAttempts = Number.isFinite(options.autoRestartMaxAttempts) && (options.autoRestartMaxAttempts ?? 0) > 0
    ? Number(options.autoRestartMaxAttempts)
    : DEFAULT_AUTO_RESTART_MAX_ATTEMPTS;

  let scriptPath = resolveScriptPath(options.scriptPath);
  let child: ChildProcess | null = null;
  let lifecycle: RuntimeHostProcessLifecycle = 'idle';
  let lastError: string | undefined;
  let shouldKeepAlive = false;
  let autoRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let crashTimestamps: number[] = [];

  const markError = (message: string): void => {
    lifecycle = 'error';
    lastError = message;
  };

  const clearAutoRestartTimer = (): void => {
    if (autoRestartTimer) {
      clearTimeout(autoRestartTimer);
      autoRestartTimer = null;
    }
  };

  const pruneCrashTimestamps = (nowMs: number): void => {
    crashTimestamps = crashTimestamps.filter((ts) => nowMs - ts <= autoRestartWindowMs);
  };

  const scheduleAutoRestart = (reason: string): void => {
    if (!autoRestartOnCrash || !shouldKeepAlive) {
      return;
    }
    if (autoRestartTimer || child) {
      return;
    }

    const nowMs = Date.now();
    pruneCrashTimestamps(nowMs);
    crashTimestamps.push(nowMs);
    if (crashTimestamps.length > autoRestartMaxAttempts) {
      logger?.error?.(
        `[runtime-host-child] auto-restart halted: exceeded ${String(autoRestartMaxAttempts)} crashes in ${String(autoRestartWindowMs)}ms`,
      );
      return;
    }

    const attempt = crashTimestamps.length;
    const delayMs = Math.min(
      autoRestartBaseDelayMs * (2 ** Math.max(0, attempt - 1)),
      autoRestartMaxDelayMs,
    );
    logger?.warn?.(
      `[runtime-host-child] scheduling auto-restart in ${String(delayMs)}ms (attempt=${String(attempt)}, reason=${reason})`,
    );

    autoRestartTimer = setTimeout(() => {
      autoRestartTimer = null;
      if (!shouldKeepAlive || child) {
        return;
      }
      void start().catch((error) => {
        logger?.error?.('[runtime-host-child] auto-restart failed', error);
        scheduleAutoRestart('auto-restart-failed');
      });
    }, delayMs);
    autoRestartTimer.unref();
  };

  async function start(): Promise<void> {
    shouldKeepAlive = true;
    clearAutoRestartTimer();
    if (shouldAutoRebuildRuntimeHost(scriptPath, options.scriptPath)) {
      const runtimeHostDir = resolveRuntimeHostDirFromScriptPath(scriptPath);
      if (runtimeHostDir && runtimeHostBuildArtifactStale(runtimeHostDir)) {
        rebuildRuntimeHostProcess(logger);
        scriptPath = resolveScriptPath(options.scriptPath);
      }
    }
    if (!scriptPath) {
      markError('runtime-host child script not found');
      throw new Error(lastError);
    }
    if (child && lifecycle === 'running') {
      return;
    }
    lifecycle = 'starting';
    lastError = undefined;

    const env = {
      ...process.env,
      MATCHACLAW_RUNTIME_HOST_PORT: String(port),
      ELECTRON_RUN_AS_NODE: '1',
      MATCHACLAW_RUNTIME_HOST_CHILD: '1',
      ...(childEnv ? childEnv() : {}),
      MATCHACLAW_RUNTIME_HOST_PARENT_API_BASE_URL: parentApiBaseUrl,
      MATCHACLAW_RUNTIME_HOST_PARENT_DISPATCH_TOKEN: parentDispatchToken,
    };

    child = fork(scriptPath, [], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    logger?.info?.(
      `[runtime-host-child] start requested (script="${scriptPath}", port=${String(port)}, timeoutMs=${String(startTimeoutMs)})`,
    );

    child.once('exit', (code, signal) => {
      const previousLifecycle = lifecycle;
      if (lifecycle !== 'stopped') {
        markError(`runtime-host child exited unexpectedly (code=${String(code)}, signal=${String(signal)})`);
      }
      logger?.warn?.(
        `[runtime-host-child] exited (code=${String(code)}, signal=${String(signal)}, previousLifecycle=${previousLifecycle})`,
      );
      child = null;
      if (
        previousLifecycle !== 'stopped'
        && (previousLifecycle === 'running' || previousLifecycle === 'starting')
      ) {
        scheduleAutoRestart('child-exit');
      }
    });

    child.stdout?.on('data', (chunk) => {
      logger?.info?.(`[runtime-host-child] ${String(chunk).trim()}`);
    });
    child.stderr?.on('data', (chunk) => {
      logger?.warn?.(`[runtime-host-child:stderr] ${String(chunk).trim()}`);
    });

    const health = await waitForHealthReady(port, startTimeoutMs);
    if (!health.ok) {
      await stop();
      markError(health.error || 'runtime-host child health check failed');
      throw new Error(lastError);
    }

    lifecycle = 'running';
    lastError = undefined;
    crashTimestamps = [];
  }

  async function stop(): Promise<void> {
    shouldKeepAlive = false;
    clearAutoRestartTimer();
    if (!child) {
      lifecycle = 'stopped';
      return;
    }
    lifecycle = 'stopped';

    const exitPromise = new Promise<void>((resolveExit) => {
      const current = child;
      if (!current) {
        resolveExit();
        return;
      }
      current.once('exit', () => {
        resolveExit();
      });
    });

    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }

    const timeoutPromise = new Promise<void>((resolveTimeout) => {
      setTimeout(resolveTimeout, 1200);
    });

    await Promise.race([exitPromise, timeoutPromise]);

    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      child = null;
    }
  }

  async function restart(): Promise<void> {
    await stop();
    await start();
  }

  async function checkHealth(): Promise<RuntimeHostProcessHealth> {
    return await probeHealth(port);
  }

  function getState(): RuntimeHostProcessState {
    return {
      lifecycle,
      port,
      ...(child?.pid ? { pid: child.pid } : {}),
      ...(lastError ? { lastError } : {}),
    };
  }

  return {
    start,
    stop,
    restart,
    checkHealth,
    getState,
  };
}
