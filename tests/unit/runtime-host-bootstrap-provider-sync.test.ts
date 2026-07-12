import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  readProviderStoreMock: vi.fn(),
  writeProviderStoreMock: vi.fn(async () => {}),
  saveProviderKeyMock: vi.fn(async () => {}),
  removeProviderKeyMock: vi.fn(async () => {}),
  syncProviderConfigMock: vi.fn(async () => {}),
  removeProviderMock: vi.fn(async () => {}),
  upsertProviderInAgentModelsMock: vi.fn(async () => []),
  syncRuntimeModelProjectionMock: vi.fn(async () => {}),
  syncRuntimeRoutingProjectionMock: vi.fn(async () => {}),
  runtimeConfigSyncProxyMock: vi.fn(async () => {}),
  runtimeConfigSyncGatewayTokenMock: vi.fn(async () => {}),
  runtimeConfigSanitizeMock: vi.fn(async () => {}),
  runtimeConfigSyncBrowserModeMock: vi.fn(async () => {}),
  runtimeConfigSyncSessionIdleMinutesMock: vi.fn(async () => {}),
  getActiveProvidersMock: vi.fn(async () => new Set<string>()),
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
  applySavedPolicyToPluginConfigMock: vi.fn(async () => {}),
  submitLongTaskMock: vi.fn(),
  getOpenClawProviderKeyForTypeMock: vi.fn((type: string, id: string) => `${type}-${id}`),
}));

vi.mock('../../runtime-host/application/providers/provider-registry', () => ({
  getKeyableProviderTypes: vi.fn(() => []),
  getProviderEnvVar: vi.fn(() => undefined),
  getProviderBackendConfig: vi.fn((type: string) => {
    if (type === 'openai') {
      return {
        baseUrl: 'https://api.openai.com/v1',
        api: 'openai-responses',
        apiKeyEnv: 'OPENAI_API_KEY',
      };
    }
    return undefined;
  }),
}));

function createProviderProjectionSync() {
  return {
    syncProviderStore: async (store: import('../../runtime-host/application/providers/store-sync').ProviderStoreLike) => {
      const { ProviderProjectionSyncService } = await import('../../runtime-host/application/providers/store-sync');
      const { ProviderProjectionSyncWorkflow } = await import('../../runtime-host/application/workflows/provider-projection-sync/provider-projection-sync-workflow');
      return await new ProviderProjectionSyncService(new ProviderProjectionSyncWorkflow({
        authProfiles: {
          saveProviderKey: hoisted.saveProviderKeyMock,
          removeProviderKey: hoisted.removeProviderKeyMock,
        },
        providerConfig: {
          syncProviderConfig: hoisted.syncProviderConfigMock,
        },
        projectionState: {
          getActiveProviders: hoisted.getActiveProvidersMock,
        },
        authRepository: {
          discoverAgentIds: async () => ['main'],
        },
        agentModels: {
          upsertProviderInAgentModels: hoisted.upsertProviderInAgentModelsMock,
        },
        projectionKeys: {
          resolveProviderKey: ({ vendorId, accountId }) => hoisted.getOpenClawProviderKeyForTypeMock(vendorId, accountId),
        },
        projectionPolicy: {
          getReplaceProviderKeys: () => [],
          getOAuthProviderApi: () => undefined,
          getOAuthProviderTokenKey: (vendorId) => vendorId,
          getOAuthProviderDefaultBaseUrl: () => undefined,
          normalizeOAuthBaseUrl: (_vendorId, baseUrl) => baseUrl,
          getOAuthApiKeyEnv: () => undefined,
          usesOAuthAuthHeader: () => false,
        },
      })).syncProviderStore(store);
    },
  };
}

async function createBootstrapService(RuntimeHostBootstrapService: typeof import('../../runtime-host/application/runtime-host/bootstrap').RuntimeHostBootstrapService) {
  const { GatewayPrelaunchWorkflow } = await import('../../runtime-host/application/workflows/runtime-bootstrap/gateway-prelaunch-workflow');
  const gatewayPrelaunchWorkflow = new GatewayPrelaunchWorkflow({
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
    providerProjectionSync: createProviderProjectionSync(),
    providerProjectionKeys: {
      resolveProviderKey: ({ vendorId, accountId }) => hoisted.getOpenClawProviderKeyForTypeMock(vendorId, accountId),
    },
    providerModels: {
      syncRuntimeProjection: hoisted.syncRuntimeModelProjectionMock,
    },
    capabilityRouting: {
      syncRuntimeProjection: hoisted.syncRuntimeRoutingProjectionMock,
    },
    workspace: {
      ensureDefaultIdentity: hoisted.ensureDefaultIdentityMock,
      migrateMainAgentTemplatesIfNeeded: hoisted.migrateMainAgentTemplatesIfNeededMock,
      mergeContextSnippets: hoisted.mergeContextSnippetsMock,
    },
    securityPluginConfig: {
      applySavedPolicyToPluginConfig: hoisted.applySavedPolicyToPluginConfigMock,
    },
    idGenerator: {
      randomHex: vi.fn(() => '1'.repeat(32)),
    },
  });
  return new RuntimeHostBootstrapService({
    gatewayPrelaunchWorkflow,
    jobs: {
      submitGatewayPrelaunch: hoisted.submitLongTaskMock,
      submitWorkspaceTemplateMigration: hoisted.submitLongTaskMock,
    },
  });
}

vi.mock('../../runtime-host/application/adapters/openclaw/projections/openclaw-provider-projection-rules', () => ({
  getOpenClawProviderKeyForType: (...args: unknown[]) => hoisted.getOpenClawProviderKeyForTypeMock(...args),
  getOAuthProviderApi: vi.fn(() => undefined),
  getOAuthProviderTokenKey: vi.fn((providerType: string) => providerType),
  getOAuthProviderDefaultBaseUrl: vi.fn(() => undefined),
  getOAuthApiKeyEnv: vi.fn(() => undefined),
  normalizeOAuthBaseUrl: vi.fn((_providerType: string, baseUrl?: string) => baseUrl),
  usesOAuthAuthHeader: vi.fn(() => false),
  getLegacyOpenClawProviderKeys: vi.fn(() => []),
}));

describe('runtime-host bootstrap provider sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.saveProviderKeyMock.mockResolvedValue(undefined);
    hoisted.removeProviderKeyMock.mockResolvedValue(undefined);
    hoisted.getAllSettingsMock.mockResolvedValue({ browserMode: 'relay', gatewayToken: '' });
    hoisted.cleanupStaleBuiltinExtensionsForGatewayLaunchMock.mockResolvedValue([]);
    hoisted.reconcileConfiguredChannelPluginsForGatewayLaunchMock.mockResolvedValue([]);
    hoisted.ensureConfiguredManagedPluginsForGatewayLaunchMock.mockResolvedValue([]);
    hoisted.applySavedPolicyToPluginConfigMock.mockResolvedValue(undefined);
    hoisted.ensureDefaultIdentityMock.mockResolvedValue({
      workspaceDirs: [],
      seededFiles: [],
      replacedTemplateFiles: [],
      removedBootstrapFiles: [],
    });
    hoisted.syncRuntimeModelProjectionMock.mockResolvedValue(undefined);
    hoisted.syncRuntimeRoutingProjectionMock.mockResolvedValue(undefined);
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
    const service = await createBootstrapService(RuntimeHostBootstrapService);
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

  it('gateway prelaunch 任务会同时同步 runtime-host settings 与 openclaw.json 的 gateway token', async () => {
    hoisted.readProviderStoreMock.mockResolvedValue({
      accounts: {},
      apiKeys: {},
    });
    hoisted.reconcileConfiguredChannelPluginsForGatewayLaunchMock.mockResolvedValue(['openclaw-weixin']);

    const { RuntimeHostBootstrapService } = await import('../../runtime-host/application/runtime-host/bootstrap');
    const service = await createBootstrapService(RuntimeHostBootstrapService);
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
    expect(hoisted.syncRuntimeModelProjectionMock).toHaveBeenCalledTimes(1);
    expect(hoisted.syncRuntimeRoutingProjectionMock).toHaveBeenCalledTimes(1);
    expect(hoisted.reconcileConfiguredChannelPluginsForGatewayLaunchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.ensureConfiguredManagedPluginsForGatewayLaunchMock).toHaveBeenCalledTimes(1);
    expect(hoisted.applySavedPolicyToPluginConfigMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({
      configuredChannels: ['openclaw-weixin'],
    }));
  });

});
