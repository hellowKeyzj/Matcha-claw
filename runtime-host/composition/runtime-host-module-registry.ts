import type { RuntimeJobRegistry } from '../core/jobs';
import type { RuntimeHostLifecycle } from '../core/lifecycle';
import type {
  RuntimeHostApplicationServices,
  RuntimeHostApplicationServicesContext,
} from './application-services';
import type { RuntimeHostContainer } from './container';
import type { RuntimeHostRouteRegistry } from './route-registry';
import { GatewayCapabilityService } from '../application/gateway/gateway-capability-service';
import { RuntimeHostModuleRegistry, type RuntimeHostNamedModule } from '../core/registry';
import {
  registerOpenClawApplicationServices,
  registerOpenClawApplicationLifecycle,
  registerOpenClawApplicationJobs,
  resolveOpenClawApplicationServices,
} from './modules/openclaw-application-module';
import {
  registerOperationsApplicationServices,
  registerOperationsLifecycle,
  registerOperationsJobs,
  resolveOperationsApplicationServices,
} from './modules/operations-application-module';
import {
  registerRuntimeApplicationServices,
  registerRuntimeApplicationLifecycle,
  registerRuntimeApplicationJobs,
  resolveRuntimeApplicationServices,
} from './modules/runtime-application-module';
import { registerOpenClawRoutes } from './modules/openclaw-route-module';
import { registerOperationsRoutes } from './modules/operations-route-module';
import { registerRuntimeRoutes } from './modules/runtime-route-module';
import { registerSessionRoutes } from './modules/session-route-module';

export interface RuntimeHostApplicationModule extends RuntimeHostNamedModule {
  readonly name: string;
  readonly registerServices: (context: RuntimeHostApplicationServicesContext) => void;
  readonly resolveServices?: (container: RuntimeHostContainer) => object;
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
    services: RuntimeHostApplicationServices,
  ) => void;
}

const openClawModule: RuntimeHostApplicationModule = {
  name: 'openclaw',
  registerServices: (context) => registerOpenClawApplicationServices(context.container, context),
  resolveServices: resolveOpenClawApplicationServices,
  registerJobs: registerOpenClawApplicationJobs,
  registerLifecycle: registerOpenClawApplicationLifecycle,
  registerRoutes: registerOpenClawRoutes,
};

const applicationFoundationModule: RuntimeHostApplicationModule = {
  name: 'application-foundation',
  registerServices: (context) => {
    context.container.register('gateway.capabilities', () => new GatewayCapabilityService({
      gateway: context.openclawBridge,
    }));
  },
};

const runtimeModule: RuntimeHostApplicationModule = {
  name: 'runtime',
  registerServices: (context) => registerRuntimeApplicationServices(context.container, context),
  resolveServices: resolveRuntimeApplicationServices,
  registerJobs: registerRuntimeApplicationJobs,
  registerLifecycle: registerRuntimeApplicationLifecycle,
  registerRoutes: registerRuntimeRoutes,
};

const operationsModule: RuntimeHostApplicationModule = {
  name: 'operations',
  registerServices: (context) => registerOperationsApplicationServices(context.container, context),
  resolveServices: resolveOperationsApplicationServices,
  registerJobs: registerOperationsJobs,
  registerLifecycle: registerOperationsLifecycle,
  registerRoutes: registerOperationsRoutes,
};

const sessionsModule: RuntimeHostApplicationModule = {
  name: 'sessions',
  registerServices: () => undefined,
  resolveServices: () => ({}),
  registerRoutes: registerSessionRoutes,
};

export const RUNTIME_HOST_APPLICATION_MODULES: readonly RuntimeHostApplicationModule[] = [
  applicationFoundationModule,
  openClawModule,
  runtimeModule,
  operationsModule,
  sessionsModule,
] as const;

const RUNTIME_HOST_ROUTE_MODULES: readonly RuntimeHostApplicationModule[] = [
  runtimeModule,
  operationsModule,
  openClawModule,
  sessionsModule,
] as const;

function createRuntimeHostApplicationModuleRegistry(
  modules: readonly RuntimeHostApplicationModule[],
): RuntimeHostModuleRegistry<RuntimeHostApplicationModule> {
  const registry = new RuntimeHostModuleRegistry<RuntimeHostApplicationModule>();
  for (const module of modules) {
    registry.register(module);
  }
  return registry;
}

const RUNTIME_HOST_APPLICATION_MODULE_REGISTRY = createRuntimeHostApplicationModuleRegistry(
  RUNTIME_HOST_APPLICATION_MODULES,
);
const RUNTIME_HOST_ROUTE_MODULE_REGISTRY = createRuntimeHostApplicationModuleRegistry(
  RUNTIME_HOST_ROUTE_MODULES,
);

export function registerRuntimeHostModuleServices(
  context: RuntimeHostApplicationServicesContext,
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('services', (module) => {
    module.registerServices(context);
  });
}

export function resolveRuntimeHostModuleServices(
  context: RuntimeHostApplicationServicesContext,
): RuntimeHostApplicationServices {
  const services: Record<string, unknown> = {
    sessionRuntime: context.sessionRuntime,
  };
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('service-resolution', (module) => {
    Object.assign(services, module.resolveServices?.(context.container));
  });
  context.container.registerValue('application.services', services);
  return services as unknown as RuntimeHostApplicationServices;
}

export function registerRuntimeHostModuleJobs(
  container: RuntimeHostContainer,
  deps: {
    readonly jobRegistry: RuntimeJobRegistry;
  },
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('jobs', (module) => {
    module.registerJobs?.(container, deps);
  });
}

export function registerRuntimeHostModuleLifecycle(
  container: RuntimeHostContainer,
  deps: {
    readonly lifecycle: RuntimeHostLifecycle;
  },
): void {
  RUNTIME_HOST_APPLICATION_MODULE_REGISTRY.run('lifecycle', (module) => {
    module.registerLifecycle?.(container, deps);
  });
}

export function registerRuntimeHostModuleRoutes(
  routes: RuntimeHostRouteRegistry,
  services: RuntimeHostApplicationServices,
): void {
  RUNTIME_HOST_ROUTE_MODULE_REGISTRY.run('routes', (module) => {
    module.registerRoutes?.(routes, services);
  });
}
