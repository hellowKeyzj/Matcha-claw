import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

const fetchProviderSnapshotMock = vi.fn();
const hostProviderCreateAccountMock = vi.fn();
const hostProviderDeleteAccountMock = vi.fn();
const hostProviderSetDefaultAccountMock = vi.fn();
const hostProviderUpdateAccountMock = vi.fn();
const hostProviderValidateMock = vi.fn();
const hostProviderReadApiKeyMock = vi.fn();
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
  hostProviderCreateAccount: (...args: unknown[]) => hostProviderCreateAccountMock(...args),
  hostProviderDeleteAccount: (...args: unknown[]) => hostProviderDeleteAccountMock(...args),
  hostProviderReadApiKey: (...args: unknown[]) => hostProviderReadApiKeyMock(...args),
  hostProviderSetDefaultAccount: (...args: unknown[]) => hostProviderSetDefaultAccountMock(...args),
  hostProviderUpdateAccount: (...args: unknown[]) => hostProviderUpdateAccountMock(...args),
  hostProviderValidate: (...args: unknown[]) => hostProviderValidateMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: (...args: unknown[]) => trackUiEventMock(...args),
  startUiTiming: (...args: unknown[]) => startUiTimingMock(...args),
}));

import { useProviderStore } from '@/stores/providers';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('useProviderStore mutation states', () => {
  beforeEach(() => {
    fetchProviderSnapshotMock.mockReset();
    hostProviderCreateAccountMock.mockReset();
    hostProviderDeleteAccountMock.mockReset();
    hostProviderSetDefaultAccountMock.mockReset();
    hostProviderUpdateAccountMock.mockReset();
    hostProviderValidateMock.mockReset();
    hostProviderReadApiKeyMock.mockReset();
    trackUiEventMock.mockReset();
    startUiTimingMock.mockClear();
    localStorage.clear();

    useProviderStore.setState({
      providerSnapshot: {
        accounts: [
          {
            id: 'openai-main',
            vendorId: 'openai',
            label: 'OpenAI',
            authMode: 'api_key',
            enabled: true,
            isDefault: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        statuses: [
          {
            id: 'openai-main',
            type: 'openai',
            name: 'OpenAI',
            hasKey: true,
            keyMasked: 'sk-****',
            enabled: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
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
      mutating: false,
      mutatingActionsByAccountId: {},
      error: null,
    });
  });

  it('updateAccount 成功后先本地 patch，再后台 reconcile', async () => {
    let resolveSnapshot: ((value: unknown) => void) | null = null;
    const snapshotTask = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    fetchProviderSnapshotMock.mockReturnValue(snapshotTask);
    hostProviderUpdateAccountMock.mockResolvedValue({ success: true });

    const updateTask = useProviderStore.getState().updateAccount('openai-main', {
      model: 'gpt-5.4',
    });

    const settled = await Promise.race([
      updateTask.then(() => 'resolved' as const),
      sleep(30).then(() => 'timeout' as const),
    ]);

    if (settled === 'timeout') {
      resolveSnapshot?.({
        statuses: [{ id: 'openai-main', hasKey: true }],
        accounts: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI', model: 'gpt-5.4' }],
        vendors: [{ id: 'openai', name: 'OpenAI' }],
        defaultAccountId: 'openai-main',
      });
      await updateTask;
    }

    expect(settled).toBe('resolved');
    expect(useProviderStore.getState().providerSnapshot.accounts[0]?.model).toBe('gpt-5.4');
    expect(useProviderStore.getState().refreshing).toBe(true);

    resolveSnapshot?.({
      statuses: [{ id: 'openai-main', hasKey: true }],
      accounts: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI', model: 'gpt-5.4' }],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
      defaultAccountId: 'openai-main',
    });

    await act(async () => {
      await sleep(0);
    });

    expect(useProviderStore.getState().refreshing).toBe(false);
    expect(trackUiEventMock).toHaveBeenCalledWith(
      'providers.snapshot_refresh.reconcile.success',
      expect.objectContaining({
        reason: 'mutation_update',
      }),
    );
  });

  it('removeAccount 期间会暴露 mutating 行级状态，并在结束后清理', async () => {
    let resolveDelete: ((value: unknown) => void) | null = null;
    const deleteTask = new Promise((resolve) => {
      resolveDelete = resolve;
    });
    hostProviderDeleteAccountMock.mockReturnValue(deleteTask);
    fetchProviderSnapshotMock.mockResolvedValue({
      statuses: [],
      accounts: [],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
      defaultAccountId: null,
    });

    const removeTask = useProviderStore.getState().removeAccount('openai-main');
    expect(useProviderStore.getState().mutating).toBe(true);
    expect(useProviderStore.getState().mutatingActionsByAccountId['openai-main']?.delete).toBeTruthy();

    resolveDelete?.({ success: true });

    await act(async () => {
      await removeTask;
    });

    expect(useProviderStore.getState().mutating).toBe(false);
    expect(useProviderStore.getState().mutatingActionsByAccountId['openai-main']).toBeUndefined();
  });
});
