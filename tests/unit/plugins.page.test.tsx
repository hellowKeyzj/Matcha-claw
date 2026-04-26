import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
      pluginExecutionEnabled: true,
      enabledPluginIds,
    },
    health: {
      ok: true,
      lifecycle: 'ready',
      activePluginCount: enabledPluginIds.length,
      degradedPlugins: [],
    },
    execution: {
      pluginExecutionEnabled: true,
      enabledPluginIds,
    },
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
            pluginExecutionEnabled: true,
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
        pluginExecutionEnabled: true,
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
            pluginExecutionEnabled: true,
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
