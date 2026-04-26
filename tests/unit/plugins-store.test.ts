import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

function buildRuntimePayload(params?: { executionEnabled?: boolean; enabledPluginIds?: string[] }) {
  const executionEnabled = params?.executionEnabled ?? true;
  const enabledPluginIds = params?.enabledPluginIds ?? ['plugin-a'];
  return {
    success: true,
    state: {
      lifecycle: 'running',
      runtimeLifecycle: 'ready',
      activePluginCount: enabledPluginIds.length,
      pluginExecutionEnabled: executionEnabled,
      enabledPluginIds,
    },
    health: {
      ok: true,
      lifecycle: 'ready',
      activePluginCount: enabledPluginIds.length,
      degradedPlugins: [],
    },
    execution: {
      pluginExecutionEnabled: executionEnabled,
      enabledPluginIds,
    },
  };
}

function buildCatalogPayload() {
  return {
    success: true,
    execution: {
      pluginExecutionEnabled: true,
      enabledPluginIds: ['plugin-a'],
    },
    plugins: [
      {
        id: 'plugin-a',
        name: 'Plugin A',
        version: '1.0.0',
        kind: 'builtin' as const,
        platform: 'matchaclaw' as const,
        category: 'runtime',
        enabled: true,
      },
    ],
  };
}

describe('plugins store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
  });

  it('首次加载时 runtime 和 catalog 分层写入，不再等整份 snapshot', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload();
      }
      if (path === '/api/plugins/catalog') {
        return buildCatalogPayload();
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
    expect(usePluginsStore.getState().runtimeReady).toBe(false);
    expect(usePluginsStore.getState().catalogReady).toBe(false);

    await usePluginsStore.getState().refreshRuntime({ reason: 'initial' });

    let state = usePluginsStore.getState();
    expect(state.runtimeReady).toBe(true);
    expect(state.catalogReady).toBe(false);
    expect(state.runtime?.execution.pluginExecutionEnabled).toBe(true);

    await usePluginsStore.getState().refreshCatalog({ reason: 'initial' });

    state = usePluginsStore.getState();
    expect(state.catalogReady).toBe(true);
    expect(state.catalog).toHaveLength(1);
    expect(state.error).toBeNull();
  });

  it('有缓存时 refreshSnapshot 失败保留旧 runtime 和 catalog', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload();
      }
      if (path === '/api/plugins/catalog') {
        return buildCatalogPayload();
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });

    hostApiFetchMock.mockRejectedValue(new Error('network error'));
    await expect(usePluginsStore.getState().refreshSnapshot({ reason: 'manual', force: true })).rejects.toThrow();

    const state = usePluginsStore.getState();
    expect(state.runtimeReady).toBe(true);
    expect(state.catalogReady).toBe(true);
    expect(state.runtime?.execution.pluginExecutionEnabled).toBe(true);
    expect(state.catalog).toHaveLength(1);
    expect(state.error).toBe('plugins:errors.loadFailed');
  });

  it('缓存新鲜时 prewarm 不重复请求插件数据', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload();
      }
      if (path === '/api/plugins/catalog') {
        return buildCatalogPayload();
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    hostApiFetchMock.mockClear();

    await usePluginsStore.getState().prewarm();

    expect(hostApiFetchMock).not.toHaveBeenCalled();
  });

  it('toggleExecution 后刷新 runtime 与 catalog，并在结束后清理 mutating 状态', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload({ executionEnabled: true, enabledPluginIds: ['plugin-a'] });
      }
      if (path === '/api/plugins/catalog') {
        return buildCatalogPayload();
      }
      if (path === '/api/plugins/runtime/execution') {
        return buildRuntimePayload({ executionEnabled: false, enabledPluginIds: ['plugin-a'] });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    await usePluginsStore.getState().toggleExecution(false);

    const state = usePluginsStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.mutatingAction).toBeNull();
    expect(state.runtime?.execution.pluginExecutionEnabled).toBe(true);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/runtime/execution', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    });
  });
});
