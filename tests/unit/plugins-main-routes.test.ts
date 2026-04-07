import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const applyEnabledPluginIdsToOpenClawConfigMock = vi.fn(async (config: Record<string, unknown>, _pluginIds: readonly string[]) => config);
const readEnabledPluginIdsFromOpenClawConfigMock = vi.fn(() => ['plugin-a']);

vi.mock('../../electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('../../runtime-host/application/openclaw/openclaw-plugin-config-service', () => ({
  applyEnabledPluginIdsToOpenClawConfig: (...args: unknown[]) => applyEnabledPluginIdsToOpenClawConfigMock(...args),
  readEnabledPluginIdsFromOpenClawConfig: (...args: unknown[]) => readEnabledPluginIdsFromOpenClawConfigMock(...args),
}));

function createContext() {
  return {
    gatewayManager: {
      reload: vi.fn(async () => undefined),
    },
    runtimeHost: {
      refreshExecutionState: vi.fn(async () => ({
        pluginExecutionEnabled: true,
        enabledPluginIds: ['plugin-a'],
      })),
      getState: vi.fn(() => ({
        lifecycle: 'running',
        runtimeLifecycle: 'running',
        activePluginCount: 1,
        pluginExecutionEnabled: true,
        enabledPluginIds: ['plugin-a'],
      })),
      getExecutionState: vi.fn(() => ({
        pluginExecutionEnabled: true,
        enabledPluginIds: ['plugin-a'],
      })),
      checkHealth: vi.fn(async () => ({
        ok: true,
        lifecycle: 'running',
        activePluginCount: 1,
        degradedPlugins: [],
      })),
      listAvailablePlugins: vi.fn(async () => ([
        {
          id: 'plugin-a',
          name: 'Plugin A',
          version: '1.0.0',
          kind: 'builtin',
          platform: 'openclaw',
          category: 'runtime',
        },
        {
          id: 'plugin-b',
          name: 'Plugin B',
          version: '1.2.0',
          kind: 'third-party',
          platform: 'matchaclaw',
          category: 'workflow',
        },
      ])),
      setExecutionEnabled: vi.fn(async () => ({
        pluginExecutionEnabled: false,
        enabledPluginIds: [],
      })),
      setEnabledPluginIds: vi.fn(async () => ({
        pluginExecutionEnabled: true,
        enabledPluginIds: ['plugin-b'],
      })),
      request: vi.fn(async (method: string, route: string) => {
        if (method === 'GET' && route === '/api/platform/tools?includeDisabled=true') {
          return {
            status: 200,
            data: {
              success: true,
              tools: [
                {
                  id: 'tool-plugin-a',
                  name: 'Plugin A Runtime',
                  enabled: true,
                  source: 'plugin',
                  metadata: { pluginId: 'plugin-a' },
                },
              ],
            },
          };
        }
        if (method === 'POST' && route === '/api/gateway/rpc') {
          return {
            status: 200,
            data: {
              success: true,
              result: {
                hash: 'cfg-hash-1',
                config: {
                  plugins: {
                    allow: ['plugin-a'],
                    entries: {
                      'plugin-a': { enabled: true },
                    },
                  },
                },
              },
            },
          };
        }
        return {
          status: 200,
          data: { success: true, result: { ok: true } },
        };
      }),
      restart: vi.fn(async () => undefined),
    },
  };
}

describe('main plugins routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyEnabledPluginIdsToOpenClawConfigMock.mockReset();
    applyEnabledPluginIdsToOpenClawConfigMock.mockImplementation(async (config: Record<string, unknown>) => config);
    readEnabledPluginIdsFromOpenClawConfigMock.mockReset();
    readEnabledPluginIdsFromOpenClawConfigMock.mockReturnValue(['plugin-a']);
  });

  it('GET /api/plugins/runtime 由主进程直接返回 runtime 快照', async () => {
    const ctx = createContext();
    const { handlePluginRoutes } = await import('../../electron/api/routes/plugins');

    const handled = await handlePluginRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/runtime'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.runtimeHost.checkHealth).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      execution: {
        pluginExecutionEnabled: true,
        enabledPluginIds: ['plugin-a'],
      },
    }));
  });

  it('GET /api/plugins/catalog 对 openclaw 插件启用态优先使用 openclaw 配置，tools.catalog 只补充运行时信息', async () => {
    const ctx = createContext();
    const { handlePluginRoutes } = await import('../../electron/api/routes/plugins');

    const handled = await handlePluginRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/catalog'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.runtimeHost.listAvailablePlugins).toHaveBeenCalledTimes(1);
    expect(ctx.runtimeHost.request).toHaveBeenCalledWith('GET', '/api/platform/tools?includeDisabled=true');
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      plugins: [
        expect.objectContaining({ id: 'plugin-a', enabled: true }),
        expect.objectContaining({ id: 'plugin-b', enabled: false }),
      ],
    }));
  });

  it('GET /api/plugins/catalog 在 runtime-host 暂时不可用时返回空目录而不是抛错', async () => {
    const ctx = createContext();
    ctx.runtimeHost.listAvailablePlugins = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    ctx.runtimeHost.request = vi.fn(async () => {
      throw new Error('fetch failed');
    });
    readEnabledPluginIdsFromOpenClawConfigMock.mockReturnValue([]);
    const { handlePluginRoutes } = await import('../../electron/api/routes/plugins');

    const handled = await handlePluginRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/catalog'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      execution: {
        pluginExecutionEnabled: true,
        enabledPluginIds: [],
      },
      plugins: [],
    });
  });

  it('PUT /api/plugins/runtime/enabled-plugins 对 openclaw 插件写配置并 reload Gateway，对本地插件走 runtime-host 本地状态', async () => {
    const ctx = createContext();
    parseJsonBodyMock.mockResolvedValueOnce({
      pluginIds: ['plugin-b'],
    });
    readEnabledPluginIdsFromOpenClawConfigMock.mockReturnValue(['plugin-a']);
    ctx.runtimeHost.refreshExecutionState = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['plugin-b'],
    }));
    ctx.runtimeHost.getState = vi.fn(() => ({
      lifecycle: 'running',
      runtimeLifecycle: 'running',
      activePluginCount: 1,
      pluginExecutionEnabled: true,
      enabledPluginIds: ['plugin-b'],
    }));
    ctx.runtimeHost.getExecutionState = vi.fn(() => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['plugin-b'],
    }));

    const { handlePluginRoutes } = await import('../../electron/api/routes/plugins');
    const handled = await handlePluginRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/runtime/enabled-plugins'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.runtimeHost.setEnabledPluginIds).toHaveBeenCalledWith(['plugin-b']);
    expect(ctx.runtimeHost.request).toHaveBeenCalledWith('GET', '/api/platform/tools?includeDisabled=true');
    expect(applyEnabledPluginIdsToOpenClawConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.any(Object),
      }),
      [],
    );
    expect(ctx.gatewayManager.reload).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({
      success: true,
      execution: {
        pluginExecutionEnabled: true,
        enabledPluginIds: ['plugin-b', 'plugin-a'],
      },
    }));
  });

  it('PUT /api/plugins/runtime/enabled-plugins 启用 openclaw 插件时会写配置并 reload Gateway', async () => {
    const ctx = createContext();
    parseJsonBodyMock.mockResolvedValueOnce({
      pluginIds: ['plugin-a', 'plugin-b'],
    });
    ctx.runtimeHost.refreshExecutionState = vi.fn(async () => ({
      pluginExecutionEnabled: true,
      enabledPluginIds: ['plugin-b'],
    }));
    ctx.runtimeHost.request = vi.fn(async (method: string, route: string, payload?: unknown) => {
      if (method === 'GET' && route === '/api/platform/tools?includeDisabled=true') {
        return {
          status: 200,
          data: {
            success: true,
            tools: [
              {
                id: 'tool-plugin-a',
                name: 'Plugin A Runtime',
                enabled: false,
                source: 'plugin',
                metadata: { pluginId: 'plugin-a' },
              },
            ],
          },
        };
      }
      if (method === 'POST' && route === '/api/gateway/rpc') {
        const body = payload as { method?: string };
        if (body?.method === 'config.get') {
          return {
            status: 200,
            data: {
              success: true,
              result: {
                hash: 'cfg-hash-2',
                config: {
                  plugins: {
                    allow: ['plugin-b'],
                    entries: {
                      'plugin-b': { enabled: true },
                    },
                  },
                },
              },
            },
          };
        }
        return {
          status: 200,
          data: { success: true, result: { ok: true } },
        };
      }
      return {
        status: 200,
        data: { success: true, payload },
      };
    });

    const { handlePluginRoutes } = await import('../../electron/api/routes/plugins');
    const handled = await handlePluginRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/runtime/enabled-plugins'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(applyEnabledPluginIdsToOpenClawConfigMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.any(Object),
      }),
      ['plugin-a'],
    );
    expect(ctx.gatewayManager.reload).toHaveBeenCalledTimes(1);
    expect(ctx.runtimeHost.setEnabledPluginIds).toHaveBeenCalledWith(['plugin-b']);
  });

  it('PUT /api/plugins/runtime/execution 参数非法时返回 400', async () => {
    const ctx = createContext();
    parseJsonBodyMock.mockResolvedValueOnce({
      enabled: 'yes',
    });
    const { handlePluginRoutes } = await import('../../electron/api/routes/plugins');

    const handled = await handlePluginRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:3210/api/plugins/runtime/execution'),
      ctx as never,
    );

    expect(handled).toBe(true);
    expect(ctx.runtimeHost.setExecutionEnabled).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 400, {
      success: false,
      error: 'enabled must be a boolean',
    });
  });
});
