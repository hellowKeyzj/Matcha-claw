import { describe, expect, it, vi } from 'vitest';
import { RuntimeHostBootstrapService } from '../../runtime-host/application/runtime-host/bootstrap';

function createBootstrapService() {
  const submitPolicySync = vi.fn(() => ({
    success: true as const,
    job: {
      id: 'security-sync-job',
      type: 'security.policySync',
      status: 'queued' as const,
      queuedAt: 1,
      attempts: 0,
      maxAttempts: 1,
      queue: 'default' as const,
    },
  }));

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
      migrateMainAgentTemplatesIfNeeded: vi.fn(),
    },
    securityJobs: {
      submitPolicySync,
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

  return { service, submitPolicySync };
}

describe('runtime-host gateway lifecycle', () => {
  it('Gateway running 事件由 runtime-host 提交安全策略同步 job', () => {
    const { service, submitPolicySync } = createBootstrapService();

    const job = service.onGatewayLifecycle({ state: 'running', port: 18789 });

    expect(submitPolicySync).toHaveBeenCalledTimes(1);
    expect(job).toMatchObject({
      success: true,
      job: {
        id: 'security-sync-job',
        type: 'security.policySync',
      },
    });
  });

  it('非 running 生命周期事件不触发业务 job', () => {
    const { service, submitPolicySync } = createBootstrapService();

    const job = service.onGatewayLifecycle({ state: 'stopped' });

    expect(job).toBeNull();
    expect(submitPolicySync).not.toHaveBeenCalled();
  });
});
