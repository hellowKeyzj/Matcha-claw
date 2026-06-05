import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import type { RuntimeHostRouteResult } from '../../electron/main/runtime-host-contract';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const sendNoContentMock = vi.fn();

const schedulerCronRuntimeAddress: RuntimeAddress = {
  kind: 'native-runtime',
  capabilityId: 'scheduler.cron',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
};

const pluginRuntimeAddress: RuntimeAddress = {
  kind: 'native-runtime',
  capabilityId: 'plugin.runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
};

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
    expect(runtimeHostRequest).toHaveBeenCalledWith('GET', '/api/security/audit?limit=20', undefined, undefined);
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
    expect(runtimeHostRequest).toHaveBeenCalledWith('GET', '/api/platform/tools?includeDisabled=true', undefined, undefined);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true, tools: [] });
  });

  it('POST /api/* 路由会解析 body 并透传到 runtime-host.request', async () => {
    const payload = {
      id: 'scheduler.cron',
      operationId: 'cron.trigger',
      runtimeAddress: schedulerCronRuntimeAddress,
      input: {
        runtimeAddress: schedulerCronRuntimeAddress,
      },
    };
    parseJsonBodyMock.mockResolvedValueOnce(payload);
    const runtimeHostRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true },
    } satisfies RuntimeHostRouteResult);

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/capabilities/execute'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).toHaveBeenCalledWith('POST', '/api/capabilities/execute', payload, undefined);
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

  it('插件运行态写能力会走 runtime-host-proxy 转发', async () => {
    const runtimeHostRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true },
    } satisfies RuntimeHostRouteResult);
    const payload = {
      id: 'plugin.runtime',
      operationId: 'plugins.setEnabled',
      runtimeAddress: pluginRuntimeAddress,
      input: {
        runtimeAddress: pluginRuntimeAddress,
        pluginId: 'plugin-1',
        enabled: true,
      },
    };
    parseJsonBodyMock.mockResolvedValueOnce(payload);

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/capabilities/execute'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      payload,
      undefined,
    );
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
  });

  it('透传 renderer 指定的 timeoutMs 到 runtime-host transport', async () => {
    const payload = {
      id: 'scheduler.cron',
      operationId: 'cron.trigger',
      runtimeAddress: schedulerCronRuntimeAddress,
      input: {
        runtimeAddress: schedulerCronRuntimeAddress,
      },
    };
    parseJsonBodyMock.mockResolvedValueOnce(payload);
    const runtimeHostRequest = vi.fn().mockResolvedValue({
      status: 200,
      data: { success: true, task: { id: 'task-1' } },
    } satisfies RuntimeHostRouteResult);

    const { handleRuntimeHostProxyRoutes } = await import('../../electron/api/routes/runtime-host-proxy');
    const handled = await handleRuntimeHostProxyRoutes(
      {
        method: 'POST',
        headers: {
          'x-matchaclaw-request-timeout-ms': '60000',
        },
      } as unknown as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/capabilities/execute'),
      { runtimeHost: { request: runtimeHostRequest } } as never,
    );

    expect(handled).toBe(true);
    expect(runtimeHostRequest).toHaveBeenCalledWith(
      'POST',
      '/api/capabilities/execute',
      payload,
      { timeoutMs: 60000 },
    );
  });
});
