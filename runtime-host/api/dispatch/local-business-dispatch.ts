import { parseRouteUrl } from '../common/http';
import { createCoreLocalBusinessHandlers } from './local-business-dispatch-core-routes';
import { createTailLocalBusinessHandlers } from './local-business-dispatch-tail-routes';
import type {
  LocalBusinessDispatchContext,
  LocalBusinessDispatchRequest,
  LocalBusinessHandlerEntry,
  LocalBusinessHandlerKey,
  LocalDispatchResponse,
} from './local-business-dispatch-types';

export type {
  LocalBusinessDispatchContext,
  LocalBusinessDispatchRequest,
  LocalBusinessHandlerEntry,
  LocalBusinessHandlerKey,
  LocalDispatchResponse,
} from './local-business-dispatch-types';

export function createLocalBusinessHandlerRegistry(
  context: LocalBusinessDispatchContext,
): LocalBusinessHandlerEntry[] {
  return [
    ...createCoreLocalBusinessHandlers(context),
    ...createTailLocalBusinessHandlers(context),
  ];
}

export function createLocalBusinessDispatcher(context: LocalBusinessDispatchContext) {
  const handlers = createLocalBusinessHandlerRegistry(context);
  return async (method: string, route: string, payload: unknown): Promise<LocalDispatchResponse | null> => {
    const routeUrl = parseRouteUrl(route);
    const request: LocalBusinessDispatchRequest = {
      method,
      route,
      payload,
      routePath: routeUrl.pathname,
      routeUrl,
    };
    for (const handler of handlers) {
      const result = await handler.handle(request);
      if (result) {
        return result;
      }
    }
    return null;
  };
}
