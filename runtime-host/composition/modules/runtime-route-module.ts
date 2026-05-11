import { gatewayRoutes } from '../../api/routes/gateway-routes';
import { pluginRuntimeRoutes } from '../../api/routes/plugin-runtime-routes';
import { runtimeHostRoutes } from '../../api/routes/runtime-host-routes';
import { workbenchRoutes } from '../../api/routes/workbench-routes';
import type { RuntimeHostApplicationServices } from '../application-services';
import type { RuntimeHostRouteRegistry } from '../route-registry';

export function registerRuntimeRoutes(
  routes: RuntimeHostRouteRegistry,
  services: RuntimeHostApplicationServices,
): void {
  routes.registerDefinitions('workbench', workbenchRoutes, {
    workbenchService: services.workbenchService,
  });
  routes.registerDefinitions('runtime_host', runtimeHostRoutes, services.runtimeHostService);
  routes.registerDefinitions('plugin_runtime', pluginRuntimeRoutes, {
    pluginRuntimeService: services.pluginRuntimeService,
  });
  routes.registerDefinitions('gateway', gatewayRoutes, {
    gatewayService: services.gatewayService,
  });
}
