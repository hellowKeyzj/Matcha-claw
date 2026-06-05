import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const loadHostBootstrapSettingsMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('../../electron/gateway/config-sync', () => ({
  loadHostBootstrapSettings: (...args: unknown[]) => loadHostBootstrapSettingsMock(...args),
}));

function createContext() {
  return {
    gatewayManager: {
      getStatus: vi.fn(() => ({ processState: 'running', port: 18789 })),
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
      readGatewayStatus: vi.fn(async () => ({
        state: 'reconnecting',
        portReachable: true,
        gatewayReady: false,
        healthSummary: 'degraded',
        diagnostics: {
          lastAliveAt: 1200,
          consecutiveHeartbeatMisses: 1,
          consecutiveRpcFailures: 0,
        },
        lastError: 'connect timeout',
        updatedAt: 1234,
      })),
    },
  };
}

describe('main gateway routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadHostBootstrapSettingsMock.mockResolvedValue({
      gatewayToken: 'token-test',
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '',
      gatewayAutoStart: true,
      launchAtStartup: false,
    });
  });

  it('/api/gateway/rpc 不再由 Main 作为通用 Gateway 后门处理', async () => {
    const ctx = createContext();
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/rpc'),
      ctx as never,
    );

    expect(handled).toBe(false);
    expect(ctx.runtimeHost.request).not.toHaveBeenCalled();
    expect(ctx.gatewayManager.rpc).not.toHaveBeenCalled();
    expect(sendJsonMock).not.toHaveBeenCalled();
  });

  it('/api/gateway/control-ui 返回使用 hash token 的 URL，并触发 Control UI 配对自动批准', async () => {
    vi.useFakeTimers();
    const ctx = createContext();
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/control-ui'),
      ctx as never,
    );

    await Promise.resolve();
    await Promise.resolve();
    vi.clearAllTimers();
    vi.useRealTimers();

    expect(handled).toBe(true);
    expect(ctx.runtimeHost.request).toHaveBeenCalledWith(
      'POST',
      '/api/gateway/control-ui/auto-approve',
      {},
      { timeoutMs: 20000 },
    );
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        url: 'http://127.0.0.1:18789/#token=token-test',
        token: 'token-test',
        port: 18789,
      }),
    );
  });

  it('/api/gateway/health 直接透传 runtime health 的端口态和连接态', async () => {
    const ctx = createContext();
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/health'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        ok: true,
        status: 'degraded',
        detail: 'gateway control channel not ready',
        portReachable: true,
        connectionState: 'reconnecting',
        lastError: 'connect timeout',
        updatedAt: 1234,
      },
    );
  });
});
