import { buildTransportStatsSnapshot } from '../../application/runtime-host/runtime-state';
import type { ChannelConfigRepository } from '../../application/channels/channel-runtime';
import { GatewayService } from '../../application/gateway/service';
import type { OpenClawConfigRepositoryPort } from '../../application/openclaw/openclaw-config-repository';
import type { OpenClawEnvironmentRepository } from '../../application/openclaw/openclaw-environment-repository';
import { OpenClawRuntimeConfigService } from '../../application/openclaw/openclaw-runtime-config-service';
import { PluginRuntimeService } from '../../application/plugins/plugin-runtime-service';
import {
  GATEWAY_PRELAUNCH_JOB,
  PROVIDER_AUTH_BOOTSTRAP_JOB,
  WORKSPACE_TEMPLATE_MIGRATION_JOB,
  createRuntimeHostBootstrapJobPort,
  type RuntimeHostBootstrapJobPort,
} from '../../application/runtime-host/bootstrap-jobs';
import { RuntimeHostBootstrapService } from '../../application/runtime-host/bootstrap';
import { PrelaunchMaintenanceCacheRepository } from '../../application/runtime-host/prelaunch-maintenance-cache';
import { PrelaunchPluginMaintenanceService } from '../../application/runtime-host/prelaunch-plugin-maintenance';
import { RuntimeJobsService } from '../../application/runtime-host/runtime-jobs-service';
import { RuntimeHostService } from '../../application/runtime-host/service';
import { RuntimeHostStateService } from '../../application/runtime-host/runtime-state';
import { DiagnosticsService } from '../../application/support/diagnostics';
import {
  COLLECT_DIAGNOSTICS_JOB,
  createDiagnosticsJobPort,
  type DiagnosticsJobPort,
} from '../../application/support/diagnostics-jobs';
import { WorkbenchService } from '../../application/workbench/service';
import type { RuntimePluginRepositoryPort } from '../../application/plugins/runtime-plugin-service';
import type { ProviderRuntimeSyncService } from '../../application/providers/store-sync';
import type { ProviderModelsApplicationService } from '../../application/providers/provider-models-service';
import type { CapabilityRoutingApplicationService } from '../../application/providers/capability-routing-service';
import type { ProviderStoreRepository } from '../../application/providers/provider-store-repository';
import type { SettingsRepository } from '../../application/settings/store';
import type { RuntimeHostApplicationServicesContext } from '../application-services';
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
import type { RuntimeLongTaskSubmissionPort } from '../../application/runtime-host/runtime-task-ports';
import type { SecurityPluginConfigApplier } from '../../application/security/security-plugin-config-applier';
import {
  registerRuntimeLifecycleDefinitions,
  type RuntimeHostLifecycle,
} from '../../core/lifecycle';

export interface RuntimeApplicationServices {
  readonly gatewayService: GatewayService;
  readonly pluginRuntimeService: PluginRuntimeService;
  readonly runtimeHostService: RuntimeHostService;
  readonly runtimeJobsService: RuntimeJobsService;
  readonly workbenchService: WorkbenchService;
}

function createRuntimeHostService(
  scope: RuntimeHostContainer,
  context: RuntimeHostApplicationServicesContext,
): RuntimeHostService {
  return new RuntimeHostService({
    environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    processInfo: scope.resolve<RuntimeProcessInfoPort>('runtime.processInfo'),
    systemEnvironment: scope.resolve('runtime.systemEnvironment'),
    runtimeState: scope.resolve<RuntimeHostStateService>('runtimeHost.stateService'),
    bootstrap: scope.resolve<RuntimeHostBootstrapService>('runtimeHost.bootstrapService'),
    diagnostics: scope.resolve<DiagnosticsService>('diagnostics.service'),
    license: scope.resolve<LicenseService>('license.service'),
    jobs: scope.resolve<RuntimeJobsService>('runtimeHost.jobsService'),
    parentShell: context.parentShell,
  });
}

export function registerRuntimeApplicationServices(
  container: RuntimeHostContainer,
  context: RuntimeHostApplicationServicesContext,
): void {
  container.register('gateway.service', (scope) => new GatewayService({
    gateway: context.openclawBridge,
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
  }));
  container.register('plugins.runtimeService', (scope) => new PluginRuntimeService({
    runtime: context.pluginRuntime,
    jobs: scope.resolve('plugins.runtimeJobs'),
  }));
  container.register('runtimeHost.prelaunchMaintenanceCacheRepository', (scope) => new PrelaunchMaintenanceCacheRepository(
    scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    scope.resolve<RuntimeClockPort>('runtime.clock'),
  ));
  container.register('runtimeHost.prelaunchPluginMaintenanceService', (scope) => new PrelaunchPluginMaintenanceService({
    runtimePlugins: scope.resolve<RuntimePluginRepositoryPort>('plugins.repository'),
    channels: scope.resolve<ChannelConfigRepository>('channels.configRepository'),
    configRepository: scope.resolve<OpenClawConfigRepositoryPort>('openclaw.configRepository'),
    environment: scope.resolve<OpenClawEnvironmentRepository>('openclaw.environmentRepository'),
    cacheRepository: scope.resolve<PrelaunchMaintenanceCacheRepository>('runtimeHost.prelaunchMaintenanceCacheRepository'),
    fileSystem: scope.resolve<RuntimeFileSystemPort>('runtime.fileSystem'),
    logger: scope.resolve<RuntimeHostLogger>('logger'),
  }));
  container.register('runtimeHost.bootstrapService', (scope) => new RuntimeHostBootstrapService({
    settingsRepository: scope.resolve<SettingsRepository>('settings.repository'),
    providerStoreRepository: scope.resolve<ProviderStoreRepository>('providers.storeRepository'),
    runtimeConfig: scope.resolve<OpenClawRuntimeConfigService>('openclaw.runtimeConfigService'),
    runtimePlugins: scope.resolve<RuntimePluginRepositoryPort>('plugins.repository'),
    prelaunchPluginMaintenance: scope.resolve<PrelaunchPluginMaintenanceService>('runtimeHost.prelaunchPluginMaintenanceService'),
    providerRuntimeSync: scope.resolve<ProviderRuntimeSyncService>('providers.runtimeSyncService'),
    providerModels: scope.resolve<ProviderModelsApplicationService>('providers.modelsService'),
    capabilityRouting: scope.resolve<CapabilityRoutingApplicationService>('providers.capabilityRoutingService'),
    workspace: scope.resolve('openclaw.workspaceService'),
    securityPluginConfig: scope.resolve<SecurityPluginConfigApplier>('security.pluginConfigApplier'),
    idGenerator: scope.resolve<RuntimeIdGeneratorPort>('runtime.idGenerator'),
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
  ));
  container.register('diagnostics.jobs', (scope): DiagnosticsJobPort => createDiagnosticsJobPort(
    scope.resolve<RuntimeLongTaskSubmissionPort>('runtime.tasks'),
  ));
  container.register('runtimeHost.stateService', (scope) => new RuntimeHostStateService({
    getRuntimeState: context.runtimeState.runtimeState,
    buildRuntimeHealth: context.runtimeState.runtimeHealth,
    buildTransportStats: () => buildTransportStatsSnapshot(context.transportStats.snapshot()),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
  container.register('runtimeHost.service', (scope) => createRuntimeHostService(scope, context));
  container.register('workbench.service', (scope) => new WorkbenchService({
    runtimeState: scope.resolve<RuntimeHostStateService>('runtimeHost.stateService'),
    clock: scope.resolve<RuntimeClockPort>('runtime.clock'),
  }));
}

export function resolveRuntimeApplicationServices(container: RuntimeHostContainer): RuntimeApplicationServices {
  return {
    gatewayService: container.resolve<GatewayService>('gateway.service'),
    pluginRuntimeService: container.resolve<PluginRuntimeService>('plugins.runtimeService'),
    runtimeJobsService: container.resolve<RuntimeJobsService>('runtimeHost.jobsService'),
    runtimeHostService: container.resolve<RuntimeHostService>('runtimeHost.service'),
    workbenchService: container.resolve<WorkbenchService>('workbench.service'),
  };
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
      type: PROVIDER_AUTH_BOOTSTRAP_JOB,
      handler: async () => {
        return await container.resolve<RuntimeHostBootstrapService>('runtimeHost.bootstrapService').executeProviderAuthBootstrap();
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
