import { gatewayRoutes } from '../../api/routes/gateway-routes';
import { pluginRuntimeRoutes } from '../../api/routes/plugin-runtime-routes';
import { runtimeHostRoutes } from '../../api/routes/runtime-host-routes';
import { workbenchRoutes } from '../../api/routes/workbench-routes';
import type { RuntimeHostRouteRegistry } from '../route-registry';
import type { WorkbenchService } from '../../application/workbench/service';
import type { RuntimeHostService } from '../../application/runtime-host/service';
import type { PluginRuntimeService } from '../../application/plugins/plugin-runtime-service';
import type { GatewayService } from '../../application/gateway/service';

export interface RuntimeRouteServices {
  readonly workbenchService: WorkbenchService;
  readonly runtimeHostService: RuntimeHostService;
  readonly pluginRuntimeService: PluginRuntimeService;
  readonly gatewayService: GatewayService;
}

export function registerRuntimeRoutes(
  routes: RuntimeHostRouteRegistry,
  services: RuntimeRouteServices,
): void {

  routes.registerDefinitions('workbench', workbenchRoutes, { workbenchService: services.workbenchService });
  routes.registerDefinitions('runtime_host', runtimeHostRoutes, services.runtimeHostService);
  routes.registerDefinitions('plugin_runtime', pluginRuntimeRoutes, { pluginRuntimeService: services.pluginRuntimeService });
  routes.registerDefinitions('gateway', gatewayRoutes, { gatewayService: services.gatewayService });
}
