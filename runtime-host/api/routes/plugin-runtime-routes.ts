import { routeResponder, type ApplicationResponse, type RuntimeRouteDefinition } from './route-utils';

interface PluginRuntimeRouteDeps {
  pluginRuntimeService: {
    runtime(): ApplicationResponse;
    catalog(): ApplicationResponse;
    setEnabled(payload: unknown): ApplicationResponse;
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
  {
    method: 'PUT',
    path: '/api/plugins/runtime/enabled-plugins',
    handle: (context, deps) => routeResponder.result(() => deps.pluginRuntimeService.setEnabled(context.payload)),
  },
] as const;

