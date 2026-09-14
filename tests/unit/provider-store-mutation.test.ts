import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';

const fetchProviderSnapshotMock = vi.fn();
const hostProviderCreateAccountMock = vi.fn();
const hostProviderDeleteAccountMock = vi.fn();
const hostProviderUpdateAccountMock = vi.fn();
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
      revisions: snapshot.revisions && typeof snapshot.revisions === 'object'
        ? snapshot.revisions as Record<string, number>
        : {},
    };
  },
}));

vi.mock('@/lib/provider-projection', () => ({
  hostProviderCreateAccount: (...args: unknown[]) => hostProviderCreateAccountMock(...args),
  hostProviderDeleteAccount: (...args: unknown[]) => hostProviderDeleteAccountMock(...args),
  hostProviderUpdateAccount: (...args: unknown[]) => hostProviderUpdateAccountMock(...args),
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
        revisions: { 'openai-main': 1 },
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

  it('updateAccount 成功后通过私密 Main ingress 并 reconcile', async () => {
    let resolveSnapshot: ((value: unknown) => void) | null = null;
    const snapshotTask = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    fetchProviderSnapshotMock.mockReturnValue(snapshotTask);
    hostProviderUpdateAccountMock.mockResolvedValue({ success: true });

    const updateTask = useProviderStore.getState().updateAccount('openai-main', {
      label: 'OpenAI primary',
    });

    await sleep(0);
    resolveSnapshot?.({
      statuses: [{ id: 'openai-main', hasKey: true }],
      credentials: [{ id: 'openai-main', vendorId: 'openai', label: 'OpenAI primary' }],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
      revisions: { 'openai-main': 2 },
    });
    await updateTask;
    expect(hostProviderUpdateAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'openai-main' }),
      2,
      undefined,
    );
    expect(useProviderStore.getState().providerSnapshot.credentials[0]?.label).toBe('OpenAI primary');
    expect(useProviderStore.getState().refreshing).toBe(false);
    expect(useProviderStore.getState().error).toBeNull();
  });

  it('createAccount 只使用 mutation 后的 owner readback', async () => {
    let resolveInitialSnapshot: ((value: unknown) => void) | null = null;
    const initialSnapshot = new Promise((resolve) => {
      resolveInitialSnapshot = resolve;
    });
    fetchProviderSnapshotMock.mockReturnValueOnce(initialSnapshot).mockResolvedValueOnce({
      statuses: [{ id: 'ollama-local', hasKey: true }],
      credentials: [{ id: 'ollama-local', vendorId: 'ollama', label: 'Ollama', authMode: 'local' }],
      vendors: [{ id: 'ollama', name: 'Ollama' }],
      revisions: { 'ollama-local': 1 },
    });
    hostProviderCreateAccountMock.mockResolvedValue({ success: true });

    const refreshTask = useProviderStore.getState().refreshProviderSnapshot({
      trigger: 'background',
      reason: 'app_init',
    });
    const createTask = useProviderStore.getState().createAccount({
      id: 'ollama-local',
      vendorId: 'ollama',
      label: 'Ollama',
      authMode: 'local',
      enabled: true,
      createdAt: '',
      updatedAt: '',
    });

    await createTask;
    expect(hostProviderCreateAccountMock).toHaveBeenCalledWith(expect.objectContaining({ id: 'ollama-local' }), undefined);
    expect(useProviderStore.getState().providerSnapshot.credentials).toContainEqual(
      expect.objectContaining({ id: 'ollama-local', vendorId: 'ollama' }),
    );

    resolveInitialSnapshot?.({ statuses: [], credentials: [], vendors: [], revisions: {} });
    await refreshTask;
    expect(useProviderStore.getState().providerSnapshot.credentials).toContainEqual(
      expect.objectContaining({ id: 'ollama-local', vendorId: 'ollama' }),
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
      credentials: [],
      vendors: [{ id: 'openai', name: 'OpenAI' }],
    });

    const removeTask = useProviderStore.getState().removeAccount('openai-main');
    await sleep(0);
    expect(hostProviderDeleteAccountMock).toHaveBeenCalledWith('openai-main', 1);
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
