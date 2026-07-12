import type { Server } from 'node:http';
import {
  DEFAULT_PORT,
} from '../shared/runtime-host-constants';
import { createHealthPayload } from '../application/runtime-host/runtime-state';
import { createParentTransportClient } from './parent-transport-client';
import { createRuntimeHostHttpServer } from './runtime-host-server';
import { RuntimeHostServerRunner } from './runtime-host-runner';
import { createRuntimeHostRouteRegistry } from './runtime-route-composition';
import {
  createApplicationServiceRegistry,
  registerRuntimeHostApplicationServices,
} from './application-services';
import type { RuntimeHostStatePort } from '../application/runtime-host/runtime-state';
import type { TeamRuntimePort } from '../application/team-runtime/team-runtime-port';
import type { RemoteFleetPort } from '../application/remote-fleet/remote-fleet-service';
import type { RemoteFleetTerminalManager } from '../application/remote-fleet/remote-fleet-terminal-manager';
import type { TeamRuntimeWebhookAuthService } from '../application/team-runtime/team-runtime-webhook-auth';
import { RuntimeHostContainer } from './container';
import {
  REMOTE_FLEET_SERVICE_TOKEN,
  RUNTIME_DISPATCH_ROUTE_TOKEN,
  TEAM_RUNTIME_SERVICE_TOKEN,
  TEAM_RUNTIME_WEBHOOK_AUTH_TOKEN,
} from './runtime-host-tokens';
import {
  registerRuntimeHostInfrastructure,
  resolveRuntimeHostInfrastructure,
} from './modules/runtime-infrastructure-module';
import {
  registerRuntimeHostModuleJobs,
  registerRuntimeHostModuleLifecycle,
  validateRuntimeHostApplicationModuleRegistrationOwners,
} from './runtime-host-module-registry';
import {
  registerRuntimeHostSystemInfrastructure,
  registerRuntimeHostSystemModuleJobs,
  registerRuntimeHostSystemModuleLifecycle,
  registerRuntimeHostSystemServices,
  resolveRuntimeHostSystemModules,
  validateRuntimeHostSystemModuleRegistrationOwners,
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
  const { pluginRegistry } = systemModules.pluginRuntime;

  container.registerValue('runtimeHost.stateSnapshots', {
    runtimeState: () => pluginRegistry.snapshotRuntimeState(),
    runtimeHealth: (state: ReturnType<RuntimeHostStatePort['runtimeState']>) => pluginRegistry.snapshotRuntimeHealth(state),
  });
  container.registerValue('runtimeHost.transportStats', {
    snapshot: () => transportStats,
  });
  container.registerValue('runtimeHost.parentShell', parentShell);
  container.registerValue('runtimeHost.parentGatewayEvents', {
    emit: parentTransportClient.emitParentGatewayEvent,
  });
  const applicationContext = {
    container,
    facades: createApplicationServiceRegistry(),
  };
  registerRuntimeHostApplicationServices(applicationContext);
  const routeRegistry = createRuntimeHostRouteRegistry(applicationContext);
  const dispatchRuntimeRoute = routeRegistry.dispatcher();
  const teamRuntimeService = applicationContext.facades.resolve<TeamRuntimePort>(TEAM_RUNTIME_SERVICE_TOKEN);
  const teamRuntimeWebhookAuth = applicationContext.facades.resolve<TeamRuntimeWebhookAuthService>(TEAM_RUNTIME_WEBHOOK_AUTH_TOKEN);
  const remoteFleetService = applicationContext.facades.resolve<Pick<RemoteFleetPort, 'invoke'>>(REMOTE_FLEET_SERVICE_TOKEN);
  const remoteFleetTerminalManager = container.resolve<RemoteFleetTerminalManager>('remoteFleet.terminalManager');
  container.registerValue(RUNTIME_DISPATCH_ROUTE_TOKEN, dispatchRuntimeRoute);
  registerRuntimeHostSystemModuleJobs(systemModuleContext, systemModules);
  registerRuntimeHostModuleJobs(container, {
    jobRegistry,
  });
  registerRuntimeHostSystemModuleLifecycle(systemModuleContext, systemModules);
  registerRuntimeHostModuleLifecycle(container, {
    lifecycle,
  });
  validateRuntimeHostSystemModuleRegistrationOwners(systemModuleContext);
  validateRuntimeHostApplicationModuleRegistrationOwners(container, {
    jobRegistry,
    lifecycle,
    routes: routeRegistry,
    facades: applicationContext.facades,
  });

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
    teamWebhookToken: () => teamRuntimeWebhookAuth.getToken(),
    teamRuntimeService,
    remoteFleetService,
    nowMs: () => clock.nowMs(),
    nowIso: () => new Date(clock.nowMs()).toISOString(),
    terminalStream: remoteFleetTerminalManager,
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
