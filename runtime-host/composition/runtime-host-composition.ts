import type { Server } from 'node:http';
import {
  DEFAULT_PORT,
} from '../shared/runtime-host-constants';
import { createHealthPayload } from '../application/runtime-host/runtime-state';
import { createRuntimeRouteDispatcher } from '../api/dispatch/runtime-route-dispatcher';
import { createParentTransportClient } from './parent-transport-client';
import { createRuntimeHostHttpServer } from './runtime-host-server';
import { RuntimeHostServerRunner } from './runtime-host-runner';
import { createRuntimeHostRouteHandlers } from './runtime-route-composition';
import {
  composeRuntimeHostApplicationServices,
  registerRuntimeHostApplicationServices,
} from './application-services';
import { RuntimeHostContainer } from './container';
import {
  registerRuntimeHostInfrastructure,
  resolveRuntimeHostInfrastructure,
} from './modules/runtime-infrastructure-module';
import {
  registerRuntimeHostModuleJobs,
  registerRuntimeHostModuleLifecycle,
} from './runtime-host-module-registry';
import {
  registerRuntimeHostSystemInfrastructure,
  registerRuntimeHostSystemModuleJobs,
  registerRuntimeHostSystemModuleLifecycle,
  registerRuntimeHostSystemServices,
  resolveRuntimeHostSystemModules,
} from './runtime-host-runtime-module-registry';

export interface RuntimeHostProcess {
  readonly server: Server;
  readonly start: () => Promise<Server>;
  readonly shutdown: (exitCode?: number) => Promise<void>;
}

export interface RuntimeHostTransportStatsSnapshot {
  totalDispatchRequests: number;
  runtimeRouteHandled: number;
  unhandledRouteCount: number;
  badRequestRejected: number;
  dispatchInternalError: number;
}

function readRequiredEnv(environment: { getEnv(name: string): string }, name: string): string {
  const value = environment.getEnv(name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing required runtime-host env: ${name}`);
  }
  return value;
}

export function createRuntimeHostProcess(): RuntimeHostProcess {
  const container = new RuntimeHostContainer();
  registerRuntimeHostInfrastructure(container);
  const infrastructure = resolveRuntimeHostInfrastructure(container);
  const {
    logger,
    lifecycle,
    jobRegistry,
    transportStats,
    httpClient,
    processInfo,
    processControl,
    scheduler,
    tcpProbe,
    clock,
    systemEnvironment,
  } = infrastructure;
  const startedAtMs = clock.nowMs();
  const port = Number.parseInt(systemEnvironment.getEnv('MATCHACLAW_RUNTIME_HOST_PORT'), 10) || DEFAULT_PORT;
  const parentApiBaseUrl = readRequiredEnv(
    systemEnvironment,
    'MATCHACLAW_RUNTIME_HOST_PARENT_API_BASE_URL',
  ).replace(/\/+$/, '');
  const parentDispatchToken = readRequiredEnv(systemEnvironment, 'MATCHACLAW_RUNTIME_HOST_PARENT_DISPATCH_TOKEN');

  const parentTransportClient = createParentTransportClient({
    parentApiBaseUrl,
    parentDispatchToken,
    httpClient,
    scheduler,
  });
  infrastructure.jobQueue.setEventSink({
    emitDone: (snapshot) => {
      void parentTransportClient.emitParentRuntimeJobEvent('runtime-job:done', snapshot).catch(() => undefined);
    },
    emitProgress: (snapshot) => {
      void parentTransportClient.emitParentRuntimeJobEvent('runtime-job:progress', snapshot).catch(() => undefined);
    },
  });
  const parentShell = {
    request: parentTransportClient.requestParentShellAction,
    mapResponse: parentTransportClient.mapParentTransportResponse,
  };

  const systemModuleContext = {
    container,
    infrastructure,
    parentTransport: parentTransportClient,
  };
  registerRuntimeHostSystemInfrastructure(systemModuleContext);
  registerRuntimeHostSystemServices(systemModuleContext);
  const systemModules = resolveRuntimeHostSystemModules(systemModuleContext);
  const openclawBridge = systemModules.gatewayBridge.openclawBridge;
  const { pluginRegistry } = systemModules.pluginRuntime;

  const applicationContext = {
    container,
    runtimeState: {
      runtimeState: () => pluginRegistry.snapshotRuntimeState(),
      runtimeHealth: (state) => pluginRegistry.snapshotRuntimeHealth(state as ReturnType<typeof pluginRegistry.snapshotRuntimeState>),
    },
    transportStats: {
      snapshot: () => transportStats,
    },
    pluginRuntime: {
      snapshotPluginsRuntimePayload: () => pluginRegistry.snapshotPluginsRuntimePayload(),
      enqueueRefresh: () => pluginRegistry.enqueueRefresh(),
      getEnabledPluginIds: () => pluginRegistry.getEnabledPluginIds(),
      getPluginCatalog: () => pluginRegistry.getPluginCatalog(),
      getRefreshJob: () => pluginRegistry.getRefreshJob(),
    },
    openclawBridge,
    sessionRuntime: systemModules.sessionRuntime.sessionRuntime,
    platformRuntime: systemModules.platformRuntime.facade,
    parentShell,
    parentGatewayEvents: {
      emit: parentTransportClient.emitParentGatewayEvent,
    },
  };
  registerRuntimeHostApplicationServices(applicationContext);
  composeRuntimeHostApplicationServices(applicationContext);
  container.registerValue('runtime.dispatchRoute', (method: string, route: string, payload: unknown) => (
    createRuntimeRouteDispatcher(createRuntimeHostRouteHandlers(container))(method, route, payload)
  ));
  registerRuntimeHostSystemModuleJobs(systemModuleContext, systemModules);
  registerRuntimeHostModuleJobs(container, {
    jobRegistry,
  });
  registerRuntimeHostSystemModuleLifecycle(systemModuleContext, systemModules);
  registerRuntimeHostModuleLifecycle(container, {
    lifecycle,
  });

  const dispatchRuntimeRoute = container.resolve<ReturnType<typeof createRuntimeRouteDispatcher>>('runtime.dispatchRoute');
  let runner: RuntimeHostServerRunner;

  const server = createRuntimeHostHttpServer({
    port,
    startedAtMs,
    getLifecycleState: () => lifecycle.getState(),
    restartLifecycle: () => {
      lifecycle.markRunning();
      lifecycle.startBackgroundServices();
    },
    createHealthPayload: (state, startedAt) => createHealthPayload(state, startedAt, processInfo, clock),
    transportStats,
    logger,
    dispatchRuntimeRoute,
    shutdown: (exitCode) => runner.shutdown(exitCode),
  });
  runner = new RuntimeHostServerRunner({
    server,
    lifecycle,
    logger,
    processControl,
    port,
  });

  return {
    server,
    start: () => runner.start(),
    shutdown: (exitCode) => runner.shutdown(exitCode),
  };
}
