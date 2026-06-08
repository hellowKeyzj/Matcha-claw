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

export const HOSTAPI_PROXY_PUBLIC_READONLY_EXACT_ROUTES = Object.freeze([
  '/api/app/browser-relay-info',
  '/api/capability-routing',
  '/api/channels/snapshot',
  '/api/cron/jobs',
  '/api/cron/session-history',
  '/api/diagnostics/gateway-snapshot',
  '/api/diagnostics/memory',
  '/api/gateway/health',
  '/api/gateway/status',
  '/api/license/gate',
  '/api/license/stored-key',
  '/api/logs',
  '/api/logs/dir',
  '/api/logs/files',
  '/api/openclaw/cli-command',
  '/api/openclaw/config-dir',
  '/api/openclaw/dir',
  '/api/openclaw/ready',
  '/api/openclaw/skills-dir',
  '/api/openclaw/status',
  '/api/openclaw/subagent-templates',
  '/api/openclaw/task-workspace-dirs',
  '/api/openclaw/workspace-dir',
  '/api/platform/runtime/health',
  '/api/platform/tools',
  '/api/plugins/catalog',
  '/api/plugins/runtime',
  '/api/provider-accounts',
  '/api/provider-models',
  '/api/provider-models/selectable',
  '/api/runtime-adapters/instances/list',
  '/api/runtime-adapters/list',
  '/api/runtime-connectors/list',
  '/api/runtime-endpoints/list',
  '/api/runtime-host/gateway-launch-plan',
  '/api/runtime-host/health',
  '/api/runtime-host/host-bootstrap-settings',
  '/api/runtime-host/jobs',
  '/api/runtime-host/provider-env-map',
  '/api/runtime-host/transport-stats',
  '/api/runtime-host/usage/recent',
  '/api/security',
  '/api/security/audit',
  '/api/security/destructive-rule-catalog',
  '/api/settings',
  '/api/skills/effective',
  '/api/skills/status',
  '/api/toolchain/uv/check',
  '/api/workbench/bootstrap',
]);

export const HOSTAPI_PROXY_PUBLIC_READONLY_PREFIX_ROUTES = Object.freeze([
  '/api/channels/config/',
  '/api/channels/pairing/',
  '/api/openclaw/subagent-templates/',
  '/api/settings/',
]);

export function getMainApiBoundarySnapshot() {
  return {
    allowedRouteFiles: [...MAIN_API_ALLOWED_ROUTE_FILES],
    mainOwnedExactRoutes: [...MAIN_OWNED_EXACT_ROUTES],
    mainOwnedPrefixRoutes: [...MAIN_OWNED_PREFIX_ROUTES],
    hostapiProxyPublicReadonlyExactRoutes: [...HOSTAPI_PROXY_PUBLIC_READONLY_EXACT_ROUTES],
    hostapiProxyPublicReadonlyPrefixRoutes: [...HOSTAPI_PROXY_PUBLIC_READONLY_PREFIX_ROUTES],
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

export function isHostApiProxyAllowedRoute(method: string, pathname: string): boolean {
  const normalizedMethod = method.toUpperCase();
  if (pathname === '/api/capabilities/list' && normalizedMethod === 'GET') {
    return true;
  }
  if (
    (pathname === '/api/capabilities/describe' || pathname === '/api/capabilities/execute')
    && normalizedMethod === 'POST'
  ) {
    return true;
  }
  if (normalizedMethod !== 'GET') {
    return false;
  }
  if (HOSTAPI_PROXY_PUBLIC_READONLY_EXACT_ROUTES.includes(pathname)) {
    return true;
  }
  return HOSTAPI_PROXY_PUBLIC_READONLY_PREFIX_ROUTES.some((prefix) => pathname.startsWith(prefix));
}
