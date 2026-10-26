import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeInstanceScope, runtimeScopeQuery } from '@/types/desktop/runtime-address';
import type { CallRecord } from '@/types/call-log';
import type { PluginCallDetail } from '@/types/call-log/plugins';

const hostApiFetchMock = vi.fn();
const scope = runtimeInstanceScope({ kind: 'native-runtime', runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' });
const catalogPath = `/api/plugins/catalog?${runtimeScopeQuery(scope)}`;
const receipt = { callId: 'a'.repeat(32), accepted: true } as const;

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostApiFetchDecoded: async (path: string, decode: (value: unknown) => unknown, options: unknown) => (
    decode(await hostApiFetchMock(path, options))
  ),
}));

function buildCatalogPayload() {
  return {
    success: true,
    execution: { enabledPluginIds: ['plugin-a'] },
    plugins: [{
      runtime: 'openclaw',
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      kind: 'builtin',
      platform: 'openclaw',
      enabled: true,
      installed: true,
      updateAvailable: false,
      companionSkillReady: true,
      description: 'Plugin description',
    }],
  };
}

function buildRuntimePayload() {
  return {
    success: true,
    state: { lifecycle: 'running', runtimeLifecycle: 'running', activePluginCount: 1, enabledPluginIds: ['plugin-a'] },
    health: { ok: true, lifecycle: 'running', activePluginCount: 1, degradedPlugins: [] },
    execution: { enabledPluginIds: ['plugin-a'] },
  };
}

function buildCall(detail: Extract<PluginCallDetail, { kind: 'configuration' | 'operation' }>): CallRecord<'plugins'> {
  return {
    callId: receipt.callId,
    module: 'plugins',
    command: `plugins.${detail.kind}`,
    status: detail.outcome === 'configured' ? 'succeeded' : detail.outcome === 'rejected' ? 'rejected' : 'unknown',
    start: 1,
    end: 2,
    revision: 1,
    detail,
  };
}

describe('plugins store', () => {
  beforeEach(async () => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
    const { usePluginsStore } = await import('@/plugins/native-plugins/store');
    usePluginsStore.getState().setScope(scope);
  });

  it('loads the catalog without requesting runtime status', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === catalogPath) return buildCatalogPayload();
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/plugins/native-plugins/store');
    await usePluginsStore.getState().refreshCatalog({ reason: 'initial' });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/catalog');
    expect(usePluginsStore.getState()).toMatchObject({
      catalogReady: true,
      catalog: buildCatalogPayload().plugins,
      error: null,
    });
  });

  it('preserves loaded projections when a later refresh fails', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === catalogPath) return buildCatalogPayload();
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/plugins/native-plugins/store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    hostApiFetchMock.mockRejectedValue(new Error('offline'));

    await expect(usePluginsStore.getState().refreshSnapshot({ reason: 'manual', force: true })).rejects.toThrow('offline');

    expect(usePluginsStore.getState()).toMatchObject({
      catalog: buildCatalogPayload().plugins,
      error: 'plugins:errors.loadFailed',
    });
  });

  it('posts the closed configuration DTO and refreshes both projections after confirmation', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === catalogPath) return buildCatalogPayload();
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      if (path === '/api/plugins/configuration') return receipt;
      if (path === '/api/calls/get') return buildCall({ kind: 'configuration', pluginId: 'plugin-a', enabled: false, outcome: 'configured' });
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/plugins/native-plugins/store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    hostApiFetchMock.mockClear();

    await expect(usePluginsStore.getState().togglePluginEnabled('plugin-a', false)).resolves.toBe('configured');

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/configuration', {
      method: 'POST',
      body: JSON.stringify({ runtime: 'openclaw', pluginId: 'plugin-a', enabled: false }),
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/catalog');
    expect(usePluginsStore.getState().mutatingPluginId).toBeNull();
  });

  it.each(['rejected', 'unknown'] as const)('keeps projections when configuration is %s', async (outcome) => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === catalogPath) return buildCatalogPayload();
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      if (path === '/api/plugins/configuration') return receipt;
      if (path === '/api/calls/get') return buildCall({ kind: 'configuration', pluginId: 'plugin-a', enabled: false, outcome });
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/plugins/native-plugins/store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    hostApiFetchMock.mockClear();

    await expect(usePluginsStore.getState().togglePluginEnabled('plugin-a', false)).resolves.toBe(outcome);

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(usePluginsStore.getState()).toMatchObject({
      catalog: buildCatalogPayload().plugins,
      error: 'plugins:errors.togglePluginFailed',
    });
  });

  it('posts a plugin operation, exposes its action, and refreshes the catalog after confirmation', async () => {
    let resolveOperation: ((value: typeof receipt) => void) | undefined;
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === catalogPath) return Promise.resolve(buildCatalogPayload());
      if (path === '/api/plugins/runtime') return Promise.resolve(buildRuntimePayload());
      if (path === '/api/calls/get') return Promise.resolve(buildCall({ kind: 'operation', pluginId: 'plugin-a', operation: 'update', outcome: 'configured' }));
      if (path === '/api/plugins/operation') {
        return new Promise<typeof receipt>((resolve) => {
          resolveOperation = resolve;
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/plugins/native-plugins/store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    hostApiFetchMock.mockClear();

    const operation = usePluginsStore.getState().operatePlugin('plugin-a', 'update');
    await vi.waitFor(() => expect(usePluginsStore.getState()).toMatchObject({
      mutatingPluginId: 'plugin-a',
      mutatingAction: 'update',
    }));
    resolveOperation?.(receipt);

    await expect(operation).resolves.toBe('configured');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/operation', {
      method: 'POST',
      body: JSON.stringify({ runtime: 'openclaw', operation: 'update', pluginId: 'plugin-a' }),
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/catalog');
    expect(usePluginsStore.getState()).toMatchObject({
      mutatingPluginId: null,
      mutatingAction: null,
      error: null,
    });
  });

  it.each(['rejected', 'unknown'] as const)('keeps projections when plugin operation is %s', async (outcome) => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === catalogPath) return buildCatalogPayload();
      if (path === '/api/plugins/runtime') return buildRuntimePayload();
      if (path === '/api/plugins/operation') return receipt;
      if (path === '/api/calls/get') return buildCall({ kind: 'operation', pluginId: 'plugin-a', operation: 'uninstall', outcome });
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/plugins/native-plugins/store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    hostApiFetchMock.mockClear();

    await expect(usePluginsStore.getState().operatePlugin('plugin-a', 'uninstall')).resolves.toBe(outcome);

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/operation', {
      method: 'POST',
      body: JSON.stringify({ runtime: 'openclaw', operation: 'uninstall', pluginId: 'plugin-a' }),
    });
    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(usePluginsStore.getState()).toMatchObject({
      catalog: buildCatalogPayload().plugins,
      mutatingPluginId: null,
      mutatingAction: null,
      error: 'plugins:errors.operationFailed',
    });
  });
});
