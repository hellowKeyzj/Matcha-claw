import { describe, expect, it } from 'vitest';
import { RendererEventRouteRegistry } from '../../electron/main/renderer-event-routes';

const matchaBinding = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'matcha-agent' as const,
    runtimeInstanceId: 'local' as const,
  },
  agentId: 'main',
  sessionKey: 'agent:main:session-1',
};

describe('RendererEventRouteRegistry', () => {
  it('issues distinct opaque Matcha keys and releases them', () => {
    const routes = new RendererEventRouteRegistry();
    const first = routes.issue(matchaBinding);
    const second = routes.issue(matchaBinding);

    expect(first).toMatch(/^renderer-route:[A-Za-z0-9_-]{32}$/);
    expect(second).toMatch(/^renderer-route:[A-Za-z0-9_-]{32}$/);
    expect(second).not.toBe(first);
    expect(routes.isMatchaRoute(first)).toBe(true);

    routes.release(first);

    expect(routes.isMatchaRoute(first)).toBe(false);
    expect(routes.isMatchaRoute(second)).toBe(true);
  });

  it('does not admit routes bound to another runtime as Matcha events', () => {
    const routes = new RendererEventRouteRegistry();
    const routeKey = routes.issue({
      ...matchaBinding,
      endpoint: {
        ...matchaBinding.endpoint,
        runtimeAdapterId: 'openclaw',
      },
    });

    expect(routes.isMatchaRoute(routeKey)).toBe(false);
  });

  it('does not reinterpret opaque route keys after they are released', () => {
    const routes = new RendererEventRouteRegistry();
    const routeKey = routes.issue(matchaBinding);

    routes.release(routeKey);

    expect(routes.isMatchaRoute(routeKey)).toBe(false);
    expect(routes.isMatchaRoute('matcha-agent:session-1')).toBe(false);
  });
});
