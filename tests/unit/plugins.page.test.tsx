import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PluginsPage } from '@/pages/Plugins';
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

describe('plugins page', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');
    vi.clearAllMocks();
    gatewayStoreState.runtimeHost = {
      lifecycle: 'unknown',
      restartCount: 0,
    };
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/plugins/runtime') {
        return {
          success: true,
          state: {
            lifecycle: 'running',
            runtimeLifecycle: 'ready',
            activePluginCount: 1,
            pluginExecutionEnabled: true,
            enabledPluginIds: ['plugin-a'],
          },
          health: {
            ok: true,
            lifecycle: 'ready',
            activePluginCount: 1,
            degradedPlugins: [],
          },
          execution: {
            pluginExecutionEnabled: true,
            enabledPluginIds: ['plugin-a'],
          },
        };
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
              category: 'runtime',
              enabled: true,
            },
          ],
        };
      }
      throw new Error(`unexpected path: ${path}`);
    });
  });

  it('显示启动中状态与恢复信息', async () => {
    gatewayStoreState.runtimeHost = {
      lifecycle: 'starting',
      restartCount: 2,
      lastRestartAt: Date.parse('2024-03-09T16:00:00.000Z'),
    };

    render(
      <MemoryRouter>
        <PluginsPage />
      </MemoryRouter>,
    );

    expect(await screen.findByText('Host starting')).toBeInTheDocument();
    expect(screen.getByText('Runtime Host auto-recovered 2 times')).toBeInTheDocument();
    expect(screen.getByText('Last recovered at: 2024-03-09 16:00:00Z')).toBeInTheDocument();
    expect(initGatewayEventsMock).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/runtime');
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/plugins/catalog');
    });
  });

  it('显示降级状态与 runtime-host 错误信息', async () => {
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
});

