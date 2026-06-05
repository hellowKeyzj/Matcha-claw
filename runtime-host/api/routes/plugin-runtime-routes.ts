import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface PluginRuntimeRouteDeps {
  pluginRuntimeService: {
    runtime(): ApplicationResponse;
    catalog(): ApplicationResponse;
  };
}

export const pluginRuntimeRoutes: readonly RuntimeRouteDefinition<PluginRuntimeRouteDeps>[] = [
  {
    method: 'GET',
    path: '/api/plugins/runtime',
    handle: (_context, deps) => routeResponder.result(() => deps.pluginRuntimeService.runtime()),
  },
  {
    method: 'GET',
    path: '/api/plugins/catalog',
    handle: (_context, deps) => routeResponder.result(() => deps.pluginRuntimeService.catalog()),
  },
] as const;

