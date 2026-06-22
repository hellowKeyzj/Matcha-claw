import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import boundarySpec from '../../electron/api/main-api-boundary.json';
import {
  HOSTAPI_PROXY_PUBLIC_READONLY_EXACT_ROUTES,
  HOSTAPI_PROXY_PUBLIC_READONLY_PREFIX_ROUTES,
  HOSTAPI_PROXY_PUBLIC_VALIDATION_POST_EXACT_ROUTES,
  MAIN_API_ALLOWED_ROUTE_FILES,
  MAIN_OWNED_EXACT_ROUTES,
  MAIN_OWNED_PREFIX_ROUTES,
  getMainApiBoundarySnapshot,
  isHostApiProxyAllowedRoute,
  isMainOwnedRoute,
  isRuntimeHostBusinessRoute,
} from '../../electron/api/route-boundary';

describe('main api boundary', () => {
  it('主进程路由归属判定正确', () => {
    expect(isMainOwnedRoute('/api/gateway/status')).toBe(true);
    expect(isMainOwnedRoute('/api/app/browser-relay-info')).toBe(true);
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
    expect(isRuntimeHostBusinessRoute('/api/runtime-host/restart')).toBe(false);
    expect(isMainOwnedRoute('/api/platform/tools')).toBe(false);
  });

  it('route-boundary 清单可枚举且不为空', () => {
    const snapshot = getMainApiBoundarySnapshot();
    expect(snapshot.allowedRouteFiles.length).toBeGreaterThan(0);
    expect(snapshot.mainOwnedExactRoutes.length).toBeGreaterThan(0);
    expect(snapshot.hostapiProxyPublicReadonlyExactRoutes.length).toBeGreaterThan(0);
  });

  it('hostapi proxy 只允许 capabilities 与明确公开只读路由', () => {
    expect(isHostApiProxyAllowedRoute('GET', '/api/capabilities/list')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/capabilities/describe')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/capabilities/execute')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/channels/credentials/validate')).toBe(true);
    expect(isHostApiProxyAllowedRoute('POST', '/api/clawhub/search')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/openclaw/subagent-templates/brand-guardian')).toBe(true);
    expect(isHostApiProxyAllowedRoute('GET', '/api/settings/model')).toBe(true);

    expect(isHostApiProxyAllowedRoute('POST', '/api/channels/config/validate')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/settings')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/gateway/start')).toBe(false);
    expect(isHostApiProxyAllowedRoute('POST', '/api/runtime-host/restart')).toBe(false);
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
    expect([...HOSTAPI_PROXY_PUBLIC_READONLY_EXACT_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicReadonlyExactRoutes);
    expect([...HOSTAPI_PROXY_PUBLIC_READONLY_PREFIX_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicReadonlyPrefixRoutes);
    expect([...HOSTAPI_PROXY_PUBLIC_VALIDATION_POST_EXACT_ROUTES]).toEqual(boundarySpec.hostapiProxyPublicValidationPostExactRoutes);
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

  it('Electron 不保留业务 settings store，设置事实源只能在 runtime-host', () => {
    expect(existsSync(path.join(process.cwd(), 'electron', 'services', 'settings', 'settings-store.ts'))).toBe(false);
  });

  it('Electron 主线目录不保留 E2E 业务后端 fixture', () => {
    expect(existsSync(path.join(process.cwd(), 'electron', 'main', 'ipc', 'e2e-host-api-fixture.ts'))).toBe(false);
  });
});
