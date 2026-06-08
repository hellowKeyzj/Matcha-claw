import { describe, expect, it, vi } from 'vitest';
import {
  createRuntimeHostRouteHandlers,
  createRuntimeHostRouteRegistry,
} from '../../runtime-host/composition/runtime-route-composition';
import {
  createApplicationServiceRegistry,
  registerRuntimeHostApplicationServices,
} from '../../runtime-host/composition/application-services';
import { RuntimeHostContainer } from '../../runtime-host/composition/container';
import {
  registerRuntimeHostInfrastructure,
  resolveRuntimeHostInfrastructure,
} from '../../runtime-host/composition/modules/runtime-infrastructure-module';
import { createParentTransportClient } from '../../runtime-host/composition/parent-transport-client';
import {
  registerRuntimeHostSystemInfrastructure,
  registerRuntimeHostSystemServices,
  resolveRuntimeHostSystemModules,
} from '../../runtime-host/composition/runtime-host-runtime-module-registry';
import {
  validateRuntimeHostApplicationModuleRegistrationOwners,
} from '../../runtime-host/composition/runtime-host-module-registry';

function createApplicationContext() {
  const container = new RuntimeHostContainer();
  registerRuntimeHostInfrastructure(container);
  const infrastructure = resolveRuntimeHostInfrastructure(container);
  const parentTransport = createParentTransportClient({
    parentApiBaseUrl: 'http://127.0.0.1:1',
    parentDispatchToken: 'test-token',
    httpClient: infrastructure.httpClient,
    scheduler: infrastructure.scheduler,
  });
  const systemModuleContext = {
    container,
    infrastructure,
    parentTransport: {
      ...parentTransport,
      emitParentGatewayEvent: vi.fn(async () => ({ success: true })),
      requestParentShellAction: vi.fn(async () => ({
        success: true,
        status: 200,
        data: { success: true },
      })),
      mapParentTransportResponse: vi.fn((upstream: unknown) => ({
        status: 200,
        data: upstream,
      })),
    },
  };

  registerRuntimeHostSystemInfrastructure(systemModuleContext);
  registerRuntimeHostSystemServices(systemModuleContext);
  const systemModules = resolveRuntimeHostSystemModules(systemModuleContext);
  container.registerValue('runtimeHost.stateSnapshots', {
    runtimeState: () => systemModules.pluginRuntime.pluginRegistry.snapshotRuntimeState(),
    runtimeHealth: () => systemModules.pluginRuntime.pluginRegistry.snapshotRuntimeHealth({
      lifecycle: 'running',
      uptimeMs: 0,
    }),
  });
  container.registerValue('runtimeHost.transportStats', {
    snapshot: () => infrastructure.transportStats,
  });
  container.registerValue('runtimeHost.parentShell', {
    request: systemModuleContext.parentTransport.requestParentShellAction,
    mapResponse: systemModuleContext.parentTransport.mapParentTransportResponse,
  });
  container.registerValue('runtimeHost.parentGatewayEvents', {
    emit: systemModuleContext.parentTransport.emitParentGatewayEvent,
  });
  const applicationContext = {
    container,
    facades: createApplicationServiceRegistry(),
  };
  registerRuntimeHostApplicationServices(applicationContext);
  return applicationContext;
}

describe('runtime-host route composition', () => {
  it('runtime 路由由领域模块注册到 composition root', () => {
    const registry = createRuntimeHostRouteHandlers(createApplicationContext());
    const keys = registry.map((entry) => entry.key);

    expect(keys[0]).toBe('workbench.GET /api/workbench/bootstrap');
    expect(new Set(keys).size).toBe(keys.length);
    expect(registry.every((entry) => typeof entry.handle === 'function')).toBe(true);
  });

  it('route facade resolve 参与 module import/export 校验', () => {
    const context = createApplicationContext();
    const routeRegistry = createRuntimeHostRouteRegistry(context);

    expect(() => validateRuntimeHostApplicationModuleRegistrationOwners(context.container, {
      routes: routeRegistry,
      facades: context.facades,
    })).not.toThrow();
    expect(context.facades.listResolveEdges()).toEqual(expect.arrayContaining([
      { fromOwner: 'sessions', toOwner: 'agentRuntime', key: 'agentRuntime.application' },
    ]));
  });

  it('runtime 路由覆盖所有 runtime-host API 能力', () => {
    const registry = createRuntimeHostRouteHandlers(createApplicationContext());
    const namespaces = new Set(registry.map((entry) => entry.key.split('.')[0]));
    expect(namespaces).toEqual(new Set([
      'workbench',
      'runtime_host',
      'runtimeTopology',
      'plugin_runtime',
      'gateway',
      'cron_usage',
      'files',
      'license',
      'toolchain_uv',
      'security',
      'platform',
      'settings',
      'provider',
      'capabilityRouting',
      'capabilities',
      'providerModels',
      'channel',
      'openclaw',
      'skills',
      'subagents',
      'clawhub',
      'session',
    ]));
    const routeKeys = registry.map((entry) => entry.key);
    expect(routeKeys).not.toContain('runtime_host.POST /api/runtime-host/jobs/get');
    expect(routeKeys).toEqual(expect.arrayContaining([
      'gateway.POST /api/gateway/ready',
      'subagents.POST /api/subagents/list',
      'runtime_host.GET /api/runtime-host/jobs',
      'files.POST /api/files/read-text',
      'session.POST /api/sessions/prompt',
      'session.POST /api/sessions/window',
      'capabilities.POST /api/capabilities/execute',
      'runtimeTopology.GET /api/runtime-endpoints/list',
    ]));
  });
});
