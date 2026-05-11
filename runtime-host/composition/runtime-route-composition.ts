import type {
  RuntimeRouteHandlerEntry,
} from '../api/dispatch/runtime-route-dispatcher-types';
import {
  resolveRuntimeHostApplicationServices,
} from './application-services';
import type { RuntimeHostContainer } from './container';
import { registerRuntimeHostModuleRoutes } from './runtime-host-module-registry';
import { RuntimeHostRouteRegistry } from './route-registry';

export function createRuntimeHostRouteHandlers(
  container: RuntimeHostContainer,
): RuntimeRouteHandlerEntry[] {
  const services = resolveRuntimeHostApplicationServices(container);
  const routes = new RuntimeHostRouteRegistry();

  registerRuntimeHostModuleRoutes(routes, services);

  return routes.list();
}
