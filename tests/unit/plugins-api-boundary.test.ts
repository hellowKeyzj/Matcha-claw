import { describe, expect, it } from 'vitest';
import boundarySpec from '../../electron/api/main-api-boundary.json';
import {
  MAIN_API_ALLOWED_ROUTE_FILES,
  MAIN_OWNED_EXACT_ROUTES,
  getMainApiBoundarySnapshot,
  isHostApiRequestAllowed,
  isMainOwnedRoute,
} from '../../electron/api/route-boundary';

const pluginRoutes = [
  '/api/plugins/catalog',
  '/api/plugins/runtime',
  '/api/plugins/configuration',
  '/api/plugins/operation',
] as const;

describe('plugins api boundary', () => {
  it('registers the plugin route file and exact Main-owned routes', () => {
    const snapshot = getMainApiBoundarySnapshot();

    expect(snapshot.allowedRouteFiles).toContain('plugins.ts');
    expect(snapshot.mainOwnedExactRoutes).toEqual(
      expect.arrayContaining(pluginRoutes)
    );
    expect(pluginRoutes.every((route) => isMainOwnedRoute(route))).toBe(true);
  });

  it('allows only the frozen Host methods for plugin routes', () => {
    expect(isHostApiRequestAllowed('GET', '/api/plugins/catalog')).toBe(true);
    expect(isHostApiRequestAllowed('GET', '/api/plugins/runtime')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/plugins/configuration')).toBe(true);
    expect(isHostApiRequestAllowed('POST', '/api/plugins/operation')).toBe(true);

    expect(isHostApiRequestAllowed('POST', '/api/plugins/catalog')).toBe(false);
    expect(isHostApiRequestAllowed('POST', '/api/plugins/runtime')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/plugins/configuration')).toBe(false);
    expect(isHostApiRequestAllowed('GET', '/api/plugins/operation')).toBe(false);
  });

  it('keeps the TypeScript registry aligned with the JSON manifest', () => {
    expect([...MAIN_API_ALLOWED_ROUTE_FILES]).toEqual(boundarySpec.allowedRouteFiles);
    expect([...MAIN_OWNED_EXACT_ROUTES]).toEqual(boundarySpec.mainOwnedExactRoutes);
  });
});
