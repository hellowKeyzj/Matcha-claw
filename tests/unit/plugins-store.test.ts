import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

function buildCatalogPayload() {
  return {
    plugins: [{
      runtime: 'openclaw',
      id: 'plugin-a',
      name: 'Plugin A',
      version: '1.0.0',
      kind: 'builtin',
      platform: 'openclaw',
      category: 'runtime',
      group: 'general',
      enabled: true,
      description: 'Plugin description',
    }],
  };
}

describe('plugins store', () => {
  beforeEach(() => {
    vi.resetModules();
    hostApiFetchMock.mockReset();
  });

  it('loads the catalog without requesting runtime status', async () => {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/catalog') return buildCatalogPayload();
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
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
      if (path === '/api/plugins/catalog') return buildCatalogPayload();
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
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
      if (path === '/api/plugins/catalog') return buildCatalogPayload();
      if (path === '/api/plugins/configuration') return { outcome: 'configured' };
      if (path === '/api/plugins/operation') return { outcome: 'configured' };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
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
      if (path === '/api/plugins/catalog') return buildCatalogPayload();
      if (path === '/api/plugins/configuration') return { outcome };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
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
    let resolveOperation: ((value: { outcome: 'configured' }) => void) | undefined;
    hostApiFetchMock.mockImplementation((path: string) => {
      if (path === '/api/plugins/catalog') return Promise.resolve(buildCatalogPayload());
      if (path === '/api/plugins/operation') {
        return new Promise<{ outcome: 'configured' }>((resolve) => {
          resolveOperation = resolve;
        });
      }
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
    await usePluginsStore.getState().refreshSnapshot({ reason: 'initial', force: true });
    hostApiFetchMock.mockClear();

    const operation = usePluginsStore.getState().operatePlugin('plugin-a', 'update');
    await vi.waitFor(() => expect(usePluginsStore.getState()).toMatchObject({
      mutatingPluginId: 'plugin-a',
      mutatingAction: 'update',
    }));
    resolveOperation?.({ outcome: 'configured' });

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
      if (path === '/api/plugins/catalog') return buildCatalogPayload();
      if (path === '/api/plugins/operation') return { outcome };
      throw new Error(`Unexpected path: ${path}`);
    });

    const { usePluginsStore } = await import('@/stores/plugins-store');
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
