import { join } from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createRuntimeHostProcessManager } from '../../electron/main/runtime-host-process-manager';

const scriptPath = join(process.cwd(), 'runtime-host', 'host-process.cjs');

function createPort(seed: number): number {
  return 46210 + seed;
}

async function waitForCondition(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 8000,
  intervalMs = 80,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitForCondition timeout');
}

async function startParentDispatchServer(
  port: number,
  token: string,
  options?: {
    onExecutionSync?: (body: {
      action: 'set_execution_enabled' | 'restart_runtime_host';
      payload?: unknown;
    }) => {
      status: number;
      payload: unknown;
    };
    onShellAction?: (body: {
      action:
        | 'gateway_restart'
        | 'provider_oauth_start'
        | 'provider_oauth_cancel'
        | 'provider_oauth_submit'
        | 'channel_session_start'
        | 'channel_session_cancel'
        | 'license_get_gate'
        | 'license_get_stored_key'
        | 'license_validate'
        | 'license_revalidate'
        | 'license_clear';
      payload?: unknown;
    }) => {
      status: number;
      payload: unknown;
    };
  },
): Promise<{
  close: () => Promise<void>;
  getDispatchRequestCount: () => number;
  getExecutionSyncRequestCount: () => number;
  getShellActionRequestCount: () => number;
}> {
  let executionSyncRequestCount = 0;
  let shellActionRequestCount = 0;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    if (req.url !== '/internal/runtime-host/execution-sync' && req.url !== '/internal/runtime-host/shell-actions') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    if (req.headers['x-runtime-host-dispatch-token'] !== token) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        version: 1,
        success: false,
        status: 403,
        error: { code: 'FORBIDDEN', message: 'Invalid token' },
      }));
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;

    if (req.url === '/internal/runtime-host/shell-actions') {
      const shellActionBody = parsedBody as {
        action:
          | 'gateway_restart'
          | 'provider_oauth_start'
          | 'provider_oauth_cancel'
          | 'provider_oauth_submit'
          | 'channel_session_start'
          | 'channel_session_cancel'
          | 'license_get_gate'
          | 'license_get_stored_key'
          | 'license_validate'
          | 'license_revalidate'
          | 'license_clear';
        payload?: unknown;
      };
      shellActionRequestCount += 1;

      if (options?.onShellAction) {
        const custom = options.onShellAction(shellActionBody);
        res.statusCode = custom.status;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(custom.payload));
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        version: 1,
        success: true,
        status: 200,
        data: {
          success: true,
          source: 'parent-api-shell-action',
          action: shellActionBody.action,
          payload: shellActionBody.payload,
        },
      }));
      return;
    }

    const executionSyncBody = parsedBody as {
      action: 'set_execution_enabled' | 'restart_runtime_host';
      payload?: unknown;
    };
    executionSyncRequestCount += 1;

    if (options?.onExecutionSync) {
      const custom = options.onExecutionSync(executionSyncBody);
      res.statusCode = custom.status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(custom.payload));
      return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({
      version: 1,
      success: true,
      status: 200,
      data: {
        execution: {
          pluginExecutionEnabled: true,
          enabledPluginIds: [],
        },
      },
    }));
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    getDispatchRequestCount: () => 0,
    getExecutionSyncRequestCount: () => executionSyncRequestCount,
    getShellActionRequestCount: () => shellActionRequestCount,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function startClawHubRegistryServer(
  port: number,
): Promise<{
  close: () => Promise<void>;
}> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method !== 'GET') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }

    if (url.pathname === '/api/v1/search') {
      const q = url.searchParams.get('q') || '';
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (!q) {
        res.end(JSON.stringify({
          results: [
            {
              slug: 'daily-summary',
              displayName: 'Daily Summary',
              summary: 'Daily summary skill',
              version: '0.9.1',
              score: 35,
              metaContent: { owner: 'matcha-labs' },
              stats: { downloads: 4500, stars: 120 },
            },
            {
              slug: 'project-planner',
              displayName: 'Project Planner',
              summary: 'Plan projects and milestones',
              version: '2.1.0',
              score: 91,
              metaContent: { owner: 'matcha-team' },
              stats: { downloads: 15500, stars: 980 },
            },
            {
              slug: 'git-helper',
              displayName: 'Git Helper',
              summary: 'Git helper skill',
              version: '1.2.3',
              score: 68,
              metaContent: { owner: 'matcha-utils' },
              stats: { downloads: 7800, stars: 260 },
            },
          ],
        }));
        return;
      }
      res.end(JSON.stringify({
        results: [
          {
            slug: 'git-helper',
            displayName: q ? `Git Helper (${q})` : 'Git Helper',
            summary: 'Git helper skill',
            version: '1.2.3',
            score: 62,
            metaContent: { owner: 'matcha-utils' },
            stats: { downloads: 7800, stars: 260 },
          },
        ],
      }));
      return;
    }

    if (url.pathname === '/api/v1/skills') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({
        items: [
          {
            slug: 'daily-summary',
            displayName: 'Daily Summary',
            summary: 'Daily summary skill',
            latestVersion: { version: '0.9.1' },
          },
        ],
      }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function startGatewayRpcServer(
  port: number,
  token: string,
  options?: {
    onRequest?: (payload: { method: string; params: unknown }) => unknown;
  },
): Promise<{
  close: () => Promise<void>;
  getRequestCount: () => number;
  getRequests: () => Array<{ method: string; params: unknown }>;
}> {
  const requests: Array<{ method: string; params: unknown }> = [];
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port,
  });

  wss.on('connection', (socket) => {
    const nonce = `nonce-${Date.now()}`;
    socket.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce },
    }));

    let authed = false;
    socket.on('message', (rawData) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(rawData.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type !== 'req' || typeof message.id !== 'string') {
        return;
      }

      if (message.method === 'connect') {
        const params = (
          message.params
          && typeof message.params === 'object'
          && !Array.isArray(message.params)
        ) ? message.params as Record<string, unknown> : {};
        const auth = (
          params.auth
          && typeof params.auth === 'object'
          && !Array.isArray(params.auth)
        ) ? params.auth as Record<string, unknown> : {};
        if (auth.token !== token) {
          socket.send(JSON.stringify({
            type: 'res',
            id: message.id,
            ok: false,
            error: {
              code: 'FORBIDDEN',
              message: 'invalid gateway token',
            },
          }));
          socket.close();
          return;
        }
        authed = true;
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: { hello: 'ok' },
        }));
        return;
      }

      if (!authed || typeof message.method !== 'string') {
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'handshake not completed',
          },
        }));
        return;
      }

      const request = {
        method: message.method,
        params: message.params,
      };
      requests.push(request);
      const payload = options?.onRequest
        ? options.onRequest(request)
        : { success: true, method: message.method };
      socket.send(JSON.stringify({
        type: 'res',
        id: message.id,
        ok: true,
        payload,
      }));
    });
  });

  await new Promise<void>((resolve) => {
    wss.on('listening', () => resolve());
  });

  return {
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
    getRequestCount: () => requests.length,
    getRequests: () => [...requests],
  };
}

describe('runtime-host process manager', () => {
  let openClawConfigDir = '';
  let previousOpenClawConfigDir: string | undefined;

  beforeEach(() => {
    previousOpenClawConfigDir = process.env.OPENCLAW_CONFIG_DIR;
    openClawConfigDir = mkdtempSync(join(tmpdir(), 'runtime-host-process-config-'));
    process.env.OPENCLAW_CONFIG_DIR = openClawConfigDir;
  });

  afterEach(() => {
    if (previousOpenClawConfigDir === undefined) {
      delete process.env.OPENCLAW_CONFIG_DIR;
    } else {
      process.env.OPENCLAW_CONFIG_DIR = previousOpenClawConfigDir;
    }
    if (openClawConfigDir) {
      rmSync(openClawConfigDir, { recursive: true, force: true });
    }
  });

  it('enabled mode can start, restart and stop child process', async () => {
    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port: createPort(2),
      startTimeoutMs: 8000,
      parentApiBaseUrl: 'http://127.0.0.1:3210',
      parentDispatchToken: 'test-runtime-host-dispatch-token-lifecycle',
    });

    await manager.start();
    const startedHealth = await manager.checkHealth();
    expect(startedHealth.ok).toBe(true);
    expect(startedHealth.lifecycle).toBe('running');

    await manager.restart();
    const restartedHealth = await manager.checkHealth();
    expect(restartedHealth.ok).toBe(true);
    expect(restartedHealth.lifecycle).toBe('running');

    await manager.stop();
    const finalState = manager.getState();
    expect(finalState.lifecycle).toBe('stopped');
  });

  it('child 进程异常退出后会自动重拉起并恢复健康', async () => {
    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port: createPort(4),
      startTimeoutMs: 8000,
      parentApiBaseUrl: 'http://127.0.0.1:3210',
      parentDispatchToken: 'test-runtime-host-dispatch-token-auto-restart',
    });

    try {
      await manager.start();
      const stateBeforeKill = manager.getState();
      expect(stateBeforeKill.pid).toBeTypeOf('number');
      const pidBeforeKill = stateBeforeKill.pid as number;

      process.kill(pidBeforeKill);

      await waitForCondition(async () => {
        const state = manager.getState();
        if (!state.pid || state.pid === pidBeforeKill || state.lifecycle !== 'running') {
          return false;
        }
        const health = await manager.checkHealth();
        return health.ok && health.lifecycle === 'running';
      }, 12000);

      const stateAfterRestart = manager.getState();
      expect(stateAfterRestart.lifecycle).toBe('running');
      expect(stateAfterRestart.pid).toBeTypeOf('number');
      expect(stateAfterRestart.pid).not.toBe(pidBeforeKill);
    } finally {
      await manager.stop();
    }
  });

  it('dispatch endpoint 对未实现业务路由直接返回 404，不再回跳主进程分发', async () => {
    const port = createPort(3);
    const parentApiPort = createPort(30);
    const token = 'test-runtime-host-dispatch-token';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/echo',
          payload: { hello: 'world' },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        error?: { code?: string; message?: string };
      };

      expect(response.status).toBe(404);
      expect(payload).toMatchObject({
        success: false,
        status: 404,
        error: { code: 'NOT_FOUND' },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }

    const finalState = manager.getState();
    expect(finalState.lifecycle).toBe('stopped');
  });

  it('local business route is handled in child without parent dispatch', async () => {
    const port = createPort(5);
    const parentApiPort = createPort(32);
    const token = 'test-runtime-host-dispatch-token-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/runtime-host/health',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          health?: { ok?: boolean; lifecycle?: string };
        };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          health: {
            ok: true,
            lifecycle: 'running',
          },
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('workbench/bootstrap 在子进程本地返回按 catalog+execution 计算的插件状态', async () => {
    writeFileSync(join(openClawConfigDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['security-core'],
        entries: {
          'security-core': { enabled: true },
        },
      },
    }, null, 2));
    const port = createPort(12);
    const parentApiPort = createPort(39);
    const token = 'test-runtime-host-dispatch-token-bootstrap-local-state';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core']),
        MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify([
          {
            id: 'security-core',
            name: 'Security Core',
            version: '1.0.0',
            kind: 'builtin',
            category: 'security',
          },
          {
            id: 'task-manager',
            name: 'Task Manager',
            version: '1.2.0',
            kind: 'third-party',
            category: 'automation',
          },
        ]),
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/workbench/bootstrap',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          runtime?: { lifecycle?: string; activePluginCount?: number };
          plugins?: Array<{ id: string; lifecycle: string; kind: string }>;
        };
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.status).toBe(200);
      expect(payload.data?.success).toBe(true);
      expect(payload.data?.runtime).toMatchObject({
        lifecycle: 'running',
        activePluginCount: 1,
      });
      const plugins = payload.data?.plugins ?? [];
      expect(Array.isArray(plugins)).toBe(true);
      const securityCore = plugins.find((plugin) => plugin.id === 'security-core');
      const taskManager = plugins.find((plugin) => plugin.id === 'task-manager');
      expect(securityCore).toBeDefined();
      expect(taskManager).toBeDefined();
      expect(securityCore?.lifecycle).toBe('active');
      expect(taskManager?.lifecycle).toBe('inactive');
      expect(typeof securityCore?.kind).toBe('string');
      expect(typeof taskManager?.kind).toBe('string');
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('openclaw 只读路由在子进程本地处理且不走 parent dispatch', async () => {
    const port = createPort(14);
    const parentApiPort = createPort(41);
    const token = 'test-runtime-host-dispatch-token-openclaw-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();

      const configDirResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/openclaw/config-dir',
        }),
      });
      const configDirPayload = await configDirResponse.json() as {
        success: boolean;
        status: number;
        data?: string;
      };

      const statusResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/openclaw/status',
        }),
      });
      const statusPayload = await statusResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          packageExists?: boolean;
          isBuilt?: boolean;
          dir?: string;
          entryPath?: string;
        };
      };

      expect(configDirResponse.status).toBe(200);
      expect(configDirPayload.success).toBe(true);
      expect(configDirPayload.data).toBe(openClawConfigDir);

      expect(statusResponse.status).toBe(200);
      expect(statusPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          packageExists: expect.any(Boolean),
          isBuilt: expect.any(Boolean),
          dir: expect.any(String),
          entryPath: expect.any(String),
        },
      });

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('openclaw subagent-templates 路由在子进程本地处理且不走 parent dispatch', async () => {
    const port = createPort(15);
    const parentApiPort = createPort(42);
    const token = 'test-runtime-host-dispatch-token-openclaw-templates-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const templatesRoot = mkdtempSync(join(tmpdir(), 'matchaclaw-subagents-'));
    const templateDir = join(templatesRoot, 'brand-guardian');
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, 'IDENTITY.md'), '# 🛡️ Brand Guardian\nProtect the brand.');
    writeFileSync(join(templateDir, 'AGENTS.md'), 'Brand guardian agents.');
    writeFileSync(join(templateDir, 'SOUL.md'), 'Soul');
    writeFileSync(join(templateDir, 'TOOLS.md'), 'Tools');
    writeFileSync(join(templateDir, 'USER.md'), 'User');

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_SUBAGENT_TEMPLATE_DIR: templatesRoot,
      }),
    });

    try {
      await manager.start();

      const catalogResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/openclaw/subagent-templates',
        }),
      });
      const catalogPayload = await catalogResponse.json() as {
        success: boolean;
        status: number;
        data?: { templates?: Array<{ id: string; name: string }> };
      };

      const detailResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/openclaw/subagent-templates/brand-guardian',
        }),
      });
      const detailPayload = await detailResponse.json() as {
        success: boolean;
        status: number;
        data?: { template?: { id?: string; fileContents?: Record<string, string> } };
      };

      expect(catalogResponse.status).toBe(200);
      expect(catalogPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          templates: [
            { id: 'brand-guardian', name: 'Brand Guardian' },
          ],
        },
      });

      expect(detailResponse.status).toBe(200);
      expect(detailPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          template: {
            id: 'brand-guardian',
          },
        },
      });
      expect(detailPayload.data?.template?.fileContents).toBeDefined();
      expect(detailPayload.data?.template?.fileContents?.['AGENTS.md']).toContain('Brand guardian agents.');

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('toolchain uv/check 路由在子进程本地处理且不走 parent dispatch', async () => {
    const port = createPort(16);
    const parentApiPort = createPort(43);
    const token = 'test-runtime-host-dispatch-token-toolchain-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();

      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/toolchain/uv/check',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: boolean;
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(typeof payload.data).toBe('boolean');
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('toolchain uv/install 路由在子进程本地处理且不走 parent dispatch', async () => {
    const port = createPort(18);
    const parentApiPort = createPort(45);
    const token = 'test-runtime-host-dispatch-token-toolchain-install-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        PATH: '',
      }),
    });

    try {
      await manager.start();

      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/toolchain/uv/install',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; error?: string };
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(typeof payload.data?.success).toBe('boolean');
      if (payload.data?.success === false) {
        expect(typeof payload.data.error).toBe('string');
      }
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('skills 配置路由在子进程本地处理且不走 parent dispatch', async () => {
    const port = createPort(19);
    const parentApiPort = createPort(46);
    const token = 'test-runtime-host-dispatch-token-skills-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-skills-config-'));
    writeFileSync(
      join(configDir, 'openclaw.json'),
      JSON.stringify({
        skills: {
          entries: {
            'skill.alpha': { apiKey: 'old-key', env: { REGION: 'cn' } },
          },
        },
      }, null, 2),
      'utf8',
    );

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
      }),
    });

    try {
      await manager.start();

      const getResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/skills/configs',
        }),
      });
      const getPayload = await getResponse.json() as {
        success: boolean;
        status: number;
        data?: Record<string, { apiKey?: string; env?: Record<string, string> }>;
      };

      expect(getResponse.status).toBe(200);
      expect(getPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          'skill.alpha': {
            apiKey: 'old-key',
            env: { REGION: 'cn' },
          },
        },
      });

      const updateResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/skills/config',
          payload: {
            skillKey: 'skill.alpha',
            apiKey: 'new-key',
            env: {
              REGION: 'us',
              EMPTY: '   ',
            },
          },
        }),
      });
      const updatePayload = await updateResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean };
      };

      expect(updateResponse.status).toBe(200);
      expect(updatePayload).toMatchObject({
        success: true,
        status: 200,
        data: { success: true },
      });

      const nextConfig = JSON.parse(readFileSync(join(configDir, 'openclaw.json'), 'utf8')) as {
        skills?: { entries?: Record<string, { apiKey?: string; env?: Record<string, string> }> };
      };
      expect(nextConfig.skills?.entries?.['skill.alpha']).toEqual({
        apiKey: 'new-key',
        env: { REGION: 'us' },
      });

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('team-runtime 路由在子进程本地执行任务编排，不走 parent dispatch', async () => {
    const port = createPort(92);
    const parentApiPort = createPort(93);
    const token = 'test-runtime-host-dispatch-token-team-runtime-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-team-runtime-config-'));

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
      }),
    });

    try {
      await manager.start();

      const initResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/team-runtime/init',
          payload: { teamId: 'team-alpha', leadAgentId: 'lead-1' },
        }),
      });
      expect(initResponse.status).toBe(200);

      const upsertResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/team-runtime/plan-upsert',
          payload: {
            teamId: 'team-alpha',
            tasks: [
              { taskId: 'task-1', instruction: 'do task 1' },
              { taskId: 'task-2', instruction: 'do task 2', dependsOn: ['task-1'] },
            ],
          },
        }),
      });
      const upsertPayload = await upsertResponse.json() as {
        success: boolean;
        status: number;
        data?: { tasks?: Array<{ taskId?: string }> };
      };
      expect(upsertResponse.status).toBe(200);
      expect(upsertPayload.data?.tasks?.length).toBe(2);

      const claimResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/team-runtime/claim-next',
          payload: {
            teamId: 'team-alpha',
            agentId: 'agent-a',
            sessionKey: 'session-a',
          },
        }),
      });
      const claimPayload = await claimResponse.json() as {
        success: boolean;
        status: number;
        data?: { task?: { taskId?: string; status?: string } };
      };
      expect(claimResponse.status).toBe(200);
      expect(claimPayload.data?.task).toMatchObject({
        taskId: 'task-1',
        status: 'claimed',
      });

      const updateResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/team-runtime/task-update',
          payload: {
            teamId: 'team-alpha',
            taskId: 'task-1',
            status: 'running',
          },
        }),
      });
      const updateToRunningPayload = await updateResponse.json() as {
        success: boolean;
        status: number;
        data?: { task?: { taskId?: string; status?: string } };
      };
      expect(updateResponse.status).toBe(200);
      expect(updateToRunningPayload.data?.task).toMatchObject({
        taskId: 'task-1',
        status: 'running',
      });

      const doneResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/team-runtime/task-update',
          payload: {
            teamId: 'team-alpha',
            taskId: 'task-1',
            status: 'done',
          },
        }),
      });
      const updatePayload = await doneResponse.json() as {
        success: boolean;
        status: number;
        data?: { task?: { taskId?: string; status?: string } };
      };
      expect(doneResponse.status).toBe(200);
      expect(updatePayload.data?.task).toMatchObject({
        taskId: 'task-1',
        status: 'done',
      });

      const mailboxPostResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/team-runtime/mailbox-post',
          payload: {
            teamId: 'team-alpha',
            message: {
              msgId: 'msg-1',
              fromAgentId: 'agent-a',
              content: 'hello team',
            },
          },
        }),
      });
      expect(mailboxPostResponse.status).toBe(200);

      const snapshotResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/team-runtime/snapshot',
          payload: { teamId: 'team-alpha', mailboxLimit: 20 },
        }),
      });
      const snapshotPayload = await snapshotResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          run?: { teamId?: string };
          tasks?: Array<{ taskId?: string; status?: string }>;
          mailbox?: { messages?: Array<{ msgId?: string; content?: string }> };
          events?: Array<{ type?: string }>;
        };
      };
      expect(snapshotResponse.status).toBe(200);
      expect(snapshotPayload.data?.run?.teamId).toBe('team-alpha');
      expect(snapshotPayload.data?.tasks?.find((task) => task.taskId === 'task-1')?.status).toBe('done');
      expect(snapshotPayload.data?.mailbox?.messages?.[0]).toMatchObject({
        msgId: 'msg-1',
        content: 'hello team',
      });
      expect((snapshotPayload.data?.events || []).length).toBeGreaterThan(0);

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('skills/effective 与 clawhub/search 在子进程本地处理，不走 parent dispatch', async () => {
    const port = createPort(94);
    const parentApiPort = createPort(95);
    const clawHubRegistryPort = createPort(96);
    const token = 'test-runtime-host-dispatch-token-clawhub-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const clawHubRegistryServer = await startClawHubRegistryServer(clawHubRegistryPort);
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-clawhub-config-'));
    const skillsDir = join(configDir, 'skills');
    mkdirSync(join(skillsDir, 'git-helper'), { recursive: true });
    writeFileSync(join(skillsDir, 'git-helper', 'SKILL.md'), '# Git Helper\n', 'utf8');
    writeFileSync(join(skillsDir, 'git-helper', 'package.json'), JSON.stringify({ version: '1.2.3' }, null, 2), 'utf8');
    writeFileSync(
      join(configDir, 'openclaw.json'),
      JSON.stringify({
        skills: {
          entries: {
            'git-helper': { enabled: true },
            'disabled-skill': { enabled: false },
          },
        },
      }, null, 2),
      'utf8',
    );

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
        CLAWHUB_REGISTRY: `http://127.0.0.1:${clawHubRegistryPort}`,
      }),
    });

    try {
      await manager.start();

      const effectiveResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/skills/effective',
        }),
      });
      const effectivePayload = await effectiveResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; tools?: Array<{ id?: string; enabled?: boolean }> };
      };
      expect(effectiveResponse.status).toBe(200);
      expect(effectivePayload.data?.success).toBe(true);
      expect(effectivePayload.data?.tools?.some((tool) => tool.id === 'git-helper' && tool.enabled === true)).toBe(true);
      expect(effectivePayload.data?.tools?.some((tool) => tool.id === 'disabled-skill')).toBe(false);

      const searchResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/clawhub/search',
          payload: { query: 'git' },
        }),
      });
      const searchPayload = await searchResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; results?: Array<{ slug?: string; name?: string }> };
      };
      expect(searchResponse.status).toBe(200);
      expect(searchPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
        },
      });
      expect(searchPayload.data?.results?.[0]).toMatchObject({
        slug: 'git-helper',
        name: 'Git Helper (git)',
      });
      expect(searchPayload.data?.results?.[0]).toMatchObject({
        author: 'matcha-utils',
        downloads: 7800,
        stars: 260,
      });

      const discoveryResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/clawhub/search',
          payload: { query: '' },
        }),
      });
      const discoveryPayload = await discoveryResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          results?: Array<{
            slug?: string;
            name?: string;
            author?: string;
            downloads?: number;
            stars?: number;
          }>;
        };
      };
      expect(discoveryResponse.status).toBe(200);
      expect(discoveryPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
        },
      });
      expect(discoveryPayload.data?.results?.[0]).toMatchObject({
        slug: 'project-planner',
        name: 'Project Planner',
        author: 'matcha-team',
        downloads: 15500,
        stars: 980,
      });
      expect(discoveryPayload.data?.results?.[1]).toMatchObject({
        slug: 'git-helper',
      });
      expect(discoveryPayload.data?.results?.[2]).toMatchObject({
        slug: 'daily-summary',
      });

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
      await clawHubRegistryServer.close();
    }
  });

  it('sessions/delete 路由在子进程本地处理并完成会话文件与索引清理', async () => {
    const port = createPort(17);
    const parentApiPort = createPort(44);
    const token = 'test-runtime-host-dispatch-token-sessions-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-openclaw-config-'));
    const sessionsDir = join(configDir, 'agents', 'foo', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        sessions: [
          { key: 'agent:foo:session-a', id: 'uuid-a' },
          { key: 'agent:foo:main', id: 'uuid-main' },
        ],
      }, null, 2),
      'utf8',
    );
    writeFileSync(join(sessionsDir, 'uuid-a.jsonl'), '{"hello":"world"}\n', 'utf8');

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/sessions/delete',
          payload: { sessionKey: 'agent:foo:session-a' },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: { success: true },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);

      const deletedPath = join(sessionsDir, 'uuid-a.deleted.jsonl');
      expect(existsSync(deletedPath)).toBe(true);
      const sessionsIndex = JSON.parse(readFileSync(join(sessionsDir, 'sessions.json'), 'utf8')) as {
        sessions?: Array<{ key?: string }>;
      };
      expect(sessionsIndex.sessions).toEqual([{ key: 'agent:foo:main', id: 'uuid-main' }]);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('settings 路由在子进程本地处理并持久化，不走 parent dispatch', async () => {
    const port = createPort(69);
    const parentApiPort = createPort(70);
    const token = 'test-runtime-host-dispatch-token-settings-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const settingsDir = mkdtempSync(join(tmpdir(), 'matchaclaw-settings-store-'));
    const settingsFile = join(settingsDir, 'settings.json');

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_SETTINGS_FILE: settingsFile,
      }),
    });

    try {
      await manager.start();

      const readBefore = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/settings',
        }),
      });
      const beforePayload = await readBefore.json() as {
        success: boolean;
        status: number;
        data?: { theme?: string };
      };
      expect(readBefore.status).toBe(200);
      expect(beforePayload.data?.theme).toBe('system');

      const updateResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/settings',
          payload: {
            theme: 'dark',
            language: 'zh',
          },
        }),
      });
      const updatePayload = await updateResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean };
      };
      expect(updateResponse.status).toBe(200);
      expect(updatePayload).toMatchObject({
        success: true,
        status: 200,
        data: { success: true },
      });

      const readKey = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/settings/theme',
        }),
      });
      const keyPayload = await readKey.json() as {
        success: boolean;
        status: number;
        data?: { value?: string };
      };
      expect(readKey.status).toBe(200);
      expect(keyPayload.data?.value).toBe('dark');

      const persisted = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        theme?: string;
        language?: string;
      };
      expect(persisted.theme).toBe('dark');
      expect(persisted.language).toBe('zh');
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('provider-accounts 路由在子进程本地处理，不走 parent dispatch', async () => {
    const port = createPort(71);
    const parentApiPort = createPort(72);
    const token = 'test-runtime-host-dispatch-token-provider-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const providerStoreDir = mkdtempSync(join(tmpdir(), 'matchaclaw-provider-store-'));
    const providerStoreFile = join(providerStoreDir, 'provider-accounts.json');

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE: providerStoreFile,
      }),
    });

    try {
      await manager.start();

      const createResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/provider-accounts',
          payload: {
            account: {
              id: 'openai-main',
              vendorId: 'openai',
              label: 'OpenAI Main',
              authMode: 'api_key',
              enabled: true,
              isDefault: false,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
            apiKey: 'sk-test-openai-main',
          },
        }),
      });
      const createPayload = await createResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; account?: { id?: string } };
      };
      expect(createResponse.status).toBe(200);
      expect(createPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          account: { id: 'openai-main' },
        },
      });

      const listResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/provider-accounts',
        }),
      });
      const listPayload = await listResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          accounts?: Array<{ id?: string }>;
          statuses?: Array<{ id?: string; hasKey?: boolean }>;
          vendors?: Array<{ id?: string }>;
          defaultAccountId?: string;
        };
      };
      expect(listResponse.status).toBe(200);
      expect(listPayload.data?.accounts?.[0]?.id).toBe('openai-main');
      expect(listPayload.data?.statuses?.[0]).toMatchObject({
        id: 'openai-main',
        hasKey: true,
      });
      expect(listPayload.data?.vendors?.some((vendor) => vendor.id === 'openai')).toBe(true);
      expect(listPayload.data?.defaultAccountId).toBe('openai-main');

      const keyResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/provider-accounts/openai-main/api-key',
        }),
      });
      const keyPayload = await keyResponse.json() as {
        success: boolean;
        status: number;
        data?: { apiKey?: string | null };
      };
      expect(keyResponse.status).toBe(200);
      expect(keyPayload.data?.apiKey).toBe('sk-test-openai-main');

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('provider oauth 路由在子进程本地命中并通过 shell-actions 调用主进程壳能力', async () => {
    const port = createPort(171);
    const parentApiPort = createPort(172);
    const token = 'test-runtime-host-dispatch-token-provider-oauth-shell-action';
    const shellActions: string[] = [];
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onShellAction: (body) => {
        shellActions.push(body.action);
        if (body.action === 'provider_oauth_submit') {
          return {
            status: 200,
            payload: {
              version: 1,
              success: true,
              status: 200,
              data: { success: true },
            },
          };
        }
        return {
          status: 200,
          payload: {
            version: 1,
            success: true,
            status: 200,
            data: { success: true },
          },
        };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();

      const startResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/provider-accounts/oauth/start',
          payload: {
            provider: 'openai',
            accountId: 'openai-main',
            label: 'OpenAI Main',
          },
        }),
      });
      const startPayload = await startResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean };
      };
      expect(startResponse.status).toBe(200);
      expect(startPayload).toMatchObject({
        success: true,
        status: 200,
        data: { success: true },
      });

      const submitResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/provider-accounts/oauth/submit',
          payload: { code: 'oauth-demo-code' },
        }),
      });
      expect(submitResponse.status).toBe(200);

      const cancelResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/provider-accounts/oauth/cancel',
        }),
      });
      expect(cancelResponse.status).toBe(200);

      expect(shellActions).toEqual([
        'provider_oauth_start',
        'provider_oauth_submit',
        'provider_oauth_cancel',
      ]);
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(parentDispatchServer.getShellActionRequestCount()).toBe(3);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('shell-actions 上游返回非法 transport payload 时返回 500 并透出契约错误', async () => {
    const port = createPort(177);
    const parentApiPort = createPort(178);
    const token = 'test-runtime-host-dispatch-token-invalid-shell-transport-payload';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onShellAction: () => ({
        status: 200,
        payload: {
          ok: true,
          message: 'invalid transport shape',
        },
      }),
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/provider-accounts/oauth/start',
          payload: {
            provider: 'openai',
            accountId: 'openai-main',
            label: 'OpenAI Main',
          },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; error?: string };
      };

      expect(response.status).toBe(500);
      expect(payload.success).toBe(true);
      expect(payload.status).toBe(500);
      expect(payload.data?.success).toBe(false);
      expect(payload.data?.error).toContain('Invalid parent transport response');
      expect(parentDispatchServer.getShellActionRequestCount()).toBe(1);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('channels start/cancel 路由在子进程本地命中并通过 shell-actions 调用主进程壳能力', async () => {
    const port = createPort(173);
    const parentApiPort = createPort(174);
    const token = 'test-runtime-host-dispatch-token-channels-shell-action';
    const shellActions: string[] = [];
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onShellAction: (body) => {
        shellActions.push(body.action);
        if (body.action === 'channel_session_start') {
          return {
            status: 200,
            payload: {
              version: 1,
              success: true,
              status: 200,
              data: {
                success: true,
                queued: true,
                sessionKey: 'weixin-session-1',
              },
            },
          };
        }
        return {
          status: 200,
          payload: {
            version: 1,
            success: true,
            status: 200,
            data: { success: true },
          },
        };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();

      const whatsAppStart = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/channels/activate',
          payload: { channelType: 'whatsapp', accountId: 'default' },
        }),
      });
      expect(whatsAppStart.status).toBe(200);

      const whatsAppCancel = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/channels/session/cancel',
          payload: { channelType: 'whatsapp' },
        }),
      });
      expect(whatsAppCancel.status).toBe(200);

      const weixinStart = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/channels/activate',
          payload: {
            channelType: 'openclaw-weixin',
            accountId: 'wx-main',
            config: { routeTag: 'prod' },
          },
        }),
      });
      const weixinStartPayload = await weixinStart.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; queued?: boolean; sessionKey?: string };
      };
      expect(weixinStart.status).toBe(200);
      expect(weixinStartPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          queued: true,
          sessionKey: 'weixin-session-1',
        },
      });

      const weixinCancel = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/channels/session/cancel',
          payload: { channelType: 'openclaw-weixin' },
        }),
      });
      expect(weixinCancel.status).toBe(200);

      expect(shellActions).toEqual([
        'channel_session_start',
        'channel_session_cancel',
        'channel_session_start',
        'channel_session_cancel',
      ]);
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(parentDispatchServer.getShellActionRequestCount()).toBe(4);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('license 路由在子进程本地命中并通过 shell-actions 调用主进程壳能力', async () => {
    const port = createPort(175);
    const parentApiPort = createPort(176);
    const token = 'test-runtime-host-dispatch-token-license-shell-action';
    const shellActions: string[] = [];
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onShellAction: (body) => {
        shellActions.push(body.action);
        if (body.action === 'license_get_gate') {
          return {
            status: 200,
            payload: {
              version: 1,
              success: true,
              status: 200,
              data: {
                state: 'granted',
                reason: 'valid',
                checkedAtMs: Date.now(),
                hasStoredKey: true,
                hasUsableCache: true,
                nextRevalidateAtMs: null,
              },
            },
          };
        }
        if (body.action === 'license_get_stored_key') {
          return {
            status: 200,
            payload: {
              version: 1,
              success: true,
              status: 200,
              data: {
                key: 'MATCHACLAW-ABCD-EFGH-IJKL-MNOP',
              },
            },
          };
        }
        if (body.action === 'license_validate' || body.action === 'license_revalidate') {
          return {
            status: 200,
            payload: {
              version: 1,
              success: true,
              status: 200,
              data: {
                valid: true,
                code: 'valid',
              },
            },
          };
        }
        return {
          status: 200,
          payload: {
            version: 1,
            success: true,
            status: 200,
            data: { success: true },
          },
        };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();

      const gateResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/license/gate',
        }),
      });
      expect(gateResponse.status).toBe(200);

      const storedResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/license/stored-key',
        }),
      });
      expect(storedResponse.status).toBe(200);

      const validateResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/license/validate',
          payload: { key: 'MATCHACLAW-ABCD-EFGH-IJKL-MNOP' },
        }),
      });
      expect(validateResponse.status).toBe(200);

      const revalidateResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/license/revalidate',
        }),
      });
      expect(revalidateResponse.status).toBe(200);

      const clearResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/license/clear',
        }),
      });
      expect(clearResponse.status).toBe(200);

      expect(shellActions).toEqual([
        'license_get_gate',
        'license_get_stored_key',
        'license_validate',
        'license_revalidate',
        'license_clear',
      ]);
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(parentDispatchServer.getShellActionRequestCount()).toBe(5);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('channels 主路径在子进程本地处理并直连 gateway rpc，不走 parent dispatch', async () => {
    const port = createPort(73);
    const parentApiPort = createPort(74);
    const gatewayPort = createPort(75);
    const token = 'test-runtime-host-dispatch-token-channel-local';
    const gatewayToken = 'test-runtime-host-channel-gateway-token';
    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-channel-config-'));
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const gatewayServer = await startGatewayRpcServer(gatewayPort, gatewayToken, {
      onRequest: ({ method }) => {
        if (method === 'channels.status') {
          return {
            channelOrder: ['discord'],
            channels: { discord: { configured: true, enabled: true } },
            channelAccounts: { discord: [{ accountId: 'default', connected: false }] },
            channelDefaultAccountId: { discord: 'default' },
          };
        }
        if (method === 'channels.requestQr') {
          return { qrCode: 'qr://demo', sessionId: 'session-demo' };
        }
        return { success: true, method };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: gatewayToken,
      }),
    });

    try {
      await manager.start();

      const saveResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/channels/activate',
          payload: {
            channelType: 'discord',
            config: {
              token: 'discord-token',
              guildId: 'guild-1',
              channelId: 'channel-1',
            },
          },
        }),
      });
      const savePayload = await saveResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean };
      };
      expect(saveResponse.status).toBe(200);
      expect(savePayload.data?.success).toBe(true);

      const configuredResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/channels/configured',
        }),
      });
      const configuredPayload = await configuredResponse.json() as {
        success: boolean;
        status: number;
        data?: { channels?: string[] };
      };
      expect(configuredResponse.status).toBe(200);
      expect(configuredPayload.data?.channels).toContain('discord');

      const snapshotResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/channels/snapshot',
        }),
      });
      const snapshotPayload = await snapshotResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; snapshot?: { channelOrder?: string[] } };
      };
      expect(snapshotResponse.status).toBe(200);
      expect(snapshotPayload.data?.success).toBe(true);
      expect(snapshotPayload.data?.snapshot?.channelOrder).toEqual(['discord']);

      const qrResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/channels/request-qr',
          payload: { channelType: 'whatsapp' },
        }),
      });
      const qrPayload = await qrResponse.json() as {
        success: boolean;
        status: number;
        data?: { success?: boolean; qrCode?: string; sessionId?: string };
      };
      expect(qrResponse.status).toBe(200);
      expect(qrPayload.data).toMatchObject({
        success: true,
        qrCode: 'qr://demo',
        sessionId: 'session-demo',
      });

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      const rpcMethods = gatewayServer.getRequests().map((item) => item.method);
      expect(rpcMethods).toContain('channels.status');
      expect(rpcMethods).toContain('channels.requestQr');
    } finally {
      await manager.stop();
      await gatewayServer.close();
      await parentDispatchServer.close();
    }
  });

  it('runtime-host usage/recent 在子进程本地读取 transcript 聚合，不走 parent dispatch', async () => {
    const port = createPort(67);
    const parentApiPort = createPort(68);
    const token = 'test-runtime-host-dispatch-token-usage-local';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const configDir = mkdtempSync(join(tmpdir(), 'matchaclaw-openclaw-usage-'));
    const mainSessionsDir = join(configDir, 'agents', 'main', 'sessions');
    const workerSessionsDir = join(configDir, 'agents', 'worker', 'sessions');
    mkdirSync(mainSessionsDir, { recursive: true });
    mkdirSync(workerSessionsDir, { recursive: true });

    writeFileSync(
      join(mainSessionsDir, 'session-main.jsonl'),
      [
        JSON.stringify({
          timestamp: '2026-04-01T09:00:00.000Z',
          message: {
            role: 'assistant',
            provider: 'openai',
            model: 'gpt-4.1',
            usage: {
              promptTokens: 7,
              completionTokens: 3,
              totalTokens: 10,
              cost: { total: 0.0012 },
            },
          },
        }),
        JSON.stringify({
          timestamp: '2026-04-01T10:00:00.000Z',
          message: {
            role: 'assistant',
            provider: 'anthropic',
            model: 'claude-sonnet-4',
            usage: {
              input: 12,
              output: 6,
              cacheRead: 2,
              cacheWrite: 1,
              total: 21,
              cost: { total: 0.0021 },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    writeFileSync(
      join(workerSessionsDir, 'session-worker.jsonl'),
      `${JSON.stringify({
        timestamp: '2026-03-30T08:00:00.000Z',
        message: {
          role: 'assistant',
          provider: 'openai',
          modelRef: 'gpt-4o-mini',
          usage: {
            input: 3,
            output: 1,
            total: 4,
          },
        },
      })}\n`,
      'utf8',
    );

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/runtime-host/usage/recent',
          payload: { limit: 10 },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: Array<{
          timestamp?: string;
          sessionId?: string;
          agentId?: string;
          totalTokens?: number;
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
          provider?: string;
          model?: string;
          costUsd?: number;
        }>;
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.status).toBe(200);
      expect(Array.isArray(payload.data)).toBe(true);
      expect((payload.data?.length ?? 0)).toBeGreaterThanOrEqual(2);

      const anthropicMain = payload.data?.find((item) =>
        item.timestamp === '2026-04-01T10:00:00.000Z'
        && item.sessionId === 'session-main'
        && item.agentId === 'main');
      expect(anthropicMain).toMatchObject({
        timestamp: '2026-04-01T10:00:00.000Z',
        sessionId: 'session-main',
        agentId: 'main',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        inputTokens: 12,
        outputTokens: 6,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        totalTokens: 21,
        costUsd: 0.0021,
      });
      const openaiEntries = payload.data?.filter((item) => item.provider === 'openai') ?? [];
      expect(openaiEntries.length).toBeGreaterThan(0);

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('security 策略路由在子进程本地处理并落盘，不走 parent dispatch', async () => {
    const port = createPort(14);
    const parentApiPort = createPort(41);
    const gatewayPort = createPort(47);
    const token = 'test-runtime-host-dispatch-token-security-policy';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const configDir = mkdtempSync(join(tmpdir(), 'runtime-host-security-policy-'));

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
      }),
    });

    try {
      await manager.start();

      const initialResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/security',
        }),
      });
      const initialPayload = await initialResponse.json() as {
        success: boolean;
        status: number;
        data?: { preset?: string };
      };
      expect(initialResponse.status).toBe(200);
      expect(initialPayload.data?.preset).toBe('balanced');

      const updateResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/security',
          payload: {
            preset: 'strict',
            securityPolicyVersion: 11,
            runtime: {
              allowDomains: ['api.openai.com', '  ', 'api.openai.com'],
              blockDestructive: true,
            },
          },
        }),
      });
      const updatePayload = await updateResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          policy?: {
            preset?: string;
            securityPolicyVersion?: number;
            runtime?: { allowDomains?: string[] };
          };
        };
      };

      expect(updateResponse.status).toBe(200);
      expect(updatePayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          policy: {
            preset: 'strict',
            securityPolicyVersion: 11,
            runtime: {
              allowDomains: ['api.openai.com'],
            },
          },
        },
      });

      const policyPath = join(configDir, 'policies', 'security.policy.json');
      expect(existsSync(policyPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(policyPath, 'utf8')) as { preset?: string };
      expect(persisted.preset).toBe('strict');

      const afterResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/security',
        }),
      });
      const afterPayload = await afterResponse.json() as {
        success: boolean;
        status: number;
        data?: { preset?: string };
      };
      expect(afterResponse.status).toBe(200);
      expect(afterPayload.data?.preset).toBe('strict');
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('security destructive-rule-catalog 在子进程本地过滤，不走 parent dispatch', async () => {
    const port = createPort(15);
    const parentApiPort = createPort(42);
    const token = 'test-runtime-host-dispatch-token-security-catalog';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();

      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/security/destructive-rule-catalog?platform=windows',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          total?: number;
          items?: Array<{ platform?: string }>;
        };
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.status).toBe(200);
      expect(payload.data?.success).toBe(true);
      expect((payload.data?.total ?? 0) > 0).toBe(true);
      expect(payload.data?.items?.some((item) => item.platform === 'windows')).toBe(true);
      expect(
        payload.data?.items?.every((item) => item.platform === 'windows' || item.platform === 'universal'),
      ).toBe(true);
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('security audit 在子进程直连 gateway rpc，不走 parent dispatch', async () => {
    const port = createPort(16);
    const parentApiPort = createPort(43);
    const gatewayPort = createPort(44);
    const token = 'test-runtime-host-dispatch-token-security-audit';
    const gatewayToken = 'test-gateway-token-security-audit';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const gatewayServer = await startGatewayRpcServer(gatewayPort, gatewayToken, {
      onRequest: ({ method, params }) => {
        if (method === 'security.audit.query') {
          return {
            total: 1,
            items: [{ id: 'audit-1', params }],
          };
        }
        return { success: true, method };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: gatewayToken,
      }),
    });

    try {
      await manager.start();

      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/security/audit?page=1&pageSize=8&agentId=main',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          total?: number;
          items?: Array<{ id?: string; params?: Record<string, unknown> }>;
        };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: {
          total: 1,
          items: [
            {
              id: 'audit-1',
              params: {
                page: '1',
                pageSize: '8',
                agentId: 'main',
              },
            },
          ],
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(gatewayServer.getRequestCount()).toBe(1);
      expect(gatewayServer.getRequests()[0]).toMatchObject({
        method: 'security.audit.query',
      });
    } finally {
      await manager.stop();
      await gatewayServer.close();
      await parentDispatchServer.close();
    }
  });

  it('security emergency-response 在子进程本地执行锁定并直连 gateway rpc', async () => {
    const port = createPort(17);
    const parentApiPort = createPort(45);
    const gatewayPort = createPort(46);
    const token = 'test-runtime-host-dispatch-token-security-emergency';
    const gatewayToken = 'test-gateway-token-security-emergency';
    const configDir = mkdtempSync(join(tmpdir(), 'runtime-host-security-emergency-'));
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const gatewayServer = await startGatewayRpcServer(gatewayPort, gatewayToken, {
      onRequest: ({ method }) => {
        if (method === 'security.policy.sync') {
          return { synced: true };
        }
        if (method === 'security.emergency.run') {
          return { incidentId: 'incident-1' };
        }
        return { success: true, method };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: gatewayToken,
      }),
    });

    try {
      await manager.start();

      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/security/emergency-response',
          payload: {},
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          lockdownApplied?: boolean;
          emergency?: { incidentId?: string };
          emergencyError?: string | null;
          policy?: { preset?: string; securityPolicyVersion?: number };
        };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          lockdownApplied: true,
          emergency: {
            incidentId: 'incident-1',
          },
          emergencyError: null,
          policy: {
            preset: 'strict',
          },
        },
      });

      const policyPath = join(configDir, 'policies', 'security.policy.json');
      expect(existsSync(policyPath)).toBe(true);
      const persisted = JSON.parse(readFileSync(policyPath, 'utf8')) as { preset?: string };
      expect(persisted.preset).toBe('strict');

      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(gatewayServer.getRequestCount()).toBe(2);
      expect(gatewayServer.getRequests().map((item) => item.method)).toEqual([
        'security.policy.sync',
        'security.emergency.run',
      ]);
    } finally {
      await manager.stop();
      await gatewayServer.close();
      await parentDispatchServer.close();
    }
  });

  it('chat/send-with-media 在子进程直连 gateway chat.send，不走 parent dispatch', async () => {
    const port = createPort(18);
    const parentApiPort = createPort(47);
    const gatewayPort = createPort(48);
    const token = 'test-runtime-host-dispatch-token-send-with-media';
    const gatewayToken = 'test-gateway-token-send-with-media';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const gatewayServer = await startGatewayRpcServer(gatewayPort, gatewayToken, {
      onRequest: ({ method, params }) => {
        if (method === 'chat.send') {
          return { ok: true, echo: params };
        }
        return { success: true, method };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: gatewayToken,
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/chat/send-with-media',
          payload: {
            sessionKey: 'agent:main:session-1',
            message: 'hello',
            idempotencyKey: 'idem-1',
            deliver: true,
          },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          result?: {
            ok?: boolean;
            echo?: {
              sessionKey?: string;
              message?: string;
              idempotencyKey?: string;
              deliver?: boolean;
            };
          };
        };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          result: {
            ok: true,
            echo: {
              sessionKey: 'agent:main:session-1',
              message: 'hello',
              idempotencyKey: 'idem-1',
              deliver: true,
            },
          },
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(gatewayServer.getRequestCount()).toBe(1);
      expect(gatewayServer.getRequests()[0]?.method).toBe('chat.send');
    } finally {
      await manager.stop();
      await gatewayServer.close();
      await parentDispatchServer.close();
    }
  });

  it('cron/jobs 在子进程直连 gateway，不走 parent dispatch', async () => {
    const port = createPort(19);
    const parentApiPort = createPort(49);
    const gatewayPort = createPort(50);
    const token = 'test-runtime-host-dispatch-token-cron-jobs';
    const gatewayToken = 'test-gateway-token-cron-jobs';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const gatewayServer = await startGatewayRpcServer(gatewayPort, gatewayToken, {
      onRequest: ({ method }) => {
        if (method === 'cron.list') {
          return {
            jobs: [
              {
                id: 'job-1',
                name: 'Daily Report',
                enabled: true,
                createdAtMs: 1700000000000,
                updatedAtMs: 1700003600000,
                schedule: { kind: 'cron', expr: '0 9 * * *' },
                payload: { kind: 'agentTurn', message: 'report' },
                delivery: { mode: 'none' },
                state: {
                  nextRunAtMs: 1700010000000,
                },
              },
            ],
          };
        }
        return { success: true, method };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: gatewayToken,
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/cron/jobs',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: Array<{
          id?: string;
          name?: string;
          message?: string;
          enabled?: boolean;
          schedule?: { expr?: string };
        }>;
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: [
          {
            id: 'job-1',
            name: 'Daily Report',
            message: 'report',
            enabled: true,
            schedule: {
              expr: '0 9 * * *',
            },
          },
        ],
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(gatewayServer.getRequestCount()).toBe(1);
      expect(gatewayServer.getRequests()[0]?.method).toBe('cron.list');
    } finally {
      await manager.stop();
      await gatewayServer.close();
      await parentDispatchServer.close();
    }
  });

  it('cron/trigger 在子进程直连 gateway，不走 parent dispatch', async () => {
    const port = createPort(20);
    const parentApiPort = createPort(51);
    const gatewayPort = createPort(52);
    const token = 'test-runtime-host-dispatch-token-cron-trigger';
    const gatewayToken = 'test-gateway-token-cron-trigger';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);
    const gatewayServer = await startGatewayRpcServer(gatewayPort, gatewayToken, {
      onRequest: ({ method, params }) => {
        if (method === 'cron.list') {
          return {
            jobs: [
              {
                id: 'job-trigger-1',
                name: 'Trigger Job',
                sessionTarget: 'main',
                payload: { kind: 'agentTurn', message: 'run now' },
                state: {},
              },
            ],
          };
        }
        if (method === 'cron.run') {
          return {
            ran: true,
            reason: null,
            source: params,
          };
        }
        return { success: true, method };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(gatewayPort),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: gatewayToken,
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/cron/trigger',
          payload: { id: 'job-trigger-1' },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: { ran?: boolean; source?: { id?: string; mode?: string } };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: {
          ran: true,
          source: {
            id: 'job-trigger-1',
            mode: 'force',
          },
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(gatewayServer.getRequestCount()).toBe(2);
      expect(gatewayServer.getRequests().map((item) => item.method)).toEqual([
        'cron.list',
        'cron.run',
      ]);
    } finally {
      await manager.stop();
      await gatewayServer.close();
      await parentDispatchServer.close();
    }
  });

  it('cron/session-history 在子进程本地读取 run log，不走 parent dispatch', async () => {
    const port = createPort(21);
    const parentApiPort = createPort(53);
    const token = 'test-runtime-host-dispatch-token-cron-history';
    const configDir = mkdtempSync(join(tmpdir(), 'runtime-host-cron-history-'));
    const runDir = join(configDir, 'cron', 'runs');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, 'job-1.jsonl'),
      `${JSON.stringify({
        jobId: 'job-1',
        action: 'finished',
        status: 'ok',
        summary: 'scheduled output',
        runAtMs: 1700000000000,
        durationMs: 1200,
      })}\n`,
      'utf8',
    );
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        OPENCLAW_CONFIG_DIR: configDir,
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/cron/session-history?sessionKey=agent:main:cron:job-1&limit=10',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          messages?: Array<{ content?: string }>;
        };
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.status).toBe(200);
      expect(payload.data?.messages?.[0]?.content).toContain('scheduled output');
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('plugins/runtime GET is handled in child and reflects injected execution state', async () => {
    writeFileSync(join(openClawConfigDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['security-core', 'task-manager'],
        entries: {
          'security-core': { enabled: true },
          'task-manager': { enabled: true },
        },
      },
    }, null, 2));
    const port = createPort(6);
    const parentApiPort = createPort(33);
    const token = 'test-runtime-host-dispatch-token-plugins-runtime';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '0',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core', 'task-manager']),
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/plugins/runtime',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          execution?: {
            pluginExecutionEnabled?: boolean;
            enabledPluginIds?: string[];
          };
        };
      };

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          execution: {
            pluginExecutionEnabled: false,
            enabledPluginIds: ['security-core', 'task-manager'],
          },
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('plugins/catalog GET is handled in child and returns enabled projection', async () => {
    writeFileSync(join(openClawConfigDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['security-core'],
        entries: {
          'security-core': { enabled: true },
        },
      },
    }, null, 2));
    const port = createPort(7);
    const parentApiPort = createPort(34);
    const token = 'test-runtime-host-dispatch-token-plugins-catalog';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core']),
        MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify([
          {
            id: 'security-core',
            name: 'Security Core',
            version: '1.0.0',
            kind: 'builtin',
            category: 'security',
          },
          {
            id: 'task-manager',
            name: 'Task Manager',
            version: '1.2.0',
            kind: 'third-party',
            category: 'automation',
          },
        ]),
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/plugins/catalog',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          plugins?: Array<{ id: string; enabled: boolean }>;
        };
      };

      expect(response.status).toBe(200);
      expect(payload.success).toBe(true);
      expect(payload.status).toBe(200);
      expect(payload.data?.success).toBe(true);
      const plugins = payload.data?.plugins ?? [];
      expect(Array.isArray(plugins)).toBe(true);
      const securityCore = plugins.find((plugin) => plugin.id === 'security-core');
      const taskManager = plugins.find((plugin) => plugin.id === 'task-manager');
      expect(securityCore).toBeDefined();
      expect(taskManager).toBeDefined();
      expect(securityCore?.enabled).toBe(true);
      expect(taskManager?.enabled).toBe(false);
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('启动时会把配置里已启用的 managed 插件安装到 extensions', async () => {
    writeFileSync(join(openClawConfigDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['task-manager', 'security-core'],
        entries: {
          'task-manager': { enabled: true },
          'security-core': { enabled: true },
        },
      },
    }, null, 2));
    const port = createPort(41);
    const parentApiPort = createPort(42);
    const token = 'test-runtime-host-dispatch-token-managed-plugin-install-on-startup';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
    });

    try {
      await manager.start();

      expect(existsSync(join(openClawConfigDir, 'extensions', 'task-manager', 'openclaw.plugin.json'))).toBe(true);
      expect(existsSync(join(openClawConfigDir, 'extensions', 'security-core', 'openclaw.plugin.json'))).toBe(true);

      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/plugins/catalog',
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          plugins?: Array<{ id: string; enabled: boolean }>;
        };
      };

      expect(response.status).toBe(200);
      expect(payload.data?.plugins?.find((plugin) => plugin.id === 'task-manager')).toMatchObject({
        id: 'task-manager',
        enabled: true,
      });
      expect(payload.data?.plugins?.find((plugin) => plugin.id === 'security-core')).toMatchObject({
        id: 'security-core',
        enabled: true,
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('execution 路由仍走 execution-sync，且不会改写本地 enabled plugin 列表', async () => {
    writeFileSync(join(openClawConfigDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['security-core'],
        entries: {
          'security-core': { enabled: true },
        },
      },
    }, null, 2));
    const port = createPort(8);
    const parentApiPort = createPort(35);
    const token = 'test-runtime-host-dispatch-token-execution-sync';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onExecutionSync: (body) => {
        if (body.action === 'set_execution_enabled') {
          return {
            status: 200,
            payload: {
              version: 1,
              success: true,
              status: 200,
              data: {
                execution: {
                  pluginExecutionEnabled: false,
                  enabledPluginIds: [],
                },
              },
            },
          };
        }
        return {
          status: 200,
          payload: {
            version: 1,
            success: true,
            status: 200,
            data: {
              execution: {
                pluginExecutionEnabled: true,
                enabledPluginIds: [],
              },
            },
          },
        };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core']),
        MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify([
          {
            id: 'security-core',
            name: 'Security Core',
            version: '1.0.0',
            kind: 'builtin',
            category: 'security',
          },
        ]),
      }),
    });

    try {
      await manager.start();
      const toggleResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/plugins/runtime/execution',
          payload: { enabled: false },
        }),
      });
      expect(toggleResponse.status).toBe(200);
      const togglePayload = await toggleResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          execution?: {
            pluginExecutionEnabled?: boolean;
            enabledPluginIds?: string[];
          };
        };
      };
      expect(togglePayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          execution: {
            pluginExecutionEnabled: false,
            enabledPluginIds: ['security-core'],
          },
        },
      });

      const runtimeResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/plugins/runtime',
        }),
      });
      const runtimePayload = await runtimeResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          execution?: {
            pluginExecutionEnabled?: boolean;
            enabledPluginIds?: string[];
          };
        };
      };

      expect(runtimeResponse.status).toBe(200);
      expect(runtimePayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          execution: {
            pluginExecutionEnabled: false,
            enabledPluginIds: ['security-core'],
          },
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(1);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('enabled-plugins 在子进程本地改写 OpenClaw 配置后会触发 gateway_restart', async () => {
    const port = createPort(9);
    const parentApiPort = createPort(36);
    const token = 'test-runtime-host-dispatch-token-enabled-plugins-restart';
    const shellActionBodies: Array<{
      action:
        | 'gateway_restart'
        | 'provider_oauth_start'
        | 'provider_oauth_cancel'
        | 'provider_oauth_submit'
        | 'channel_session_start'
        | 'channel_session_cancel'
        | 'license_get_gate'
        | 'license_get_stored_key'
        | 'license_validate'
        | 'license_revalidate'
        | 'license_clear';
      payload?: unknown;
    }> = [];
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onShellAction: (body) => {
        shellActionBodies.push(body);
        return {
          status: 200,
          payload: {
            version: 1,
            success: true,
            status: 200,
            data: {
              execution: {
                pluginExecutionEnabled: true,
                enabledPluginIds: ['task-manager'],
              },
            },
          },
        };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core']),
        MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify([
          {
            id: 'security-core',
            name: 'Security Core',
            version: '1.0.0',
            kind: 'builtin',
            category: 'security',
          },
          {
            id: 'task-manager',
            name: 'Task Manager',
            version: '1.0.0',
            kind: 'builtin',
            category: 'automation',
          },
        ]),
      }),
    });

    try {
      await manager.start();
      const setEnabledPluginsResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/plugins/runtime/enabled-plugins',
          payload: { pluginIds: ['task-manager'] },
        }),
      });
      expect(setEnabledPluginsResponse.status).toBe(200);

      const runtimeResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/plugins/runtime',
        }),
      });
      const runtimePayload = await runtimeResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          execution?: {
            pluginExecutionEnabled?: boolean;
            enabledPluginIds?: string[];
          };
        };
      };
      expect(runtimeResponse.status).toBe(200);
      expect(runtimePayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          execution: {
            pluginExecutionEnabled: true,
            enabledPluginIds: ['task-manager'],
          },
        },
      });
      expect(shellActionBodies.map((item) => ({
        action: item.action,
        payload: item.payload,
      }))).toEqual([
        {
          action: 'gateway_restart',
          payload: undefined,
        },
      ]);
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
      expect(parentDispatchServer.getShellActionRequestCount()).toBe(1);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('enabled-plugins 写入口会忽略由频道配置派生的插件 ID', async () => {
    writeFileSync(join(openClawConfigDir, 'openclaw.json'), JSON.stringify({
      plugins: {
        allow: ['openclaw-lark'],
        entries: {
          'openclaw-lark': { enabled: true },
        },
      },
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            default: {
              appId: 'cli_xxx',
              appSecret: 'secret',
              enabled: true,
            },
          },
        },
      },
    }, null, 2));
    const port = createPort(63);
    const parentApiPort = createPort(64);
    const token = 'test-runtime-host-dispatch-token-ignore-channel-managed-plugin-ids';
    const shellActionBodies: Array<{
      action:
        | 'gateway_restart'
        | 'provider_oauth_start'
        | 'provider_oauth_cancel'
        | 'provider_oauth_submit'
        | 'channel_session_start'
        | 'channel_session_cancel'
        | 'license_get_gate'
        | 'license_get_stored_key'
        | 'license_validate'
        | 'license_revalidate'
        | 'license_clear';
      payload?: unknown;
    }> = [];
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onShellAction: (body) => {
        shellActionBodies.push(body);
        return {
          status: 200,
          payload: {
            version: 1,
            success: true,
            status: 200,
            data: {
              execution: {
                pluginExecutionEnabled: true,
                enabledPluginIds: ['openclaw-lark', 'task-manager'],
              },
            },
          },
        };
      },
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['openclaw-lark']),
        MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG: JSON.stringify([
          {
            id: 'openclaw-lark',
            name: 'OpenClaw Lark',
            version: '1.0.0',
            kind: 'builtin',
            category: 'channel',
          },
          {
            id: 'task-manager',
            name: 'Task Manager',
            version: '1.0.0',
            kind: 'builtin',
            category: 'automation',
          },
        ]),
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/plugins/runtime/enabled-plugins',
          payload: { pluginIds: ['task-manager'] },
        }),
      });
      expect(response.status).toBe(200);

      const config = JSON.parse(
        readFileSync(join(openClawConfigDir, 'openclaw.json'), 'utf8'),
      ) as {
        plugins?: {
          allow?: string[];
          entries?: Record<string, { enabled?: boolean }>;
        };
      };

      expect(config.plugins?.allow).toEqual(expect.arrayContaining(['openclaw-lark', 'task-manager']));
      expect(config.plugins?.entries?.['openclaw-lark']?.enabled).toBe(true);
      expect(config.plugins?.entries?.['task-manager']?.enabled).toBe(true);
      expect(shellActionBodies.map((item) => item.action)).toEqual(['gateway_restart']);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('execution-sync 写路径参数非法时在子进程本地返回 400 且不调用上游', async () => {
    const port = createPort(10);
    const parentApiPort = createPort(37);
    const token = 'test-runtime-host-dispatch-token-bad-request';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core']),
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/plugins/runtime/enabled-plugins',
          payload: { pluginIds: [1, 2, 3] },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        error?: { code?: string };
      };

      expect(response.status).toBe(400);
      expect(payload).toMatchObject({
        success: true,
        status: 400,
        data: {
          success: false,
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(0);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('execution-sync 上游拒绝时透传错误并保持失败语义', async () => {
    const port = createPort(11);
    const parentApiPort = createPort(38);
    const token = 'test-runtime-host-dispatch-token-forbidden';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token, {
      onExecutionSync: () => ({
        status: 403,
        payload: {
          version: 1,
          success: false,
          status: 403,
          error: {
            code: 'FORBIDDEN',
            message: 'Invalid runtime-host internal dispatch token',
          },
        },
      }),
    });

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core']),
      }),
    });

    try {
      await manager.start();
      const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/plugins/runtime/execution',
          payload: { enabled: false },
        }),
      });
      const payload = await response.json() as {
        success: boolean;
        status: number;
        error?: { code?: string };
      };

      expect(response.status).toBe(403);
      expect(payload).toMatchObject({
        success: false,
        status: 403,
        error: {
          code: 'FORBIDDEN',
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(1);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });

  it('transport-stats 会反映本地处理、execution-sync 与未实现路由命中情况', async () => {
    const port = createPort(13);
    const parentApiPort = createPort(40);
    const token = 'test-runtime-host-dispatch-token-transport-stats';
    const parentDispatchServer = await startParentDispatchServer(parentApiPort, token);

    const manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 8000,
      parentApiBaseUrl: `http://127.0.0.1:${parentApiPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_PLUGIN_EXECUTION_ENABLED: '1',
        MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS: JSON.stringify(['security-core']),
      }),
    });

    try {
      await manager.start();
      await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/runtime-host/health',
        }),
      });
      await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'PUT',
          route: '/api/plugins/runtime/execution',
          payload: { enabled: false },
        }),
      });
      await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'POST',
          route: '/api/echo',
          payload: { ok: true },
        }),
      });

      const statsResponse = await fetch(`http://127.0.0.1:${port}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: 1,
          method: 'GET',
          route: '/api/runtime-host/transport-stats',
        }),
      });
      const statsPayload = await statsResponse.json() as {
        success: boolean;
        status: number;
        data?: {
          success?: boolean;
          stats?: {
            totalDispatchRequests?: number;
            localBusinessHandled?: number;
            executionSyncHandled?: number;
            unhandledRouteCount?: number;
          };
        };
      };

      expect(statsResponse.status).toBe(200);
      expect(statsPayload).toMatchObject({
        success: true,
        status: 200,
        data: {
          success: true,
          stats: {
            totalDispatchRequests: 4,
            localBusinessHandled: 1,
            executionSyncHandled: 1,
            unhandledRouteCount: 1,
          },
        },
      });
      expect(parentDispatchServer.getDispatchRequestCount()).toBe(0);
      expect(parentDispatchServer.getExecutionSyncRequestCount()).toBe(1);
    } finally {
      await manager.stop();
      await parentDispatchServer.close();
    }
  });
});
