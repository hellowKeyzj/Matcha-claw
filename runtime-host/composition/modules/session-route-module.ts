import { sessionRoutes } from '../../api/routes/session-routes';
import type { RuntimeHostApplicationServices } from '../application-services';
import type { RuntimeHostRouteRegistry } from '../route-registry';

export function registerSessionRoutes(
  routes: RuntimeHostRouteRegistry,
  services: RuntimeHostApplicationServices,
): void {
  routes.registerDefinitions('session', sessionRoutes, services.sessionRuntime);
}
