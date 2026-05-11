import { parseRouteUrl } from '../common/http';
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

function routeMatches(entry: RuntimeRouteHandlerEntry, routePath: string): boolean {
  if (entry.matcher.type === 'exact') {
    return routePath === entry.matcher.path;
  }
  if (entry.matcher.type === 'prefix') {
    return routePath.startsWith(entry.matcher.prefix);
  }
  return entry.matcher.pattern.test(routePath);
}

export function createRuntimeRouteDispatcher(handlers: RuntimeRouteHandlerEntry[]) {
  return async (method: string, route: string, payload: unknown): Promise<RuntimeRouteResponse | null> => {
    const routeUrl = parseRouteUrl(route);
    const request: RuntimeRouteRequest = {
      method,
      route,
      payload,
      routePath: routeUrl.pathname,
      routeUrl,
    };
    for (const handler of handlers) {
      if (!routeMatches(handler, request.routePath)) {
        continue;
      }
      const result = await handler.handle(request);
      if (result) {
        return result;
      }
    }
    return null;
  };
}
