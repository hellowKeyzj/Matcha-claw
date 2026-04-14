import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createRuntimeHostProcessManager } from '../../electron/main/runtime-host-process-manager';
import { RUNTIME_HOST_TRANSPORT_VERSION } from '../../electron/main/runtime-host-contract';

const scriptPath = join(process.cwd(), 'runtime-host', 'host-process.cjs');
const port = 46391;

const manager = createRuntimeHostProcessManager({
  scriptPath,
  port,
  startTimeoutMs: 8000,
  parentApiBaseUrl: 'http://127.0.0.1:3210',
  parentDispatchToken: 'test-runtime-host-dispatch-token-contract',
});

describe('runtime-host transport v1 contract', () => {
  beforeAll(async () => {
    await manager.start();
  });

  afterAll(async () => {
    await manager.stop();
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
