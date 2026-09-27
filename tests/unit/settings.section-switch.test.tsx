import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '@/pages/Settings';
import { useSettingsStore } from '@/stores/settings';
import { useRuntimeHostStore } from '@/stores/gateway';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { useUpdateStore } from '@/stores/update';
import i18n from '@/i18n';

vi.mock('@/components/settings/UpdateSettings', () => ({
  UpdateSettings: () => <div data-testid="update-settings-panel">mock-updates</div>,
}));

const hostApiFetchMock = vi.hoisted(() => vi.fn(async (path: string, init?: RequestInit) => {
  if (path === '/api/openclaw/lifecycle/restart' && init?.method === 'POST') {
    return {
      success: true,
      status: {
        processState: 'waitingToRestart',
      },
    };
  }
  if (path === '/api/openclaw/lifecycle/status') {
    return {
      processState: 'running',
    };
  }
  if (path === '/api/openclaw/runtime/snapshot') {
    return {
      state: { ok: true, lifecycle: 'ready', matcha: { lifecycle: 'idle' }, openClaw: { lifecycle: 'running' } },
      health: { ok: true, lifecycle: 'ready', matcha: { lifecycle: 'idle' }, openClaw: { lifecycle: 'running' } },
      gateway: { availability: 'available', ok: true, timestampMs: 1, durationMs: 2, channelCount: 1, agentCount: 1, sessionCount: 1, heartbeatEnabled: true },
      control: { ready: true, phase: 'ready', retryable: false },
      observedAtMs: 1,
    };
  }
  if (path.startsWith('/api/openclaw/logs')) {
    return {
      entries: [],
      cursor: 0,
      reset: false,
      truncated: false,
      lifecycleTailEvicted: false,
    };
  }
  if (
    (path === '/api/openclaw/lifecycle/start' || path === '/api/openclaw/lifecycle/stop')
    && init?.method === 'POST'
  ) {
    return { success: true, status: { processState: 'running' } };
  }
  if (path === '/api/matcha-agent/app-server/restart' && init?.method === 'POST') {
    return { success: true };
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

const hostRuntimeEndpointsListMock = vi.hoisted(() => vi.fn(async () => ({ endpoints: [] })));

vi.mock('@/lib/host-api', () => ({
  hostCapabilityExecute: vi.fn().mockResolvedValue(undefined),
  resolveSingleCapabilityScope: vi.fn().mockResolvedValue({ kind: 'app' }),
  hostApiFetch: hostApiFetchMock,
  hostOpenClawGetLifecycleStatus: () => hostApiFetchMock('/api/openclaw/lifecycle/status'),
  hostOpenClawGetRuntimeSnapshot: () => hostApiFetchMock('/api/openclaw/runtime/snapshot'),
  hostOpenClawGetLogs: (cursor?: number) => hostApiFetchMock(
    cursor === undefined ? '/api/openclaw/logs' : `/api/openclaw/logs?cursor=${cursor}`,
  ),
  hostOpenClawStart: () => hostApiFetchMock('/api/openclaw/lifecycle/start', { method: 'POST' }),
  hostOpenClawStop: () => hostApiFetchMock('/api/openclaw/lifecycle/stop', { method: 'POST' }),
  hostOpenClawRestart: () => hostApiFetchMock('/api/openclaw/lifecycle/restart', { method: 'POST' }),
  hostRuntimeEndpointsList: hostRuntimeEndpointsListMock,
}));

function runtimeStatusPanel(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const item = heading.closest('[role="listitem"]');
  expect(item).not.toBeNull();
  return item as HTMLElement;
}

function buildRuntimeEndpoint(runtimeAdapterId: 'openclaw' | 'matcha-agent') {
  return {
    id: `${runtimeAdapterId}-local`,
    protocolId: runtimeAdapterId,
    runtimeAdapterId,
    runtimeInstanceId: 'local',
    endpointRef: { kind: 'native-runtime', runtimeAdapterId, runtimeInstanceId: 'local' },
    source: { kind: 'runtime-adapter', runtimeAdapterId, runtimeInstanceId: 'local' },
    location: { kind: 'local' },
    lifecycle: { phase: 'ready', connected: true, ready: true, updatedAt: 1 },
    displayName: runtimeAdapterId,
    agentIds: ['main'],
    defaultAgentId: 'main',
    agents: [],
    acceptsDynamicAgents: true,
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      approvals: true,
      replay: true,
      modelSelection: true,
    },
    capabilityFamilies: [{ family: 'session', availability: 'supported' }],
    controlState: {
      connection: null,
      readiness: { ready: true, phase: 'ready' },
      capabilities: null,
      updatedAt: 1,
    },
  };
}

describe('settings page section switch', () => {
  const renderWithRouter = (entry = '/settings?section=gateway') => render(
    <MemoryRouter initialEntries={[entry]}>
      <Settings />
    </MemoryRouter>,
  );

  beforeEach(() => {
    hostApiFetchMock.mockClear();
    hostRuntimeEndpointsListMock.mockReset();
    hostRuntimeEndpointsListMock.mockResolvedValue({
      endpoints: [
        buildRuntimeEndpoint('openclaw'),
        buildRuntimeEndpoint('matcha-agent'),
      ],
    });
    useRuntimeEndpointsStore.setState({
      status: 'idle',
      error: null,
      endpoints: [],
      hasLoadedOnce: false,
      revision: 0,
      changedRuntimeScopeKeys: [],
      revisionByRuntimeScopeKey: {},
    });
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
      userAvatarDataUrl: null,
      initialized: true,
    }));

    useRuntimeHostStore.setState((state) => ({
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
      runtimeHost: { lifecycle: 'running' },
      init: vi.fn().mockResolvedValue(undefined),
      restart: vi.fn().mockResolvedValue(undefined),
      refreshRuntimeHostStatus: vi.fn().mockResolvedValue(undefined),
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

    expect(screen.getAllByText('Runtime Status').length).toBeGreaterThan(0);
    const openClawStatusTitle = await screen.findByText('OpenClaw');
    const openClawStatusPanel = runtimeStatusPanel(openClawStatusTitle.textContent ?? 'OpenClaw');
    expect(within(openClawStatusPanel as HTMLElement).getByText('running')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(openClawStatusPanel as HTMLElement).getByRole('button', { name: 'Logs' }));
    });
    expect(within(openClawStatusPanel as HTMLElement).getByText('OpenClaw Logs')).toBeInTheDocument();
    expect(within(openClawStatusPanel as HTMLElement).queryByText('raw logs')).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(within(openClawStatusPanel as HTMLElement).getByRole('button', { name: 'Restart' }));
    });
    await waitFor(() => {
      expect(useRuntimeHostStore.getState().restart).toHaveBeenCalled();
    });

    const matchaAgentTitle = await screen.findByText('matcha-agent');
    const matchaAgentPanel = runtimeStatusPanel(matchaAgentTitle.textContent ?? 'matcha-agent');
    expect(within(matchaAgentPanel as HTMLElement).getByText('running')).toBeInTheDocument();
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
    expect(screen.queryByRole('heading', { name: 'Runtime Status' })).not.toBeInTheDocument();
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

      const matchaAgentTitle = await screen.findByText('matcha-agent');
      const matchaAgentPanel = runtimeStatusPanel(matchaAgentTitle.textContent ?? 'matcha-agent');
      expect(within(matchaAgentPanel as HTMLElement).getByText('running')).toBeInTheDocument();

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
      expect(within(matchaAgentPanel as HTMLElement).queryByText('stopping')).not.toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).queryByText('Port: 31987')).not.toBeInTheDocument();
      expect(within(matchaAgentPanel as HTMLElement).queryByText('stale status')).not.toBeInTheDocument();
    } finally {
      if (defaultHostApiFetchImplementation) {
        hostApiFetchMock.mockImplementation(defaultHostApiFetchImplementation);
      }
    }
  });

  it('Matcha 主状态使用 app-server direct status，不等待 endpoint catalog', async () => {
    hostRuntimeEndpointsListMock.mockReturnValue(new Promise(() => {}));

    await act(async () => {
      renderWithRouter('/settings?section=gateway');
    });

    const openClawStatusTitle = await screen.findByText('OpenClaw');
    const openClawStatusPanel = runtimeStatusPanel(openClawStatusTitle.textContent ?? 'OpenClaw');
    expect(within(openClawStatusPanel as HTMLElement).getByText('Loading...')).toBeInTheDocument();

    const matchaAgentTitle = await screen.findByText('matcha-agent');
    const matchaAgentPanel = runtimeStatusPanel(matchaAgentTitle.textContent ?? 'matcha-agent');
    await waitFor(() => {
      expect(within(matchaAgentPanel as HTMLElement).getByText('running')).toBeInTheDocument();
    });
  });

  it('Matcha app-server status 刷新不依赖 OpenClaw 或 Runtime Host status 刷新', async () => {
    const refreshRuntimeHostStatus = vi.fn().mockResolvedValue(undefined);
    useRuntimeHostStore.setState((state) => ({
      ...state,
      status: {
        processState: 'control_connecting',
        port: 18789,
        gatewayReady: false,
        healthSummary: 'degraded',
        transportState: 'reconnecting',
        portReachable: true,
        diagnostics: {
          consecutiveHeartbeatMisses: 0,
          consecutiveRpcFailures: 0,
        },
        updatedAt: 2,
      },
      runtimeHost: { lifecycle: 'running' },
      refreshRuntimeHostStatus,
    } as never));

    await act(async () => {
      renderWithRouter('/settings?section=gateway');
    });

    const matchaAgentTitle = await screen.findByText('matcha-agent');
    const matchaAgentPanel = runtimeStatusPanel(matchaAgentTitle.textContent ?? 'matcha-agent');
    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/matcha-agent/app-server/status');
    });
    expect(within(matchaAgentPanel as HTMLElement).getByText('running')).toBeInTheDocument();

    hostApiFetchMock.mockClear();
    await act(async () => {
      fireEvent.click(within(matchaAgentPanel as HTMLElement).getByRole('button', { name: 'Refresh' }));
    });

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalledWith('/api/matcha-agent/app-server/status');
    });
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/openclaw/lifecycle/status');
    expect(hostApiFetchMock).not.toHaveBeenCalledWith('/api/openclaw/runtime/snapshot');
    expect(refreshRuntimeHostStatus).not.toHaveBeenCalled();
  });

  it('旧的 aiProviders 分栏链接会回退到默认分栏', async () => {
    await act(async () => {
      renderWithRouter('/settings?section=aiProviders');
    });

    expect(screen.getByRole('button', { name: 'Runtime Status' })).toBeInTheDocument();
    expect(screen.getAllByText('Runtime Status').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'AI Providers' })).not.toBeInTheDocument();
  });
});
