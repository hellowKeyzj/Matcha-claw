import type { GatewayChatPort, GatewayRpcPort } from '../application/gateway/gateway-runtime-port';
import type { RuntimeJobRegistry } from '../core/jobs';
import type { RuntimeHostLifecycle } from '../core/lifecycle';
import {
  RuntimeHostModuleRegistry,
  type RuntimeHostModuleRegistrationDiagnostic,
  type RuntimeHostNamedModule,
  type RuntimeHostRegistrationOwnerDescriptor,
} from '../core/registry';
import type { RuntimeHostPlatformRoot } from './modules/platform-runtime-module';
import {
  registerRuntimeHostPlatformRoot,
  resolveRuntimeHostPlatformRoot,
} from './modules/platform-runtime-module';
import type { PluginRuntimeModule } from './modules/plugin-runtime-module';
import {
  registerPluginRuntimeModule,
  registerPluginRuntimeJobs,
  registerPluginRuntimeLifecycle,
  resolvePluginRuntimeModule,
} from './modules/plugin-runtime-module';
import type { AgentRuntimeModule } from './modules/agent-runtime-module';
import {
  registerAgentRuntimeModule,
  resolveAgentRuntimeModule,
} from './modules/agent-runtime-module';
import type { SessionRuntimeModule } from './modules/session-runtime-module';
import {
  registerSessionRuntimeModule,
  registerSessionRuntimeJobs,
  registerSessionRuntimeLifecycle,
  resolveSessionRuntimeModule,
} from './modules/session-runtime-module';
import type { GatewayBridgeModule } from './modules/gateway-bridge-module';
import {
  registerGatewayBridgeModule,
  registerGatewayBridgeLifecycle,
  resolveGatewayBridgeModule,
} from './modules/gateway-bridge-module';
import type { ParentTransportClient } from './parent-transport-client';
import type { RuntimeHostContainer } from './container';
import type { RuntimeHostInfrastructure } from './modules/runtime-infrastructure-module';
import { registerRuntimeHostInfrastructureLifecycle } from './modules/runtime-infrastructure-module';
import { registerOpenClawInfrastructure } from './modules/openclaw-infrastructure-module';
import { registerAcpConnectorModule } from './modules/acp-connector-module';
import {
  ParentShellGatewayControl,
  type GatewayControlPort,
} from '../application/runtime-host/parent-shell-port';
import {
  RUNTIME_DISPATCH_ROUTE_TOKEN,
  type RuntimeDispatchRoutePort,
} from './runtime-host-tokens';

export interface RuntimeHostSystemModuleContext {
  readonly container: RuntimeHostContainer;
  readonly infrastructure: RuntimeHostInfrastructure;
  readonly parentTransport: ParentTransportClient;
}

export interface RuntimeHostSystemModules {
  readonly gatewayBridge: GatewayBridgeModule;
  readonly platformRuntime: RuntimeHostPlatformRoot;
  readonly pluginRuntime: PluginRuntimeModule;
  readonly agentRuntime: AgentRuntimeModule;
  readonly sessionRuntime: SessionRuntimeModule;
}

interface RuntimeHostSystemModule extends RuntimeHostNamedModule {
  readonly name: string;
  readonly registerInfrastructure?: (context: RuntimeHostSystemModuleContext) => void;
  readonly registerServices?: (
    context: RuntimeHostSystemModuleContext,
    modules: Partial<RuntimeHostSystemModules>,
  ) => void;
  readonly connect?: (context: RuntimeHostSystemModuleContext, modules: RuntimeHostSystemModules) => void;
  readonly registerJobs?: (
    context: RuntimeHostSystemModuleContext,
    modules: RuntimeHostSystemModules,
    deps: {
      readonly jobRegistry: RuntimeJobRegistry;
    },
  ) => void;
  readonly registerLifecycle?: (
    context: RuntimeHostSystemModuleContext,
    modules: RuntimeHostSystemModules,
    deps: {
      readonly lifecycle: RuntimeHostLifecycle;
    },
  ) => void;
}

const infrastructureModule: RuntimeHostSystemModule = {
  name: 'infrastructure',
  manifest: {
    id: 'infrastructure',
    registerLifecycle: true,
    exports: ['runtime.infrastructure'],
  },
  registerLifecycle: (context) => {
    registerRuntimeHostInfrastructureLifecycle(context.infrastructure);
  },
};

const openclawInfrastructureModule: RuntimeHostSystemModule = {
  name: 'openclaw-infrastructure',
  manifest: {
    id: 'openclaw-infrastructure',
    registerProviders: true,
    imports: ['runtime.infrastructure'],
    exports: [
      'gateway.runtimeData',
      'gateway.runtimeEndpointId',
      'gateway.runtimeFactory',
      'gateway.settings',
      'platform.runtimeDriverFactory',
      'channels.activationStrategy',
      'channels.deliveryProjection',
      'openclaw.infrastructure',
      'openclaw.providerSnapshotService',
      'sessionConfigDirectory',
      'sessionExternalArtefactResolver',
      'sessionDefaultModelResolver',
      'plugins.catalogProjection',
      'plugins.companionSkillWorkspace',
      'plugins.configProjection',
      'plugins.configStore',
      'plugins.fileSystem',
      'plugins.injectedCatalogPlatformPolicy',
      'plugins.managedCatalog',
      'plugins.managedInstaller',
      'runtime.adapterRegistrationFactories',
    ],
  },
  registerInfrastructure: (context) => {
    registerOpenClawInfrastructure(context.container);
  },
};

const acpConnectorModule: RuntimeHostSystemModule = {
  name: 'acp-connector',
  manifest: {
    id: 'acp-connector',
    registerProviders: true,
    exports: ['runtime.connectorRegistrationFactories'],
  },
  registerInfrastructure: (context) => {
    registerAcpConnectorModule(context.container);
  },
};

const gatewayBridgeModule: RuntimeHostSystemModule = {
  name: 'gateway-bridge',
  manifest: {
    id: 'gateway-bridge',
    registerProviders: true,
    registerLifecycle: true,
    imports: ['runtime.infrastructure', 'agentRuntime.registry', 'gateway.runtimeData', 'gateway.runtimeFactory', 'gateway.settings'],
    exports: ['gateway.control', 'gateway.endpointControlState', 'gateway.runtime'],
  },
  registerInfrastructure: (context) => {
    context.container.register('gateway.control', (): GatewayControlPort => new ParentShellGatewayControl({
      request: context.parentTransport.requestParentShellAction,
    }));
  },
  registerServices: (context) => {
    const { container, infrastructure, parentTransport } = context;
    registerGatewayBridgeModule(container, {
      parentTransport,
      dispatchRoute: (method, route, payload) => container.resolve<RuntimeDispatchRoutePort>(
        RUNTIME_DISPATCH_ROUTE_TOKEN,
      )(method, route, payload),
      systemEnvironment: infrastructure.systemEnvironment,
      clock: infrastructure.clock,
      scheduler: infrastructure.scheduler,
      tcpProbe: infrastructure.tcpProbe,
      logger: infrastructure.logger,
    });
  },
  registerLifecycle: (_context, modules, deps) => {
    registerGatewayBridgeLifecycle(modules.gatewayBridge, deps);
  },
};

const platformRuntimeModule: RuntimeHostSystemModule = {
  name: 'platform-runtime',
  manifest: {
    id: 'platform-runtime',
    registerProviders: true,
    imports: ['gateway.runtime', 'platform.runtimeDriverFactory'],
    exports: ['platform.runtimeDriver', 'platform.facade'],
  },
  registerServices: (context) => {
    registerRuntimeHostPlatformRoot(context.container);
  }
};

const pluginRuntimeModule: RuntimeHostSystemModule = {
  name: 'plugin-runtime',
  manifest: {
    id: 'plugin-runtime',
    registerProviders: true,
    registerJobs: true,
    registerLifecycle: true,
    imports: [
      'runtime.infrastructure',
      'gateway.control',
      'openclaw.infrastructure',
      'plugins.catalogProjection',
      'plugins.companionSkillWorkspace',
      'plugins.configProjection',
      'plugins.configStore',
      'plugins.fileSystem',
      'plugins.injectedCatalogPlatformPolicy',
      'plugins.managedCatalog',
      'plugins.managedInstaller',
    ],
    exports: ['plugins.companionSkillService', 'plugins.registry', 'plugins.runtime'],
  },
  registerServices: (context) => {
    const { infrastructure } = context;
    registerPluginRuntimeModule(context.container, {
      lifecycle: infrastructure.lifecycle,
      logger: infrastructure.logger,
      enabledPluginIdsEnv: infrastructure.systemEnvironment.getEnv('MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS'),
      pluginCatalogEnv: infrastructure.systemEnvironment.getEnv('MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG'),
      injectedPluginPlatformPolicy: context.container.resolve('plugins.injectedCatalogPlatformPolicy'),
    });
  },
  registerJobs: (context, modules, deps) => {
    registerPluginRuntimeJobs(modules.pluginRuntime, {
      ...deps,
      gatewayControl: context.container.resolve<GatewayControlPort>('gateway.control'),
    });
  },
  registerLifecycle: (_context, modules, deps) => {
    registerPluginRuntimeLifecycle(modules.pluginRuntime, deps);
  },
};

const agentRuntimeModule: RuntimeHostSystemModule = {
  name: 'agent-runtime',
  manifest: {
    id: 'agent-runtime',
    registerProviders: true,
    imports: [
      'runtime.adapterRegistrationFactories',
      'runtime.connectorRegistrationFactories',
    ],
    exports: [
      'agentRuntime.registry',
      'agentRuntime.capabilityRouter',
      'agentRuntime.application',
    ],
  },
  registerServices: (context) => {
    registerAgentRuntimeModule(
      context.container,
      () => context.container.resolve('gateway.runtime') as GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>,
    );
  },
};

const sessionRuntimeModule: RuntimeHostSystemModule = {
  name: 'session-runtime',
  manifest: {
    id: 'session-runtime',
    registerProviders: true,
    connect: true,
    connectImports: ['gateway-bridge'],
    registerJobs: true,
    registerLifecycle: true,
    imports: [
      'agentRuntime.registry',
      'gateway.runtimeEndpointId',
      'sessionConfigDirectory',
      'sessionExternalArtefactResolver',
      'sessionDefaultModelResolver',
    ],
    exports: ['agentRuntime.capabilityOperationRoutes', 'session.runtime'],
  },
  registerServices: (context) => {
    registerSessionRuntimeModule(
      context.container,
      {
        emit: context.parentTransport.emitParentGatewayEvent,
      },
    );
  },
  connect: (_context, modules) => {
    modules.gatewayBridge.setSessionRuntime(modules.sessionRuntime.sessionRuntime);
  },
  registerJobs: (_context, modules, deps) => {
    registerSessionRuntimeJobs(modules.sessionRuntime, deps);
  },
  registerLifecycle: (context, modules, deps) => {
    registerSessionRuntimeLifecycle(context.container, modules.sessionRuntime, deps);
  },
};

const RUNTIME_HOST_SYSTEM_MODULES: readonly RuntimeHostSystemModule[] = [
  infrastructureModule,
  openclawInfrastructureModule,
  acpConnectorModule,
  gatewayBridgeModule,
  platformRuntimeModule,
  pluginRuntimeModule,
  agentRuntimeModule,
  sessionRuntimeModule,
] as const;

const RUNTIME_HOST_SYSTEM_MODULE_REGISTRY = new RuntimeHostModuleRegistry<RuntimeHostSystemModule>(
  RUNTIME_HOST_SYSTEM_MODULES,
  {
    stages: [
      { name: 'infrastructure', handler: 'registerInfrastructure' },
      { name: 'services', handler: 'registerServices' },
      { name: 'connect', handler: 'connect' },
      { name: 'jobs', handler: 'registerJobs' },
      { name: 'lifecycle', handler: 'registerLifecycle' },
    ],
  },
);

function listRuntimeHostSystemRegistrationOwners(
  context: RuntimeHostSystemModuleContext,
): RuntimeHostRegistrationOwnerDescriptor[] {
  return [
    ...context.container.listRegistrations(),
    ...context.infrastructure.jobRegistry.listRegistrations().map((registration) => ({
      key: registration.type,
      owner: registration.owner,
    })),
    ...context.infrastructure.lifecycle.listRegistrations().map((registration) => ({
      key: registration.name,
      owner: registration.owner,
    })),
  ];
}

export function listRuntimeHostSystemModuleRegistrationDiagnostics(
  context: RuntimeHostSystemModuleContext,
): RuntimeHostModuleRegistrationDiagnostic[] {
  return RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.listRegistrationDiagnostics(
    listRuntimeHostSystemRegistrationOwners(context),
  );
}

export function validateRuntimeHostSystemModuleRegistrationOwners(
  context: RuntimeHostSystemModuleContext,
): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.validateRegistrationOwners(
    listRuntimeHostSystemRegistrationOwners(context),
  );
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.validateResolveImports(context.container.listResolveEdges());
}

export function registerRuntimeHostSystemInfrastructure(context: RuntimeHostSystemModuleContext): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('infrastructure', (module) => {
    context.container.withRegistrationOwner(module.name, () => {
      module.registerInfrastructure?.(context);
    });
  });
}

export function registerRuntimeHostSystemServices(context: RuntimeHostSystemModuleContext): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('services', (module) => {
    context.container.withRegistrationOwner(module.name, () => {
      context.container.withResolutionOwner(module.name, () => {
        module.registerServices?.(context, {});
      });
    });
  });
}

export function resolveRuntimeHostSystemModules(context: RuntimeHostSystemModuleContext): RuntimeHostSystemModules {
  const modules: RuntimeHostSystemModules = {
    gatewayBridge: context.container.withResolutionOwner('gateway-bridge', () => resolveGatewayBridgeModule(context.container)),
    platformRuntime: context.container.withResolutionOwner('platform-runtime', () => resolveRuntimeHostPlatformRoot(context.container)),
    pluginRuntime: context.container.withResolutionOwner('plugin-runtime', () => resolvePluginRuntimeModule(context.container)),
    agentRuntime: context.container.withResolutionOwner('agent-runtime', () => resolveAgentRuntimeModule(context.container)),
    sessionRuntime: context.container.withResolutionOwner('session-runtime', () => resolveSessionRuntimeModule(context.container)),
  };
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('connect', (module) => {
    context.container.withResolutionOwner(module.name, () => {
      module.connect?.(context, modules);
    });
  });
  return modules;
}

export function registerRuntimeHostSystemModuleJobs(
  context: RuntimeHostSystemModuleContext,
  modules: RuntimeHostSystemModules,
): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('jobs', (module) => {
    context.infrastructure.jobRegistry.withRegistrationOwner(module.name, () => {
      context.container.withResolutionOwner(module.name, () => {
        module.registerJobs?.(context, modules, {
          jobRegistry: context.infrastructure.jobRegistry,
        });
      });
    });
  });
}

export function registerRuntimeHostSystemModuleLifecycle(
  context: RuntimeHostSystemModuleContext,
  modules: RuntimeHostSystemModules,
): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('lifecycle', (module) => {
    context.infrastructure.lifecycle.withRegistrationOwner(module.name, () => {
      context.container.withResolutionOwner(module.name, () => {
        module.registerLifecycle?.(context, modules, {
          lifecycle: context.infrastructure.lifecycle,
        });
      });
    });
  });
}
