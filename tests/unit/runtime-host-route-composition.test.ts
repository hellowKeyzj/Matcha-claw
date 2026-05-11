import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeHostRouteHandlers,
} from '../../runtime-host/composition/runtime-route-composition';
import {
  composeRuntimeHostApplicationServices,
  registerRuntimeHostApplicationServices,
} from '../../runtime-host/composition/application-services';
import { RuntimeHostContainer } from '../../runtime-host/composition/container';
import { registerOpenClawInfrastructure } from '../../runtime-host/composition/modules/openclaw-infrastructure-module';
import {
  registerRuntimeHostInfrastructure,
  resolveRuntimeHostInfrastructure,
} from '../../runtime-host/composition/modules/runtime-infrastructure-module';
import {
  registerPluginRuntimeModule,
  resolvePluginRuntimeModule,
} from '../../runtime-host/composition/modules/plugin-runtime-module';

function createContainer() {
  const container = new RuntimeHostContainer();
  registerRuntimeHostInfrastructure(container);
  const infrastructure = resolveRuntimeHostInfrastructure(container);
  registerOpenClawInfrastructure(container);
  registerPluginRuntimeModule(container, {
    lifecycle: infrastructure.lifecycle,
    logger: infrastructure.logger,
    enabledPluginIdsEnv: undefined,
    pluginCatalogEnv: undefined,
  });
  resolvePluginRuntimeModule(container);
  container.registerValue('gateway.control', {
    restartGateway: vi.fn(async () => ({
      success: true,
      status: 200,
      data: { success: true },
    })),
  });
  const applicationContext = {
    container,
    runtimeState: {
      runtimeState: vi.fn(() => ({
        lifecycle: 'running',
        plugins: [],
      })),
      runtimeHealth: vi.fn(() => ({
        ok: true,
      })),
    },
    transportStats: {
      snapshot: vi.fn(() => ({
        totalDispatchRequests: 0,
        runtimeRouteHandled: 0,
        unhandledRouteCount: 0,
        badRequestRejected: 0,
        dispatchInternalError: 0,
      })),
    },
    pluginRuntime: {
      snapshotPluginsRuntimePayload: vi.fn(() => ({
        success: true,
      })),
      enqueueRefresh: vi.fn(),
      getRefreshJob: vi.fn(() => null),
      getEnabledPluginIds: vi.fn(() => ['security-core']),
      getPluginCatalog: vi.fn(() => []),
    },
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
    platformRuntime: {},
    parentShell: {
      request: vi.fn(async () => ({
        success: true,
        status: 200,
        data: { success: true },
      })),
      mapResponse: vi.fn((upstream: unknown) => ({
        status: 200,
        data: upstream,
      })),
    },
  } as never;
  registerRuntimeHostApplicationServices(applicationContext);
  composeRuntimeHostApplicationServices(applicationContext);
  return container;
}

describe('runtime-host route composition', () => {
  it('runtime 路由由领域模块注册到 composition root', () => {
    const registry = createRuntimeHostRouteHandlers(createContainer());
    const keys = registry.map((entry) => entry.key);

    expect(keys[0]).toBe('workbench.GET /api/workbench/bootstrap');
    expect(new Set(keys).size).toBe(keys.length);
    expect(registry.every((entry) => typeof entry.handle === 'function')).toBe(true);
  });

  it('runtime 路由覆盖所有 runtime-host API 能力', () => {
    const registry = createRuntimeHostRouteHandlers(createContainer());
    const namespaces = new Set(registry.map((entry) => entry.key.split('.')[0]));
    expect(namespaces).toEqual(new Set([
      'workbench',
      'runtime_host',
      'plugin_runtime',
      'gateway',
      'cron_usage',
      'files',
      'license',
      'team_runtime',
      'toolchain_uv',
      'security',
      'tasks',
      'platform',
      'settings',
      'provider',
      'channel',
      'openclaw',
      'skills',
      'subagents',
      'clawhub',
      'session',
    ]));
    expect(registry.map((entry) => entry.key)).toEqual(expect.arrayContaining([
      'gateway.POST /api/gateway/ready',
      'tasks.POST /api/tasks/list',
      'subagents.POST /api/subagents/config/get',
      'runtime_host.POST /api/runtime-host/jobs/get',
      'files.POST /api/files/read-text',
    ]));
  });
});
