import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import boundarySpec from '../../electron/api/main-api-boundary.json';
import {
  HOSTAPI_PROXY_PUBLIC_READONLY_EXACT_ROUTES,
  HOSTAPI_PROXY_PUBLIC_READONLY_PREFIX_ROUTES,
  HOSTAPI_PROXY_PUBLIC_VALIDATION_POST_EXACT_ROUTES,
  HOSTAPI_PROXY_PUBLIC_MUTATION_POST_EXACT_ROUTES,
  HOSTAPI_PROXY_PUBLIC_MUTATION_PUT_EXACT_ROUTES,
  HOSTAPI_PROXY_WEBSOCKET_EXACT_ROUTES,
  MAIN_API_ALLOWED_ROUTE_FILES,
  MAIN_OWNED_EXACT_ROUTES,
  MAIN_OWNED_PREFIX_ROUTES,
  getMainApiBoundarySnapshot,
  isHostApiProxyAllowedRoute,
  isHostApiProxyWebSocketRoute,
  isMainOwnedRoute,
  isRuntimeHostBusinessRoute,
} from '../../electron/api/route-boundary';

describe('main api boundary', () => {
  it('主进程路由归属判定正确', () => {
    expect(isMainOwnedRoute('/api/gateway/status')).toBe(true);
    expect(isMainOwnedRoute('/api/app/browser-relay-info')).toBe(true);
    expect(isMainOwnedRoute('/api/matcha-agent/app-server/status')).toBe(true);
    expect(isMainOwnedRoute('/api/matcha-agent/app-server/restart')).toBe(true);
    expect(isMainOwnedRoute('/api/runtime-host/restart')).toBe(true);
    expect(isMainOwnedRoute('/api/files/save-image')).toBe(true);
    expect(isMainOwnedRoute('/api/files/write-text')).toBe(false);
    expect(isRuntimeHostBusinessRoute('/api/files/write-text')).toBe(true);
    expect(isMainOwnedRoute('/api/files/read-text')).toBe(false);
    expect(isMainOwnedRoute('/api/plugins/runtime')).toBe(false);
    expect(isRuntimeHostBusinessRoute('/api/plugins/runtime')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/security/audit')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/capabilities/execute')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/platform/tools')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/plugins/catalog')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/gateway/status')).toBe(false);
    expect(isRuntimeHostBusinessRoute('/api/matcha-agent/app-server/status')).toBe(false);
    expect(isRuntimeHostBusinessRoute('/api/matcha-agent/app-server/restart')).toBe(false);
    expect(isRuntimeHostBusinessRoute('/api/runtime-host/restart')).toBe(false);
    expect(isMainOwnedRoute('/api/platform/tools')).toBe(false);
  });

  it('route-boundary 清单可枚举且不为空', () => {
    const snapshot = getMainApiBoundarySnapshot();
    expect(snapshot.allowedRouteFiles.length).toBeGreaterThan(0);
    expect(snapshot.mainOwnedExactRoutes.length).toBeGreaterThan(0);
    expect(snapshot.hostapiProxyPublicReadonlyExactRoutes.length).toBeGreaterThan(0);
  });

  it('hostapi proxy 只允许 capabilities 与明确公开 route', () => {
    expect(isHostApiProxyAllowedRoute('GET', '/api/capabilities/list')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/capabilities/describe')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/capabilities/execute')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/channels/credentials/validate')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/clawhub/search')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/probe-connection')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/external-connectors')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/external-connectors/mcp-server-programs')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/external-connectors/status')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/snapshot')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/metrics')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/list-commands')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/list-audit-events')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/terminal/sessions')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/openclaw/logs')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/openclaw/logs/dir')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/matcha-agent/app-server/status')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/gateway/restart')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/matcha-agent/app-server/restart')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/runtime-host/restart')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/external-connectors/get')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/external-connectors/probe')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/external-connectors/session-status')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/external-connectors/upsert')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/external-connectors/remove')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/register-connection')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/delete-connection')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/register-environment')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/deploy-environment')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/delete-environment')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/register')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/write-credential')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/terminal/open')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/terminal/reconnect')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/terminal/close')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/install-agent')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/drain-endpoint')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/openclaw/subagent-templates/brand-guardian')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/openclaw/tool-permission-mode')).toBe(true);
    expect(isHostApiProxyAllowedRoute('PUT', '/api/openclaw/tool-permission-mode')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/settings/model')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/runtime-host/team-webhook-auth')).toBe(true);
    expect(isHostApiProxyWebSocketRoute('/api/remote-fleet/terminal/stream')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/terminal/stream')).toBe(false);

    expect(isHostApiProxyAllowedRoute('POST', '/api/external-connectors')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/probe')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/probe-connection')).toBe(false);
    expect(isHostApiProxyAllowedRoute('GET', '/api/external-connectors/get')).toBe(false);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/register')).toBe(false);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/write-credential')).toBe(false);
    expect(isHostApiProxyAllowedRoute('GET', '/api/remote-fleet/terminal/open')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/terminal/sessions')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/record-heartbeat')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/record-command-progress')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/record-command-result')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/remote-fleet/runtime-agent/ingress')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/channels/config/validate')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/settings')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/openclaw/tool-permission-mode')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/matcha-agent/app-server/status')).toBe(false);
    expect(isHostApiProxyAllowedRoute('PUT', '/api/matcha-agent/app-server/status')).toBe(false);
    expect(isHostApiProxyAllowedRoute('GET', '/api/matcha-agent/app-server/restart')).toBe(false);
    expect(isHostApiProxyAllowedRoute('PUT', '/api/matcha-agent/app-server/restart')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/gateway/start')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/files/read-text')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/files/write-text')).toBe(false);
    expect(isHostApiProxyAllowedRoute('GET', '/api/provider-accounts/account-1/api-key')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/provider-accounts/validate')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/internal/runtime-host/shell-actions')).toBe(false);
  });

  it('ts 边界定义必须与 JSON 边界清单保持一致', () => {
    expect([...MAIN_API_ALLOWED_ROUTE_FILES]).toEqual(boundarySpec.allowedRouteFiles);
    expect([...MAIN_OWNED_EXACT_ROUTES]).toEqual(boundarySpec.mainOwnedExactRoutes);
    expect([...MAIN_OWNED_PREFIX_ROUTES]).toEqual(boundarySpec.mainOwnedPrefixRoutes);
    expect([...HOSTAPI_PROXY_WEBSOCKET_EXACT_ROUTES]).toEqual(boundarySpec.hostapiProxyWebsocketExactRoutes);
    expect([...HOSTAPI_PROXY_PUBLIC_READONLY_EXACT_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicReadonlyExactRoutes);
    expect([...HOSTAPI_PROXY_PUBLIC_READONLY_PREFIX_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicReadonlyPrefixRoutes);
    expect([...HOSTAPI_PROXY_PUBLIC_VALIDATION_POST_EXACT_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicValidationPostExactRoutes);
    expect([...HOSTAPI_PROXY_PUBLIC_MUTATION_POST_EXACT_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicMutationPostExactRoutes);
    expect([...HOSTAPI_PROXY_PUBLIC_MUTATION_PUT_EXACT_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicMutationPutExactRoutes);
  });

  it('electron/api/routes 目录必须与边界清单一致', async () => {
    const routesDir = path.join(process.cwd(), 'electron', 'api', 'routes');
    const files = (await readdir(routesDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name)
      .sort();
    const allowed = [...MAIN_API_ALLOWED_ROUTE_FILES].sort();
    expect(files).toEqual(allowed);
  });

  it('OpenClaw gateway registry entry uses GatewayManager facade for lifecycle commands', async () => {
    const mainSource = await readFile(path.join(process.cwd(), 'electron', 'main', 'index.ts'), 'utf8');
    const registrationStart = mainSource.indexOf("id: 'openclaw-gateway'");
    expect(registrationStart).toBeGreaterThan(-1);
    const registrationSource = mainSource.slice(registrationStart, mainSource.indexOf('  });', registrationStart));

    expect(registrationSource).toContain('start: () => gatewayManager.start()');
    expect(registrationSource).toContain('stop: () => gatewayManager.stop()');
    expect(registrationSource).toContain('restart: () => gatewayManager.restart().then(() => undefined)');
    expect(registrationSource).not.toContain('runner: gatewayProcessRunner');
    expect(registrationSource).not.toContain('restart: () => gatewayProcessRunner.restart()');
  });

  it('Electron 不保留业务 settings store，设置事实源只能在 runtime-host', () => {
    expect(existsSync(path.join(process.cwd(), 'electron', 'services', 'settings', 'settings-store.ts'))).toBe(false);
  });

  it('Electron 主线目录不保留 E2E 业务后端 fixture', () => {
    expect(existsSync(path.join(process.cwd(), 'electron', 'main', 'ipc', 'e2e-host-api-fixture.ts'))).toBe(false);
  });
});
