import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '@/i18n';

const hostApiFetchMock = vi.fn();
const initGatewayEventsMock = vi.fn(async () => {});

type RuntimeHostState = {
  lifecycle: 'unknown' | 'starting' | 'running' | 'degraded' | 'error' | 'stopped';
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
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
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
      runtimeLifecycle: 'ready',
      activePluginCount: enabledPluginIds.length,
      enabledPluginIds,
    },
    health: {
      ok: true,
      lifecycle: 'ready',
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

  it('按正式 group 分页签，只显示当前分类的插件', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload({ enabledPluginIds: ['plugin-channel'] });
      }
      if (path === '/api/plugins/catalog') {
        return {
          success: true,
          execution: {
            enabledPluginIds: ['plugin-channel'],
          },
          plugins: [
            {
              id: 'plugin-channel',
              name: 'Channel Plugin',
              version: '1.0.0',
              kind: 'builtin',
              platform: 'openclaw',
              category: 'channel',
              group: 'channel',
              enabled: true,
              controlMode: 'channel-config',
            },
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

    expect(await screen.findByText('Channel Plugin')).toBeInTheDocument();
    expect(screen.queryByText('Model Plugin')).not.toBeInTheDocument();
    expect(screen.queryByText('General Plugin')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Models (1)' }));
    expect(await screen.findByText('Model Plugin')).toBeInTheDocument();
    expect(screen.queryByText('Channel Plugin')).not.toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'General (1)' }));
    expect(await screen.findByText('General Plugin')).toBeInTheDocument();
    expect(screen.queryByText('Model Plugin')).not.toBeInTheDocument();
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
    expect(screen.getByText('Runtime ready')).toBeInTheDocument();
    expect(screen.queryByText('host:running')).not.toBeInTheDocument();
    expect(screen.queryByText('runtime:ready')).not.toBeInTheDocument();
  });

  it('渠道托管插件在插件中心显示为只读', async () => {
    const { PluginsPage } = await import('@/pages/Plugins');
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return buildRuntimePayload({ enabledPluginIds: ['openclaw-lark'] });
      }
      if (path === '/api/plugins/catalog') {
        return {
          success: true,
          execution: {
            enabledPluginIds: ['openclaw-lark'],
          },
          plugins: [
            {
              id: 'openclaw-lark',
              name: 'OpenClaw Lark',
              version: '1.0.0',
              kind: 'builtin',
              platform: 'openclaw',
              category: 'channel',
              group: 'channel',
              enabled: true,
              controlMode: 'channel-config',
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

    expect(await screen.findByText('Managed by channel configuration')).toBeInTheDocument();
    const switches = screen.getAllByRole('switch');
    expect(switches[switches.length - 1]).toBeDisabled();
  });
});
