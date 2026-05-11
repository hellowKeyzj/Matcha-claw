import { describe, expect, it, vi } from 'vitest';
import { pluginRuntimeRoutes } from '../../runtime-host/api/routes/plugin-runtime-routes';
import { PluginRuntimeService } from '../../runtime-host/application/plugins/plugin-runtime-service';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function createDeps() {
  return {
    snapshotPluginsRuntimePayload: vi.fn(() => ({
      success: true,
      state: {
        enabledPluginIds: ['memory-lancedb-pro'],
      },
    })),
    enqueueRefresh: vi.fn(),
    getRefreshJob: vi.fn(() => ({
      id: 'job-1',
      type: 'plugins.refreshCatalog',
      status: 'running',
      queuedAt: 1,
    })),
    getEnabledPluginIds: vi.fn(() => ['memory-lancedb-pro']),
    getPluginCatalog: vi.fn(() => [{
      id: 'memory-lancedb-pro',
      name: 'Memory',
      version: '1.0.0',
      kind: 'builtin',
      platform: 'openclaw',
      category: 'memory',
      group: 'general',
    }]),
  };
}

describe('runtime-host process plugin runtime routes', () => {
  it('GET /api/plugins/catalog 只触发后台刷新并立即返回当前快照', async () => {
    const deps = createDeps();
    const pluginRuntimeService = new PluginRuntimeService({
      runtime: deps,
      jobs: {
        submitSetEnabledPlugins: vi.fn(() => ({
          success: true,
          job: {
            id: 'job-2',
            type: 'plugins.setEnabled',
            status: 'queued',
            queuedAt: 2,
            attempts: 0,
            maxAttempts: 1,
          },
        })),
      },
    });

    const result = await dispatchRuntimeRouteDefinition(pluginRuntimeRoutes, 
      'GET',
      '/api/plugins/catalog',
      undefined,
      { pluginRuntimeService },
    );

    expect(deps.enqueueRefresh).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        refreshJob: {
          id: 'job-1',
          type: 'plugins.refreshCatalog',
          status: 'running',
          queuedAt: 1,
        },
        execution: {
          enabledPluginIds: ['memory-lancedb-pro'],
        },
        plugins: [{
          id: 'memory-lancedb-pro',
          name: 'Memory',
          version: '1.0.0',
          kind: 'builtin',
          platform: 'openclaw',
          category: 'memory',
          group: 'general',
          enabled: true,
          controlMode: 'manual',
        }],
      },
    });
  });

  it('PUT /api/plugins/runtime/enabled-plugins 只提交启用变更任务', async () => {
    const deps = createDeps();
    const submitSetEnabledPlugins = vi.fn(() => ({
      success: true,
      job: {
        id: 'job-2',
        type: 'plugins.setEnabled',
        status: 'queued',
        queuedAt: 2,
        attempts: 0,
        maxAttempts: 1,
      },
    }));
    const pluginRuntimeService = new PluginRuntimeService({
      runtime: deps,
      jobs: {
        submitSetEnabledPlugins,
      },
    });

    const result = await dispatchRuntimeRouteDefinition(pluginRuntimeRoutes, 
      'PUT',
      '/api/plugins/runtime/enabled-plugins',
      { pluginIds: ['memory-lancedb-pro'] },
      { pluginRuntimeService },
    );

    expect(submitSetEnabledPlugins).toHaveBeenCalledWith({ pluginIds: ['memory-lancedb-pro'] });
    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: {
          id: 'job-2',
          type: 'plugins.setEnabled',
          status: 'queued',
          queuedAt: 2,
          attempts: 0,
          maxAttempts: 1,
        },
      },
    });
    expect(deps.enqueueRefresh).not.toHaveBeenCalled();
  });
});
