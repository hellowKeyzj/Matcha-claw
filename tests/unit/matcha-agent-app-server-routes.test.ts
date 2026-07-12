import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendJsonMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

function createContext(options: {
  lifecycle: string;
  port?: number;
  pid?: number;
  lastError?: string;
  endpointPort?: number;
  restartError?: unknown;
} = { lifecycle: 'running' }) {
  return {
    matchaAgentAppServerManager: {
      getState: vi.fn(() => ({
        lifecycle: options.lifecycle,
        ...(options.port === undefined ? {} : { port: options.port }),
        ...(options.pid === undefined ? {} : { pid: options.pid }),
        ...(options.lastError === undefined ? {} : { lastError: options.lastError }),
      })),
      getEndpointSnapshot: vi.fn(() => ({
        enabled: true,
        url: 'http://127.0.0.1:39090?token=secret-endpoint-token',
        token: 'secret-endpoint-token',
        port: options.endpointPort ?? 39090,
        storageRoot: 'C:/private/matcha-agent/storage-root',
      })),
      restart: options.restartError === undefined
        ? vi.fn(async () => undefined)
        : vi.fn(async () => { throw options.restartError; }),
    },
  };
}

describe('matcha-agent app-server routes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.006Z'));
    sendJsonMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('GET /api/matcha-agent/app-server/status 返回 public status 且不暴露 endpoint 私有字段', async () => {
    const ctx = createContext({
      lifecycle: 'running',
      pid: 12345,
      lastError: 'previous failure',
      endpointPort: 40123,
    });
    const { handleMatchaAgentAppServerRoutes } = await import('../../electron/api/routes/matcha-agent-app-server');

    const handled = await handleMatchaAgentAppServerRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/matcha-agent/app-server/status'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.matchaAgentAppServerManager.getState).toHaveBeenCalledTimes(1);
    expect(ctx.matchaAgentAppServerManager.getEndpointSnapshot).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        processState: 'running',
        port: 40123,
        pid: 12345,
        ready: true,
        lastError: 'previous failure',
        updatedAt: Date.now(),
      },
    );

    const payload = sendJsonMock.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual([
      'lastError',
      'pid',
      'port',
      'processState',
      'ready',
      'updatedAt',
    ]);
    const responseJson = JSON.stringify(payload);
    expect(responseJson).not.toContain('secret-endpoint-token');
    expect(responseJson).not.toContain('http://127.0.0.1:39090');
    expect(responseJson).not.toContain('storageRoot');
    expect(responseJson).not.toContain('C:/private/matcha-agent/storage-root');
  });

  it('state.port 缺失时只使用 endpoint snapshot 的 port fallback', async () => {
    const ctx = createContext({ lifecycle: 'starting', endpointPort: 39091 });
    const { handleMatchaAgentAppServerRoutes } = await import('../../electron/api/routes/matcha-agent-app-server');

    const handled = await handleMatchaAgentAppServerRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/matcha-agent/app-server/status'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        processState: 'starting',
        port: 39091,
        pid: null,
        ready: false,
        lastError: null,
        updatedAt: Date.now(),
      },
    );
  });

  it('POST /api/matcha-agent/app-server/status 不由只读 status route 处理', async () => {
    const ctx = createContext();
    const { handleMatchaAgentAppServerRoutes } = await import('../../electron/api/routes/matcha-agent-app-server');

    const handled = await handleMatchaAgentAppServerRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/matcha-agent/app-server/status'),
      ctx as never,
    );

    expect(handled).toBe(false);
    expect(ctx.matchaAgentAppServerManager.getState).not.toHaveBeenCalled();
    expect(ctx.matchaAgentAppServerManager.getEndpointSnapshot).not.toHaveBeenCalled();
    expect(ctx.matchaAgentAppServerManager.restart).not.toHaveBeenCalled();
    expect(sendJsonMock).not.toHaveBeenCalled();
  });

  it('POST /api/matcha-agent/app-server/restart 调用 manager.restart 并返回成功', async () => {
    const ctx = createContext();
    const { handleMatchaAgentAppServerRoutes } = await import('../../electron/api/routes/matcha-agent-app-server');

    const handled = await handleMatchaAgentAppServerRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/matcha-agent/app-server/restart'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.matchaAgentAppServerManager.restart).toHaveBeenCalledTimes(1);
    expect(ctx.matchaAgentAppServerManager.getState).not.toHaveBeenCalled();
    expect(ctx.matchaAgentAppServerManager.getEndpointSnapshot).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('POST /api/matcha-agent/app-server/restart 失败时返回 500 且只暴露 String(error)', async () => {
    const ctx = createContext({ lifecycle: 'running', restartError: new Error('restart failed') });
    const { handleMatchaAgentAppServerRoutes } = await import('../../electron/api/routes/matcha-agent-app-server');

    const handled = await handleMatchaAgentAppServerRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/matcha-agent/app-server/restart'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.matchaAgentAppServerManager.restart).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 500, {
      success: false,
      error: 'Error: restart failed',
    });
  });

  it('GET /api/matcha-agent/app-server/restart 不由 restart route 处理', async () => {
    const ctx = createContext();
    const { handleMatchaAgentAppServerRoutes } = await import('../../electron/api/routes/matcha-agent-app-server');

    const handled = await handleMatchaAgentAppServerRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/matcha-agent/app-server/restart'),
      ctx as never,
    );

    expect(handled).toBe(false);
    expect(ctx.matchaAgentAppServerManager.restart).not.toHaveBeenCalled();
    expect(sendJsonMock).not.toHaveBeenCalled();
  });
});
