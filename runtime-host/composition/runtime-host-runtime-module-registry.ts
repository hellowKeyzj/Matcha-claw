import type { GatewayChatPort, GatewayRpcPort } from '../application/gateway/gateway-runtime-port';
import type { RuntimeJobRegistry } from '../core/jobs';
import type { RuntimeHostLifecycle } from '../core/lifecycle';
import { RuntimeHostModuleRegistry, type RuntimeHostNamedModule } from '../core/registry';
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
import type { RuntimeRouteResponse } from '../api/dispatch/runtime-route-dispatcher';
import {
  ParentShellGatewayControl,
  type GatewayControlPort,
} from '../application/runtime-host/parent-shell-port';
import { PendingApprovalStore } from '../application/sessions/pending-approval-store';

export interface RuntimeHostSystemModuleContext {
  readonly container: RuntimeHostContainer;
  readonly infrastructure: RuntimeHostInfrastructure;
  readonly parentTransport: ParentTransportClient;
}

export interface RuntimeHostSystemModules {
  readonly gatewayBridge: GatewayBridgeModule;
  readonly platformRuntime: RuntimeHostPlatformRoot;
  readonly pluginRuntime: PluginRuntimeModule;
  readonly sessionRuntime: SessionRuntimeModule;
}

interface RuntimeHostSystemModule extends RuntimeHostNamedModule {
  readonly name: string;
  readonly registerInfrastructure?: (context: RuntimeHostSystemModuleContext) => void;
  readonly registerServices?: (
    context: RuntimeHostSystemModuleContext,
    modules: Partial<RuntimeHostSystemModules>,
  ) => void;
  readonly resolveServices?: (context: RuntimeHostSystemModuleContext, modules: Partial<RuntimeHostSystemModules>) => object;
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
  registerLifecycle: (context) => {
    registerRuntimeHostInfrastructureLifecycle(context.infrastructure);
  },
};

const openclawInfrastructureModule: RuntimeHostSystemModule = {
  name: 'openclaw-infrastructure',
  registerInfrastructure: (context) => {
    registerOpenClawInfrastructure(context.container);
  },
};

const gatewayBridgeModule: RuntimeHostSystemModule = {
  name: 'gateway-bridge',
  registerInfrastructure: (context) => {
    context.container.register('gateway.control', (): GatewayControlPort => new ParentShellGatewayControl({
      request: context.parentTransport.requestParentShellAction,
    }));
    context.container.register('session.pendingApprovals', () => new PendingApprovalStore({
      clock: context.infrastructure.clock,
    }));
  },
  registerServices: (context) => {
    const { container, infrastructure, parentTransport } = context;
    registerGatewayBridgeModule(container, {
      parentTransport,
      dispatchRoute: (method, route, payload) => container.resolve<(
        method: string,
        route: string,
        payload: unknown,
      ) => Promise<RuntimeRouteResponse | null>>('runtime.dispatchRoute')(method, route, payload),
      systemEnvironment: infrastructure.systemEnvironment,
      pendingApprovals: container.resolve('session.pendingApprovals'),
      clock: infrastructure.clock,
      scheduler: infrastructure.scheduler,
      tcpProbe: infrastructure.tcpProbe,
      logger: infrastructure.logger,
    });
  },
  resolveServices: (context) => {
    return {
      gatewayBridge: resolveGatewayBridgeModule(context.container),
    };
  },
  registerLifecycle: (_context, modules, deps) => {
    registerGatewayBridgeLifecycle(modules.gatewayBridge, deps);
  },
};

const platformRuntimeModule: RuntimeHostSystemModule = {
  name: 'platform-runtime',
  registerServices: (context) => {
    registerRuntimeHostPlatformRoot(
      context.container,
      () => context.container.resolve('gateway.openclawBridge'),
    );
  },
  resolveServices: (context) => {
    return {
      platformRuntime: resolveRuntimeHostPlatformRoot(context.container),
    };
  },
};

const pluginRuntimeModule: RuntimeHostSystemModule = {
  name: 'plugin-runtime',
  registerServices: (context) => {
    const { infrastructure } = context;
    registerPluginRuntimeModule(context.container, {
      lifecycle: infrastructure.lifecycle,
      logger: infrastructure.logger,
      enabledPluginIdsEnv: infrastructure.systemEnvironment.getEnv('MATCHACLAW_RUNTIME_HOST_ENABLED_PLUGIN_IDS'),
      pluginCatalogEnv: infrastructure.systemEnvironment.getEnv('MATCHACLAW_RUNTIME_HOST_PLUGIN_CATALOG'),
    });
  },
  resolveServices: (context) => {
    return {
      pluginRuntime: resolvePluginRuntimeModule(context.container),
    };
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

const sessionRuntimeModule: RuntimeHostSystemModule = {
  name: 'session-runtime',
  registerServices: (context) => {
    registerSessionRuntimeModule(
      context.container,
      () => context.container.resolve('gateway.openclawBridge') as GatewayChatPort & Pick<GatewayRpcPort, 'gatewayRpc'>,
      {
        emit: context.parentTransport.emitParentGatewayEvent,
      },
    );
  },
  resolveServices: (context) => {
    return {
      sessionRuntime: resolveSessionRuntimeModule(context.container),
    };
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
  gatewayBridgeModule,
  platformRuntimeModule,
  pluginRuntimeModule,
  sessionRuntimeModule,
] as const;

function createRuntimeHostSystemModuleRegistry(): RuntimeHostModuleRegistry<RuntimeHostSystemModule> {
  const registry = new RuntimeHostModuleRegistry<RuntimeHostSystemModule>();
  for (const module of RUNTIME_HOST_SYSTEM_MODULES) {
    registry.register(module);
  }
  return registry;
}

const RUNTIME_HOST_SYSTEM_MODULE_REGISTRY = createRuntimeHostSystemModuleRegistry();

export function registerRuntimeHostSystemInfrastructure(context: RuntimeHostSystemModuleContext): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('infrastructure', (module) => {
    module.registerInfrastructure?.(context);
  });
}

export function registerRuntimeHostSystemServices(context: RuntimeHostSystemModuleContext): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('services', (module) => {
    module.registerServices?.(context, {});
  });
}

export function resolveRuntimeHostSystemModules(context: RuntimeHostSystemModuleContext): RuntimeHostSystemModules {
  const modules: Partial<RuntimeHostSystemModules> = {};
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('service-resolution', (module) => {
    Object.assign(modules, module.resolveServices?.(context, modules));
  });
  const createdModules = modules as RuntimeHostSystemModules;
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('connect', (module) => {
    module.connect?.(context, createdModules);
  });
  return createdModules;
}

export function registerRuntimeHostSystemModuleJobs(
  context: RuntimeHostSystemModuleContext,
  modules: RuntimeHostSystemModules,
): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('jobs', (module) => {
    module.registerJobs?.(context, modules, {
      jobRegistry: context.infrastructure.jobRegistry,
    });
  });
}

export function registerRuntimeHostSystemModuleLifecycle(
  context: RuntimeHostSystemModuleContext,
  modules: RuntimeHostSystemModules,
): void {
  RUNTIME_HOST_SYSTEM_MODULE_REGISTRY.run('lifecycle', (module) => {
    module.registerLifecycle?.(context, modules, {
      lifecycle: context.infrastructure.lifecycle,
    });
  });
}
