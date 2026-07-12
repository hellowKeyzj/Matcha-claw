import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { createRuntimeHostProcessManager, type RuntimeHostProcessManager } from '../../electron/main/process-runtime/runtime-host-process-manager';
import { RUNTIME_HOST_TRANSPORT_VERSION } from '../../electron/main/runtime-host-contract';

const scriptPath = join(process.cwd(), 'runtime-host', 'host-process.cjs');

let port = 0;
let manager: RuntimeHostProcessManager | null = null;
let parentServer: Awaited<ReturnType<typeof startParentApiServer>> | null = null;

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => rejectPort(new Error('无法分配可用端口')));
        return;
      }
      server.close((error) => {
        if (error) {
          rejectPort(error);
          return;
        }
        resolvePort(address.port);
      });
    });
  });
}

function writeParentResponse(res: ServerResponse, payload: unknown, statusCode = 200): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function startParentApiServer(parentPort: number, token: string): Promise<{ close: () => Promise<void> }> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers['x-runtime-host-dispatch-token'] !== token) {
      writeParentResponse(res, {
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        success: false,
        status: 403,
        error: { code: 'FORBIDDEN', message: 'invalid dispatch token' },
      }, 403);
      return;
    }
    writeParentResponse(res, {
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: true,
      status: 200,
      data: { ok: true },
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(parentPort, '127.0.0.1', resolveListen);
  });

  return {
    close: async () => {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      });
    },
  };
}

describe('runtime-host transport v1 contract', () => {
  beforeAll(async () => {
    const [runtimeHostPort, parentPort] = await Promise.all([findFreePort(), findFreePort()]);
    const token = 'test-runtime-host-dispatch-token-contract';
    parentServer = await startParentApiServer(parentPort, token);
    port = runtimeHostPort;
    manager = createRuntimeHostProcessManager({
      scriptPath,
      port,
      startTimeoutMs: 12000,
      parentApiBaseUrl: `http://127.0.0.1:${parentPort}`,
      parentDispatchToken: token,
      childEnv: () => ({
        MATCHACLAW_RUNTIME_HOST_DISABLE_BACKGROUND_SERVICES: '1',
      }),
    });
    await manager.start();
  }, 15000);

  afterAll(async () => {
    await manager?.stop();
    await parentServer?.close();
  });

  it('GET /health 返回 v1 固定字段', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      ok: true,
      lifecycle: 'running',
      pid: expect.any(Number),
      uptimeSec: expect.any(Number),
    }));
  });

  it('POST /dispatch 对版本不匹配返回标准 BAD_REQUEST 错误体', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 999,
        method: 'GET',
        route: '/api/runtime-host/health',
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload).toEqual(expect.objectContaining({
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: false,
      status: 400,
      error: expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Unsupported transport version'),
      }),
    }));
  });

  it('POST /dispatch 对非法 method 返回标准 BAD_REQUEST 错误体', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        method: 'PATCH',
        route: '/api/runtime-host/health',
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(400);
    expect(payload).toEqual(expect.objectContaining({
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: false,
      status: 400,
      error: expect.objectContaining({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Unsupported method'),
      }),
    }));
  });

  it('POST /dispatch 成功响应满足 success 结构', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: RUNTIME_HOST_TRANSPORT_VERSION,
        method: 'GET',
        route: '/api/runtime-host/health',
      }),
    });
    const payload = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(payload).toEqual(expect.objectContaining({
      version: RUNTIME_HOST_TRANSPORT_VERSION,
      success: true,
      status: 200,
      data: expect.objectContaining({
        success: true,
        state: expect.any(Object),
        health: expect.any(Object),
      }),
    }));
  });
});
