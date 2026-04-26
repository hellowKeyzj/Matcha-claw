import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import boundarySpec from '../../electron/api/main-api-boundary.json';
import {
  MAIN_API_ALLOWED_ROUTE_FILES,
  MAIN_OWNED_EXACT_ROUTES,
  MAIN_OWNED_PREFIX_ROUTES,
  getMainApiBoundarySnapshot,
  isMainOwnedRoute,
  isRuntimeHostBusinessRoute,
} from '../../electron/api/route-boundary';

describe('main api boundary', () => {
  it('主进程路由归属判定正确', () => {
    expect(isMainOwnedRoute('/api/gateway/status')).toBe(true);
    expect(isMainOwnedRoute('/api/plugins/runtime/restart')).toBe(true);
    expect(isMainOwnedRoute('/api/plugins/runtime')).toBe(false);
    expect(isMainOwnedRoute('/api/plugins/runtime/enabled-plugins')).toBe(false);
    expect(isRuntimeHostBusinessRoute('/api/security/audit')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/chat/send-with-media')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/platform/tools')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/plugins/catalog')).toBe(true);
    expect(isRuntimeHostBusinessRoute('/api/gateway/status')).toBe(false);
    expect(isRuntimeHostBusinessRoute('/api/plugins/runtime/restart')).toBe(false);
    expect(isMainOwnedRoute('/api/platform/tools')).toBe(false);
  });

  it('route-boundary 清单可枚举且不为空', () => {
    const snapshot = getMainApiBoundarySnapshot();
    expect(snapshot.allowedRouteFiles.length).toBeGreaterThan(0);
    expect(snapshot.mainOwnedExactRoutes.length).toBeGreaterThan(0);
  });

  it('ts 边界定义必须与 JSON 边界清单保持一致', () => {
    expect([...MAIN_API_ALLOWED_ROUTE_FILES]).toEqual(boundarySpec.allowedRouteFiles);
    expect([...MAIN_OWNED_EXACT_ROUTES]).toEqual(boundarySpec.mainOwnedExactRoutes);
    expect([...MAIN_OWNED_PREFIX_ROUTES]).toEqual(boundarySpec.mainOwnedPrefixRoutes);
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
});
