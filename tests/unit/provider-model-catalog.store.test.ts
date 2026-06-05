import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderModelCatalogStore } from '@/stores/provider-model-catalog';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const hostCapabilityExecuteMock = vi.hoisted(() => vi.fn());
const resolveSingleCapabilityRuntimeAddressMock = vi.hoisted(() => vi.fn());
const capabilityRefreshMock = vi.hoisted(() => vi.fn());
const TEST_RUNTIME_ADDRESS = {
  kind: 'native-runtime',
  capabilityId: 'model.provider',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
  agentId: 'default',
} as const;

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
  hostCapabilityExecute: hostCapabilityExecuteMock,
  resolveSingleCapabilityRuntimeAddress: resolveSingleCapabilityRuntimeAddressMock,
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
    resolveSingleCapabilityRuntimeAddressMock.mockResolvedValue(TEST_RUNTIME_ADDRESS);
    hostCapabilityExecuteMock.mockResolvedValue({ success: false, error: 'sync failed' });
    useProviderModelCatalogStore.setState({
      models: [],
      ready: false,
      loading: false,
      saving: false,
      error: null,
    });
  });

  it('rejects when provider model persistence fails', async () => {
    await expect(useProviderModelCatalogStore.getState().replaceCredentialModels('custom-1', [
      { modelId: 'gpt-5.4', capabilities: ['chat'] },
    ], TEST_RUNTIME_ADDRESS)).rejects.toThrow('sync failed');

    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      saving: false,
      error: 'sync failed',
    });
    expect(capabilityRefreshMock).not.toHaveBeenCalled();
  });
});
