import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { getPort } from '../../../utils/config';
import type {
  LocalProcessAdapter,
  LocalProcessLaunchPlan,
  LocalProcessLogEvent,
  LocalProcessLogger,
  LocalProcessLogStream,
  LocalProcessReadiness,
} from '../contracts';
import { normalizeProcessOutputChunk } from '../log-tail';

export interface RuntimeHostProcessHealth {
  readonly ok: boolean;
  readonly lifecycle: string;
  readonly pid?: number;
  readonly uptimeSec?: number;
  readonly error?: string;
}

export interface RuntimeHostProcessAdapterOptions {
  readonly scriptPath?: string;
  readonly port?: number;
  readonly parentApiBaseUrl: string;
  readonly parentDispatchToken: string;
  readonly childEnv?: () => Record<string, string>;
  readonly logger?: LocalProcessLogger;
}

const HEALTH_PATH = '/health';

export class RuntimeHostProcessAdapter implements LocalProcessAdapter {
  readonly id = 'runtime-host';
  readonly displayName = 'runtime-host-child';

  private scriptPath: string | null;
  private readonly explicitScriptPath?: string;
  private readonly port: number;
  private readonly parentApiBaseUrl: string;
  private readonly parentDispatchToken: string;
  private readonly childEnv?: () => Record<string, string>;
  private readonly logger?: LocalProcessLogger;
  private launchSecrets: readonly string[];

  constructor(options: RuntimeHostProcessAdapterOptions) {
    this.explicitScriptPath = options.scriptPath;
    this.scriptPath = options.scriptPath ?? null;
    this.port = Number.isFinite(options.port) && (options.port ?? 0) > 0
      ? Number(options.port)
      : getPort('MATCHACLAW_RUNTIME_HOST');
    this.parentApiBaseUrl = options.parentApiBaseUrl.trim().replace(/\/+$/, '');
    this.parentDispatchToken = options.parentDispatchToken.trim();
    this.childEnv = options.childEnv;
    this.logger = options.logger;
    this.launchSecrets = [this.parentDispatchToken];

    if (!this.parentApiBaseUrl) {
      throw new Error('runtime-host process adapter requires parentApiBaseUrl');
    }
    if (!this.parentDispatchToken) {
      throw new Error('runtime-host process adapter requires parentDispatchToken');
    }
  }

  getPort(): number {
    return this.port;
  }

  async prepareLaunch(): Promise<LocalProcessLaunchPlan> {
    this.scriptPath = await ensureRuntimeHostBuildCurrent(
      this.scriptPath,
      this.explicitScriptPath,
      this.logger,
    );
    if (!this.scriptPath) {
      throw new Error(buildMissingRuntimeHostScriptError(this.explicitScriptPath));
    }

    const childEnv = this.childEnv?.() ?? {};
    const matchaAgentAppServerToken = childEnv.MATCHACLAW_MATCHA_AGENT_APP_SERVER_TOKEN;
    this.launchSecrets = [
      this.parentDispatchToken,
      ...(matchaAgentAppServerToken ? [matchaAgentAppServerToken] : []),
    ];

    return {
      kind: 'node-child',
      command: this.scriptPath,
      args: [],
      env: {
        ...process.env,
        MATCHACLAW_RUNTIME_HOST_PORT: String(this.port),
        ELECTRON_RUN_AS_NODE: '1',
        MATCHACLAW_RUNTIME_HOST_CHILD: '1',
        MATCHACLAW_APP_PACKAGED: process.env.MATCHACLAW_APP_PACKAGED ?? '0',
        MATCHACLAW_APP_VERSION: process.env.MATCHACLAW_APP_VERSION ?? process.env.npm_package_version ?? '0.0.0',
        MATCHACLAW_APP_USER_DATA_DIR: process.env.MATCHACLAW_APP_USER_DATA_DIR ?? '',
        ...childEnv,
        MATCHACLAW_RUNTIME_HOST_PARENT_API_BASE_URL: this.parentApiBaseUrl,
        MATCHACLAW_RUNTIME_HOST_PARENT_DISPATCH_TOKEN: this.parentDispatchToken,
      },
      stdio: 'pipe',
      ipc: true,
      gracefulShutdownMessage: { type: 'matchaclaw:shutdown' },
      terminateProcessTree: true,
      port: this.port,
      metadata: {
        scriptPath: this.scriptPath,
      },
    };
  }

  async probeReadiness(): Promise<LocalProcessReadiness> {
    const health = await this.checkHealth();
    if (health.ok) {
      return { status: 'ready', detail: health.lifecycle };
    }
    return { status: 'not-ready', detail: health.error ?? health.lifecycle };
  }

  classifyLog(line: string, stream: LocalProcessLogStream): LocalProcessLogEvent {
    return {
      level: stream === 'stderr' ? 'warn' : 'info',
      message: redactKnownSecrets(line, this.launchSecrets),
    };
  }

  async checkHealth(): Promise<RuntimeHostProcessHealth> {
    return await probeHealth(this.port);
  }
}

function redactKnownSecrets(line: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (message, secret) => secret ? message.split(secret).join('<redacted>') : message,
    line,
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.access(path);
    return true;
  } catch {
    return false;
  }
}

function getWorkspaceScriptPathCandidates(): string[] {
  return [
    join(process.cwd(), 'runtime-host', 'host-process.cjs'),
    resolve(__dirname, '../../../runtime-host/host-process.cjs'),
    resolve(__dirname, '../../../../runtime-host/host-process.cjs'),
  ];
}

function getPackagedScriptPathCandidates(resourcesPath: string): string[] {
  if (!resourcesPath) return [];
  return [
    join(resourcesPath, 'app.asar', 'runtime-host', 'host-process.cjs'),
    join(resourcesPath, 'runtime-host', 'host-process.cjs'),
  ];
}

function getDefaultScriptPathCandidates(): string[] {
  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const workspaceCandidates = getWorkspaceScriptPathCandidates();
  const packagedCandidates = getPackagedScriptPathCandidates(resourcesPath);
  const isElectronDevResources = /node_modules[\\/]+electron[\\/]+dist[\\/]+resources$/i.test(resourcesPath);
  if (isElectronDevResources) {
    return [...workspaceCandidates, ...packagedCandidates];
  }
  return [...packagedCandidates, ...workspaceCandidates];
}

async function resolveScriptPath(explicitPath?: string): Promise<string | null> {
  const candidates = explicitPath ? [explicitPath] : getDefaultScriptPathCandidates();
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildMissingRuntimeHostScriptError(explicitPath?: string): string {
  if (explicitPath) {
    return `runtime-host child script not found at ${explicitPath}; cannot start runtime-host-child.`;
  }

  const resourcesPath = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const packagedCandidates = getPackagedScriptPathCandidates(resourcesPath);
  const workspaceCandidates = getWorkspaceScriptPathCandidates();
  const candidateList = [...packagedCandidates, ...workspaceCandidates].join(', ');
  return `runtime-host child script not found; cannot start runtime-host-child. Checked: ${candidateList || '(no candidates)'}.`;
}

async function resolveRuntimeHostDirFromScriptPath(scriptPath: string | null): Promise<string | null> {
  if (!scriptPath) {
    return null;
  }
  const normalized = resolve(scriptPath);
  const scriptDir = dirname(normalized);
  const wrapperEntry = join(scriptDir, 'host-process.cjs');
  if (!(await pathExists(wrapperEntry))) {
    return null;
  }
  return scriptDir;
}

async function resolveRuntimeHostDirForBuild(scriptPath: string | null): Promise<string | null> {
  const runtimeHostDirFromScript = await resolveRuntimeHostDirFromScriptPath(scriptPath);
  if (runtimeHostDirFromScript) {
    return runtimeHostDirFromScript;
  }
  const projectRoot = await resolveProjectRootForRuntimeHostBuild();
  return projectRoot ? join(projectRoot, 'runtime-host') : null;
}

async function resolveProjectRootForRuntimeHostBuild(): Promise<string | null> {
  const candidates = [
    resolve(__dirname, '../../..'),
    resolve(__dirname, '../../../..'),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    const packageJsonPath = join(candidate, 'package.json');
    const buildScriptPath = join(candidate, 'scripts', 'build-runtime-host-process.mjs');
    if ((await pathExists(packageJsonPath)) && (await pathExists(buildScriptPath))) {
      return candidate;
    }
  }
  return null;
}

async function collectLatestMtimeMs(rootDir: string, options?: {
  readonly skipDir?: (dirPath: string) => boolean;
  readonly skipFile?: (filePath: string) => boolean;
}): Promise<number> {
  if (!(await pathExists(rootDir))) {
    return 0;
  }

  let latest = 0;
  const queue: string[] = [rootDir];
  while (queue.length > 0) {
    const currentDir = queue.pop();
    if (!currentDir) {
      continue;
    }
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
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
      const stat = await fsp.stat(fullPath);
      if (stat.mtimeMs > latest) {
        latest = stat.mtimeMs;
      }
    }
  }
  return latest;
}

async function runtimeHostBuildArtifactStale(runtimeHostDir: string): Promise<boolean> {
  const buildDir = join(runtimeHostDir, 'build');
  const buildMain = join(buildDir, 'main.js');
  if (!(await pathExists(buildMain))) {
    return true;
  }

  const latestSourceMtime = await collectLatestMtimeMs(runtimeHostDir, {
    skipDir: (dirPath) => dirPath === buildDir,
    skipFile: (filePath) => filePath.endsWith('host-process.cjs'),
  });
  const latestBuildMtime = await collectLatestMtimeMs(buildDir);
  return latestSourceMtime > latestBuildMtime;
}

async function shouldAutoRebuildRuntimeHost(
  scriptPath: string | null,
  explicitScriptPath?: string,
): Promise<boolean> {
  if (explicitScriptPath) {
    return false;
  }
  if (process.env.VITEST) {
    return false;
  }
  const runtimeHostDir = await resolveRuntimeHostDirForBuild(scriptPath);
  if (!runtimeHostDir || !(await pathExists(runtimeHostDir))) {
    return false;
  }
  return true;
}

async function ensureRuntimeHostBuildCurrent(
  scriptPath: string | null,
  explicitScriptPath: string | undefined,
  logger?: LocalProcessLogger,
): Promise<string | null> {
  if (!(await shouldAutoRebuildRuntimeHost(scriptPath, explicitScriptPath))) {
    return scriptPath ?? (await resolveScriptPath(explicitScriptPath));
  }
  const runtimeHostDir = await resolveRuntimeHostDirForBuild(scriptPath);
  if (runtimeHostDir && (await runtimeHostBuildArtifactStale(runtimeHostDir))) {
    await rebuildRuntimeHostProcess(logger);
  }
  return await resolveScriptPath(explicitScriptPath);
}

function logRebuildOutput(
  logger: LocalProcessLogger | undefined,
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

async function rebuildRuntimeHostProcess(logger?: LocalProcessLogger): Promise<void> {
  logger?.info?.('[runtime-host-child] runtime-host build is stale, rebuilding...');
  const projectRoot = await resolveProjectRootForRuntimeHostBuild();
  if (!projectRoot) {
    throw new Error('Unable to locate project root for runtime-host build');
  }
  await new Promise<void>((resolveBuild, rejectBuild) => {
    const child = spawn('pnpm', ['run', 'build:runtime-host-process'], {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        npm_config_color: 'false',
      },
      shell: process.platform === 'win32',
    });
    child.stdout?.on('data', (chunk: Buffer) => logRebuildOutput(logger, 'stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => logRebuildOutput(logger, 'stderr', chunk));
    child.once('error', (error) => rejectBuild(error));
    child.once('close', (code) => {
      if ((code ?? 1) !== 0) {
        rejectBuild(new Error(`build:runtime-host-process failed with exit code ${String(code ?? 1)}`));
        return;
      }
      resolveBuild();
    });
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
    return await response.json() as RuntimeHostProcessHealth;
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
