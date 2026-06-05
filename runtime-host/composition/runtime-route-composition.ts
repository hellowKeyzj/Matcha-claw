import type {
  RuntimeRouteHandlerEntry,
} from '../api/dispatch/runtime-route-dispatcher-types';
import type { RuntimeHostApplicationServicesContext } from './application-services';
import { registerRuntimeHostModuleRoutes } from './runtime-host-module-registry';
import { RuntimeHostRouteRegistry } from './route-registry';

export function createRuntimeHostRouteRegistry(
  context: RuntimeHostApplicationServicesContext,
): RuntimeHostRouteRegistry {
  const routes = new RuntimeHostRouteRegistry();

  registerRuntimeHostModuleRoutes(routes, {
    container: context.container,
    facades: context.facades,
  });

  return routes;
}

export function createRuntimeHostRouteHandlers(
  context: RuntimeHostApplicationServicesContext,
): RuntimeRouteHandlerEntry[] {
  return createRuntimeHostRouteRegistry(context).list();
}
