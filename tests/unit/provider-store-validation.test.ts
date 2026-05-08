import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchProviderSnapshotMock = vi.hoisted(() => vi.fn());
const hostProviderValidateMock = vi.hoisted(() => vi.fn());

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
  hostProviderValidate: (...args: unknown[]) => hostProviderValidateMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
  startUiTiming: vi.fn(() => () => 1),
}));

describe('useProviderStore validateAccountApiKey', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchProviderSnapshotMock.mockReset();
    hostProviderValidateMock.mockReset();
  });

  it('sends trimmed api key to provider validation runtime', async () => {
    hostProviderValidateMock.mockResolvedValue({ valid: true });

    const { useProviderStore } = await import('@/stores/providers');
    useProviderStore.setState({
      providerSnapshot: {
        accounts: [
          {
            id: 'custom-1',
            vendorId: 'custom',
            label: 'Custom',
            authMode: 'api_key',
            enabled: true,
            isDefault: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        statuses: [],
        vendors: [],
        defaultAccountId: 'custom-1',
      },
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingActionsByAccountId: {},
      error: null,
    });

    await useProviderStore.getState().validateAccountApiKey('custom-1', '  sk-lm-test \n', {
      baseUrl: 'https://example.com',
    });

    expect(hostProviderValidateMock).toHaveBeenCalledWith({
      accountId: 'custom-1',
      vendorId: 'custom',
      apiKey: 'sk-lm-test',
      options: {
        baseUrl: 'https://example.com',
      },
    });
  });
});
