import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { hostApiFetchMock } from './helpers/mock-gateway-client';

const fetchProviderSnapshotMock = vi.fn();
const hostProviderCreateAccountMock = vi.fn();
const hostProviderDeleteAccountMock = vi.fn();
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
      credentials: Array.isArray(snapshot.credentials) ? snapshot.credentials : [],
      statuses: Array.isArray(snapshot.statuses) ? snapshot.statuses : [],
      vendors: Array.isArray(snapshot.vendors) ? snapshot.vendors : [],
    };
  },
}));

vi.mock('@/lib/provider-projection', () => ({
  hostProviderCreateAccount: (...args: unknown[]) => hostProviderCreateAccountMock(...args),
  hostProviderDeleteAccount: (...args: unknown[]) => hostProviderDeleteAccountMock(...args),
  hostProviderReadApiKey: (...args: unknown[]) => hostProviderReadApiKeyMock(...args),
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
    hostProviderUpdateAccountMock.mockReset();
    hostProviderValidateMock.mockReset();
    hostProviderReadApiKeyMock.mockReset();
    hostApiFetchMock.mockReset();
    trackUiEventMock.mockReset();
    startUiTimingMock.mockClear();
    localStorage.clear();

    useProviderStore.setState({
      providerSnapshot: {
        credentials: [
          {
            id: 'openai-main',
            vendorId: 'openai',
            label: 'OpenAI',
            authMode: 'api_key',
            enabled: true,
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
      },
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingActionsByAccountId: {},
      error: null,
    });
  });

  function mockProviderJob(jobId: string, result: unknown = { success: true }): void {
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/capabilities/execute') {
        return {
          success: true,
          job: {
            id: jobId,
            type: 'providers.mutation',
            status: 'succeeded',
            result,
          },
        };
      }
      return {
        success: true,
        job: {
          id: jobId,
          type: 'providers.mutation',
          status: 'queued',
          queuedAt: 1,
          attempts: 0,
          maxAttempts: 1,
        },
      };
    });
  }

  it('updateAccount 成功后先本地 patch，再后台 reconcile', async () => {
    let resolveSnapshot: ((value: unknown) => void) | null = null;
    const snapshotTask = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    fetchProviderSnapshotMock.mockReturnValue(snapshotTask);
    hostProviderUpdateAccountMock.mockResolvedValue({ success: true });
    mockProviderJob('job-update');

    const updateTask = useProviderStore.getState().updateAccount('openai-main', {
      baseUrl: 'https://api.openai.example/v1',
    });

    const settled = await Promise.race([
      updateTask.then(() => 'resolved' as const),
      sleep(30).then(() => 'timeout' as const),
    ]);

    if (settled === 'timeout') {
      resolveSnapshot?.({
        statuses: [{ id: 'openai-main', hasKey: true }],
        credentials: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.example/v1' }],
        vendors: [{ id: 'openai', name: 'OpenAI' }],
      });
      await updateTask;
    }

    expect(settled).toBe('resolved');
    expect(useProviderStore.getState().providerSnapshot.credentials[0]?.baseUrl).toBe('https://api.openai.example/v1');
    expect(useProviderStore.getState().refreshing).toBe(true);

    resolveSnapshot?.({
      statuses: [{ id: 'openai-main', hasKey: true }],
      credentials: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.example/v1' }],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
    });

    await act(async () => {
      await sleep(0);
    });

    expect(useProviderStore.getState().refreshing).toBe(false);
    expect(useProviderStore.getState().error).toBeNull();
  });

  it('removeAccount 期间会暴露 mutating 行级状态，并在结束后清理', async () => {
    let resolveDelete: ((value: unknown) => void) | null = null;
    const deleteTask = new Promise((resolve) => {
      resolveDelete = resolve;
    });
    hostProviderDeleteAccountMock.mockReturnValue(deleteTask);
    hostApiFetchMock.mockImplementation(async (path: string) => {
      if (path === '/api/capabilities/execute') {
        return {
          success: true,
          job: {
            id: 'job-delete',
            type: 'providers.deleteAccount',
            status: 'succeeded',
            result: await deleteTask,
          },
        };
      }
      return {
        success: true,
        job: {
          id: 'job-delete',
          type: 'providers.deleteAccount',
          status: 'queued',
          queuedAt: 1,
          attempts: 0,
          maxAttempts: 1,
        },
      };
    });
    fetchProviderSnapshotMock.mockResolvedValue({
      statuses: [],
      credentials: [],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
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
