import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const getSettingMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('../../electron/services/settings/settings-store', () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

function createContext() {
  return {
    gatewayManager: {
      getStatus: vi.fn(() => ({ state: 'running', port: 18789 })),
      checkHealth: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => undefined),
      rpc: vi.fn(async () => ({ legacy: true })),
    },
    runtimeHost: {
      request: vi.fn(async () => ({
        status: 200,
        data: { success: true, result: { id: 'run-1' } },
      })),
    },
  };
}

describe('main gateway routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingMock.mockResolvedValue('token-test');
  });

  it('/api/gateway/rpc 通过 runtime-host 转发，不再直接调用 gatewayManager.rpc', async () => {
    const ctx = createContext();
    parseJsonBodyMock.mockResolvedValueOnce({
      method: 'chat.send',
      params: { message: 'hello' },
      timeoutMs: 10000,
    });
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/rpc'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.runtimeHost.request).toHaveBeenCalledWith('POST', '/api/gateway/rpc', {
      method: 'chat.send',
      params: { message: 'hello' },
      timeoutMs: 10000,
    });
    expect(ctx.gatewayManager.rpc).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      { success: true, result: { id: 'run-1' } },
    );
  });

  it('/api/gateway/rpc 缺少 method 时返回 400', async () => {
    const ctx = createContext();
    parseJsonBodyMock.mockResolvedValueOnce({ params: {} });
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/rpc'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.runtimeHost.request).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      400,
      { success: false, error: 'method is required' },
    );
  });
});

