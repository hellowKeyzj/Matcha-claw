import { describe, expect, it, vi } from 'vitest';

import { createRuntimeHostDeliveryIssuer } from '../../electron/main/runtime-host-delivery/bootstrap';
import { createPluginsTransport } from '../../electron/main/runtime-host-delivery/transport/plugins';

const catalog = {
  success: true,
  execution: { enabledPluginIds: ['plugin-a'] },
  plugins: [{
    runtime: 'openclaw',
    id: 'plugin-a',
    name: 'Plugin A',
    version: '1.0.0',
    kind: 'builtin',
    platform: 'openclaw',
    enabled: true,
    installed: true,
    updateAvailable: false,
    companionSkillReady: true,
    description: 'Plugin description',
    companionSkillSlugs: ['plugin-a-skill'],
  }],
};

const runtime = {
  success: true,
  state: {
    lifecycle: 'running',
    runtimeLifecycle: 'running',
    activePluginCount: 1,
    enabledPluginIds: ['plugin-a'],
  },
  health: {
    ok: true,
    lifecycle: 'running',
    activePluginCount: 1,
    degradedPlugins: [],
  },
  execution: { enabledPluginIds: ['plugin-a'] },
};

function decisionFrom(fetcher: ReturnType<typeof vi.fn>, call = 0): Record<string, unknown> {
  const authorization = fetcher.mock.calls[call]?.[1]?.headers.Authorization as string;
  const payload = authorization.slice('Bearer capability-decision.v1.'.length).split('.')[0];
  return JSON.parse(Buffer.from(payload, 'base64url').toString());
}

describe('plugin loopback transport', () => {
  it('uses fixed catalog and runtime paths with thirty-second decisions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00.000Z'));
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => catalog })
      .mockResolvedValueOnce({ status: 200, json: async () => runtime });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.catalog()).resolves.toEqual({ status: 200, body: catalog });
    expect(fetcher).toHaveBeenNthCalledWith(1, 'http://127.0.0.1:3227/api/plugins/catalog', expect.objectContaining({ method: 'GET' }));
    expect(decisionFrom(fetcher)).toMatchObject({
      endpoint: '/api/plugins/catalog', scope: 'plugins:read', capability: 'plugins.catalog.read',
      subject: 'plugin-catalog', expiresAt: Date.now() + 30_000,
    });

    await expect(transport.runtime()).resolves.toEqual({ status: 200, body: runtime });
    expect(fetcher).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:3227/api/plugins/runtime', expect.objectContaining({ method: 'GET' }));
    expect(decisionFrom(fetcher, 1)).toMatchObject({
      endpoint: '/api/plugins/runtime', scope: 'plugins:read', capability: 'plugins.runtime.read',
      subject: 'plugin-runtime', expiresAt: Date.now() + 30_000,
    });
    vi.useRealTimers();
  });

  it('accepts the lifecycle fields and optional catalog text fields', async () => {
    const { description: _description, companionSkillSlugs: _companionSkillSlugs, ...catalogItemWithoutOptionalFields } = catalog.plugins[0];
    const body = {
      success: true,
      execution: { enabledPluginIds: ['plugin-a'] },
      plugins: [catalogItemWithoutOptionalFields],
    };
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => body });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.catalog()).resolves.toEqual({ status: 200, body });
  });

  it.each([
    ['missing success', (() => { const { success: _success, ...body } = catalog; return body; })],
    ['missing execution', (() => { const { execution: _execution, ...body } = catalog; return body; })],
    ['unknown top-level field', () => ({ ...catalog, nativeDetail: 'private' })],
  ] as const)('rejects catalog envelope with %s', async (_caseName, transform) => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => transform() });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.catalog()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Plugin catalog is unavailable' },
    });
  });

  it.each([
    ['missing state', (() => { const { state: _state, ...body } = runtime; return body; })],
    ['unknown top-level field', () => ({ ...runtime, nativeDetail: 'private' })],
    ['unknown state field', () => ({ ...runtime, state: { ...runtime.state, nativeDetail: 'private' } })],
    ['invalid lifecycle', () => ({ ...runtime, state: { ...runtime.state, lifecycle: 'private' } })],
    ['negative active count', () => ({ ...runtime, state: { ...runtime.state, activePluginCount: -1 } })],
    ['malformed degraded plugins', () => ({ ...runtime, health: { ...runtime.health, degradedPlugins: [{ id: 'private' }] } })],
    ['null health error', () => ({ ...runtime, health: { ...runtime.health, error: null } })],
  ] as const)('rejects runtime envelope with %s', async (_caseName, transform) => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => transform() });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.runtime()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Plugin runtime is unavailable' },
    });
  });

  it.each([
    ['missing installed', ({ installed: _installed, ...item }) => item],
    ['missing updateAvailable', ({ updateAvailable: _updateAvailable, ...item }) => item],
    ['missing companionSkillReady', ({ companionSkillReady: _companionSkillReady, ...item }) => item],
    ['unknown field', (item) => ({ ...item, nativeDetail: 'private' })],
    ['invalid boolean', (item) => ({ ...item, installed: 'yes' })],
    ['invalid string', (item) => ({ ...item, name: 7 })],
    ['invalid array', (item) => ({ ...item, companionSkillSlugs: 'plugin-a-skill' })],
    ['invalid companion skill identity', (item) => ({ ...item, companionSkillSlugs: [''] })],
  ] as const)('rejects catalog item with %s', async (_caseName, transform) => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: async () => ({
        success: true,
        execution: { enabledPluginIds: ['plugin-a'] },
        plugins: [transform(catalog.plugins[0])],
      }),
    });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.catalog()).resolves.toEqual({
      status: 503,
      body: { success: false, error: 'Plugin catalog is unavailable' },
    });
  });

  it('posts only the closed configuration input to its fixed path', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'configured' }) });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.configuration({ runtime: 'openclaw', pluginId: 'plugin-a', enabled: true })).resolves.toEqual({ outcome: 'configured' });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3227/api/plugins/configuration', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ runtime: 'openclaw', pluginId: 'plugin-a', enabled: true }),
    }));
    expect(decisionFrom(fetcher)).toMatchObject({
      endpoint: '/api/plugins/configuration', scope: 'plugins:write',
      capability: 'plugins.configuration', subject: 'plugin-configuration',
    });
  });

  it('posts plugin operations with the dedicated delivery contract', async () => {
    const fetcher = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ outcome: 'configured' }) });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.operation({ runtime: 'openclaw', operation: 'install', pluginId: 'plugin-a' }))
      .resolves.toEqual({ outcome: 'configured' });
    expect(fetcher).toHaveBeenCalledWith('http://127.0.0.1:3227/api/plugins/operation', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ runtime: 'openclaw', operation: 'install', pluginId: 'plugin-a' }),
    }));
    expect(decisionFrom(fetcher)).toMatchObject({
      endpoint: '/api/plugins/operation', scope: 'plugins:write',
      capability: 'plugins:operation', subject: 'plugin-operation',
    });
  });

  it('does not send invalid plugin operation input and redacts transport failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('native detail'));
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.operation({ runtime: 'openclaw', operation: 'install', pluginId: 'x', path: 'private' }))
      .resolves.toEqual({ outcome: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(transport.operation({ runtime: 'openclaw', operation: 'update', pluginId: 'x' }))
      .resolves.toEqual({ outcome: 'unknown' });
  });

  it('does not send invalid configuration input', async () => {
    const fetcher = vi.fn();
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.configuration({ pluginId: 'plugin-a', enabled: true, manifest: { native: 'detail' } })).resolves.toEqual({ outcome: 'unknown' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('redacts unknown native fields and raw details into safe outcomes', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ...catalog, nativeDetail: 'private' }) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ...runtime, nativeDetail: 'private' }) })
      .mockResolvedValueOnce({ status: 500, json: async () => ({ error: 'native plugin failure', detail: 'private raw detail' }) });
    const transport = createPluginsTransport(createRuntimeHostDeliveryIssuer(), 3227, fetcher);

    await expect(transport.catalog()).resolves.toEqual({ status: 503, body: { success: false, error: 'Plugin catalog is unavailable' } });
    await expect(transport.runtime()).resolves.toEqual({ status: 503, body: { success: false, error: 'Plugin runtime is unavailable' } });
    await expect(transport.configuration({ runtime: 'openclaw', pluginId: 'plugin-a', enabled: true })).resolves.toEqual({ outcome: 'unknown' });
  });
});
