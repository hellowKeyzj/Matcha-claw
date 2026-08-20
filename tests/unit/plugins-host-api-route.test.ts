import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

import { handlePluginsRoutes } from '../../electron/api/routes/plugins';

function incoming(body: unknown, method = 'GET') {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    headers: { 'content-type': 'application/json' },
  });
}

function response() {
  const state = { statusCode: 200, body: undefined as unknown };
  return {
    state,
    raw: {
      get statusCode() { return state.statusCode; },
      set statusCode(value: number) { state.statusCode = value; },
      setHeader: () => {},
      end: (content?: string) => { state.body = content ? JSON.parse(content) : undefined; },
    },
  };
}

describe('plugins Host API routes', () => {
  it('dispatches the three fixed routes to the dedicated transport', async () => {
    const transport = {
      catalog: vi.fn().mockResolvedValue({
        status: 200,
        body: { success: true, execution: { enabledPluginIds: [] }, plugins: [] },
      }),
      runtime: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          success: true,
          state: { lifecycle: 'running', runtimeLifecycle: 'running', activePluginCount: 0, enabledPluginIds: [] },
          health: { ok: true, lifecycle: 'running', activePluginCount: 0, degradedPlugins: [] },
          execution: { enabledPluginIds: [] },
        },
      }),
      configuration: vi.fn().mockResolvedValue({ outcome: 'configured' }),
      operation: vi.fn().mockResolvedValue({ outcome: 'configured' }),
    };

    const catalog = response();
    await expect(handlePluginsRoutes(
      incoming({}, 'GET') as never,
      catalog.raw as never,
      new URL('http://127.0.0.1/api/plugins/catalog'),
      transport,
    )).resolves.toBe(true);
    expect(catalog.state).toEqual({
      statusCode: 200,
      body: { success: true, execution: { enabledPluginIds: [] }, plugins: [] },
    });

    const runtime = response();
    await handlePluginsRoutes(
      incoming({}, 'GET') as never,
      runtime.raw as never,
      new URL('http://127.0.0.1/api/plugins/runtime'),
      transport,
    );
    expect(runtime.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        state: { lifecycle: 'running', runtimeLifecycle: 'running', activePluginCount: 0, enabledPluginIds: [] },
        health: { ok: true, lifecycle: 'running', activePluginCount: 0, degradedPlugins: [] },
        execution: { enabledPluginIds: [] },
      },
    });

    const configuration = response();
    await handlePluginsRoutes(
      incoming({ runtime: 'openclaw', pluginId: 'calendar', enabled: true }, 'POST') as never,
      configuration.raw as never,
      new URL('http://127.0.0.1/api/plugins/configuration'),
      transport,
    );
    expect(configuration.state).toEqual({ statusCode: 200, body: { outcome: 'configured' } });
    expect(transport.configuration).toHaveBeenCalledWith({ runtime: 'openclaw', pluginId: 'calendar', enabled: true });

    const operation = response();
    await handlePluginsRoutes(
      incoming({ runtime: 'openclaw', operation: 'install', pluginId: 'calendar' }, 'POST') as never,
      operation.raw as never,
      new URL('http://127.0.0.1/api/plugins/operation'),
      transport,
    );
    expect(operation.state).toEqual({ statusCode: 200, body: { outcome: 'configured' } });
    expect(transport.operation).toHaveBeenCalledWith({ runtime: 'openclaw', operation: 'install', pluginId: 'calendar' });
  });

  it('rejects a non-empty runtime request body with the invalid error', async () => {
    const transport = {
      catalog: vi.fn(),
      runtime: vi.fn(),
      configuration: vi.fn(),
      operation: vi.fn(),
    };
    const runtime = response();

    await handlePluginsRoutes(
      incoming({ runtime: 'openclaw' }, 'GET') as never,
      runtime.raw as never,
      new URL('http://127.0.0.1/api/plugins/runtime'),
      transport,
    );

    expect(runtime.state).toEqual({
      statusCode: 400,
      body: { success: false, error: 'Plugin runtime request is invalid' },
    });
    expect(transport.runtime).not.toHaveBeenCalled();
  });

  it('passes through the closed catalog DTO fields', async () => {
    const transport = {
      catalog: vi.fn().mockResolvedValue({
        status: 200,
        body: {
          success: true,
          execution: { enabledPluginIds: ['calendar'] },
          plugins: [{
            runtime: 'openclaw',
            id: 'calendar',
            name: 'Calendar',
            version: '1.2.3',
            kind: 'third-party',
            platform: 'openclaw',
            enabled: true,
            installed: true,
            updateAvailable: false,
            companionSkillReady: true,
            description: 'Calendar integration',
            companionSkillSlugs: ['calendar-tools'],
          }],
        },
      }),
      runtime: vi.fn(),
      configuration: vi.fn(),
      operation: vi.fn(),
    };
    const catalog = response();

    await handlePluginsRoutes(
      incoming({}, 'GET') as never,
      catalog.raw as never,
      new URL('http://127.0.0.1/api/plugins/catalog'),
      transport,
    );

    expect(catalog.state).toEqual({
      statusCode: 200,
      body: {
        success: true,
        execution: { enabledPluginIds: ['calendar'] },
        plugins: [{
          runtime: 'openclaw',
          id: 'calendar',
          name: 'Calendar',
          version: '1.2.3',
          kind: 'third-party',
          platform: 'openclaw',
          enabled: true,
          installed: true,
          updateAvailable: false,
          companionSkillReady: true,
          description: 'Calendar integration',
          companionSkillSlugs: ['calendar-tools'],
        }],
      },
    });
  });

  it.each([
    ['missing lifecycle field', {
      runtime: 'openclaw', id: 'calendar', name: 'Calendar', version: '1.2.3', kind: 'third-party',
      platform: 'openclaw', enabled: true,
      installed: true, updateAvailable: false,
    }],
    ['unknown field', {
      runtime: 'openclaw', id: 'calendar', name: 'Calendar', version: '1.2.3', kind: 'third-party',
      platform: 'openclaw', enabled: true,
      installed: true, updateAvailable: false, companionSkillReady: true, privatePath: 'secret',
    }],
    ['non-string companion skill slug', {
      runtime: 'openclaw', id: 'calendar', name: 'Calendar', version: '1.2.3', kind: 'third-party',
      platform: 'openclaw', enabled: true,
      installed: true, updateAvailable: false, companionSkillReady: true, companionSkillSlugs: ['calendar-tools', 7],
    }],
  ])('maps %s catalog responses to safe unavailable', async (_caseName, plugin) => {
    const transport = {
      catalog: vi.fn().mockResolvedValue({ status: 200, body: { plugins: [plugin] } }),
      runtime: vi.fn(),
      configuration: vi.fn(),
      operation: vi.fn(),
    };
    const catalog = response();

    await handlePluginsRoutes(
      incoming({}, 'GET') as never,
      catalog.raw as never,
      new URL('http://127.0.0.1/api/plugins/catalog'),
      transport,
    );

    expect(catalog.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Plugin catalog is unavailable' },
    });
  });

  it.each([
    ['missing state', (body: Record<string, unknown>) => {
      const { state: _state, ...withoutState } = body;
      return withoutState;
    }],
    ['unknown state field', (body: Record<string, unknown>) => ({
      ...body,
      state: { ...(body.state as Record<string, unknown>), nativeDetail: 'private' },
    })],
    ['invalid lifecycle', (body: Record<string, unknown>) => ({
      ...body,
      state: { ...(body.state as Record<string, unknown>), lifecycle: 'private' },
    })],
    ['negative active count', (body: Record<string, unknown>) => ({
      ...body,
      state: { ...(body.state as Record<string, unknown>), activePluginCount: -1 },
    })],
    ['malformed degraded plugins', (body: Record<string, unknown>) => ({
      ...body,
      health: { ...(body.health as Record<string, unknown>), degradedPlugins: [{ id: 'private' }] },
    })],
  ] as const)('maps %s runtime responses to safe unavailable', async (_caseName, transform) => {
    const body = {
      success: true,
      state: { lifecycle: 'running', runtimeLifecycle: 'running', activePluginCount: 0, enabledPluginIds: [] },
      health: { ok: true, lifecycle: 'running', activePluginCount: 0, degradedPlugins: [] },
      execution: { enabledPluginIds: [] },
    };
    const transport = {
      catalog: vi.fn(),
      runtime: vi.fn().mockResolvedValue({ status: 200, body: transform(body) }),
      configuration: vi.fn(),
      operation: vi.fn(),
    };
    const runtime = response();

    await handlePluginsRoutes(
      incoming({}, 'GET') as never,
      runtime.raw as never,
      new URL('http://127.0.0.1/api/plugins/runtime'),
      transport,
    );

    expect(runtime.state).toEqual({
      statusCode: 503,
      body: { success: false, error: 'Plugin runtime is unavailable' },
    });
  });

  it('rejects extra fields and does not claim non-fixed methods or paths', async () => {
    const transport = {
      catalog: vi.fn(),
      runtime: vi.fn(),
      configuration: vi.fn(),
      operation: vi.fn(),
    };
    const invalid = response();
    await handlePluginsRoutes(
      incoming({ runtime: 'openclaw', pluginId: 'calendar', enabled: true, manifest: { path: 'private' } }, 'POST') as never,
      invalid.raw as never,
      new URL('http://127.0.0.1/api/plugins/configuration'),
      transport,
    );
    expect(invalid.state).toEqual({ statusCode: 400, body: { outcome: 'unknown' } });
    expect(transport.configuration).not.toHaveBeenCalled();

    for (const [path, method] of [
      ['/api/plugins/catalog', 'POST'],
      ['/api/plugins/runtime', 'POST'],
      ['/api/plugins/configuration', 'GET'],
      ['/api/plugins/operation', 'GET'],
      ['/api/plugins/catalog/extra', 'GET'],
    ] as const) {
      await expect(handlePluginsRoutes(
        incoming({}, method) as never,
        response().raw as never,
        new URL(`http://127.0.0.1${path}`),
        transport,
      )).resolves.toBe(false);
    }
  });

  it('redacts malformed transport responses and native failures', async () => {
    const transport = {
      catalog: vi.fn().mockResolvedValue({ status: 200, body: { plugins: [{ id: 'x', name: 'X', enabled: true, path: 'private' }] } }),
      runtime: vi.fn().mockRejectedValue(new Error('native detail')),
      configuration: vi.fn().mockResolvedValue({ outcome: 'private-native-detail' }),
      operation: vi.fn().mockResolvedValue({ outcome: 'private-native-detail' }),
    };
    const catalog = response();
    await handlePluginsRoutes(incoming({}, 'GET') as never, catalog.raw as never, new URL('http://127.0.0.1/api/plugins/catalog'), transport);
    expect(catalog.state).toEqual({ statusCode: 503, body: { success: false, error: 'Plugin catalog is unavailable' } });

    const runtime = response();
    await handlePluginsRoutes(incoming({}, 'GET') as never, runtime.raw as never, new URL('http://127.0.0.1/api/plugins/runtime'), transport);
    expect(runtime.state).toEqual({ statusCode: 503, body: { success: false, error: 'Plugin runtime is unavailable' } });

    const configuration = response();
    await handlePluginsRoutes(incoming({ runtime: 'openclaw', pluginId: 'x', enabled: false }, 'POST') as never, configuration.raw as never, new URL('http://127.0.0.1/api/plugins/configuration'), transport);
    expect(configuration.state).toEqual({ statusCode: 503, body: { outcome: 'unknown' } });

    const operation = response();
    await handlePluginsRoutes(incoming({ runtime: 'openclaw', operation: 'update', pluginId: 'x' }, 'POST') as never, operation.raw as never, new URL('http://127.0.0.1/api/plugins/operation'), transport);
    expect(operation.state).toEqual({ statusCode: 503, body: { outcome: 'unknown' } });
  });
});
