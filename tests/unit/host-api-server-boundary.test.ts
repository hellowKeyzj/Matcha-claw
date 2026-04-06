import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const hoisted = vi.hoisted(() => ({
  handleAppRoutesMock: vi.fn(async () => false),
  handleGatewayRoutesMock: vi.fn(async () => false),
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
});

