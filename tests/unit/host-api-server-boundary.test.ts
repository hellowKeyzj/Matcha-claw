import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const hoisted = vi.hoisted(() => ({
  handleAppRoutesMock: vi.fn(async () => false),
  handleGatewayRoutesMock: vi.fn(async () => false),
  handlePluginRoutesMock: vi.fn(async () => false),
  handleRuntimeHostInternalRoutesMock: vi.fn(async () => false),
  handleFileRoutesMock: vi.fn(async () => false),
  handleDiagnosticsRoutesMock: vi.fn(async () => false),
  handleLogRoutesMock: vi.fn(async () => false),
  handleRuntimeHostProxyRoutesMock: vi.fn(async () => false),
  sendJsonMock: vi.fn(),
}));

vi.mock('../../electron/api/routes/app', () => ({
  handleAppRoutes: (...args: unknown[]) => hoisted.handleAppRoutesMock(...args),
}));

vi.mock('../../electron/api/routes/gateway', () => ({
  handleGatewayRoutes: (...args: unknown[]) => hoisted.handleGatewayRoutesMock(...args),
}));

vi.mock('../../electron/api/routes/plugins', () => ({
  handlePluginRoutes: (...args: unknown[]) => hoisted.handlePluginRoutesMock(...args),
}));

vi.mock('../../electron/api/routes/runtime-host-internal', () => ({
  handleRuntimeHostInternalRoutes: (...args: unknown[]) => hoisted.handleRuntimeHostInternalRoutesMock(...args),
}));

vi.mock('../../electron/api/routes/files', () => ({
  handleFileRoutes: (...args: unknown[]) => hoisted.handleFileRoutesMock(...args),
}));

vi.mock('../../electron/api/routes/diagnostics', () => ({
  handleDiagnosticsRoutes: (...args: unknown[]) => hoisted.handleDiagnosticsRoutesMock(...args),
}));

vi.mock('../../electron/api/routes/logs', () => ({
  handleLogRoutes: (...args: unknown[]) => hoisted.handleLogRoutesMock(...args),
}));

vi.mock('../../electron/api/routes/runtime-host-proxy', () => ({
  handleRuntimeHostProxyRoutes: (...args: unknown[]) => hoisted.handleRuntimeHostProxyRoutesMock(...args),
}));

vi.mock('../../electron/api/route-utils', () => ({
  sendJson: (...args: unknown[]) => hoisted.sendJsonMock(...args),
  setCorsHeaders: vi.fn(),
  requireJsonContentType: vi.fn(() => true),
}));

vi.mock('../../electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('host api server boundary guard', () => {
  async function issueHostApiToken(): Promise<string> {
    const { startHostApiServer, getHostApiToken } = await import('../../electron/api/server');
    const port = 46000 + Math.floor(Math.random() * 1000);
    const server = startHostApiServer({} as never, port);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    return getHostApiToken();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('main-owned 路由未命中处理器时返回 500', async () => {
    const { createHostApiRequestHandler } = await import('../../electron/api/server');
    const handler = createHostApiRequestHandler({} as never, 3210);

    await handler(
      { method: 'GET', url: '/api/gateway/status' } as IncomingMessage,
      {} as ServerResponse,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({
        success: false,
        error: expect.stringContaining('Main-owned route is not registered'),
      }),
    );
  });

  it('非 main-owned 且未命中时返回 404', async () => {
    const { createHostApiRequestHandler } = await import('../../electron/api/server');
    const handler = createHostApiRequestHandler({} as never, 3210);

    await handler(
      { method: 'GET', url: '/api/unknown/endpoint' } as IncomingMessage,
      {} as ServerResponse,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      404,
      expect.objectContaining({
        success: false,
        error: 'No route for GET /api/unknown/endpoint',
      }),
    );
  });

  it('前置处理器已命中时不触发 fallback', async () => {
    hoisted.handleAppRoutesMock.mockResolvedValueOnce(true);
    const { createHostApiRequestHandler } = await import('../../electron/api/server');
    const handler = createHostApiRequestHandler({} as never, 3210);

    await handler(
      { method: 'GET', url: '/api/app/gateway-info' } as IncomingMessage,
      {} as ServerResponse,
    );

    expect(hoisted.handleAppRoutesMock).toHaveBeenCalledTimes(1);
    expect(hoisted.sendJsonMock).not.toHaveBeenCalled();
  });

  it('仅 internal runtime-host 路由跳过 Bearer 鉴权', async () => {
    const { shouldBypassHostApiBearerAuth } = await import('../../electron/api/server');
    expect(shouldBypassHostApiBearerAuth('/internal/runtime-host/shell-actions', 'POST')).toBe(true);
    expect(shouldBypassHostApiBearerAuth('/api/events', 'GET')).toBe(false);
    expect(shouldBypassHostApiBearerAuth('/api/events', 'POST')).toBe(false);
    expect(shouldBypassHostApiBearerAuth('/api/gateway/status', 'GET')).toBe(false);
  });

  it('/api/events 支持 query token 鉴权通过', async () => {
    const token = await issueHostApiToken();
    hoisted.handleAppRoutesMock.mockResolvedValueOnce(true);

    const { createHostApiRequestHandler } = await import('../../electron/api/server');
    const handler = createHostApiRequestHandler({} as never, 3210);

    await handler(
      { method: 'GET', url: `/api/events?token=${token}`, headers: {} } as IncomingMessage,
      {} as ServerResponse,
    );

    expect(hoisted.sendJsonMock).not.toHaveBeenCalledWith(
      expect.anything(),
      401,
      expect.objectContaining({ success: false, error: 'Unauthorized' }),
    );
    expect(hoisted.handleAppRoutesMock).toHaveBeenCalledTimes(1);
  });

  it('/api/events 缺少 token 时返回 401', async () => {
    await issueHostApiToken();

    const { createHostApiRequestHandler } = await import('../../electron/api/server');
    const handler = createHostApiRequestHandler({} as never, 3210);

    await handler(
      { method: 'GET', url: '/api/events', headers: {} } as IncomingMessage,
      {} as ServerResponse,
    );

    expect(hoisted.sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      401,
      expect.objectContaining({ success: false, error: 'Unauthorized' }),
    );
    expect(hoisted.handleAppRoutesMock).not.toHaveBeenCalled();
  });
});
