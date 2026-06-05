import { describe, expect, it, vi } from 'vitest';
import { createSettingsRuntimeCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/settings/settings-runtime-capability';
import { SettingsService } from '../../runtime-host/application/settings/service';
import { SettingsRuntimeConfigSyncWorkflow } from '../../runtime-host/application/workflows/settings-runtime-config/settings-runtime-config-sync-workflow';

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

function createSettingsCapabilityService(deps: {
  getAll: () => Promise<Record<string, unknown>>;
  patch?: (payload: Record<string, unknown>) => Promise<unknown>;
  setValue?: (key: string, value: unknown) => Promise<unknown>;
  reset?: () => Promise<Record<string, unknown>>;
  runtimeConfig: {
    syncProxy: () => Promise<void>;
    syncBrowserMode: () => Promise<void>;
  };
  jobs: ReturnType<typeof createSettingsJobs>;
  ensureManagedPluginInstalled?: (pluginId: string) => Promise<void>;
  requestParentShellAction?: (action: string) => Promise<{ success: boolean; status: number }>;
}) {
  return new SettingsService({
    repository: {
      getAll: deps.getAll,
      patch: deps.patch ?? vi.fn(async () => ({})),
      reset: deps.reset ?? vi.fn(async () => ({})),
      setValue: deps.setValue ?? vi.fn(async () => ({})),
    },
    runtimeConfigSyncWorkflow: new SettingsRuntimeConfigSyncWorkflow({
      repository: {
        getAll: deps.getAll,
        patch: deps.patch ?? vi.fn(async () => ({})),
        setValue: deps.setValue ?? vi.fn(async () => ({})),
      },
      jobs: deps.jobs,
      runtimeConfig: deps.runtimeConfig,
      runtimePlugins: deps.ensureManagedPluginInstalled
        ? { ensureManagedPluginInstalled: deps.ensureManagedPluginInstalled }
        : undefined,
      gatewayControl: deps.requestParentShellAction
        ? { restartGateway: async () => await deps.requestParentShellAction?.('gateway_restart') ?? { success: false, status: 500 } }
        : undefined,
    }),
  });
}

function getSettingsOperation(settingsService: SettingsService, operationId: string) {
  const route = createSettingsRuntimeCapabilityOperationRoutes({ settingsService })
    .find((item) => item.operationId === operationId);
  if (!route) {
    throw new Error(`Missing settings operation route: ${operationId}`);
  }
  return route;
}

describe('settings runtime capability proxy sync', () => {
  it('settings.patch 显式提交代理字段时只提交 OpenClaw 代理同步任务（允许清空）', async () => {
    const patchSettings = vi.fn(async () => ({}));
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const jobs = createSettingsJobs();

    const result = await getSettingsOperation(createSettingsCapabilityService({
      getAll: async () => ({
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '<local>',
      }),
      patch: patchSettings,
      runtimeConfig,
      jobs,
    }), 'settings.patch').handle({
      capabilityId: 'settings.runtime',
      operationId: 'settings.patch',
      address: {} as never,
      input: {},
      domainInput: {
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '<local>',
      },
    });

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

  it('settings.patch 未提交代理字段时不触发 OpenClaw 代理同步', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const jobs = createSettingsJobs();

    await getSettingsOperation(createSettingsCapabilityService({
      getAll: async () => ({
        theme: 'dark',
        proxyEnabled: true,
        proxyServer: 'http://127.0.0.1:7890',
        proxyBypassRules: '<local>',
      }),
      runtimeConfig,
      jobs,
    }), 'settings.patch').handle({
      capabilityId: 'settings.runtime',
      operationId: 'settings.patch',
      address: {} as never,
      input: {},
      domainInput: { theme: 'dark' },
    });

    expect(runtimeConfig.syncProxy).not.toHaveBeenCalled();
    expect(jobs.submitRuntimeConfigSync).not.toHaveBeenCalled();
  });

  it('settings.patch 显式提交 browserMode 时只提交浏览器模式同步任务', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const ensureManagedPluginInstalled = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({ success: true, status: 200 }));
    const jobs = createSettingsJobs();

    const result = await getSettingsOperation(createSettingsCapabilityService({
      getAll: async () => ({ browserMode: 'native' }),
      runtimeConfig,
      jobs,
      ensureManagedPluginInstalled,
      requestParentShellAction,
    }), 'settings.patch').handle({
      capabilityId: 'settings.runtime',
      operationId: 'settings.patch',
      address: {} as never,
      input: {},
      domainInput: { browserMode: 'native' },
    });

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

  it('settings.setValue 写 browserMode 也只提交浏览器模式同步任务', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const ensureManagedPluginInstalled = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({ success: true, status: 200 }));
    const jobs = createSettingsJobs();

    const result = await getSettingsOperation(createSettingsCapabilityService({
      getAll: async () => ({ browserMode: 'off' }),
      runtimeConfig,
      jobs,
      ensureManagedPluginInstalled,
      requestParentShellAction,
    }), 'settings.setValue').handle({
      capabilityId: 'settings.runtime',
      operationId: 'settings.setValue',
      address: {} as never,
      input: {},
      domainInput: { key: 'browserMode', value: 'off' },
    });

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
    const requestParentShellAction = vi.fn(async () => ({ success: true, status: 200 }));
    const jobs = createSettingsJobs();
    const service = createSettingsCapabilityService({
      getAll: async () => ({ browserMode: 'relay' }),
      runtimeConfig,
      jobs,
      ensureManagedPluginInstalled,
      requestParentShellAction,
    });

    const result = await service.executeRuntimeConfigSync({
      settings: { browserMode: 'relay' },
      syncProxy: false,
      syncBrowserMode: true,
    });

    expect(result).toEqual({ success: true });
    expect(ensureManagedPluginInstalled).toHaveBeenCalledWith('browser-relay');
    expect(runtimeConfig.syncBrowserMode).toHaveBeenCalledWith('relay');
    expect(requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
  });

  it('settings.reset 也会同步 proxy 和 browserMode 到 runtime projection', async () => {
    const runtimeConfig = {
      syncProxy: vi.fn(async () => {}),
      syncBrowserMode: vi.fn(async () => {}),
    };
    const ensureManagedPluginInstalled = vi.fn(async () => {});
    const requestParentShellAction = vi.fn(async () => ({ success: true, status: 200 }));
    const jobs = createSettingsJobs();
    const service = createSettingsCapabilityService({
      getAll: async () => ({ browserMode: 'relay' }),
      reset: async () => ({
        proxyEnabled: false,
        proxyServer: '',
        proxyBypassRules: '<local>',
        browserMode: 'relay',
      }),
      runtimeConfig,
      jobs,
      ensureManagedPluginInstalled,
      requestParentShellAction,
    });

    const result = await getSettingsOperation(service, 'settings.reset').handle({
      capabilityId: 'settings.runtime',
      operationId: 'settings.reset',
      address: { kind: 'native-runtime' } as never,
      input: {},
      domainInput: {},
    });

    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        settings: {
          proxyEnabled: false,
          proxyServer: '',
          proxyBypassRules: '<local>',
          browserMode: 'relay',
        },
      },
    });
    expect(runtimeConfig.syncProxy).toHaveBeenCalledWith({
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '<local>',
    }, { preserveExistingWhenDisabled: false });
    expect(ensureManagedPluginInstalled).toHaveBeenCalledWith('browser-relay');
    expect(runtimeConfig.syncBrowserMode).toHaveBeenCalledWith('relay');
    expect(requestParentShellAction).toHaveBeenCalledWith('gateway_restart');
  });
});
