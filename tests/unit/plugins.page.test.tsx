import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';

const hostApiFetchMock = vi.fn();
const capabilityExecuteMock = vi.fn();
const waitForRuntimeJobResultMock = vi.fn();
const initGatewayEventsMock = vi.fn(async () => {});

function capabilityScope() {
  return {
    kind: 'runtime-instance' as const,
    endpoint: {
      kind: 'native-runtime' as const,
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    },
  };
}

const pluginRuntimeScope = capabilityScope();

type RuntimeHostState = {
  lifecycle: 'unknown' | 'starting' | 'running' | 'restarting' | 'degraded' | 'error' | 'stopped';
  error?: string;
  restartCount: number;
  lastRestartAt?: number;
};

const gatewayStoreState: {
  runtimeHost: RuntimeHostState;
  init: typeof initGatewayEventsMock;
} = {
  runtimeHost: {
    lifecycle: 'unknown',
    restartCount: 0,
  },
  init: initGatewayEventsMock,
};

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: async (path: string, init?: { body?: string; timeoutMs?: number }) => {
    if (path === '/api/capabilities/execute') {
      const payload = init?.body ? JSON.parse(init.body) : {};
      return await capabilityExecuteMock(payload, { timeoutMs: init?.timeoutMs });
    }
    return init === undefined ? await hostApiFetchMock(path) : await hostApiFetchMock(path, init);
  },
  resolveSingleCapabilityScope: async () => capabilityScope(),
  waitForRuntimeJobResult: (...args: unknown[]) => waitForRuntimeJobResultMock(...args),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayStoreState) => unknown) => selector(gatewayStoreState),
}));

function buildRuntimePayload(params?: { enabledPluginIds?: string[] }) {
  const enabledPluginIds = params?.enabledPluginIds ?? ['plugin-a'];
  return {
    success: true,
    state: {
      lifecycle: 'running',
      runtimeLifecycle: 'running',
      activePluginCount: enabledPluginIds.length,
      enabledPluginIds,
    },
    health: {
      ok: true,
      lifecycle: 'running',
      activePluginCount: enabledPluginIds.length,
      degradedPlugins: [],
    },
    execution: {
      enabledPluginIds,
    },
  };
}

function buildCatalogPlugin(index: number) {
  return {
    id: `plugin-${index}`,
    name: `Plugin ${index}`,
    version: `1.0.${index}`,
    kind: 'builtin' as const,
    platform: 'matchaclaw' as const,
    category: 'runtime',
    group: 'model' as const,
    enabled: index === 1,
  };
}

describe('plugins page', () => {
  beforeEach(async () => {
    vi.resetModules();
    i18n.changeLanguage('en');
    vi.clearAllMocks();
    gatewayStoreState.runtimeHost = {
      lifecycle: 'unknown',
      restartCount: 0,
    };
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/capabilities/list') {
        return {
          capabilities: [
            {
              id: 'plugin.runtime',
              kind: 'plugin.runtime',
              scopeKind: 'runtime-instance',
              scope: pluginRuntimeScope,
              targetKinds: ['plugin'],
              supportLevel: 'native',
              availability: 'available',
              operations: [{ id: 'plugins.setEnabled', title: 'Set enabled plugins', targetKind: 'plugin' }],
              policyScope: 'plugin.runtime',
              ownerModuleId: 'openclaw',
              routeOwnerId: 'plugin',
            },
          ],
        };
      }
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload();
      }
      if (path === '/api/plugins/catalog') {
        return {
          success: true,
          execution: {
            enabledPluginIds: ['plugin-a'],
          },
          plugins: [
            {
              id: 'plugin-a',
              name: 'Plugin A',
              version: '1.0.0',
              kind: 'builtin',
              platform: 'matchaclaw',
              category: 'runtime',
              group: 'model',
              enabled: true,
            },
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    const { usePluginsStore } = await import('@/stores/plugins-store');
    usePluginsStore.setState({
      runtime: null,
      catalog: [],
      runtimeReady: false,
      catalogReady: false,
      runtimePending: false,
      catalogPending: false,
      refreshing: false,
      refreshReason: null,
      mutating: false,
      mutatingAction: null,
      mutatingPluginId: null,
      error: null,
    });
  });

  it('先显示 runtime，再等 catalog 到达后渲染插件列表', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    gatewayStoreState.runtimeHost = {
      lifecycle: 'starting',
      restartCount: 0,
    };

    let resolveCatalog: ((value: unknown) => void) | null = null;
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload();
      }
      if (path === '/api/plugins/catalog') {
        return await new Promise((resolve) => {
          resolveCatalog = resolve;
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Host starting')).toBeInTheDocument();
    expect(screen.queryByText('Plugin A')).not.toBeInTheDocument();

    resolveCatalog?.({
      success: true,
      execution: {
        enabledPluginIds: ['plugin-a'],
      },
      plugins: [
        {
          id: 'plugin-a',
          name: 'Plugin A',
          version: '1.0.0',
          kind: 'builtin',
          platform: 'matchaclaw',
          category: 'runtime',
          group: 'model',
          enabled: true,
        },
      ],
    });

    expect(await screen.findByText('Plugin A')).toBeInTheDocument();
    expect(initGatewayEventsMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/runtime');
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/catalog');
    });
  });

  it('显示降级状态与 runtime-host 错误信息', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    gatewayStoreState.runtimeHost = {
      lifecycle: 'degraded',
      restartCount: 0,
      error: 'runtime-host health check failed',
    };

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Host degraded')).toBeInTheDocument();
    expect(screen.getByText('runtime-host health check failed')).toBeInTheDocument();
  });

  it('重启过程中不展示临时 runtime-host transport 错误', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    gatewayStoreState.runtimeHost = {
      lifecycle: 'restarting',
      restartCount: 0,
      error: 'Runtime-host transport health failed: fetch failed',
    };

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Host restarting')).toBeInTheDocument();
    expect(screen.queryByText('Runtime-host transport health failed: fetch failed')).not.toBeInTheDocument();
  });

  it('插件中心直接展示后端返回的可管理能力插件，不再按渠道/模型分组', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload({ enabledPluginIds: ['plugin-model'] });
      }
      if (path === '/api/plugins/catalog') {
        return {
          success: true,
          execution: {
            enabledPluginIds: ['plugin-model'],
          },
          plugins: [
            {
              id: 'plugin-model',
              name: 'Model Plugin',
              version: '1.0.1',
              kind: 'builtin',
              platform: 'matchaclaw',
              category: 'runtime',
              group: 'model',
              enabled: false,
            },
            {
              id: 'plugin-general',
              name: 'General Plugin',
              version: '1.0.2',
              kind: 'third-party',
              platform: 'matchaclaw',
              category: 'tools',
              group: 'general',
              enabled: false,
            },
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Model Plugin')).toBeInTheDocument();
    expect(screen.getByText('General Plugin')).toBeInTheDocument();
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  });

  it('catalog 到达后直接渲染真实插件列表，不再额外等待 idle shell', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    const plugins = Array.from({ length: 13 }, (_, index) => buildCatalogPlugin(index + 1));

    let resolveCatalog: ((value: unknown) => void) | null = null;
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload({ enabledPluginIds: ['plugin-1'] });
      }
      if (path === '/api/plugins/catalog') {
        return await new Promise((resolve) => {
          resolveCatalog = resolve;
        });
      }
      throw new Error(`unexpected path: ${path}`);
    });

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findAllByText('Host running')).toHaveLength(2);

    await act(async () => {
      resolveCatalog?.({
        success: true,
        execution: {
          enabledPluginIds: ['plugin-1'],
        },
        plugins,
      });
      await Promise.resolve();
    });

    expect(screen.getByText('Plugin 13')).toBeInTheDocument();
  });

  it('runtime lifecycle badge 使用正式文案，不回退原始状态键', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findAllByText('Host running')).toHaveLength(2);
    expect(screen.getByText('Runtime running')).toBeInTheDocument();
    expect(screen.queryByText('host:running')).not.toBeInTheDocument();
    expect(screen.queryByText('runtime:running')).not.toBeInTheDocument();
  });

  it('切换插件时只提交 catalog 中的能力插件 ID，不带回渠道或 bundled 运行态 ID', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/capabilities/list') {
        return {
          capabilities: [
            {
              id: 'plugin.runtime',
              kind: 'plugin.runtime',
              scopeKind: 'runtime-instance',
              scope: pluginRuntimeScope,
              targetKinds: ['plugin'],
              supportLevel: 'native',
              availability: 'available',
              operations: [{ id: 'plugins.setEnabled', title: 'Set enabled plugins', targetKind: 'plugin' }],
              policyScope: 'plugin.runtime',
              ownerModuleId: 'openclaw',
              routeOwnerId: 'plugin',
            },
          ],
        };
      }
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload({ enabledPluginIds: ['openclaw-lark', 'browser', 'task-manager'] });
      }
      if (path === '/api/plugins/catalog') {
        return {
          success: true,
          execution: {
            enabledPluginIds: ['task-manager'],
          },
          plugins: [
            {
              id: 'task-manager',
              name: 'Task Manager',
              version: '1.0.0',
              kind: 'builtin',
              platform: 'openclaw',
              category: 'runtime',
              group: 'general',
              enabled: true,
            },
            {
              id: 'memory-lancedb-pro',
              name: 'Memory',
              version: '1.0.0',
              kind: 'builtin',
              platform: 'openclaw',
              category: 'runtime',
              group: 'general',
              enabled: false,
            },
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
    capabilityExecuteMock.mockResolvedValue({
      success: true,
      job: {
        id: 'job-plugins-set-enabled',
        type: 'plugins.setEnabled',
        status: 'queued',
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    });
    waitForRuntimeJobResultMock.mockResolvedValue(buildRuntimePayload({ enabledPluginIds: ['memory-lancedb-pro'] }));

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Memory')).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    await waitFor(() => {
      expect(switches[switches.length - 1]!).toBeEnabled();
    });
    fireEvent.click(switches[switches.length - 1]!);

    await waitFor(() => {
      expect(capabilityExecuteMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'plugin.runtime',
          operationId: 'plugins.setEnabled',
          scope: pluginRuntimeScope,
          target: { kind: 'plugin', pluginId: 'memory-lancedb-pro' },
          input: expect.objectContaining({
            pluginIds: ['memory-lancedb-pro'],
          }),
        }),
        { timeoutMs: undefined },
      );
    });
  });
});
