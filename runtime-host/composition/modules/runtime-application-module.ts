import { buildTransportStatsSnapshot } from '../../application/runtime-host/runtime-state';
import type { ChannelConfigRepository } from '../../application/channels/channel-runtime';
import { GatewayService } from '../../application/gateway/service';
import type { GatewayRuntimePort } from '../../application/gateway/gateway-runtime-port';
import { PluginRuntimeService } from '../../application/plugins/plugin-runtime-service';
import { createRuntimeHostCapabilityOperationRoutes } from '../../application/capabilities/runtime/runtime-host-capability';
import type { CapabilityOperationRoute } from '../../application/capabilities/contracts/capability-router';
import {
  GATEWAY_PRELAUNCH_JOB,
  WORKSPACE_TEMPLATE_MIGRATION_JOB,
  createRuntimeHostBootstrapJobPort,
  type RuntimeHostBootstrapJobPort,
} from '../../application/runtime-host/bootstrap-jobs';
import { RuntimeHostBootstrapService, type RuntimeHostRuntimeConfigPort, type RuntimeHostWorkspaceBootstrapPort } from '../../application/runtime-host/bootstrap';
import { GatewayPrelaunchWorkflow } from '../../application/workflows/runtime-bootstrap/gateway-prelaunch-workflow';
import { PrelaunchMaintenanceCacheWorkflow } from '../../application/workflows/runtime-bootstrap/prelaunch-maintenance-cache-workflow';
import { RuntimeHostOperationsWorkflow } from '../../application/workflows/runtime-host/runtime-host-operations-workflow';
import { GatewayReadinessWorkflow } from '../../application/workflows/gateway-readiness/gateway-readiness-workflow';
import { PluginRuntimeOperationsWorkflow } from '../../application/workflows/plugin-runtime/plugin-runtime-operations-workflow';
import { DiagnosticsCollectionWorkflow } from '../../application/workflows/diagnostics/diagnostics-collection-workflow';
import { PrelaunchMaintenanceCacheRepository, type PrelaunchMaintenanceCacheStoragePort } from '../../application/runtime-host/prelaunch-maintenance-cache';
import { PrelaunchPluginMaintenanceService, type PrelaunchChannelPluginProjectionPort, type PrelaunchPluginMaintenanceRuntimePort } from '../../application/runtime-host/prelaunch-plugin-maintenance';
import { RuntimeJobsService } from '../../application/runtime-host/runtime-jobs-service';
import { RuntimeHostService, type RuntimeHostEnvironmentPort } from '../../application/runtime-host/service';
import { RuntimeHostStateService, type RuntimeHostStatePort } from '../../application/runtime-host/runtime-state';
import type { ParentShellPort } from '../../application/runtime-host/parent-shell-port';
import type { RuntimeHostTransportStatsSnapshot } from '../runtime-host-composition';
import { DiagnosticsService } from '../../application/support/diagnostics';
import type { DiagnosticsRuntimeBundleLayoutPort } from '../../application/support/diagnostics-bundle';
import {
  COLLECT_DIAGNOSTICS_JOB,
  createDiagnosticsJobPort,
  type DiagnosticsJobPort,
} from '../../application/support/diagnostics-jobs';
import { WorkbenchService } from '../../application/workbench/service';
import type { PluginRuntimePort, RuntimePluginCatalogProjectionPort, RuntimePluginRepositoryPort } from '../../application/plugins/runtime-plugin-service';
import type { ProviderProjectionKeyResolverPort, ProviderProjectionSyncService } from '../../application/providers/store-sync';
import type { ProviderModelsApplicationService } from '../../application/providers/provider-models-service';
import type { CapabilityRoutingApplicationService } from '../../application/providers/capability-routing-service';
import type { ProviderStoreRepository } from '../../application/providers/provider-store-repository';
import type { SettingsRepository } from '../../application/settings/store';
import type { ApplicationServiceRegistry } from '../application-service-registry';
import type { RuntimeHostContainer } from '../container';
import {
  registerRuntimeJobDefinitions,
  type RuntimeJobDefinition,
  type RuntimeJobRegistry,
} from '../../core/jobs';
import type {
  RuntimeClockPort,
  RuntimeCommandExecutorPort,
  RuntimeFileSystemPort,
  RuntimeIdGeneratorPort,
  RuntimeProcessInfoPort,
} from '../../application/common/runtime-ports';
import type { LicenseService } from '../../application/license/service';
import type { RuntimeHostLogger } from '../../shared/logger';
import {
  GATEWAY_SERVICE_TOKEN,
  PLUGIN_RUNTIME_SERVICE_TOKEN,
  RUNTIME_HOST_SERVICE_TOKEN,
  WORKBENCH_SERVICE_TOKEN,
} from '../runtime-host-tokens';
import type { RuntimeLongTaskSubmissionPort } from '../../application/runtime-host/runtime-task-ports';
import type { SecurityPluginConfigApplier } from '../../application/security/security-plugin-config-applier';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';

function createRuntimeHostService(
  scope: RuntimeHostContainer,
): RuntimeHostService {
  return new RuntimeHostService({
    runtimeState: scope.resolve<RuntimeHostStateService>('runtimeHost.stateService'),
    operationsWorkflow: scope.resolve<RuntimeHostOperationsWorkflow>('runtimeHost.operationsWorkflow'),
  });
}

export function registerRuntimeApplicationServices(
  container: RuntimeHostContainer,
  facades: ApplicationServiceRegistry,
): void {
  container.register('gateway.readinessWorkflow', (scope) => new GatewayReadinessWorkflow({
    gateway: scope.resolve<GatewayRuntimePort>('gateway.runtime'),
  }));
  container.register('gateway.service', (scope) => new GatewayService({
    readinessWorkflow: scope.resolve<GatewayReadinessWorkflow>('gateway.readinessWorkflow'),
  }));
  container.register('plugins.runtimeOperationsWorkflow', (scope) => new PluginRuntimeOperationsWorkflow({
    runtime: scope.resolve<PluginRuntimePort>('plugins.runtime'),
    jobs: scope.resolve('plugins.runtimeJobs'),
    catalogProjection: scope.resolve<RuntimePluginCatalogProjectionPort>('plugins.catalogProjection'),
  }));
  container.register('plugins.runtimeService', (scope) => new PluginRuntimeService({
    operationsWorkflow: scope.resolve<PluginRuntimeOperationsWorkflow>('plugins.runtimeOperationsWorkflow'),
  }));
  container.register('runtimeHost.prelaunchMaintenanceCacheWorkflow', (scope) => new PrelaunchMaintenanceCacheWorkflow({
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('runtimeHost.prelaunchMaintenanceCacheRepository', (scope) => new PrelaunchMaintenanceCacheRepository(
    scope.resolve<PrelaunchMaintenanceCacheStoragePort>('runtimeHost.prelaunchMaintenanceCacheStorage'),
    scope.resolve<PrelaunchMaintenanceCacheWorkflow>('runtimeHost.prelaunchMaintenanceCacheWorkflow'),
  ));
  container.register('runtimeHost.prelaunchPluginMaintenanceService', (scope) => new PrelaunchPluginMaintenanceService({
    runtimePlugins: scope.resolve<RuntimePluginRepositoryPort>('plugins.repository'),
    channels: scope.resolve<ChannelConfigRepository>('channels.configRepository'),
    channelPluginProjection: scope.resolve<PrelaunchChannelPluginProjectionPort>('channels.prelaunchPluginProjection'),
    runtime: scope.resolve<PrelaunchPluginMaintenanceRuntimePort>('runtimeHost.prelaunchPluginMaintenanceRuntime'),
    cacheRepository: scope.resolve<PrelaunchMaintenanceCacheRepository>('runtimeHost.prelaunchMaintenanceCacheRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('runtimeHost.gatewayPrelaunchWorkflow', (scope) => new GatewayPrelaunchWorkflow({
    settingsRepository: scope.resolve<SettingsRepository>('settings.repository'),
    providerStoreRepository: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    runtimeConfig: scope.resolve<RuntimeHostRuntimeConfigPort>('runtimeHost.runtimeConfig'),
    runtimePlugins: scope.resolve<RuntimePluginRepositoryPort>('plugins.repository'),
    prelaunchPluginMaintenance: scope.resolve<PrelaunchPluginMaintenanceService>('runtimeHost.prelaunchPluginMaintenanceService'),
    providerProjectionSync: scope.resolve<ProviderProjectionSyncService>('providers.projectionSyncService'),
    providerProjectionKeys: scope.resolve<ProviderProjectionKeyResolverPort>('providers.projectionKeyResolver'),
    providerModels: scope.resolve<ProviderModelsApplicationService>('providers.modelsService'),
    capabilityRouting: scope.resolve<CapabilityRoutingApplicationService>('providers.capabilityRoutingService'),
    workspace: scope.resolve<RuntimeHostWorkspaceBootstrapPort>('runtimeHost.workspaceBootstrap'),
    securityPluginConfig: scope.resolve<SecurityPluginConfigApplier>('security.pluginConfigApplier'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
  }));
  container.register('runtimeHost.bootstrapService', (scope) => new RuntimeHostBootstrapService({
    gatewayPrelaunchWorkflow: scope.resolve<GatewayPrelaunchWorkflow>('runtimeHost.gatewayPrelaunchWorkflow'),
    jobs: scope.resolve<RuntimeHostBootstrapJobPort>('runtimeHost.bootstrapJobs'),
  }));
  container.register('runtimeHost.bootstrapJobs', (scope): RuntimeHostBootstrapJobPort => createRuntimeHostBootstrapJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('diagnostics.service', (scope) => new DiagnosticsService(
    scope.resolve<DiagnosticsJobPort>('diagnostics.jobs'),
    scope.resolve<RuntimeProcessInfoPort>('runtime.processInfo'),
    scope.resolve<RuntimeCommandExecutorPort>('runtime.commandExecutor'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
    scope.resolve<DiagnosticsRuntimeBundleLayoutPort>('diagnostics.runtimeLayout'),
  ));
  container.register('diagnostics.collectionWorkflow', (scope) => new DiagnosticsCollectionWorkflow({
    environment: scope.resolve<RuntimeHostEnvironmentPort>('runtimeHost.environment'),
    processInfo: scope.resolve<RuntimeProcessInfoPort>('runtime.processInfo'),
    systemEnvironment: scope.resolve('runtime.systemEnvironment'),
    diagnostics: scope.resolve<DiagnosticsService>('diagnostics.service'),
    license: scope.resolve<LicenseService>('license.service'),
    parentShell: scope.resolve<ParentShellPort>('runtimeHost.parentShell'),
  }));
  container.register('diagnostics.jobs', (scope): DiagnosticsJobPort => createDiagnosticsJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('runtimeHost.operationsWorkflow', (scope) => new RuntimeHostOperationsWorkflow({
    bootstrap: scope.resolve<RuntimeHostBootstrapService>('runtimeHost.bootstrapService'),
    diagnosticsCollectionWorkflow: scope.resolve<DiagnosticsCollectionWorkflow>('diagnostics.collectionWorkflow'),
    jobs: scope.resolve<RuntimeJobsService>('runtimeHost.jobsService'),
  }));
  container.register('runtimeHost.stateService', (scope) => {
    const stateSnapshots = scope.resolve<{
      runtimeState: RuntimeHostStatePort['runtimeState'];
      runtimeHealth: (state: ReturnType<RuntimeHostStatePort['runtimeState']>) => unknown;
    }>('runtimeHost.stateSnapshots');
    const transportStats = scope.resolve<{ snapshot: () => RuntimeHostTransportStatsSnapshot }>('runtimeHost.transportStats');
    return new RuntimeHostStateService({
      getRuntimeState: stateSnapshots.runtimeState,
      buildRuntimeHealth: stateSnapshots.runtimeHealth,
      buildTransportStats: () => buildTransportStatsSnapshot(transportStats.snapshot()),
      clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
    });
  });
  container.register('runtimeHost.service', (scope) => createRuntimeHostService(scope));
  container.register('workbench.service', (scope) => new WorkbenchService({
    runtimeState: scope.resolve<RuntimeHostStateService>('runtimeHost.stateService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.contribute('agentRuntime.capabilityOperationRoutes', (scope): readonly CapabilityOperationRoute[] => createRuntimeHostCapabilityOperationRoutes({
    runtimeHostService: scope.resolve<RuntimeHostService>('runtimeHost.service'),
    gatewayService: scope.resolve<GatewayService>('gateway.service'),
  }));
  facades.registerContainerFacade('runtime', WORKBENCH_SERVICE_TOKEN, container);
  facades.registerContainerFacade('runtime', RUNTIME_HOST_SERVICE_TOKEN, container);
  facades.registerContainerFacade('runtime', PLUGIN_RUNTIME_SERVICE_TOKEN, container);
  facades.registerContainerFacade('runtime', GATEWAY_SERVICE_TOKEN, container);
}

export function registerRuntimeApplicationJobs(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry: RuntimeJobRegistry;
  },
): void {
  registerRuntimeJobDefinitions(deps.jobRegistry, createRuntimeApplicationJobDefinitions(container));
}

export function registerRuntimeApplicationLifecycle(
  container: RuntimeHostContainer,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  registerRuntimeLifecycleDefinitions(deps.lifecycle, {
    backgroundServices: [
      {
        name: 'workspace.main-agent-template-migration',
        start: () => submitWorkspaceTemplateMigration(container),
      },
    ],
  });
}

function submitWorkspaceTemplateMigration(container: RuntimeHostContainer): void {
  container.resolve<RuntimeHostBootstrapJobPort>('runtimeHost.bootstrapJobs').submitWorkspaceTemplateMigration();
}

function createRuntimeApplicationJobDefinitions(
  container: RuntimeHostContainer,
): readonly RuntimeJobDefinition[] {
  return [
    {
      type: COLLECT_DIAGNOSTICS_JOB,
      handler: async (payload) => {
        return await container.resolve<DiagnosticsService>('diagnostics.service').collect(payload as never);
      },
    },
    {
      type: GATEWAY_PRELAUNCH_JOB,
      handler: async (payload) => {
        return await container.resolve<RuntimeHostBootstrapService>('runtimeHost.bootstrapService').executeGatewayPrelaunch(payload as never);
      },
    },
    {
      type: WORKSPACE_TEMPLATE_MIGRATION_JOB,
      handler: async () => {
        return await container.resolve<RuntimeHostBootstrapService>('runtimeHost.bootstrapService').executeWorkspaceTemplateMigration();
      },
    },
  ];
}
