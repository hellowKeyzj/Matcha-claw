import type { RuntimeJobRegistry } from '../core/jobs';
import type { RuntimeHostLifecycle } from '../core/lifecycle';
import type { ApplicationServiceRegistry } from './application-service-registry';
import type { RuntimeHostContainer } from './container';
import type { RuntimeHostRouteRegistry } from './route-registry';
import type { RuntimeHostRegistrationOwnerDescriptor } from '../core/registry';
import { GatewayCapabilityService } from '../application/gateway/gateway-capability-service';
import {
  AGENT_RUNTIME_APPLICATION_TOKEN,
  CAPABILITY_ROUTING_SERVICE_TOKEN,
  CHANNEL_SERVICE_TOKEN,
  CLAWHUB_SERVICE_TOKEN,
  CRON_SERVICE_TOKEN,
  FILE_SERVICE_TOKEN,
  GATEWAY_SERVICE_TOKEN,
  LICENSE_SERVICE_TOKEN,
  OPENCLAW_SERVICE_TOKEN,
  PLATFORM_SERVICE_TOKEN,
  PLUGIN_RUNTIME_SERVICE_TOKEN,
  PROVIDER_ACCOUNTS_SERVICE_TOKEN,
  PROVIDER_MODELS_SERVICE_TOKEN,
  RUNTIME_HOST_SERVICE_TOKEN,
  SECURITY_SERVICE_TOKEN,
  SESSION_RUNTIME_TOKEN,
  SETTINGS_SERVICE_TOKEN,
  SKILLS_SERVICE_TOKEN,
  SUBAGENT_SERVICE_TOKEN,
  TEAM_RUNTIME_SERVICE_TOKEN,
  TEAM_RUNTIME_WEBHOOK_AUTH_TOKEN,
  TOOLCHAIN_UV_SERVICE_TOKEN,
  WORKBENCH_SERVICE_TOKEN,
  EXTERNAL_CONNECTOR_SERVICE_TOKEN,
} from './runtime-host-tokens';
import type { GatewayConnectionPort } from '../application/gateway/gateway-runtime-port';
import {
  RuntimeHostModuleRegistry,
  type RuntimeHostModuleRegistrationDiagnostic,
  type RuntimeHostNamedModule,
} from '../core/registry';
import {
  registerExternalConnectorApplicationServices,
  registerExternalConnectorRoutes,
} from './modules/external-connectors-application-module';
import {
  connectOpenClawApplicationServices,
  registerOpenClawApplicationServices,
  registerOpenClawApplicationLifecycle,
  registerOpenClawApplicationJobs,
} from './modules/openclaw-application-module';
import {
  registerOperationsApplicationServices,
  registerOperationsLifecycle,
  registerOperationsJobs,
} from './modules/operations-application-module';
import {
  registerRuntimeApplicationServices,
  registerRuntimeApplicationLifecycle,
  registerRuntimeApplicationJobs,
} from './modules/runtime-application-module';
import { registerOpenClawRoutes } from './modules/openclaw-route-module';
import { registerOperationsRoutes } from './modules/operations-route-module';
import { registerRuntimeRoutes } from './modules/runtime-route-module';
import { registerSessionRoutes } from './modules/session-route-module';

export interface RuntimeHostServiceRegistrationContext {
  readonly container: RuntimeHostContainer;
  readonly facades: ApplicationServiceRegistry;
}

export interface RuntimeHostRouteRegistrationContext {
  readonly facades: ApplicationServiceRegistry;
}

export interface RuntimeHostApplicationModule extends RuntimeHostNamedModule {
  readonly name: string;
  readonly registerServices: (context: RuntimeHostServiceRegistrationContext) => void;
  readonly registerJobs?: (
    container: RuntimeHostContainer,
    deps: {
      readonly jobRegistry: RuntimeJobRegistry;
    },
  ) => void;
  readonly registerLifecycle?: (
    container: RuntimeHostContainer,
    deps: {
      readonly lifecycle: RuntimeHostLifecycle;
    },
  ) => void;
  readonly registerRoutes?: (
    routes: RuntimeHostRouteRegistry,
    context: RuntimeHostRouteRegistrationContext,
  ) => void;
  readonly connect?: (context: RuntimeHostServiceRegistrationContext) => void;
}

const openClawModule: RuntimeHostApplicationModule = {
  name: 'openclaw',
  manifest: {
    id: 'openclaw',
    registerProviders: true,
    registerJobs: true,
    registerLifecycle: true,
    registerRoutes: true,
    imports: [
      'channels.activationStrategy',
      'channels.configRepository',
      'channels.loginRuntime',
      'channels.pairingRuntime',
      'clawhub.cliRunner',
      'clawhub.registryClient',
      'clawhub.runtime',
      'clawhub.skillInventory',
      'externalConnectors.service',
      'gateway.capabilities',
      'gateway.control',
      'gateway.runtime',
      'logger',
      'openclaw.authProfileService',
      'openclaw.authRepository',
      'openclaw.configRepository',
      'openclaw.environmentRepository',
      'openclaw.infrastructure',
      'openclaw.oauthPluginRegistrationService',
      'openclaw.providerSnapshotService',
      'openclaw.subagentTemplateService',
      'openclaw.workspaceService',
      'plugins.configProjection',
      'plugins.configStore',
      'plugins.fileSystem',
      'plugins.repository',
      'plugins.runtime',
      'providers.agentIdentityProjection',
      'providers.agentModelsProjection',
      'providers.capabilityRoutingProjection',
      'providers.capabilityRoutingStorage',
      'providers.customMediaProjection',
      'providers.modelsProjection',
      'providers.modelsStorage',
      'providers.projectionKeyResolver',
      'providers.accountsProjectionPort',
      'providers.projectionPolicy',
      'providers.storeRepository',
      'runtime.clock',
      'runtime.commandExecutor',
      'runtime.fileSystem',
      'runtime.httpClient',
      'runtime.idGenerator',
      'runtime.systemEnvironment',
      'runtime.tasks',
      'runtime.timer',
      'runtimeHost.parentGatewayEvents',
      'runtimeHost.parentShell',
      'settings.repository',
      'skills.configRepository',
      'skills.readmePreviewRepository',
      'skills.workspace',
    ],
    exports: [
      'settings.service',
      'providers.accountsService',
      'providers.capabilityRoutingService',
      'providers.modelsService',
      'channels.service',
      'openclaw.service',
      'skills.service',
      'subagents.service',
      'clawhub.service',
      'runtimeHost.runtimeConfig',
      'runtimeHost.workspaceBootstrap',
    ],
    connect: true,
    connectImports: ['external-connectors'],
  },
  registerServices: (context) => registerOpenClawApplicationServices(context.container, context.facades),
  registerJobs: registerOpenClawApplicationJobs,
  registerLifecycle: registerOpenClawApplicationLifecycle,
  connect: connectOpenClawApplicationServices,
  registerRoutes: (routes, context) => registerOpenClawRoutes(routes, {
    settingsService: context.facades.resolve(SETTINGS_SERVICE_TOKEN),
    providerAccountsService: context.facades.resolve(PROVIDER_ACCOUNTS_SERVICE_TOKEN),
    capabilityRoutingService: context.facades.resolve(CAPABILITY_ROUTING_SERVICE_TOKEN),
    providerModelsService: context.facades.resolve(PROVIDER_MODELS_SERVICE_TOKEN),
    channelService: context.facades.resolve(CHANNEL_SERVICE_TOKEN),
    openClawService: context.facades.resolve(OPENCLAW_SERVICE_TOKEN),
    skillsService: context.facades.resolve(SKILLS_SERVICE_TOKEN),
    subagentService: context.facades.resolve(SUBAGENT_SERVICE_TOKEN),
    clawHubService: context.facades.resolve(CLAWHUB_SERVICE_TOKEN),
  }),
};

const applicationFoundationModule: RuntimeHostApplicationModule = {
  name: 'application-foundation',
  manifest: {
    id: 'application-foundation',
    registerProviders: true,
    imports: ['gateway.runtime'],
    exports: ['gateway.capabilities'],
  },
  registerServices: (context) => {
    context.container.register('gateway.capabilities', (scope) => new GatewayCapabilityService({
      gateway: scope.resolve<Pick<GatewayConnectionPort, 'inspectGatewayMethodReadiness'>>('gateway.runtime'),
    }));
  },
};

const runtimeModule: RuntimeHostApplicationModule = {
  name: 'runtime',
  manifest: {
    id: 'runtime',
    registerProviders: true,
    registerJobs: true,
    registerLifecycle: true,
    registerRoutes: true,
    imports: [
      'channels.configRepository',
      'channels.prelaunchPluginProjection',
      'diagnostics.runtimeLayout',
      'gateway.runtime',
      'license.service',
      'logger',
      'plugins.catalogProjection',
      'plugins.repository',
      'plugins.runtime',
      'plugins.runtimeJobs',
      'providers.capabilityRoutingService',
      'providers.modelsService',
      'providers.projectionKeyResolver',
      'providers.projectionSyncService',
      'providers.storeRepository',
      'runtime.clock',
      'runtime.commandExecutor',
      'runtime.fileSystem',
      'runtime.idGenerator',
      'runtime.processInfo',
      'runtime.systemEnvironment',
      'runtime.tasks',
      'runtimeHost.environment',
      'runtimeHost.parentShell',
      'runtimeHost.prelaunchMaintenanceCacheStorage',
      'runtimeHost.prelaunchPluginMaintenanceRuntime',
      'runtimeHost.runtimeConfig',
      'runtimeHost.stateSnapshots',
      'runtimeHost.transportStats',
      'runtimeHost.workspaceBootstrap',
      'security.pluginConfigApplier',
      'settings.repository',
      'teamRuntime.webhookAuth',
    ],
    exports: [
      'workbench.service',
      'runtimeHost.service',
      'plugins.runtimeService',
      'gateway.service',
    ],
  },
  registerServices: (context) => registerRuntimeApplicationServices(context.container, context.facades),
  registerJobs: registerRuntimeApplicationJobs,
  registerLifecycle: registerRuntimeApplicationLifecycle,
  registerRoutes: (routes, context) => registerRuntimeRoutes(routes, {
    workbenchService: context.facades.resolve(WORKBENCH_SERVICE_TOKEN),
    runtimeHostService: context.facades.resolve(RUNTIME_HOST_SERVICE_TOKEN),
    pluginRuntimeService: context.facades.resolve(PLUGIN_RUNTIME_SERVICE_TOKEN),
    gatewayService: context.facades.resolve(GATEWAY_SERVICE_TOKEN),
    teamRuntimeWebhookAuth: context.facades.resolve(TEAM_RUNTIME_WEBHOOK_AUTH_TOKEN),
  }),
};

const licenseModule: RuntimeHostApplicationModule = {
  name: 'license',
  manifest: {
    id: 'license',
    registerProviders: true,
    imports: ['runtimeHost.parentGatewayEvents'],
    exports: ['license.service'],
  },
  registerServices: (context) => registerOperationsApplicationServices(context.container, context.facades, { only: 'license' }),
};

const externalConnectorModule: RuntimeHostApplicationModule = {
  name: 'external-connectors',
  manifest: {
    id: 'external-connectors',
    registerProviders: true,
    registerRoutes: true,
    imports: [
      'runtimeHost.runtimeDataRoot',
      'runtime.fileSystem',
      'runtime.systemEnvironment',
      'runtime.httpClient',
      'runtime.clock',
    ],
    exports: ['externalConnectors.service'],
  },
  registerServices: (context) => registerExternalConnectorApplicationServices(context.container, context.facades),
  registerRoutes: (routes, context) => registerExternalConnectorRoutes(routes, {
    externalConnectorService: context.facades.resolve(EXTERNAL_CONNECTOR_SERVICE_TOKEN),
  }),
};

const operationsModule: RuntimeHostApplicationModule = {
  name: 'operations',
  manifest: {
    id: 'operations',
    registerProviders: true,
    registerJobs: true,
    registerLifecycle: true,
    registerRoutes: true,
    imports: [
      'channels.deliveryProjection',
      'file.runtimeDataStore',
      'gateway.capabilities',
      'gateway.runtime',
      'license.service',
      'logger',
      'openclaw.configRepository',
      'openclaw.infrastructure',
      'openclaw.workspaceService',
      'runtimeHost.runtimeDataRoot',
      'operations.taskWorkspace',
      'platform.facade',
      'runtime.backgroundTasks',
      'runtime.clock',
      'runtime.commandExecutor',
      'runtime.fileSystem',
      'runtime.idGenerator',
      'runtime.systemEnvironment',
      'runtime.tasks',
      'runtime.timer',
      'settings.repository',
      'runtimeHost.parentGatewayEvents',
      'security.pluginConfigProjection',
      'security.policyStorage',
      'session.runtime',
      'skills.service',
      'toolchainUv.runtime',
      'usage.runtimeData',
      'usage.transcriptLayout',
    ],
    exports: [
      'agentRuntime.capabilityOperationRoutes',
      'cron.service',
      'file.service',
      'toolchainUv.service',
      'security.service',
      'task.service',
      'teamRuntime.service',
      'teamRuntime.webhookAuth',
      'platform.service',
      'security.pluginConfigApplier',
    ],
  },
  registerServices: (context) => registerOperationsApplicationServices(context.container, context.facades),
  registerJobs: registerOperationsJobs,
  registerLifecycle: registerOperationsLifecycle,
  registerRoutes: (routes, context) => registerOperationsRoutes(routes, {
    cronService: context.facades.resolve(CRON_SERVICE_TOKEN),
    fileService: context.facades.resolve(FILE_SERVICE_TOKEN),
    licenseService: context.facades.resolve(LICENSE_SERVICE_TOKEN),
    toolchainUvService: context.facades.resolve(TOOLCHAIN_UV_SERVICE_TOKEN),
    securityService: context.facades.resolve(SECURITY_SERVICE_TOKEN),
    platformService: context.facades.resolve(PLATFORM_SERVICE_TOKEN),
  }),
};

const sessionsModule: RuntimeHostApplicationModule = {
  name: 'sessions',
  manifest: {
    id: 'sessions',
    registerProviders: true,
    registerRoutes: true,
    imports: ['agentRuntime.application', 'session.runtime'],
    exports: ['agentRuntime.routes', 'sessions.routes'],
  },
  registerServices: (context) => {
    context.facades.registerContainerFacade('agentRuntime', AGENT_RUNTIME_APPLICATION_TOKEN, context.container);
    context.facades.registerContainerFacade('session-runtime', SESSION_RUNTIME_TOKEN, context.container);
  },
  registerRoutes: (routes, context) => registerSessionRoutes(routes, {
    agentRuntimeService: context.facades.resolve(AGENT_RUNTIME_APPLICATION_TOKEN),
    sessionRuntimeService: context.facades.resolve(SESSION_RUNTIME_TOKEN),
  }),
};

export const RUNTIME_HOST_APPLICATION_MODULES: readonly RuntimeHostApplicationModule[] = [
  applicationFoundationModule,
  externalConnectorModule,
  openClawModule,
  licenseModule,
  runtimeModule,
  operationsModule,
  sessionsModule,
] as const;

const RUNTIME_HOST_ROUTE_MODULES: readonly RuntimeHostApplicationModule[] = [
  applicationFoundationModule,
  licenseModule,
  runtimeModule,
  operationsModule,
  externalConnectorModule,
  openClawModule,
  sessionsModule,
] as const;

function createRuntimeHostApplicationModuleRegistry(
  modules: readonly RuntimeHostApplicationModule[],
): RuntimeHostModuleRegistry<RuntimeHostApplicationModule> {
  return new RuntimeHostModuleRegistry<RuntimeHostApplicationModule>(modules, {
    stages: [
      { name: 'services', handler: 'registerServices' },
      { name: 'jobs', handler: 'registerJobs' },
      { name: 'lifecycle', handler: 'registerLifecycle' },
      { name: 'routes', handler: 'registerRoutes' },
      { name: 'connect', handler: 'connect' },
    ],
    externalExports: [
      'channels.activationStrategy',
      'channels.configRepository',
      'channels.deliveryProjection',
      'channels.prelaunchPluginProjection',
      'diagnostics.runtimeLayout',
      'gateway.runtime',
      'logger',
      'channels.loginRuntime',
      'channels.pairingRuntime',
      'clawhub.cliRunner',
      'clawhub.registryClient',
      'clawhub.runtime',
      'clawhub.skillInventory',
      'file.runtimeDataStore',
      'gateway.control',
      'openclaw.authProfileService',
      'openclaw.authRepository',
      'openclaw.configRepository',
      'openclaw.environmentRepository',
      'openclaw.infrastructure',
      'openclaw.oauthPluginRegistrationService',
      'openclaw.providerSnapshotService',
      'openclaw.subagentTemplateService',
      'openclaw.workspaceService',
      'runtimeHost.runtimeDataRoot',
      'operations.taskWorkspace',
      'platform.facade',
      'plugins.catalogProjection',
      'plugins.configProjection',
      'plugins.configStore',
      'plugins.fileSystem',
      'plugins.repository',
      'plugins.runtime',
      'plugins.runtimeJobs',
      'providers.agentIdentityProjection',
      'providers.agentModelsProjection',
      'providers.capabilityRoutingProjection',
      'providers.capabilityRoutingStorage',
      'providers.customMediaProjection',
      'providers.modelsProjection',
      'providers.modelsStorage',
      'providers.projectionKeyResolver',
      'providers.accountsProjectionPort',
      'providers.projectionPolicy',
      'providers.projectionSyncService',
      'providers.storeRepository',
      'runtime.backgroundTasks',
      'runtime.clock',
      'runtime.commandExecutor',
      'runtime.fileSystem',
      'runtime.httpClient',
      'runtime.idGenerator',
      'runtime.processInfo',
      'runtime.systemEnvironment',
      'runtime.tasks',
      'runtime.timer',
      'runtimeHost.environment',
      'runtimeHost.parentGatewayEvents',
      'runtimeHost.parentShell',
      'runtimeHost.prelaunchMaintenanceCacheStorage',
      'runtimeHost.prelaunchPluginMaintenanceRuntime',
      'runtimeHost.stateSnapshots',
      'runtimeHost.transportStats',
      'session.runtime',
      'settings.repository',
      'security.pluginConfigProjection',
      'security.policyStorage',
      'skills.configRepository',
      'skills.readmePreviewRepository',
      'skills.workspace',
      'toolchainUv.runtime',
      'usage.runtimeData',
      'usage.transcriptLayout',
      'agentRuntime.application',
    ],
  });
}

const RUNTIME_HOST_APPLICATION_MODULE_REGISTRY = createRuntimeHostApplicationModuleRegistry(
  RUNTIME_HOST_APPLICATION_MODULES,
);
const RUNTIME_HOST_ROUTE_MODULE_REGISTRY = createRuntimeHostApplicationModuleRegistry(
  RUNTIME_HOST_ROUTE_MODULES,
);

function listRuntimeHostApplicationRegistrationOwners(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry?: RuntimeJobRegistry;
    readonly lifecycle?: RuntimeHostLifecycle;
    readonly routes?: RuntimeHostRouteRegistry;
  } = {},
): RuntimeHostRegistrationOwnerDescriptor[] {
  return [
    ...container.listRegistrations(),
    ...(deps.jobRegistry?.listRegistrations().map((registration) => ({
      key: registration.type,
      owner: registration.owner,
    })) ?? []),
    ...(deps.lifecycle?.listRegistrations().map((registration) => ({
      key: registration.name,
      owner: registration.owner,
    })) ?? []),
    ...(deps.routes?.listRegistrations() ?? []),
  ];
}

export function listRuntimeHostApplicationModuleRegistrationDiagnostics(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry?: RuntimeJobRegistry;
    readonly lifecycle?: RuntimeHostLifecycle;
    readonly routes?: RuntimeHostRouteRegistry;
  } = {},
): RuntimeHostModuleRegistrationDiagnostic[] {
  return RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.listRegistrationDiagnostics(
    listRuntimeHostApplicationRegistrationOwners(container, deps),
  );
}

export function validateRuntimeHostApplicationModuleRegistrationOwners(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry?: RuntimeJobRegistry;
    readonly lifecycle?: RuntimeHostLifecycle;
    readonly routes?: RuntimeHostRouteRegistry;
    readonly facades?: ApplicationServiceRegistry;
  } = {},
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.validateRegistrationOwners(
    listRuntimeHostApplicationRegistrationOwners(container, deps),
  );
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.validateResolveImports([
    ...container.listResolveEdges(),
    ...(deps.facades?.listResolveEdges() ?? []),
  ]);
  RUNTIME_HOST_ROUTE_MODULE_REGISTRY.validateResolveImports([
    ...(deps.facades?.listResolveEdges() ?? []),
  ]);
}

export function registerRuntimeHostModuleServices(
  context: RuntimeHostServiceRegistrationContext,
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('services', (module) => {
    context.container.withRegistrationOwner(module.name, () => {
      context.container.withResolutionOwner(module.name, () => {
        module.registerServices(context);
      });
    });
  });
}

export function connectRuntimeHostModuleServices(
  context: RuntimeHostServiceRegistrationContext,
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('connect', (module) => {
    context.container.withResolutionOwner(module.name, () => {
      context.facades.withResolutionOwner(module.name, () => {
        module.connect?.(context);
      });
    });
  });
}

export function registerRuntimeHostModuleJobs(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry: RuntimeJobRegistry;
  },
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('jobs', (module) => {
    deps.jobRegistry.withRegistrationOwner(module.name, () => {
      container.withResolutionOwner(module.name, () => {
        module.registerJobs?.(container, deps);
      });
    });
  });
}

export function registerRuntimeHostModuleLifecycle(
  container: RuntimeHostContainer,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('lifecycle', (module) => {
    deps.lifecycle.withRegistrationOwner(module.name, () => {
      container.withResolutionOwner(module.name, () => {
        module.registerLifecycle?.(container, deps);
      });
    });
  });
}

export function registerRuntimeHostModuleRoutes(
  routes: RuntimeHostRouteRegistry,
  deps: {
    readonly container: RuntimeHostContainer;
    readonly facades: ApplicationServiceRegistry;
  },
): void {
  const routeContext: RuntimeHostRouteRegistrationContext = { facades: deps.facades };
  RUNTIME_HOST_ROUTE_MODULE_REGISTRY.run('routes', (module) => {
    routes.withRegistrationOwner(module.name, () => {
      deps.container.withResolutionOwner(module.name, () => {
        deps.facades.withResolutionOwner(module.name, () => {
          module.registerRoutes?.(routes, routeContext);
        });
      });
    });
  });
}
