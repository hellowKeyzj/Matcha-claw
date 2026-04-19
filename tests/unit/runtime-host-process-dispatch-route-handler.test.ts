import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { handleDispatchRoute } from '../../runtime-host/api/dispatch/dispatch-route-handler';
import type { ParentTransportUpstreamPayload } from '../../runtime-host/api/dispatch/parent-transport';

class FakeRequest extends EventEmitter {
  private readonly body: string;

  constructor(body: string) {
    super();
    this.body = body;
  }

  start() {
    setImmediate(() => {
      this.emit('data', Buffer.from(this.body, 'utf8'));
      this.emit('end');
    });
  }
}

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  bodyText = '';
  private readonly doneResolver: () => void;
  readonly done: Promise<void>;

  constructor() {
    let resolveDone = () => {};
    this.done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.doneResolver = resolveDone;
  }

  setHeader(name: string, value: string) {
    this.headers[name] = value;
  }

  end(payload?: string) {
    if (typeof payload === 'string') {
      this.bodyText += payload;
    }
    this.doneResolver();
  }
}

function createTransportStats() {
  return {
    totalDispatchRequests: 0,
    localBusinessHandled: 0,
    executionSyncHandled: 0,
    executionSyncFailed: 0,
    unhandledRouteCount: 0,
    badRequestRejected: 0,
    dispatchInternalError: 0,
  };
}

async function runDispatch(
  requestPayload: unknown,
  overrides?: Partial<{
    tryHandleLocalBusinessDispatch: (
      method: string,
      route: string,
      payload: unknown,
    ) => Promise<{ status: number; data: unknown } | null>;
    requestParentExecutionSync: (
      action: 'set_execution_enabled' | 'restart_runtime_host',
      payload?: unknown,
    ) => Promise<ParentTransportUpstreamPayload>;
    buildLocalPluginsRuntimePayload: () => unknown;
    setPluginExecutionEnabled: (enabled: boolean) => void;
    setEnabledPluginIds: (pluginIds: string[]) => void;
  }>,
) {
  const transportStats = createTransportStats();
  const tryHandleLocalBusinessDispatch = overrides?.tryHandleLocalBusinessDispatch
    || vi.fn(async () => null);
  const requestParentExecutionSync = overrides?.requestParentExecutionSync
    || vi.fn(async () => ({
      version: 1,
      success: true,
      status: 200,
      data: {
        execution: {
          pluginExecutionEnabled: true,
          enabledPluginIds: ['security-core'],
        },
      },
    }));
  const buildLocalPluginsRuntimePayload = overrides?.buildLocalPluginsRuntimePayload
    || vi.fn(() => ({ success: true, execution: { pluginExecutionEnabled: true } }));
  const setPluginExecutionEnabled = overrides?.setPluginExecutionEnabled || vi.fn();
  const setEnabledPluginIds = overrides?.setEnabledPluginIds || vi.fn();

  const req = new FakeRequest(JSON.stringify(requestPayload));
  const res = new FakeResponse();

  handleDispatchRoute(req, res, {
    transportStats,
    tryHandleLocalBusinessDispatch,
    requestParentExecutionSync,
    buildLocalPluginsRuntimePayload,
    setPluginExecutionEnabled,
    setEnabledPluginIds,
  });
  req.start();
  await res.done;

  return {
    statusCode: res.statusCode,
    body: JSON.parse(res.bodyText || '{}') as Record<string, unknown>,
    transportStats,
    mocks: {
      tryHandleLocalBusinessDispatch,
      requestParentExecutionSync,
      buildLocalPluginsRuntimePayload,
      setPluginExecutionEnabled,
      setEnabledPluginIds,
    },
  };
}

describe('runtime-host process dispatch route handler', () => {
  it('本地业务命中时返回 local response 并累计统计', async () => {
    const result = await runDispatch(
      {
        version: 1,
        method: 'GET',
        route: '/api/workbench/bootstrap',
      },
      {
        tryHandleLocalBusinessDispatch: vi.fn(async () => ({
          status: 200,
          data: { success: true, source: 'local' },
        })),
      },
    );

    expect(result.statusCode).toBe(200);
    expect(result.body.success).toBe(true);
    expect(result.body.data).toEqual({ success: true, source: 'local' });
    expect(result.transportStats.totalDispatchRequests).toBe(1);
    expect(result.transportStats.localBusinessHandled).toBe(1);
  });

  it('execution sync 路由命中时更新本地执行状态并返回 runtime payload', async () => {
    const setPluginExecutionEnabled = vi.fn();
    const setEnabledPluginIds = vi.fn();
    const buildLocalPluginsRuntimePayload = vi.fn(() => ({ success: true, runtime: { execution: 'synced' } }));

    const result = await runDispatch(
      {
        version: 1,
        method: 'POST',
        route: '/api/plugins/runtime/restart',
      },
      {
        setPluginExecutionEnabled,
        setEnabledPluginIds,
        buildLocalPluginsRuntimePayload,
      },
    );

    expect(result.statusCode).toBe(200);
    expect(result.transportStats.executionSyncHandled).toBe(1);
    expect(setPluginExecutionEnabled).toHaveBeenCalledWith(true);
    expect(setEnabledPluginIds).not.toHaveBeenCalled();
    expect(buildLocalPluginsRuntimePayload).toHaveBeenCalledTimes(1);
    expect(result.body.data).toEqual({ success: true, runtime: { execution: 'synced' } });
  });

  it('transport version 不匹配时返回 BAD_REQUEST', async () => {
    const result = await runDispatch({
      version: 999,
      method: 'GET',
      route: '/api/workbench/bootstrap',
    });

    expect(result.statusCode).toBe(400);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toEqual(
      expect.objectContaining({
        code: 'BAD_REQUEST',
      }),
    );
    expect(result.transportStats.badRequestRejected).toBe(1);
  });

  it('未命中任何路由时返回 NOT_FOUND 并累计 unhandled 计数', async () => {
    const result = await runDispatch({
      version: 1,
      method: 'GET',
      route: '/api/not-exists',
    });

    expect(result.statusCode).toBe(404);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toEqual(
      expect.objectContaining({
        code: 'NOT_FOUND',
      }),
    );
    expect(result.transportStats.unhandledRouteCount).toBe(1);
  });

  it('execution sync 上游失败时返回错误并累计 executionSyncFailed', async () => {
    const result = await runDispatch(
      {
        version: 1,
        method: 'POST',
        route: '/api/plugins/runtime/restart',
      },
      {
        requestParentExecutionSync: vi.fn(async () => ({
          version: 1,
          success: false,
          status: 502,
          error: {
            code: 'UPSTREAM_ERROR',
            message: 'parent execution sync failed',
          },
        })),
      },
    );

    expect(result.statusCode).toBe(502);
    expect(result.body.success).toBe(false);
    expect(result.body.error).toEqual({
      code: 'UPSTREAM_ERROR',
      message: 'parent execution sync failed',
    });
    expect(result.transportStats.executionSyncHandled).toBe(1);
    expect(result.transportStats.executionSyncFailed).toBe(1);
  });
});
