import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  readProviderStoreMock: vi.fn(),
  writeProviderStoreMock: vi.fn(async () => {}),
  saveProviderKeyMock: vi.fn(async () => {}),
  removeProviderKeyMock: vi.fn(async () => {}),
  setOpenClawDefaultModelMock: vi.fn(async () => {}),
  setOpenClawDefaultModelWithOverrideMock: vi.fn(async () => {}),
  syncProviderConfigMock: vi.fn(async () => {}),
  runtimeConfigSyncProxyMock: vi.fn(async () => {}),
  runtimeConfigSyncGatewayTokenMock: vi.fn(async () => {}),
  runtimeConfigSanitizeMock: vi.fn(async () => {}),
  runtimeConfigSyncBrowserModeMock: vi.fn(async () => {}),
  runtimeConfigSyncSessionIdleMinutesMock: vi.fn(async () => {}),
  reconcileConfiguredChannelPluginsForGatewayLaunchMock: vi.fn(async () => []),
  cleanupStaleBuiltinExtensionsForGatewayLaunchMock: vi.fn(async () => []),
  ensureConfiguredManagedPluginsForGatewayLaunchMock: vi.fn(async () => []),
  ensureDefaultIdentityMock: vi.fn(async () => ({
    workspaceDirs: [],
    seededFiles: [],
    replacedTemplateFiles: [],
    removedBootstrapFiles: [],
  })),
  migrateMainAgentTemplatesIfNeededMock: vi.fn(async () => ({ workspaceDir: '', migratedFiles: [] })),
  mergeContextSnippetsMock: vi.fn(async () => ({ mergedFiles: [], skippedMissing: 0 })),
  getAllSettingsMock: vi.fn(async () => ({ browserMode: 'relay', gatewayToken: '' })),
  setSettingValueMock: vi.fn(async () => {}),
  ensureManagedPluginInstalledMock: vi.fn(async () => {}),
  submitLongTaskMock: vi.fn(),
  getOpenClawProviderKeyForTypeMock: vi.fn((type: string, id: string) => `${type}-${id}`),
}));

vi.mock('../../runtime-host/application/providers/provider-registry', () => ({
  getKeyableProviderTypes: vi.fn(() => []),
  getProviderEnvVar: vi.fn(() => undefined),
}));

function createProviderRuntimeSync() {
  return {
    syncProviderStore: async (store: import('../../runtime-host/application/providers/store-sync').ProviderStoreLike) => {
      const { ProviderRuntimeSyncService } = await import('../../runtime-host/application/providers/store-sync');
      return await new ProviderRuntimeSyncService(
        {
          saveProviderKey: hoisted.saveProviderKeyMock,
          removeProviderKey: hoisted.removeProviderKeyMock,
        },
        {
          setDefaultModel: hoisted.setOpenClawDefaultModelMock,
          setDefaultModelWithOverride: hoisted.setOpenClawDefaultModelWithOverrideMock,
          syncProviderConfig: hoisted.syncProviderConfigMock,
        },
      ).syncProviderStore(store);
    },
  };
}

function createBootstrapService(RuntimeHostBootstrapService: typeof import('../../runtime-host/application/runtime-host/bootstrap').RuntimeHostBootstrapService) {
  return new RuntimeHostBootstrapService({
    settingsRepository: {
      getAll: hoisted.getAllSettingsMock,
      setValue: hoisted.setSettingValueMock,
    },
    providerStoreRepository: {
      read: hoisted.readProviderStoreMock,
      write: hoisted.writeProviderStoreMock,
    },
    runtimeConfig: {
      syncProxy: hoisted.runtimeConfigSyncProxyMock,
      syncGatewayToken: hoisted.runtimeConfigSyncGatewayTokenMock,
      sanitize: hoisted.runtimeConfigSanitizeMock,
      syncBrowserMode: hoisted.runtimeConfigSyncBrowserModeMock,
      syncSessionIdleMinutes: hoisted.runtimeConfigSyncSessionIdleMinutesMock,
    },
    runtimePlugins: {
      ensureManagedPluginInstalled: hoisted.ensureManagedPluginInstalledMock,
    },
    prelaunchPluginMaintenance: {
      cleanupStaleBuiltinExtensionsForGatewayLaunch: hoisted.cleanupStaleBuiltinExtensionsForGatewayLaunchMock,
      reconcileConfiguredChannelPluginsForGatewayLaunch: hoisted.reconcileConfiguredChannelPluginsForGatewayLaunchMock,
      ensureConfiguredManagedPluginsForGatewayLaunch: hoisted.ensureConfiguredManagedPluginsForGatewayLaunchMock,
    },
    providerRuntimeSync: createProviderRuntimeSync(),
    workspace: {
      ensureDefaultIdentity: hoisted.ensureDefaultIdentityMock,
      migrateMainAgentTemplatesIfNeeded: hoisted.migrateMainAgentTemplatesIfNeededMock,
      mergeContextSnippets: hoisted.mergeContextSnippetsMock,
    },
    securityJobs: {
      submitPolicySync: vi.fn(),
    },
    idGenerator: {
      randomHex: vi.fn(() => '1'.repeat(32)),
    },
    jobs: {
      submitGatewayPrelaunch: hoisted.submitLongTaskMock,
      submitProviderAuthBootstrap: hoisted.submitLongTaskMock,
      submitWorkspaceTemplateMigration: hoisted.submitLongTaskMock,
    },
  });
}

vi.mock('../../runtime-host/application/providers/provider-runtime-rules', () => ({
  getOpenClawProviderKeyForType: (...args: unknown[]) => hoisted.getOpenClawProviderKeyForTypeMock(...args),
  getOAuthProviderApi: vi.fn(() => undefined),
  getOAuthApiKeyEnv: vi.fn(() => undefined),
  normalizeOAuthBaseUrl: vi.fn((_providerType: string, baseUrl?: string) => baseUrl),
  usesOAuthAuthHeader: vi.fn(() => false),
}));

describe('runtime-host bootstrap provider sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getAllSettingsMock.mockResolvedValue({ browserMode: 'relay', gatewayToken: '' });
    hoisted.cleanupStaleBuiltinExtensionsForGatewayLaunchMock.mockResolvedValue([]);
    hoisted.reconcileConfiguredChannelPluginsForGatewayLaunchMock.mockResolvedValue([]);
    hoisted.ensureConfiguredManagedPluginsForGatewayLaunchMock.mockResolvedValue([]);
    hoisted.ensureDefaultIdentityMock.mockResolvedValue({
      workspaceDirs: [],
      seededFiles: [],
      replacedTemplateFiles: [],
      removedBootstrapFiles: [],
    });
    hoisted.submitLongTaskMock.mockReturnValue({
      success: true,
      job: {
        id: 'job-1',
        type: 'runtimeHost.gatewayPrelaunch',
        status: 'queued',
      },
    });
  });

  it('RuntimeHostBootstrapService 会把 gateway prelaunch 提交给任务系统', async () => {
    const { RuntimeHostBootstrapService } = await import('../../runtime-host/application/runtime-host/bootstrap');
    const service = createBootstrapService(RuntimeHostBootstrapService);
    const result = service.submitGatewayPrelaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
    });

    expect(hoisted.submitLongTaskMock).toHaveBeenCalledWith({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
    });
    expect(result.job.id).toBe('job-1');
  });

  it('RuntimeHostBootstrapService 会把 provider auth bootstrap 提交给任务系统', async () => {
    const { RuntimeHostBootstrapService } = await import('../../runtime-host/application/runtime-host/bootstrap');
    const service = createBootstrapService(RuntimeHostBootstrapService);
    const result = service.submitProviderAuthBootstrap();

    expect(hoisted.submitLongTaskMock).toHaveBeenCalledWith();
    expect(result.job.id).toBe('job-1');
  });

  it('gateway prelaunch 任务会同时同步 runtime-host settings 与 openclaw.json 的 gateway token', async () => {
    hoisted.reconcileConfiguredChannelPluginsForGatewayLaunchMock.mockResolvedValue(['openclaw-weixin']);

    const { RuntimeHostBootstrapService } = await import('../../runtime-host/application/runtime-host/bootstrap');
    const service = createBootstrapService(RuntimeHostBootstrapService);
    const result = await service.executeGatewayPrelaunch({
      gatewayToken: 'matchaclaw-token-1',
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    });

    expect(hoisted.runtimeConfigSyncProxyMock).toHaveBeenCalledWith({
      proxyEnabled: true,
      proxyServer: 'http://127.0.0.1:7890',
      proxyBypassRules: '<local>',
    }, {
      preserveExistingWhenDisabled: true,
    });
    expect(hoisted.setSettingValueMock).toHaveBeenCalledWith('gatewayToken', 'matchaclaw-token-1');
    expect(hoisted.runtimeConfigSyncGatewayTokenMock).toHaveBeenCalledWith('matchaclaw-token-1');
    expect(hoisted.ensureDefaultIdentityMock).toHaveBeenCalledTimes(1);
    expect(hoisted.runtimeConfigSanitizeMock).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureManagedPluginInstalledMock).toHaveBeenCalledWith('browser-relay');
    expect(hoisted.runtimeConfigSyncBrowserModeMock).toHaveBeenCalledWith('relay');
    expect(hoisted.runtimeConfigSyncSessionIdleMinutesMock).toHaveBeenCalledTimes(1);
    expect(hoisted.reconcileConfiguredChannelPluginsForGatewayLaunchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureConfiguredManagedPluginsForGatewayLaunchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      configuredChannels: ['openclaw-weixin'],
    });
  });

  it('默认 Ollama 账号会按 openai-completions 协议写入 runtime 覆盖配置', async () => {
    hoisted.readProviderStoreMock.mockResolvedValue({
      defaultAccountId: 'ollama-main',
      accounts: {
        'ollama-main': {
          id: 'ollama-main',
          vendorId: 'ollama',
          model: 'qwen3:30b',
          baseUrl: 'http://localhost:11434/v1',
        },
      },
      apiKeys: {
        'ollama-main': 'ollama-local',
      },
    });

    const { RuntimeHostBootstrapService } = await import('../../runtime-host/application/runtime-host/bootstrap');
    const service = createBootstrapService(RuntimeHostBootstrapService);
    await service.executeProviderAuthBootstrap();

    expect(hoisted.saveProviderKeyMock).toHaveBeenCalledWith('ollama-ollama-main', 'ollama-local');
    expect(hoisted.syncProviderConfigMock).toHaveBeenCalledWith(
      'ollama-ollama-main',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
        models: [
          {
            id: 'qwen3:30b',
            name: 'qwen3:30b',
          },
        ],
      }),
    );
    expect(hoisted.setOpenClawDefaultModelWithOverrideMock).toHaveBeenCalledWith(
      'ollama-ollama-main',
      'qwen3:30b',
      expect.objectContaining({
        baseUrl: 'http://localhost:11434/v1',
        api: 'openai-completions',
      }),
      [],
    );
    expect(hoisted.setOpenClawDefaultModelMock).not.toHaveBeenCalled();
  });

  it('custom/ollama 之外的默认账号继续走非 override 分支', async () => {
    hoisted.readProviderStoreMock.mockResolvedValue({
      defaultAccountId: 'openai-main',
      accounts: {
        'openai-main': {
          id: 'openai-main',
          vendorId: 'openai',
          model: 'gpt-5.4',
        },
      },
      apiKeys: {
        'openai-main': 'sk-openai',
      },
    });

    const { RuntimeHostBootstrapService } = await import('../../runtime-host/application/runtime-host/bootstrap');
    const service = createBootstrapService(RuntimeHostBootstrapService);
    await service.executeProviderAuthBootstrap();

    expect(hoisted.setOpenClawDefaultModelMock).toHaveBeenCalledWith(
      'openai-openai-main',
      'gpt-5.4',
      [],
    );
    expect(hoisted.setOpenClawDefaultModelWithOverrideMock).not.toHaveBeenCalled();
    expect(hoisted.syncProviderConfigMock).not.toHaveBeenCalled();
  });
});
