import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

const fetchProviderSnapshotMock = vi.fn();
const trackUiEventMock = vi.hoisted(() => vi.fn());
const startUiTimingMock = vi.hoisted(() => vi.fn(() => () => 1));

vi.mock('@/lib/provider-accounts', () => ({
  fetchProviderSnapshot: (...args: unknown[]) => fetchProviderSnapshotMock(...args),
  normalizeProviderSnapshot: (value: unknown) => {
    const snapshot = value && typeof value === 'object'
      ? value as Record<string, unknown>
      : {};
    return {
      accounts: Array.isArray(snapshot.accounts) ? snapshot.accounts : [],
      statuses: Array.isArray(snapshot.statuses) ? snapshot.statuses : [],
      vendors: Array.isArray(snapshot.vendors) ? snapshot.vendors : [],
      defaultAccountId: typeof snapshot.defaultAccountId === 'string' ? snapshot.defaultAccountId : null,
    };
  },
}));

vi.mock('@/lib/provider-runtime', () => ({
  hostProviderCreateAccount: vi.fn(),
  hostProviderDeleteAccount: vi.fn(),
  hostProviderReadApiKey: vi.fn(),
  hostProviderSetDefaultAccount: vi.fn(),
  hostProviderUpdateAccount: vi.fn(),
  hostProviderValidate: vi.fn(),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: (...args: unknown[]) => trackUiEventMock(...args),
  startUiTiming: (...args: unknown[]) => startUiTimingMock(...args),
}));

import { useProviderStore } from '@/stores/providers';

describe('useProviderStore.init', () => {
  beforeEach(() => {
    vi.useRealTimers();
    fetchProviderSnapshotMock.mockReset();
    trackUiEventMock.mockReset();
    startUiTimingMock.mockClear();
    useProviderStore.setState({
      providerSnapshot: {
        statuses: [],
        accounts: [],
        vendors: [],
        defaultAccountId: null,
      },
      snapshotReady: false,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingActionsByAccountId: {},
      error: null,
    });
  });

  it('会触发 refreshProviderSnapshot 并写入快照', async () => {
    fetchProviderSnapshotMock.mockResolvedValueOnce({
      statuses: [{ id: 'openai-main', name: 'OpenAI', hasKey: true, keyMasked: 'sk-****' }],
      accounts: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI' }],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
      defaultAccountId: 'openai-main',
    });

    await act(async () => {
      await useProviderStore.getState().init();
    });

    expect(fetchProviderSnapshotMock).toHaveBeenCalledTimes(1);
    const state = useProviderStore.getState();
    expect(state.providerSnapshot.defaultAccountId).toBe('openai-main');
    expect(state.providerSnapshot.accounts).toEqual([{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI' }]);
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toBeNull();
    expect(trackUiEventMock).toHaveBeenCalledWith(
      'providers.snapshot_refresh.background.success',
      expect.objectContaining({
        reason: 'app_init',
      }),
    );
  });

  it('快照失败时会收敛到 error 状态', async () => {
    fetchProviderSnapshotMock.mockRejectedValueOnce(new Error('snapshot failed'));

    await act(async () => {
      await useProviderStore.getState().init();
    });

    const state = useProviderStore.getState();
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toContain('snapshot failed');
  });

  it('并发 refreshProviderSnapshot 会复用同一个进行中的请求', async () => {
    let resolveSnapshot: ((value: unknown) => void) | null = null;
    const snapshotTask = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    fetchProviderSnapshotMock.mockReturnValue(snapshotTask);

    const first = useProviderStore.getState().refreshProviderSnapshot();
    const second = useProviderStore.getState().refreshProviderSnapshot();

    expect(fetchProviderSnapshotMock).toHaveBeenCalledTimes(1);
    resolveSnapshot?.({
      statuses: [],
      accounts: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI' }],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
      defaultAccountId: 'openai-main',
    });

    await act(async () => {
      await Promise.all([first, second]);
    });

    const state = useProviderStore.getState();
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.providerSnapshot.defaultAccountId).toBe('openai-main');
  });

  it('快照请求长期无响应时，会超时收口 initialLoading', async () => {
    vi.useFakeTimers();
    fetchProviderSnapshotMock.mockImplementation(() => new Promise(() => {}));

    const task = useProviderStore.getState().refreshProviderSnapshot();
    expect(useProviderStore.getState().initialLoading).toBe(true);
    expect(useProviderStore.getState().refreshing).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
      await task;
    });

    const state = useProviderStore.getState();
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.error).toContain('Provider snapshot request timed out');
  });

  it('已有快照时 background 刷新不会回退到阻塞式 initialLoading', async () => {
    let resolveSnapshot: ((value: unknown) => void) | null = null;
    const snapshotTask = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    fetchProviderSnapshotMock.mockReturnValue(snapshotTask);
    useProviderStore.setState({
      providerSnapshot: {
        accounts: [{
          id: 'openai-main',
          vendorId: 'openai',
          label: 'OpenAI',
          authMode: 'api_key',
          enabled: true,
          isDefault: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }],
        statuses: [{
          id: 'openai-main',
          type: 'openai',
          name: 'OpenAI',
          enabled: true,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          hasKey: true,
          keyMasked: 'sk-****',
        }],
        vendors: [{
          id: 'openai',
          name: 'OpenAI',
          icon: 'O',
          placeholder: 'sk-...',
          requiresApiKey: true,
          category: 'official',
          supportedAuthModes: ['api_key'],
          defaultAuthMode: 'api_key',
          supportsMultipleAccounts: false,
        }],
        defaultAccountId: 'openai-main',
      },
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      error: null,
    });

    const refreshTask = useProviderStore.getState().refreshProviderSnapshot();
    expect(useProviderStore.getState().initialLoading).toBe(false);
    expect(useProviderStore.getState().refreshing).toBe(false);

    resolveSnapshot?.({
      statuses: [{ id: 'openai-main', hasKey: true }],
      accounts: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI' }],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
      defaultAccountId: 'openai-main',
    });

    await act(async () => {
      await refreshTask;
    });

    expect(useProviderStore.getState().initialLoading).toBe(false);
    expect(useProviderStore.getState().refreshing).toBe(false);
  });

  it('空快照也应视为已加载，后续 background 刷新走静默', async () => {
    fetchProviderSnapshotMock.mockResolvedValueOnce({
      statuses: [],
      accounts: [],
      vendors: [],
      defaultAccountId: null,
    });

    await act(async () => {
      await useProviderStore.getState().refreshProviderSnapshot();
    });

    let resolveSnapshot: ((value: unknown) => void) | null = null;
    const secondTask = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    fetchProviderSnapshotMock.mockReturnValueOnce(secondTask);

    const refreshTask = useProviderStore.getState().refreshProviderSnapshot();
    expect(useProviderStore.getState().snapshotReady).toBe(true);
    expect(useProviderStore.getState().initialLoading).toBe(false);
    expect(useProviderStore.getState().refreshing).toBe(false);

    resolveSnapshot?.({
      statuses: [],
      accounts: [],
      vendors: [],
      defaultAccountId: null,
    });

    await act(async () => {
      await refreshTask;
    });

    expect(useProviderStore.getState().initialLoading).toBe(false);
    expect(useProviderStore.getState().refreshing).toBe(false);
  });

  it('手动刷新应记录 manual telemetry 事件', async () => {
    fetchProviderSnapshotMock.mockResolvedValueOnce({
      statuses: [],
      accounts: [],
      vendors: [],
      defaultAccountId: null,
    });

    await act(async () => {
      await useProviderStore.getState().refreshProviderSnapshot({
        trigger: 'manual',
        reason: 'user_manual_refresh',
      });
    });

    expect(trackUiEventMock).toHaveBeenCalledWith(
      'providers.snapshot_refresh.manual.success',
      expect.objectContaining({
        reason: 'user_manual_refresh',
      }),
    );
  });
});
