import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import boundarySpec from '../../electron/api/main-api-boundary.json';
import {
  MAIN_API_ALLOWED_ROUTE_FILES,
  getMainApiBoundarySnapshot,
  isHostApiRequestAllowed,
  isMainOwnedRoute,
} from '../../electron/api/route-boundary';

describe('main api boundary', () => {
  it('将具名 Electron 产品路由登记为 main-owned', () => {
    expect(isMainOwnedRoute('/api/app/browser-relay-info')).toBe(true);
    expect(isMainOwnedRoute('/api/files/save-image')).toBe(true);
    expect(isMainOwnedRoute('/api/diagnostics/memory')).toBe(true);
    expect(isMainOwnedRoute('/api/logs')).toBe(true);
    expect(isMainOwnedRoute('/api/logs/dir')).toBe(true);
    expect(isMainOwnedRoute('/api/logs/files')).toBe(true);
    expect(isMainOwnedRoute('/api/openclaw/logs')).toBe(true);
    expect(isMainOwnedRoute('/api/openclaw/logs/dir')).toBe(true);
    expect(isMainOwnedRoute('/api/gateway/status')).toBe(true);
    expect(isMainOwnedRoute('/api/gateway/restart')).toBe(true);
    expect(isMainOwnedRoute('/api/matcha-agent/app-server/status')).toBe(true);
    expect(isMainOwnedRoute('/api/matcha-agent/app-server/restart')).toBe(true);
    expect(isMainOwnedRoute('/internal/runtime-host/shell-actions')).toBe(false);
  });

  it('将 runtime-host process 路由登记为 main-owned', () => {
    expect(isMainOwnedRoute('/api/runtime-host/status')).toBe(true);
    expect(isMainOwnedRoute('/api/runtime-host/restart')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-host/status')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/runtime-host/restart')).toBe(true);
  });

  it('route-boundary 清单保留具名产品路由且排除旧 runtime HTTP proxy', () => {
    const snapshot = getMainApiBoundarySnapshot();
    expect(snapshot.allowedRouteFiles).toEqual(expect.arrayContaining([
      'gateway.ts',
      'logs.ts',
      'runtime-host-process.ts',
    ]));
    expect(snapshot.allowedRouteFiles).not.toEqual(expect.arrayContaining([
      'runtime-host-internal.ts',
      'runtime-host-proxy.ts',
    ]));
    expect(snapshot.mainOwnedExactRoutes).toEqual(expect.arrayContaining([
      '/api/files/save-image',
      '/api/diagnostics/memory',
      '/api/logs',
      '/api/logs/dir',
      '/api/logs/files',
      '/api/openclaw/logs',
      '/api/openclaw/logs/dir',
      '/api/gateway/status',
      '/api/gateway/health',
      '/api/gateway/start',
      '/api/gateway/stop',
      '/api/gateway/restart',
      '/api/gateway/control-ui',
      '/api/matcha-agent/app-server/status',
      '/api/matcha-agent/app-server/restart',
      '/api/runtime-host/status',
      '/api/runtime-host/restart',
    ]));
    expect(JSON.stringify(snapshot)).not.toContain('runtime-host-proxy');
  });

  it('只向冻结的 Host API 开放精确 method', () => {
    expect(isHostApiRequestAllowed('GET', '/api/app/browser-relay-info')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/app/browser-relay-info')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/capabilities/list')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/capabilities/list')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/capabilities/describe')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/capabilities/execute')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/capabilities/execute')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/channels/authorization')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/channels/authorization')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/channels/config/validate')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/channels/config/validate')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/security/policy')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/security/policy/current')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/security/policy')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/diagnostics/memory')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/diagnostics/memory')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/clawhub/skills/install')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/clawhub/skills/install')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/plugins/configuration')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/plugins/configuration')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/files/save-image')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/files/save-image')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/license/gate')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/license/stored-key')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/license/validate')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/logs')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/logs')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/logs/dir')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/logs/files')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/logs')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/logs/dir')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/status')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/runtime/snapshot')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/openclaw/status')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/lifecycle/status')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/openclaw/lifecycle/status')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/openclaw/lifecycle/restart')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/lifecycle/restart')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/gateway/status')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/gateway/status')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/gateway/health')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/gateway/health')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/gateway/start')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/gateway/start')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/gateway/stop')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/gateway/stop')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/gateway/restart')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/gateway/restart')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/gateway/control-ui')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/gateway/control-ui')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/subagent-templates')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/subagent-templates/brand-guardian')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/openclaw/subagent-templates/../private')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/openclaw/subagent-templates/brand-guardian')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/team/graph')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/team/graph')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/team/lifecycle')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/team/lifecycle')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/cron/jobs')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/provider-models/selectable')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/provider-models/selectable')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/provider-models/discover')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/provider-models/discover')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/cron/jobs/create')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/cron/jobs/toggle')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/cron/jobs')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/usage/recent')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/usage/recent')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-host/usage/session-timeseries')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/runtime-host/usage/session-timeseries')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/matcha-agent/app-server/status')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/matcha-agent/app-server/status')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/matcha-agent/app-server/restart')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/matcha-agent/app-server/restart')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-adapters/list')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-adapters/instances/list')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-connectors/list')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/runtime-connectors/connect')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/runtime-connectors/disconnect')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/platform/tools')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-endpoints/list')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-host/status')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/runtime-host/status')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/runtime-host/restart')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/runtime-host/restart')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/toolchain/uv/check')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/toolchain/uv/check')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/toolchain/uv/prepare')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/toolchain/uv/prepare')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/remote-fleet/runtime-agent/ingress')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/remote-fleet/runtime-agent/ingress')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/remote-fleet/start-runtime')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/remote-fleet/start-runtime')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/remote-fleet/stop-runtime')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/remote-fleet/stop-runtime')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/remote-fleet/sync-capabilities')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/remote-fleet/sync-capabilities')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/remote-fleet/register')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/remote-fleet/register-connection')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/remote-fleet/register-environment')).toBe(true);
    expect(isMainOwnedRoute('/api/remote-fleet/register')).toBe(false);
    expect(isMainOwnedRoute('/api/remote-fleet/runtime-agent/ingress')).toBe(true);
    expect(isMainOwnedRoute('/api/remote-fleet/register-connection')).toBe(true);
    expect(isMainOwnedRoute('/api/remote-fleet/register-environment')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/internal/runtime-host/shell-actions')).toBe(false);
  });

  it('ts 边界定义必须与 JSON 边界清单保持一致', () => {
    const snapshot = getMainApiBoundarySnapshot();
    expect(snapshot.allowedRouteFiles).toEqual(boundarySpec.allowedRouteFiles);
    expect(snapshot.mainOwnedExactRoutes).toEqual(boundarySpec.mainOwnedExactRoutes);
    expect(snapshot.hostApiAllowedRequests).toEqual(boundarySpec.hostApiAllowedRequests);
    expect(snapshot.hostApiAllowedDynamicRequests).toEqual(boundarySpec.hostApiAllowedDynamicRequests);
  });

  it('electron/api/routes 保留已登记的具名产品 handler', async () => {
    const routesDir = path.join(process.cwd(), 'electron', 'api', 'routes');
    const routeFiles = new Set((await readdir(routesDir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => entry.name));
    const retainedProductHandlers = [
      'gateway.ts',
      'logs.ts',
      'runtime-host-process.ts',
    ];

    expect(MAIN_API_ALLOWED_ROUTE_FILES).toEqual(expect.arrayContaining(retainedProductHandlers));
    expect(retainedProductHandlers.every((fileName) => routeFiles.has(fileName))).toBe(true);
    expect(MAIN_API_ALLOWED_ROUTE_FILES).not.toContain('runtime-host-internal.ts');
    expect(MAIN_API_ALLOWED_ROUTE_FILES).not.toContain('runtime-host-proxy.ts');
  });

  it('Electron 不保留业务 settings store，设置事实源只能在 runtime-host', () => {
    expect(
      existsSync(path.join(process.cwd(), 'electron', 'services', 'settings', 'settings-store.ts'))
    ).toBe(false);
  });

  it('Electron 主线不保留业务 IPC 或旧 Node HTTP proxy', async () => {
    expect(
      existsSync(path.join(process.cwd(), 'electron', 'main', 'ipc', 'e2e-host-api-fixture.ts'))
    ).toBe(false);
    expect(existsSync(path.join(process.cwd(), 'electron', 'main', 'ipc', 'license-ipc.ts'))).toBe(
      false
    );
    const transport = await readFile(
      path.join(process.cwd(), 'electron', 'main', 'ipc', 'hostapi-proxy-ipc.ts'),
      'utf8'
    );
    expect(transport).toContain("'hostapi:fetch'");
    expect(transport).not.toContain('runtime-host-proxy');
  });
});
