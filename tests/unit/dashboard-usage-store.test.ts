import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { hostApiFetchMock } = vi.hoisted(() => ({
  hostApiFetchMock: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
}));

const entry = {
  timestamp: '2026-04-03T00:00:00.000Z',
  sessionId: 'session-1',
  agentId: 'main',
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 3,
};

describe('dashboard usage refresh cache', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-03T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads the runtime-host legacy array DTO and keeps cached entries across errors', async () => {
    hostApiFetchMock.mockResolvedValueOnce([entry]).mockResolvedValueOnce([entry]);
    const { useDashboardUsageStore } = await import('@/stores/dashboard-usage');

    await useDashboardUsageStore.getState().refreshUsageHistory({ maxAttempts: 1, silent: true });
    await useDashboardUsageStore.getState().refreshUsageHistory({ maxAttempts: 1, silent: true });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(2);
    expect(useDashboardUsageStore.getState()).toMatchObject({
      usageHistory: [entry],
      usageHistoryReady: true,
      error: null,
    });

    vi.setSystemTime(new Date('2026-04-03T00:00:10.001Z'));
    hostApiFetchMock.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await useDashboardUsageStore.getState().refreshUsageHistory({ maxAttempts: 1, silent: true });

    expect(useDashboardUsageStore.getState()).toMatchObject({
      usageHistory: [entry],
      usageHistoryReady: true,
      error: 'temporarily unavailable',
    });

    vi.setSystemTime(new Date('2026-04-03T00:00:20.002Z'));
    hostApiFetchMock.mockResolvedValueOnce([]);
    await useDashboardUsageStore.getState().refreshUsageHistory({ maxAttempts: 1, silent: true });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(4);
    expect(useDashboardUsageStore.getState()).toMatchObject({
      usageHistory: [],
      usageHistoryReady: true,
      error: null,
    });
  });

  it('loads session details through the public session identity', async () => {
    hostApiFetchMock.mockResolvedValueOnce([entry]).mockResolvedValueOnce([entry]);
    const { useDashboardUsageStore } = await import('@/stores/dashboard-usage');

    await useDashboardUsageStore.getState().loadSessionDetails(entry.sessionId, entry.agentId);

    expect(hostApiFetchMock).toHaveBeenCalledWith(
      '/api/runtime-host/usage/session-timeseries?sessionId=session-1&agentId=main',
    );
    expect(useDashboardUsageStore.getState().sessionDetails['session-1']).toMatchObject({
      status: 'loaded',
      entries: [entry],
    });
  });
});
