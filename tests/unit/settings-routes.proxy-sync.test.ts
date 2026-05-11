import { describe, expect, it, vi } from 'vitest';
import { settingsRoutes } from '../../runtime-host/api/routes/settings-routes';
import { SettingsService } from '../../runtime-host/application/settings/service';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';

function createSettingsJobs() {
  return {
    submitRuntimeConfigSync: vi.fn((payload: unknown) => ({
      success: true as const,
      job: {
        id: 'job-settings-runtime-config',
        type: 'settings.syncRuntimeConfig',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
      },
    })),
  };
}

describe('settings route proxy sync', () => {
  it('PUT /api/settings 显式提交代理字段时只提交 OpenClaw 代理同步任务（允许清空）', async () => {
    const patchSettings = vi.fn(async () => ({}));
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const jobs = createSettingsJobs();

    const result = await dispatchRuntimeRouteDefinition(settingsRoutes, 
      'PUT',
      '/api/settings',
      {
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '<local>',
      },
      {
        settingsService: new SettingsService({
          repository: {
            getAll: async () => ({
              proxyEnabled: false,
              proxyServer: '',
              proxyBypassRules: '<local>',
            }),
            patch: patchSettings,
            reset: async () => ({}),
            setValue: async () => ({}),
          },
          runtimeConfig,
          jobs,
        }),
      },
    );

    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: expect.objectContaining({
          id: 'job-settings-runtime-config',
          type: 'settings.syncRuntimeConfig',
        }),
      },
    });
    expect(patchSettings).toHaveBeenCalledWith({
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '<local>',
    });
    expect(runtimeConfig.syncProxy).not.toHaveBeenCalled();
    expect(jobs.submitRuntimeConfigSync).toHaveBeenCalledWith({
      settings: {
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '<local>',
      },
      syncProxy: true,
      syncBrowserMode: false,
    });
  });

  it('PUT /api/settings 未提交代理字段时不触发 OpenClaw 代理同步', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const jobs = createSettingsJobs();

    await dispatchRuntimeRouteDefinition(settingsRoutes, 
      'PUT',
      '/api/settings',
      {
        theme: 'dark',
      },
      {
        settingsService: new SettingsService({
          repository: {
            getAll: async () => ({
              theme: 'dark',
              proxyEnabled: true,
              proxyServer: 'http://127.0.0.1:7890',
              proxyBypassRules: '<local>',
            }),
            patch: async () => ({}),
            reset: async () => ({}),
            setValue: async () => ({}),
          },
          runtimeConfig,
          jobs,
        }),
      },
    );

    expect(runtimeConfig.syncProxy).not.toHaveBeenCalled();
    expect(jobs.submitRuntimeConfigSync).not.toHaveBeenCalled();
  });

  it('PUT /api/settings 显式提交 browserMode 时只提交浏览器模式同步任务', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const ensureManagedPluginInstalled = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({
      success: true,
      status: 200,
    }));
    const jobs = createSettingsJobs();

    const result = await dispatchRuntimeRouteDefinition(settingsRoutes, 
      'PUT',
      '/api/settings',
      {
        browserMode: 'native',
      },
      {
        settingsService: new SettingsService({
          repository: {
            getAll: async () => ({
              browserMode: 'native',
            }),
            patch: async () => ({}),
            reset: async () => ({}),
            setValue: async () => ({}),
          },
          runtimeConfig,
          runtimePlugins: {
            ensureManagedPluginInstalled,
          },
          gatewayControl: {
            restartGateway: async () => await requestParentShellAction('gateway_restart'),
          },
          jobs,
        }),
      },
    );

    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: expect.objectContaining({
          id: 'job-settings-runtime-config',
          type: 'settings.syncRuntimeConfig',
        }),
      },
    });
    expect(jobs.submitRuntimeConfigSync).toHaveBeenCalledWith({
      settings: { browserMode: 'native' },
      syncProxy: false,
      syncBrowserMode: true,
    });
    expect(runtimeConfig.syncBrowserMode).not.toHaveBeenCalled();
    expect(ensureManagedPluginInstalled).not.toHaveBeenCalled();
    expect(requestParentShellAction).not.toHaveBeenCalled();
  });

  it('PUT /api/settings/browserMode 也只提交浏览器模式同步任务', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const ensureManagedPluginInstalled = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({
      success: true,
      status: 200,
    }));
    const jobs = createSettingsJobs();

    const result = await dispatchRuntimeRouteDefinition(settingsRoutes, 
      'PUT',
      '/api/settings/browserMode',
      {
        value: 'off',
      },
      {
        settingsService: new SettingsService({
          repository: {
            getAll: async () => ({
              browserMode: 'off',
            }),
            patch: async () => ({}),
            reset: async () => ({}),
            setValue: async () => ({}),
          },
          runtimeConfig,
          runtimePlugins: {
            ensureManagedPluginInstalled,
          },
          gatewayControl: {
            restartGateway: async () => await requestParentShellAction('gateway_restart'),
          },
          jobs,
        }),
      },
    );

    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: expect.objectContaining({
          id: 'job-settings-runtime-config',
          type: 'settings.syncRuntimeConfig',
        }),
      },
    });
    expect(jobs.submitRuntimeConfigSync).toHaveBeenCalledWith({
      settings: { browserMode: 'off' },
      syncProxy: false,
      syncBrowserMode: true,
    });
    expect(runtimeConfig.syncBrowserMode).not.toHaveBeenCalled();
    expect(ensureManagedPluginInstalled).not.toHaveBeenCalled();
    expect(requestParentShellAction).not.toHaveBeenCalled();
  });

  it('浏览器模式同步任务切到 relay 时先确保 browser-relay 插件可用', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const ensureManagedPluginInstalled = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({
      success: true,
      status: 200,
    }));
    const jobs = createSettingsJobs();
    const service = new SettingsService({
      repository: {
        getAll: async () => ({
          browserMode: 'relay',
        }),
        patch: async () => ({}),
        reset: async () => ({}),
        setValue: async () => ({}),
      },
      runtimeConfig,
      runtimePlugins: {
        ensureManagedPluginInstalled,
      },
      gatewayControl: {
        restartGateway: async () => await requestParentShellAction('gateway_restart'),
      },
      jobs,
    });

    const result = await service.executeRuntimeConfigSync({
      settings: { browserMode: 'relay' },
      syncProxy: false,
      syncBrowserMode: true,
    });

    expect(result).toEqual({
      status: 200,
      data: { success: true },
    });
    expect(ensureManagedPluginInstalled).toHaveBeenCalledWith('browser-relay');
    expect(runtimeConfig.syncBrowserMode).toHaveBeenCalledWith('relay');
    expect(requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
  });
});
