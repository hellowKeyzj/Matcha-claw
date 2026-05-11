import { describe, expect, it, vi } from 'vitest';
import { createRuntimeRouteDispatcher } from '../../runtime-host/api/dispatch/runtime-route-dispatcher';

describe('runtime-host process runtime route dispatcher', () => {
  it('按组合根注册的路由表直接命中领域 handler，api 层不负责服务装配', async () => {
    const first = vi.fn(() => null);
    const second = vi.fn(() => ({
      status: 200,
      data: { success: true },
    }));
    const dispatcher = createRuntimeRouteDispatcher([
      { key: 'workbench', matcher: { type: 'exact', path: '/api/workbench/bootstrap' }, handle: first },
      { key: 'runtime_host', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: second },
    ]);

    const result = await dispatcher('GET', '/api/runtime-host/health?x=1', undefined);

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      route: '/api/runtime-host/health?x=1',
      routePath: '/api/runtime-host/health',
    }));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('未命中路由表时不会调用任何领域 handler', async () => {
    const handler = vi.fn(() => ({
      status: 200,
      data: { success: true },
    }));
    const dispatcher = createRuntimeRouteDispatcher([
      { key: 'runtime_host', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: handler },
    ]);

    await expect(dispatcher('GET', '/api/unknown', undefined)).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });
});
