import {
  createRuntimeRouteContext,
  invokeRuntimeRouteDefinition,
  type RuntimeRouteDefinition,
  type RuntimeRouteResponse,
} from '../../../runtime-host/api/routes/route-utils';

export async function dispatchRuntimeRouteDefinition<Deps>(
  routes: readonly RuntimeRouteDefinition<Deps>[],
  method: string,
  routePath: string,
  routeUrlOrPayload: URL | unknown,
  payloadOrDeps: unknown | Deps,
  maybeDeps?: Deps,
): Promise<RuntimeRouteResponse | null> {
  const hasUrl = routeUrlOrPayload instanceof URL;
  const routeUrl = hasUrl
    ? routeUrlOrPayload
    : new URL(routePath, 'http://runtime-host.local');
  const payload = hasUrl ? payloadOrDeps : routeUrlOrPayload;
  const deps = (hasUrl ? maybeDeps : payloadOrDeps) as Deps;
  const context = createRuntimeRouteContext(method, routePath, routeUrl, payload);

  for (const route of routes) {
    const result = await invokeRuntimeRouteDefinition(route, context, deps);
    if (result) {
      return result;
    }
  }
  return null;
}
