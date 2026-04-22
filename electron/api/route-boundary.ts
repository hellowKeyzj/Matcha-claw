export const MAIN_API_ALLOWED_ROUTE_FILES = Object.freeze([
  'app.ts',
  'diagnostics.ts',
  'files.ts',
  'gateway.ts',
  'logs.ts',
  'runtime-host-internal.ts',
  'runtime-host-proxy.ts',
]);

export const MAIN_OWNED_EXACT_ROUTES = Object.freeze([
  '/api/events',
  '/api/gateway/status',
  '/api/gateway/health',
  '/api/gateway/start',
  '/api/gateway/stop',
  '/api/gateway/restart',
  '/api/gateway/control-ui',
  '/api/gateway/rpc',
  '/api/files/stage-paths',
  '/api/files/stage-buffer',
  '/api/files/thumbnails',
  '/api/files/save-image',
  '/api/diagnostics/collect',
  '/api/logs',
  '/api/logs/dir',
  '/api/logs/files',
  '/internal/runtime-host/execution-sync',
  '/internal/runtime-host/shell-actions',
]);

export const MAIN_OWNED_PREFIX_ROUTES = Object.freeze([
  '/internal/runtime-host/',
]);

export function getMainApiBoundarySnapshot() {
  return {
    allowedRouteFiles: [...MAIN_API_ALLOWED_ROUTE_FILES],
    mainOwnedExactRoutes: [...MAIN_OWNED_EXACT_ROUTES],
    mainOwnedPrefixRoutes: [...MAIN_OWNED_PREFIX_ROUTES],
  };
}

export function isMainOwnedRoute(pathname: string): boolean {
  if (MAIN_OWNED_EXACT_ROUTES.includes(pathname)) {
    return true;
  }
  return MAIN_OWNED_PREFIX_ROUTES.some((prefix) => pathname.startsWith(prefix));
}

export function isRuntimeHostBusinessRoute(pathname: string): boolean {
  if (!pathname.startsWith('/api/')) {
    return false;
  }
  return !isMainOwnedRoute(pathname);
}
