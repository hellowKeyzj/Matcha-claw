import { parseRouteUrl } from '../common/http';
import { RuntimeRouteIndex } from './runtime-route-index';
import type {
  RuntimeRouteRequest,
  RuntimeRouteHandlerEntry,
  RuntimeRouteHandlerKey,
  RuntimeRouteResponse,
} from './runtime-route-dispatcher-types';

export type {
  RuntimeRouteRequest,
  RuntimeRouteHandlerEntry,
  RuntimeRouteHandlerKey,
  RuntimeRouteResponse,
} from './runtime-route-dispatcher-types';

export function createRuntimeRouteDispatcher(handlersOrIndex: RuntimeRouteHandlerEntry[] | RuntimeRouteIndex) {
  const routeIndex = Array.isArray(handlersOrIndex) ? RuntimeRouteIndex.from(handlersOrIndex) : handlersOrIndex;
  return async (method: string, route: string, payload: unknown): Promise<RuntimeRouteResponse | null> => {
    const routeUrl = parseRouteUrl(route);
    const request: RuntimeRouteRequest = {
      method,
      route,
      payload,
      routePath: routeUrl.pathname,
      routeUrl,
    };
    const exactHandler = routeIndex.exact(method, request.routePath);
    if (exactHandler) {
      const result = await exactHandler.handle(request);
      if (result) {
        return result;
      }
    }
    for (const entry of routeIndex.fallbackCandidates(method, request.routePath)) {
      const result = await entry.handle(request);
      if (result) {
        return result;
      }
    }
    return null;
  };
}
