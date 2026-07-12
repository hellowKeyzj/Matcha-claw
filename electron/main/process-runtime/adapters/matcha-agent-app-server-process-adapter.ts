import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import { getPort } from '../../../utils/config';
import type {
  LocalProcessAdapter,
  LocalProcessLaunchPlan,
  LocalProcessLogEvent,
  LocalProcessReadiness,
  LocalProcessReadinessContext,
  LocalProcessStartContext,
} from '../contracts';

const ADAPTER_ID = 'matcha-agent-app-server';
const DISPLAY_NAME = 'matcha-agent app-server';
const APP_SERVER_HOST = '127.0.0.1';
const READINESS_TIMEOUT_MS = 800;
const HEALTH_PATH = '/health';
const TOKEN_BYTE_LENGTH = 32;
const APP_SERVER_SHUTDOWN_GRACE_MS = 3_000;
const APP_SERVER_WORKER_ENV_PREFIX = 'MATCHA_AGENT_APP_SERVER_WORKER_';

type LaunchMode = 'dev' | 'packaged';

export type MatchaAgentAppServerEndpointSnapshot = {
  readonly enabled: true;
  readonly url: string;
  readonly token: string;
  readonly port: number;
  readonly storageRoot: string;
};

type MatchaAgentAppServerEndpointMetadata = Omit<
  MatchaAgentAppServerEndpointSnapshot,
  'token'
>;

type MatchaAgentAppServerLaunchMetadata = {
  readonly endpoint: MatchaAgentAppServerEndpointMetadata;
  readonly sanitizedArgs: readonly string[];
  readonly mode: LaunchMode;
};

export type MatchaAgentAppServerProcessAdapterOptions = {
  readonly port?: number;
  readonly token?: string;
};

export class MatchaAgentAppServerProcessAdapter implements LocalProcessAdapter {
  readonly id = ADAPTER_ID;
  readonly displayName = DISPLAY_NAME;

  private readonly port: number;
  private readonly token: string;
  private endpointSnapshot: MatchaAgentAppServerEndpointSnapshot | undefined;

  constructor(options: MatchaAgentAppServerProcessAdapterOptions = {}) {
    this.port = options.port ?? getPort('MATCHA_AGENT_APP_SERVER');
    this.token = options.token ?? createAppServerAuthToken();
  }

  async prepareLaunch(_context: LocalProcessStartContext): Promise<LocalProcessLaunchPlan> {
    const storageRoot = getAppServerStorageRoot();
    ensureDirectory(storageRoot);

    const mode: LaunchMode = app.isPackaged ? 'packaged' : 'dev';
    const executable = resolveLaunchExecutable(mode);
    const entry = resolveAppServerEntry(mode);
    requireExistingFile(executable.path, executable.label, mode);
    requireExistingFile(entry.path, entry.label, mode);

    const endpoint = buildEndpointSnapshot({
      port: this.port,
      token: this.token,
      storageRoot,
    });
    this.endpointSnapshot = endpoint;

    const args = buildAppServerArgs({
      mode,
      entryPath: entry.path,
      port: this.port,
      storageRoot,
    });

    return {
      kind: 'spawn',
      command: executable.path,
      args,
      cwd: entry.cwd,
      env: buildAppServerEnv(process.env, this.token),
      stdio: 'pipe',
      gracefulShutdownStdin: true,
      gracefulShutdownGraceMs: APP_SERVER_SHUTDOWN_GRACE_MS,
      terminateProcessTree: true,
      port: this.port,
      metadata: {
        endpoint: endpointMetadata(endpoint),
        sanitizedArgs: sanitizeAppServerArgs(args),
        mode,
      } satisfies MatchaAgentAppServerLaunchMetadata,
    };
  }

  async probeReadiness(
    plan: LocalProcessLaunchPlan,
    context: LocalProcessReadinessContext,
  ): Promise<LocalProcessReadiness> {
    const url = readinessUrlFromLaunchPlan(plan);
    if (!url) {
      return { status: 'error', error: 'matcha-agent app-server launch plan is missing a valid port' };
    }

    const controller = new AbortController();
    const abort = () => controller.abort(context.signal.reason);
    const timeout = setTimeout(() => controller.abort(), READINESS_TIMEOUT_MS);

    try {
      if (context.signal.aborted) {
        return { status: 'not-ready', detail: 'readiness probe aborted' };
      }
      context.signal.addEventListener('abort', abort, { once: true });

      const response = await fetch(`${url}${HEALTH_PATH}`, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!response.ok) {
        return { status: 'not-ready', detail: `health returned HTTP ${response.status}` };
      }

      return { status: 'ready', detail: `listening on ${url}` };
    } catch (error) {
      return { status: 'not-ready', detail: readinessFailureDetail(error, context.signal) };
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', abort);
    }
  }

  getEndpointSnapshot(): MatchaAgentAppServerEndpointSnapshot | undefined {
    return this.endpointSnapshot;
  }

  classifyLog(line: string): LocalProcessLogEvent {
    const message = redactAppServerToken(line, this.token);
    return { level: 'info', message };
  }
}

export function createMatchaAgentAppServerProcessAdapter(
  options?: MatchaAgentAppServerProcessAdapterOptions,
): MatchaAgentAppServerProcessAdapter {
  return new MatchaAgentAppServerProcessAdapter(options);
}

export function getMatchaAgentAppServerEndpointSnapshot(
  adapter: MatchaAgentAppServerProcessAdapter,
): MatchaAgentAppServerEndpointSnapshot | undefined {
  return adapter.getEndpointSnapshot();
}

function resolveLaunchExecutable(mode: LaunchMode): { path: string; label: string } {
  if (mode === 'packaged') {
    return {
      path: join(process.resourcesPath, 'bin', bunExecutableName()),
      label: 'bundled Bun executable',
    };
  }

  return {
    path: join(process.cwd(), 'resources', 'bin', `${process.platform}-${process.arch}`, bunExecutableName()),
    label: 'current Bun executable',
  };
}

function resolveAppServerEntry(mode: LaunchMode): { path: string; cwd: string; label: string } {
  if (mode === 'packaged') {
    const resourcesPath = process.resourcesPath;
    return {
      path: join(resourcesPath, 'matcha-agent', 'dist', 'cli-bun.js'),
      cwd: resourcesPath,
      label: 'bundled matcha-agent app-server entry',
    };
  }

  const repoRoot = resolve(process.cwd());
  return {
    path: join(repoRoot, 'matcha-agent', 'scripts', 'dev.ts'),
    cwd: repoRoot,
    label: 'matcha-agent dev app-server entry',
  };
}

function buildAppServerArgs(input: {
  readonly mode: LaunchMode;
  readonly entryPath: string;
  readonly port: number;
  readonly storageRoot: string;
}): string[] {
  const appServerArgs = [
    'app-server',
    '--host',
    APP_SERVER_HOST,
    '--port',
    String(input.port),
    '--storage-root',
    input.storageRoot,
  ];

  return input.mode === 'dev'
    ? ['run', input.entryPath, ...appServerArgs]
    : [input.entryPath, ...appServerArgs];
}

function sanitizeAppServerArgs(args: readonly string[]): string[] {
  return args.map((arg, index) => {
    const previous = args[index - 1];
    if (previous === '--auth-token') return '<redacted>';
    if (arg.startsWith('--auth-token=')) return '--auth-token=<redacted>';
    return arg;
  });
}

function buildEndpointSnapshot(input: {
  readonly port: number;
  readonly token: string;
  readonly storageRoot: string;
}): MatchaAgentAppServerEndpointSnapshot {
  return {
    enabled: true,
    url: `http://${APP_SERVER_HOST}:${input.port}`,
    token: input.token,
    port: input.port,
    storageRoot: input.storageRoot,
  };
}

function endpointMetadata(
  snapshot: MatchaAgentAppServerEndpointSnapshot,
): MatchaAgentAppServerEndpointMetadata {
  return {
    enabled: snapshot.enabled,
    url: snapshot.url,
    port: snapshot.port,
    storageRoot: snapshot.storageRoot,
  };
}

function readinessUrlFromLaunchPlan(plan: LocalProcessLaunchPlan): string | undefined {
  const port = plan.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    return undefined;
  }
  return `http://${APP_SERVER_HOST}:${port}`;
}

function buildAppServerEnv(baseEnv: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (key.startsWith(APP_SERVER_WORKER_ENV_PREFIX)) continue;
    env[key] = value;
  }

  return {
    ...env,
    MATCHA_AGENT_APP_SERVER_AUTH_TOKEN: token,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

function getAppServerStorageRoot(): string {
  return join(app.getPath('userData'), 'matcha-agent', 'app-server');
}

function ensureDirectory(pathname: string): void {
  mkdirSync(pathname, { recursive: true });
}

function requireExistingFile(pathname: string, label: string, mode: LaunchMode): void {
  if (existsSync(pathname)) return;
  throw new Error(
    `${label} not found at ${pathname}; cannot start ${DISPLAY_NAME} in ${mode} mode. Run the matching build/download step before starting ${DISPLAY_NAME}.`,
  );
}

function createAppServerAuthToken(): string {
  return randomBytes(TOKEN_BYTE_LENGTH).toString('base64url');
}

function bunExecutableName(): string {
  return process.platform === 'win32' ? 'bun.exe' : 'bun';
}

function readinessFailureDetail(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return 'readiness probe aborted';
  if (error instanceof Error && error.name === 'AbortError') return 'health request timed out';
  return error instanceof Error ? error.message : String(error);
}

function redactAppServerToken(line: string, token: string): string {
  if (!token) return line;
  return line.split(token).join('<redacted>');
}
