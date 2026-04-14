import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostRouteResult } from '../../electron/main/runtime-host-contract';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const sendNoContentMock = vi.fn();

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
  sendNoContent: (...args: unknown[]) => sendNoContentMock(...args),
}));

describe('runtime-host proxy routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('GET /api/* 路由会透传到 runtime-host.request', async () => {
    const runtimeHostRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true },
    } satisfies RuntimeHostRouteResult);

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/security/audit?limit=20'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).toHaveBeenCalledWith('GET', '/api/security/audit?limit=20', undefined);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('GET /api/platform/* 路由会走 runtime-host 转发而不是主进程本地处理', async () => {
    const runtimeHostRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, tools: [] },
    } satisfies RuntimeHostRouteResult);

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/platform/tools?includeDisabled=true'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).toHaveBeenCalledWith('GET', '/api/platform/tools?includeDisabled=true', undefined);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true, tools: [] });
  });

  it('POST /api/* 路由会解析 body 并透传到 runtime-host.request', async () => {
    parseJsonBodyMock.mockResolvedValueOnce({ id: 'job-1' });
    const runtimeHostRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true },
    } satisfies RuntimeHostRouteResult);

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/cron/trigger'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).toHaveBeenCalledWith('POST', '/api/cron/trigger', { id: 'job-1' });
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('OPTIONS /api/* 返回 204', async () => {
    const runtimeHostRequest = vi.fn();

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'OPTIONS' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/license/gate'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).not.toHaveBeenCalled();
    expect(sendNoContentMock).toHaveBeenCalledTimes(1);
  });

  it('main-owned 路由不会被 runtime-host-proxy 转发', async () => {
    const runtimeHostRequest = vi.fn();

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/gateway/status'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(false);
    expect(runtimeHostRequest).not.toHaveBeenCalled();
    expect(sendJsonMock).not.toHaveBeenCalled();
  });

  it('插件运行态路由会走 runtime-host-proxy 转发', async () => {
    const runtimeHostRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true },
    } satisfies RuntimeHostRouteResult);
    parseJsonBodyMock.mockResolvedValueOnce({ pluginIds: ['task-manager'] });

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/runtime/enabled-plugins'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).toHaveBeenCalledWith(
      'PUT',
      '/api/plugins/runtime/enabled-plugins',
      { pluginIds: ['task-manager'] },
    );
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });
});
