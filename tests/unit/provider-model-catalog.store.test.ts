import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderModelCatalogStore } from '@/stores/provider-model-catalog';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const resolveSingleCapabilityScopeMock = vi.hoisted(() => vi.fn());
const capabilityRefreshMock = vi.hoisted(() => vi.fn());
const TEST_RUNTIME_SCOPE = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
} as const;

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
  resolveSingleCapabilityScope: resolveSingleCapabilityScopeMock,
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
    resolveSingleCapabilityScopeMock.mockResolvedValue(TEST_RUNTIME_SCOPE);
    hostApiFetchMock.mockResolvedValue({ success: false, error: 'sync failed' });
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
    ], 'custom')).rejects.toThrow('sync failed');

    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      saving: false,
      error: 'sync failed',
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(hostApiFetchMock.mock.calls[0][1].body)).toEqual({
      id: 'model.provider',
      operationId: 'providerModels.replace',
      scope: TEST_RUNTIME_SCOPE,
      target: { kind: 'provider-credential', accountId: 'custom-1', vendorId: 'custom' },
      input: {
        credentialId: 'custom-1',
        vendorId: 'custom',
        models: [{ modelId: 'gpt-5.4', capabilities: ['chat'] }],
      },
    });
    expect(capabilityRefreshMock).not.toHaveBeenCalled();
  });

  it('dedupes concurrent refresh requests through one provider model fetch', async () => {
    let resolveModels: ((value: unknown) => void) | null = null;
    hostApiFetchMock.mockReturnValueOnce(new Promise((resolve) => {
      resolveModels = resolve;
    }));

    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = useProviderModelCatalogStore.getState().refresh();
      second = useProviderModelCatalogStore.getState().refresh();
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(resolveModels).not.toBeNull();
    await act(async () => {
      resolveModels?.({ models: [{ credentialId: 'custom-1', modelId: 'gpt-5.4', capabilities: ['chat'] }] });
      await Promise.all([first, second]);
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      ready: true,
      loading: false,
      error: null,
      models: [{ credentialId: 'custom-1', modelId: 'gpt-5.4', capabilities: ['chat'] }],
    });
  });
});
