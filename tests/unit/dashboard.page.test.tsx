import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Dashboard } from '@/pages/Dashboard';
import { useDashboardUiStore } from '@/stores/dashboard-ui';
import { useDashboardUsageStore } from '@/stores/dashboard-usage';

const hostApiFetchMock = vi.fn(async (path: string) => {
  if (path === '/api/runtime-host/usage/recent') {
    return [
      {
        timestamp: new Date().toISOString(),
        sessionId: 's-1',
        agentId: 'main',
        model: 'demo-model',
        provider: 'demo-provider',
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 2,
      },
    ];
  }
  return { success: true };
});

const gatewayState = {
  status: {
    state: 'running',
    port: 18789,
    pid: 1234,
    connectedAt: Date.now(),
  },
};

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('dashboard page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useDashboardUiStore.setState({
      dashboardHeavyContentReady: true,
      usageGroupBy: 'model',
      usageWindow: '7d',
      usagePage: 1,
    });
    useDashboardUsageStore.setState({
      usageHistory: [],
      usageHistoryReady: false,
      initialLoading: false,
      refreshing: false,
      usagePanelReady: true,
      usageChartReady: false,
      usageDetailListReady: false,
      error: null,
    });
  });

  it('不再渲染快捷入口到频道和技能页面', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(hostApiFetchMock).toHaveBeenCalled();
    });

    expect(screen.queryByRole('link', { name: /addChannel/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /installSkill/i })).not.toBeInTheDocument();
  });

  it('token 历史有数据时，明细列表应结束骨架并渲染记录', async () => {
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('demo-model').length).toBeGreaterThan(0);
    });
  });
});
