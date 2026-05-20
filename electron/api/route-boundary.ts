export const MAIN_API_ALLOWED_ROUTE_FILES = Object.freeze([
  'app.ts',
  'diagnostics.ts',
  'files.ts',
  'gateway.ts',
  'logs.ts',
  'runtime-host-internal.ts',
  'runtime-host-process.ts',
  'runtime-host-proxy.ts',
]);

export const MAIN_OWNED_EXACT_ROUTES = Object.freeze([
  '/api/events',
  '/api/app/browser-relay-info',
  '/api/gateway/status',
  '/api/gateway/health',
  '/api/gateway/start',
  '/api/gateway/stop',
  '/api/gateway/restart',
  '/api/gateway/control-ui',
  '/api/files/save-image',
  '/api/files/write-text',
  '/api/diagnostics/memory',
  '/api/diagnostics/gateway-snapshot',
  '/api/logs',
  '/api/logs/dir',
  '/api/logs/files',
  '/api/runtime-host/restart',
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
