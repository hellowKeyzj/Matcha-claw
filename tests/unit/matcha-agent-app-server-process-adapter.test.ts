import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const electronMock = vi.hoisted(() => {
  const state = {
    isPackaged: false,
    userDataDir: '',
  };
  return {
    state,
    getPath: vi.fn((name: string) => name === 'userData' ? state.userDataDir : ''),
  };
});

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electronMock.state.isPackaged;
    },
    getPath: electronMock.getPath,
  },
}));

import {
  MatchaAgentAppServerProcessAdapter,
  getMatchaAgentAppServerEndpointSnapshot,
} from '../../electron/main/process-runtime/adapters/matcha-agent-app-server-process-adapter';

const envBackup = { ...process.env };
const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

function restoreProcessEnv(): void {
  process.env = { ...envBackup };
}

function portArg(args: readonly string[] | undefined): string | undefined {
  const index = args?.indexOf('--port') ?? -1;
  return index >= 0 ? args?.[index + 1] : undefined;
}

function storageRootFor(userDataDir: string): string {
  return join(userDataDir, 'matcha-agent', 'app-server');
}

function overrideResourcesPath(resourcesPath: string): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });
}

function restoreResourcesPath(): void {
  if (resourcesPathDescriptor) {
    Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
    return;
  }
  delete (process as Partial<NodeJS.Process>).resourcesPath;
}

describe('matcha-agent app-server process adapter', () => {
  let userDataDir = '';
  let resourcesDir = '';

  beforeEach(() => {
    restoreProcessEnv();
    restoreResourcesPath();
    userDataDir = mkdtempSync(join(tmpdir(), 'matcha-agent-app-server-adapter-'));
    resourcesDir = '';
    electronMock.state.isPackaged = false;
    electronMock.state.userDataDir = userDataDir;
    process.env.MATCHACLAW_MATCHA_AGENT_APP_SERVER_PORT = '45678';
    process.env.VISIBLE_APP_SERVER_ENV = 'visible';
    process.env.MATCHA_AGENT_RUN_TRACE = '1';
    process.env.MATCHA_AGENT_APP_SERVER_WORKER_SESSION_ID = 'worker-session';
    process.env.MATCHA_AGENT_APP_SERVER_WORKER_TOKEN = 'worker-token';
  });

  afterEach(() => {
    restoreProcessEnv();
    restoreResourcesPath();
    if (userDataDir) {
      rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = '';
    }
    if (resourcesDir) {
      rmSync(resourcesDir, { recursive: true, force: true });
      resourcesDir = '';
    }
  });

  it('uses getPort for the default port and keeps auth token out of metadata and sanitized args', async () => {
    const token = 'test-app-server-token';
    const adapter = new MatchaAgentAppServerProcessAdapter({ token });

    const plan = await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });
    const metadata = plan.metadata as {
      endpoint: Record<string, unknown>;
      sanitizedArgs: readonly string[];
      mode: string;
    };

    expect(plan.kind).toBe('spawn');
    expect(plan.port).toBe(45678);
    expect(portArg(plan.args)).toBe('45678');
    expect(plan.args).toContain(join(process.cwd(), 'matcha-agent', 'scripts', 'dev.ts'));
    expect(plan.cwd).toBe(process.cwd());
    expect(plan.env?.MATCHA_AGENT_APP_SERVER_AUTH_TOKEN).toBe(token);
    expect(plan.env?.VISIBLE_APP_SERVER_ENV).toBe('visible');
    expect(plan.env?.MATCHA_AGENT_RUN_TRACE).toBe('1');
    expect(plan.env?.MATCHA_AGENT_APP_SERVER_WORKER_SESSION_ID).toBeUndefined();
    expect(plan.env?.MATCHA_AGENT_APP_SERVER_WORKER_TOKEN).toBeUndefined();
    expect(plan.env?.FORCE_COLOR).toBe('0');
    expect(plan.env?.NO_COLOR).toBe('1');

    expect(metadata).toMatchObject({
      mode: 'dev',
      endpoint: {
        enabled: true,
        url: 'http://127.0.0.1:45678',
        port: 45678,
        storageRoot: storageRootFor(userDataDir),
      },
      sanitizedArgs: plan.args,
    });
    expect(metadata.endpoint).not.toHaveProperty('token');
    expect(JSON.stringify(plan.metadata)).not.toContain(token);
    expect(metadata.sanitizedArgs.join(' ')).not.toContain(token);

    expect(getMatchaAgentAppServerEndpointSnapshot(adapter)).toEqual({
      enabled: true,
      url: 'http://127.0.0.1:45678',
      token,
      port: 45678,
      storageRoot: storageRootFor(userDataDir),
    });
  });

  it('lets explicit options.port override the configured app-server port', async () => {
    const adapter = new MatchaAgentAppServerProcessAdapter({
      port: 45679,
      token: 'test-app-server-token',
    });

    const plan = await adapter.prepareLaunch({ nowMs: () => 0, attempt: 1 });
    const metadata = plan.metadata as { endpoint: { port: number; url: string } };

    expect(plan.port).toBe(45679);
    expect(portArg(plan.args)).toBe('45679');
    expect(metadata.endpoint).toMatchObject({
      port: 45679,
      url: 'http://127.0.0.1:45679',
    });
  });

  it('redacts auth token from classified log messages', () => {
    const token = 'test-app-server-token';
    const adapter = new MatchaAgentAppServerProcessAdapter({ port: 45680, token });

    const classified = adapter.classifyLog(`worker started with ${token} and repeated ${token}`);

    expect(classified).toEqual({
      level: 'info',
      message: 'worker started with <redacted> and repeated <redacted>',
    });
    expect(JSON.stringify(classified)).not.toContain(token);
  });
});
