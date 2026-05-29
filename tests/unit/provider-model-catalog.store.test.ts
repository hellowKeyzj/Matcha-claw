import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderModelCatalogStore } from '@/stores/provider-model-catalog';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const capabilityRefreshMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

vi.mock('@/stores/capability-routing', () => ({
  useCapabilityRoutingStore: {
    getState: () => ({
      refresh: capabilityRefreshMock,
    }),
  },
}));

describe('provider model catalog store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProviderModelCatalogStore.setState({
      models: [],
      ready: false,
      loading: false,
      saving: false,
      error: null,
    });
  });

  it('rejects when provider model persistence fails', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ success: false, error: 'sync failed' });

    await expect(useProviderModelCatalogStore.getState().replaceCredentialModels('custom-1', [
      { modelId: 'gpt-5.4', capabilities: ['chat'] },
    ])).rejects.toThrow('sync failed');

    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      saving: false,
      error: 'sync failed',
    });
    expect(capabilityRefreshMock).not.toHaveBeenCalled();
  });
});
