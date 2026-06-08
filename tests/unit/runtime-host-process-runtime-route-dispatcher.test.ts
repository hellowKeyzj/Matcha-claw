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
      { key: 'workbench', method: 'GET', matcher: { type: 'exact', path: '/api/workbench/bootstrap' }, handle: first },
      { key: 'runtime_host', method: 'GET', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: second },
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
      { key: 'runtime_host', method: 'GET', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: handler },
    ]);

    await expect(dispatcher('GET', '/api/unknown', undefined)).resolves.toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it('exact 路由通过 method/path 索引直达，不扫描同 method fallback', async () => {
    const exact = vi.fn(() => ({
      status: 200,
      data: { success: true, route: 'exact' },
    }));
    const fallback = vi.fn(() => ({
      status: 200,
      data: { success: true, route: 'fallback' },
    }));
    const otherMethod = vi.fn(() => ({
      status: 200,
      data: { success: true, route: 'other' },
    }));
    const dispatcher = createRuntimeRouteDispatcher([
      { key: 'runtime_host.POST /api/runtime-host/exact-action', method: 'POST', matcher: { type: 'exact', path: '/api/runtime-host/exact-action' }, handle: exact },
      { key: 'runtime_host.POST /api/runtime-host/', method: 'POST', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: fallback },
      { key: 'runtime_host.GET /api/runtime-host/', method: 'GET', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: otherMethod },
    ]);

    await expect(dispatcher('POST', '/api/runtime-host/exact-action', undefined)).resolves.toEqual({
      status: 200,
      data: { success: true, route: 'exact' },
    });
    expect(exact).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(otherMethod).not.toHaveBeenCalled();
  });

  it('exact 路由在大路由表中仍只调用目标 handler', async () => {
    const exact = vi.fn(() => ({
      status: 200,
      data: { route: 'exact' },
    }));
    const fallbackHandlers = Array.from({ length: 1000 }, (_, index) => vi.fn(() => ({
      status: 200,
      data: { route: `fallback-${index}` },
    })));
    const dispatcher = createRuntimeRouteDispatcher([
      ...fallbackHandlers.map((handle, index) => ({
        key: `pattern-${index}`,
        method: 'POST',
        matcher: { type: 'pattern' as const, pattern: new RegExp(`^/api/pattern-${index}/`) },
        handle,
      })),
      { key: 'target', method: 'POST', matcher: { type: 'exact', path: '/api/target' }, handle: exact },
    ]);

    await expect(dispatcher('POST', '/api/target', undefined)).resolves.toEqual({
      status: 200,
      data: { route: 'exact' },
    });
    expect(exact).toHaveBeenCalledTimes(1);
    expect(fallbackHandlers.every((handle) => handle.mock.calls.length === 0)).toBe(true);
  });

  it('exact handler 返回 null 时继续检查同 method fallback', async () => {
    const exact = vi.fn(() => null);
    const fallback = vi.fn(() => ({
      status: 200,
      data: { success: true, route: 'fallback' },
    }));
    const dispatcher = createRuntimeRouteDispatcher([
      { key: 'runtime_host.POST /api/runtime-host/exact-action', method: 'POST', matcher: { type: 'exact', path: '/api/runtime-host/exact-action' }, handle: exact },
      { key: 'runtime_host.POST /api/runtime-host/', method: 'POST', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: fallback },
    ]);

    await expect(dispatcher('POST', '/api/runtime-host/exact-action', undefined)).resolves.toEqual({
      status: 200,
      data: { success: true, route: 'fallback' },
    });
    expect(exact).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('rejects duplicate exact routes for the same method and path', () => {
    expect(() => createRuntimeRouteDispatcher([
      { key: 'first', method: 'POST', matcher: { type: 'exact', path: '/api/runtime-host/exact-action' }, handle: vi.fn() },
      { key: 'second', method: 'POST', matcher: { type: 'exact', path: '/api/runtime-host/exact-action' }, handle: vi.fn() },
    ])).toThrow('Duplicate exact runtime route: POST /api/runtime-host/exact-action (first vs second)');
  });

  it('prefix trie 只调用匹配分支并保留 fallback 注册顺序', async () => {
    const unmatchedPrefix = vi.fn(() => ({
      status: 200,
      data: { route: 'unmatched-prefix' },
    }));
    const pattern = vi.fn(() => ({
      status: 200,
      data: { route: 'pattern' },
    }));
    const prefix = vi.fn(() => ({
      status: 200,
      data: { route: 'prefix' },
    }));
    const dispatcher = createRuntimeRouteDispatcher([
      { key: 'unmatched', method: 'GET', matcher: { type: 'prefix', prefix: '/api/unmatched/' }, handle: unmatchedPrefix },
      { key: 'pattern', method: 'GET', matcher: { type: 'pattern', pattern: /^\/api\/runtime-host\/jobs\// }, handle: pattern },
      { key: 'prefix', method: 'GET', matcher: { type: 'prefix', prefix: '/api/runtime-host/' }, handle: prefix },
    ]);

    await expect(dispatcher('GET', '/api/runtime-host/jobs/list', undefined)).resolves.toEqual({
      status: 200,
      data: { route: 'pattern' },
    });
    expect(unmatchedPrefix).not.toHaveBeenCalled();
    expect(pattern).toHaveBeenCalledTimes(1);
    expect(prefix).not.toHaveBeenCalled();
  });
});
