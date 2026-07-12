import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const loadHostBootstrapSettingsMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('../../electron/main/process-runtime/openclaw-gateway/config-sync', () => ({
  loadHostBootstrapSettings: (...args: unknown[]) => loadHostBootstrapSettingsMock(...args),
}));

function createContext() {
  return {
    gatewayManager: {
      getStatus: vi.fn(() => ({ processState: 'running', port: 18789 })),
      checkHealth: vi.fn(async () => ({ ok: true })),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      restart: vi.fn(async () => ({ status: 'restarted' as const })),
      rpc: vi.fn(async () => ({ legacy: true })),
    },
    runtimeHost: {
      request: vi.fn(async (_method: string, route: string) => {
        if (route === '/api/runtime-endpoints/list') {
          return {
            status: 200,
            data: {
              endpoints: [{
                kind: 'native-runtime',
                runtimeAdapterId: 'openclaw',
                runtimeInstanceId: 'local',
                capabilitySummaries: [{ id: 'runtime.host', availability: 'available' }],
              }],
            },
          };
        }
        if (route === '/api/capabilities/list') {
          return {
            status: 200,
            data: {
              capabilities: [{
                id: 'runtime.host',
                scope: { kind: 'runtime-instance', endpoint: { kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' } },
                availability: 'available',
              }],
            },
          };
        }
        return {
          status: 200,
          data: { success: true, result: { id: 'run-1' } },
        };
      }),
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

  it('/api/gateway/status 返回 public gateway status projection', async () => {
    const ctx = createContext();
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/status'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.gatewayManager.getStatus).toHaveBeenCalledTimes(1);
    expect(ctx.runtimeHost.readGatewayStatus).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      {
        processState: 'running',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'degraded',
        transportState: 'reconnecting',
        portReachable: true,
        lastAliveAt: 1200,
        lastError: 'connect timeout',
        diagnostics: {
          lastAliveAt: 1200,
          consecutiveHeartbeatMisses: 1,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1234,
      },
    );
  });

  it('/api/gateway/start 通过 GatewayManager facade 启动', async () => {
    const ctx = createContext();
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/start'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.gatewayManager.start).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
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

  it('/api/gateway/control-ui GET 只返回控制台入口，不触发配对自动批准副作用', async () => {
    vi.useFakeTimers();
    try {
      const ctx = createContext();
      const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

      const handled = await handleGatewayRoutes(
        { method: 'GET' } as IncomingMessage,
        {} as ServerResponse,
        new URL('http://127.0.0.1:3210/api/gateway/control-ui'),
        ctx as never,
      );

      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
      }

      expect(handled).toBe(true);
      expect(ctx.runtimeHost.request).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(sendJsonMock).toHaveBeenCalledWith(
        expect.anything(),
        200,
        expect.objectContaining({
          success: true,
          url: 'http://127.0.0.1:18789/',
          port: 18789,
        }),
      );
      expect(JSON.stringify(sendJsonMock.mock.calls)).not.toContain('token-test');
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('/api/gateway/restart 会在后端重启后重建 runtime-host 控制通道', async () => {
    const ctx = createContext();
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/restart'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.gatewayManager.restart).toHaveBeenCalledTimes(1);
    expect(ctx.runtimeHost.request).toHaveBeenCalledWith(
      'POST',
      '/api/gateway/recover',
      { reason: 'gateway-restart', timeoutMs: 15000 },
      { timeoutMs: 20000 },
    );
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('/api/gateway/restart 被延迟时不提前重建 runtime-host 控制通道', async () => {
    const ctx = createContext();
    ctx.gatewayManager.restart.mockResolvedValueOnce({ status: 'deferred' });
    const { handleGatewayRoutes } = await import('../../electron/api/routes/gateway');

    const handled = await handleGatewayRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/restart'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.gatewayManager.restart).toHaveBeenCalledTimes(1);
    expect(ctx.runtimeHost.request).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      deferred: true,
    });
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
