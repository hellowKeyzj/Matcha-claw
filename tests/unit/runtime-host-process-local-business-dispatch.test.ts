import { describe, expect, it, vi } from 'vitest';
import {
  createLocalBusinessHandlerRegistry,
  type LocalBusinessHandlerKey,
} from '../../runtime-host/api/dispatch/local-business-dispatch';

function createContext() {
  return {
    buildLocalRuntimeState: vi.fn(() => ({
      lifecycle: 'running',
      plugins: [],
    })),
    buildLocalRuntimeHealth: vi.fn(() => ({
      ok: true,
    })),
    buildTransportStatsSnapshot: vi.fn(() => ({
      totalDispatchRequests: 0,
    })),
    buildLocalPluginsRuntimePayload: vi.fn(() => ({
      success: true,
    })),
    getPluginExecutionEnabled: vi.fn(() => true),
    getEnabledPluginIds: vi.fn(() => ['security-core']),
    getPluginCatalog: vi.fn(() => []),
    openclawBridge: {
      gatewayRpc: vi.fn(async () => ({ success: true })),
      chatSend: vi.fn(async () => ({ success: true })),
      isGatewayRunning: vi.fn(async () => true),
      securityPolicySync: vi.fn(async () => ({ success: true })),
      securityAuditQueryFromUrl: vi.fn(async () => ({ success: true, items: [] })),
      securityQuickAuditRun: vi.fn(async () => ({ success: true })),
      securityEmergencyRun: vi.fn(async () => ({ success: true })),
      securityIntegrityCheck: vi.fn(async () => ({ success: true })),
      securityIntegrityRebaseline: vi.fn(async () => ({ success: true })),
      securitySkillsScan: vi.fn(async () => ({ success: true })),
      securityAdvisoriesCheck: vi.fn(async () => ({ success: true })),
      securityRemediationPreview: vi.fn(async () => ({ success: true })),
      securityRemediationApply: vi.fn(async () => ({ success: true })),
      securityRemediationRollback: vi.fn(async () => ({ success: true })),
      listCronJobs: vi.fn(async () => ({ jobs: [] })),
      addCronJob: vi.fn(async () => ({ success: true })),
      updateCronJob: vi.fn(async () => ({ success: true })),
      removeCronJob: vi.fn(async () => ({ success: true })),
      runCronJob: vi.fn(async () => ({ success: true })),
      channelsStatus: vi.fn(async () => ({ success: true })),
      channelsConnect: vi.fn(async () => ({ success: true })),
      channelsDisconnect: vi.fn(async () => ({ success: true })),
      channelsRequestQr: vi.fn(async () => ({ success: true })),
    },
    requestParentShellAction: vi.fn(async () => ({
      success: true,
      status: 200,
      data: { success: true },
    })),
    mapParentTransportResponse: vi.fn((upstream: unknown) => ({
      status: 200,
      data: upstream,
    })),
  };
}

describe('runtime-host process local business dispatch registry', () => {
  it('路由注册顺序保持稳定，避免分发链隐式漂移', () => {
    const registry = createLocalBusinessHandlerRegistry(createContext());
    const keys = registry.map((entry) => entry.key);
    const expectedOrder: LocalBusinessHandlerKey[] = [
      'workbench',
      'runtime_host',
      'cron_usage',
      'license',
      'settings',
      'provider',
      'channel',
      'openclaw',
      'skills',
      'team_runtime',
      'clawhub',
      'toolchain_uv',
      'session',
      'plugin_runtime',
      'gateway',
      'security',
      'platform',
    ];

    expect(keys).toEqual(expectedOrder);
  });

  it('每个注册项都必须提供可执行 handler', () => {
    const registry = createLocalBusinessHandlerRegistry(createContext());
    expect(registry.every((entry) => typeof entry.handle === 'function')).toBe(true);
  });
});
