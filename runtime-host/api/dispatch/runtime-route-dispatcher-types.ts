import type { ApplicationResponse } from '../../application/common/application-response';

export type RuntimeRouteResponse = ApplicationResponse;

export interface RuntimeRouteRequest {
  method: string;
  route: string;
  payload: unknown;
  routePath: string;
  routeUrl: URL;
}

export type RuntimeRouteHandler = (
  request: RuntimeRouteRequest,
) => Promise<RuntimeRouteResponse | null> | RuntimeRouteResponse | null;

export type RuntimeRouteHandlerKey = string;

export type RuntimeRouteMatcher =
  | { readonly type: 'exact'; readonly path: string }
  | { readonly type: 'prefix'; readonly prefix: string }
  | { readonly type: 'pattern'; readonly pattern: RegExp };

export interface RuntimeRouteHandlerEntry {
  key: RuntimeRouteHandlerKey;
  matcher: RuntimeRouteMatcher;
  handle: RuntimeRouteHandler;
}
