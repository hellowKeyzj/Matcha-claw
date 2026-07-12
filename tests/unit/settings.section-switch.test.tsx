import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '@/pages/Settings';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { useUpdateStore } from '@/stores/update';
import i18n from '@/i18n';

vi.mock('@/components/settings/UpdateSettings', () => ({
  UpdateSettings: () => <div data-testid="update-settings-panel">mock-updates</div>,
}));

const hostApiFetchMock = vi.hoisted(() => vi.fn(async (path: string, init?: RequestInit) => {
  if (path === '/api/matcha-agent/app-server/restart' && init?.method === 'POST') {
    return { success: true };
  }
  if (path === '/api/license/gate') {
    return {
      state: 'blocked',
      reason: 'empty',
      checkedAtMs: Date.now(),
      hasStoredKey: false,
      hasUsableCache: false,
      nextRevalidateAtMs: null,
      lastValidation: null,
      renewalAlert: null,
    };
  }
  if (path === '/api/license/stored-key') {
    return { key: null };
  }
  if (path === '/api/gateway/status') {
    return {
      processState: 'running',
      port: 18789,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
      },
      updatedAt: 1,
    };
  }
  if (path === '/api/plugins/runtime') {
    return {
      success: true,
      state: {
        lifecycle: 'running',
        runtimeLifecycle: 'running',
        activePluginCount: 0,
        enabledPluginIds: [],
      },
      health: {
        ok: true,
        lifecycle: 'running',
        activePluginCount: 0,
        degradedPlugins: [],
      },
      execution: {
        enabledPluginIds: [],
      },
    };
  }
  if (path === '/api/matcha-agent/app-server/status') {
    return {
      processState: 'running',
      port: 31987,
      pid: 4321,
      ready: true,
      lastError: null,
      updatedAt: 1,
    };
  }
  throw new Error(`unhandled hostApiFetch path: ${path}`);
}));

vi.mock('@/lib/host-api', () => ({
  hostCapabilityExecute: vi.fn().mockResolvedValue(undefined),
  resolveSingleCapabilityScope: vi.fn().mockResolvedValue({ kind: 'app' }),
  hostApiFetch: hostApiFetchMock,
}));

describe('settings page section switch', () => {
  const renderWithRouter = (entry = '/settings?section=gateway') => render(
    <MemoryRouter initialEntries={[entry]}>
      <Settings />
    </MemoryRouter>,
  );

  beforeEach(() => {
    hostApiFetchMock.mockClear();
    i18n.changeLanguage('en');

    useSettingsStore.setState((state) => ({
      ...state,
      theme: 'system',
      language: 'en',
      gatewayAutoStart: true,
      proxyEnabled: false,
      proxyServer: '',
      proxyBypassRules: '<local>;localhost;127.0.0.1;::1',
      autoCheckUpdate: true,
      devModeUnlocked: false,
      setupComplete: true,
      userAvatarDataUrl: null,
      initialized: true,
    }));

    useGatewayStore.setState((state) => ({
      ...state,
      status: {
        processState: 'running',
        port: 18789,
        gatewayReady: true,
        healthSummary: 'healthy',
        transportState: 'connected',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 1,
      },
    }));

    useUpdateStore.setState((state) => ({
      ...state,
      currentVersion: '0.1.23',
    }));
  });

  it('左侧分栏切换后仅显示当前分类内容', async () => {
    await act(async () => {
      renderWithRouter('/settings?section=gateway');
    });

    expect(screen.getByRole('button', { name: 'Runtime Status' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'General' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI Providers' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Task Plugin' })).not.toBeInTheDocument();

    expect(screen.getByText('OpenClaw Status')).toBeInTheDocument();
    const matchaAgentTitle = await screen.findByText('matcha-agent app-server Status');
    const matchaAgentPanel = matchaAgentTitle.closest('.space-y-3');
    expect(matchaAgentPanel).not.toBeNull();
    expect(within(matchaAgentPanel as HTMLElement).getByText('running')).toBeInTheDocument();
    expect(within(matchaAgentPanel as HTMLElement).getByText('Port: 31987')).toBeInTheDocument();
    expect(within(matchaAgentPanel as HTMLElement).getByRole('button', { name: 'Refresh' })).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(matchaAgentPanel as HTMLElement).getByRole('button', { name: 'Restart' }));
    });

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/matcha-agent/app-server/restart', { method: 'POST' });
    });
    expect(hostApiFetchMock.mock.calls.filter(([path]) => path === '/api/matcha-agent/app-server/status')).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Updates' }));
    });
    expect(screen.getByTestId('update-settings-panel')).toBeInTheDocument();
    expect(screen.queryByText('OpenClaw Status')).not.toBeInTheDocument();
  });

  it('后发的 app-server status 请求拥有最终状态，旧响应不会覆盖', async () => {
    const defaultHostApiFetchImplementation = hostApiFetchMock.getMockImplementation();
    const statusRequests: Array<{
      promise: Promise<unknown>;
      resolve: (status: unknown) => void;
      reject: (error: unknown) => void;
    }> = [];

    hostApiFetchMock.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/matcha-agent/app-server/status') {
        let resolveStatus!: (status: unknown) => void;
        let rejectStatus!: (error: unknown) => void;
        const promise = new Promise<unknown>((resolve, reject) => {
          resolveStatus = resolve;
          rejectStatus = reject;
        });
        statusRequests.push({ promise, resolve: resolveStatus, reject: rejectStatus });
        return promise;
      }
      if (!defaultHostApiFetchImplementation) {
        throw new Error(`missing default hostApiFetch implementation for path: ${path}`);
      }
      return defaultHostApiFetchImplementation(path, init);
    });

    try {
      await act(async () => {
        renderWithRouter('/settings?section=gateway');
      });
      await waitFor(() => {
        expect(statusRequests).toHaveLength(1);
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'General' }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Runtime Status' }));
      });
      await waitFor(() => {
        expect(statusRequests).toHaveLength(2);
      });

      await act(async () => {
        statusRequests[1].resolve({
          processState: 'running',
          port: 32999,
          pid: 9876,
          ready: true,
          lastError: null,
          updatedAt: 2,
        });
        await statusRequests[1].promise;
      });

      const matchaAgentTitle = await screen.findByText('matcha-agent app-server Status');
      const matchaAgentPanel = matchaAgentTitle.closest('.space-y-3');
      expect(matchaAgentPanel).not.toBeNull();
      expect(within(matchaAgentPanel as HTMLElement).getByText('Port: 32999')).toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).getByText('PID: 9876')).toBeInTheDocument();

      await act(async () => {
        statusRequests[0].resolve({
          processState: 'stopping',
          port: 31987,
          pid: 4321,
          ready: false,
          lastError: 'stale status',
          updatedAt: 1,
        });
        await statusRequests[0].promise;
      });

      expect(within(matchaAgentPanel as HTMLElement).getByText('running')).toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).getByText('Port: 32999')).toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).getByText('PID: 9876')).toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).queryByText('stopping')).not.toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).queryByText('Port: 31987')).not.toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).queryByText('stale status')).not.toBeInTheDocument();
    } finally {
      if (defaultHostApiFetchImplementation) {
        hostApiFetchMock.mockImplementation(defaultHostApiFetchImplementation);
      }
    }
  });

  it('URL section=license 时默认落在授权分栏', async () => {
    await act(async () => {
      renderWithRouter('/settings?section=license');
    });

    expect(screen.getByRole('heading', { name: 'License' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Validate License' })).toBeInTheDocument();
  });

  it('旧的 aiProviders 分栏链接会回退到默认分栏', async () => {
    await act(async () => {
      renderWithRouter('/settings?section=aiProviders');
    });

    expect(screen.getByRole('button', { name: 'Runtime Status' })).toBeInTheDocument();
    expect(screen.getByText('OpenClaw Status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI Providers' })).not.toBeInTheDocument();
  });
});
