import { describe, expect, it, vi } from 'vitest';
import { RuntimeHostBootstrapService } from '../../runtime-host/application/runtime-host/bootstrap';

function createBootstrapService() {
  const service = new RuntimeHostBootstrapService({
    settingsRepository: {
      getAll: vi.fn(),
      setValue: vi.fn(),
    },
    providerStoreRepository: {
      read: vi.fn(),
      write: vi.fn(),
    },
    runtimeConfig: {
      syncProxy: vi.fn(),
      syncGatewayToken: vi.fn(),
      sanitize: vi.fn(),
      syncBrowserMode: vi.fn(),
      syncSessionIdleMinutes: vi.fn(),
    },
    runtimePlugins: {
      ensureManagedPluginInstalled: vi.fn(),
    },
    prelaunchPluginMaintenance: {
      cleanupStaleBuiltinExtensionsForGatewayLaunch: vi.fn(),
      reconcileConfiguredChannelPluginsForGatewayLaunch: vi.fn(),
      ensureConfiguredManagedPluginsForGatewayLaunch: vi.fn(),
    },
    providerRuntimeSync: {
      syncProviderStore: vi.fn(),
    },
    workspace: {
      ensureDefaultIdentity: vi.fn(),
      migrateMainAgentTemplatesIfNeeded: vi.fn(),
      mergeContextSnippets: vi.fn(),
    },
    securityPluginConfig: {
      applySavedPolicyToPluginConfig: vi.fn(),
    },
    idGenerator: {
      randomHex: vi.fn(() => '1'.repeat(32)),
    },
    jobs: {
      submitGatewayPrelaunch: vi.fn(),
      submitProviderAuthBootstrap: vi.fn(),
      submitWorkspaceTemplateMigration: vi.fn(),
    },
  } as never);

  return { service };
}

describe('runtime-host gateway lifecycle', () => {
  it('Gateway running 事件不再提交安全策略同步 job', () => {
    const { service } = createBootstrapService();

    const job = service.onGatewayLifecycle({ state: 'running', port: 18789 });

    expect(job).toBeNull();
  });

  it('非 running 生命周期事件不触发业务 job', () => {
    const { service } = createBootstrapService();

    const job = service.onGatewayLifecycle({ state: 'stopped' });

    expect(job).toBeNull();
  });
});
