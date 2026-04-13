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

  it('首次无缓存时走 initialLoading，并在成功后写入快照', async () => {
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
    expect(usePluginsStore.getState().snapshotReady).toBe(false);
    expect(usePluginsStore.getState().initialLoading).toBe(true);

    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial' });

    const state = usePluginsStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBeNull();
    expect(state.pluginSnapshot.plugins).toHaveLength(1);
  });

  it('有缓存时刷新失败保留旧快照，不回退空白', async () => {
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
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial' });

    hostApiFetchMock.mockRejectedValue(new Error('network error'));
    await expect(usePluginsStore.getState().refreshSnapshot({ reason: 'manual' })).rejects.toThrow();

    const state = usePluginsStore.getState();
    expect(state.snapshotReady).toBe(true);
    expect(state.pluginSnapshot.plugins).toHaveLength(1);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBe('plugins:errors.loadFailed');
  });

  it('toggleExecution 后做 mutation refresh，并在结束后清理 mutating 状态', async () => {
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
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial' });
    await usePluginsStore.getState().toggleExecution(false);

    const state = usePluginsStore.getState();
    expect(state.mutating).toBe(false);
    expect(state.mutatingAction).toBeNull();
    expect(state.pluginSnapshot.runtime?.execution.pluginExecutionEnabled).toBe(true);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/runtime/execution', {
      method: 'PUT',
      body: JSON.stringify({ enabled: false }),
    });
  });
});
