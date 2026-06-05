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
      credentials: Array.isArray(snapshot.credentials) ? snapshot.credentials : [],
      statuses: Array.isArray(snapshot.statuses) ? snapshot.statuses : [],
      vendors: Array.isArray(snapshot.vendors) ? snapshot.vendors : [],
    };
  },
}));

vi.mock('@/lib/provider-projection', () => ({
  hostProviderCreateAccount: vi.fn(),
  hostProviderDeleteAccount: vi.fn(),
  hostProviderReadApiKey: vi.fn(),
  hostProviderUpdateAccount: vi.fn(),
  hostProviderValidate: (...args: unknown[]) => hostProviderValidateMock(...args),
}));

vi.mock('@/lib/telemetry', () => ({
  trackUiEvent: vi.fn(),
  startUiTiming: vi.fn(() => () => 1),
}));

const TEST_RUNTIME_ADDRESS = {
  kind: 'native-runtime',
  capabilityId: 'model.provider',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
} as const;

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
        credentials: [
          {
            id: 'custom-1',
            vendorId: 'custom',
            label: 'Custom',
            authMode: 'api_key',
            enabled: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        statuses: [],
        vendors: [],
      },
      snapshotReady: true,
      initialLoading: false,
      refreshing: false,
      mutating: false,
      mutatingActionsByAccountId: {},
      error: null,
    });

    await useProviderStore.getState().validateAccountApiKey('custom-1', '  sk-lm-test \n', TEST_RUNTIME_ADDRESS, {
      baseUrl: 'https://example.com',
    });

    expect(hostProviderValidateMock).toHaveBeenCalledWith({
      accountId: 'custom-1',
      vendorId: 'custom',
      apiKey: 'sk-lm-test',
      options: {
        baseUrl: 'https://example.com',
      },
    }, TEST_RUNTIME_ADDRESS);
  });
});
