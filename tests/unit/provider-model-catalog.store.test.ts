import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderModelCatalogStore } from '@/stores/provider-model-catalog';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const providerSnapshotRefreshMock = vi.hoisted(() => vi.fn());
const capabilityRefreshMock = vi.hoisted(() => vi.fn());
const subagentsLoadAvailableModelsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: {
    getState: () => ({
      refreshProviderSnapshot: providerSnapshotRefreshMock,
    }),
  },
}));

vi.mock('@/stores/capability-routing', () => ({
  useCapabilityRoutingStore: {
    getState: () => ({
      refresh: capabilityRefreshMock,
    }),
  },
}));

vi.mock('@/stores/subagents', () => ({
  useSubagentsStore: {
    getState: () => ({
      loadAvailableModels: subagentsLoadAvailableModelsMock,
    }),
  },
}));

const storedProviderModelsResponse = {
  success: true,
  desired: { status: 'stored' },
  persisted: { status: 'confirmed' },
  native: { changed: true, applied: { status: 'confirmed' }, observed: { status: 'matches' } },
  commit: 'committed',
};

describe('provider model catalog store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostApiFetchMock.mockResolvedValue({ success: false, error: 'Provider model request was rejected' });
    useProviderModelCatalogStore.setState({
      models: [],
      ready: false,
      loading: false,
      saving: false,
      error: null,
    });
  });

  it('rejects when provider model persistence fails', async () => {
    await expect(useProviderModelCatalogStore.getState().replaceAccountModels('custom-1', [
      { modelId: 'gpt-5.4', capabilities: ['chat'] },
    ], 'custom')).rejects.toThrow('Provider model request was rejected');

    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      saving: false,
      error: 'Provider model request was rejected',
    });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/provider-models', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(hostApiFetchMock.mock.calls[0][1].body)).toEqual({
      id: 'provider.models',
      operationId: 'providerModels.replace',
      scope: { kind: 'provider-model-catalog' },
      target: { kind: 'provider-models' },
      input: {
        kind: 'replace',
        accountId: 'custom-1',
        models: [{ modelId: 'gpt-5.4', capabilities: ['chat'] }],
      },
    });
    expect(providerSnapshotRefreshMock).not.toHaveBeenCalled();
    expect(capabilityRefreshMock).not.toHaveBeenCalled();
    expect(subagentsLoadAvailableModelsMock).not.toHaveBeenCalled();
  });

  it('refreshes dependent provider projections after provider model replacement succeeds', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce(storedProviderModelsResponse)
      .mockResolvedValueOnce({ models: [{ accountId: 'custom-1', modelId: 'gpt-5.4', capabilities: ['chat'] }] });

    await useProviderModelCatalogStore.getState().replaceAccountModels('custom-1', [
      { modelId: 'gpt-5.4', capabilities: ['chat'] },
    ]);

    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      saving: false,
      ready: true,
      error: null,
      models: [{ accountId: 'custom-1', modelId: 'gpt-5.4', capabilities: ['chat'] }],
    });
    expect(providerSnapshotRefreshMock).toHaveBeenCalledWith({
      trigger: 'reconcile',
      reason: 'provider_post_mutation',
    });
    expect(capabilityRefreshMock).toHaveBeenCalledTimes(1);
    expect(subagentsLoadAvailableModelsMock).toHaveBeenCalledWith({ force: true });
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
      resolveModels?.({ models: [{ accountId: 'custom-1', modelId: 'gpt-5.4', capabilities: ['chat'] }] });
      await Promise.all([first, second]);
    });

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      ready: true,
      loading: false,
      error: null,
      models: [{ accountId: 'custom-1', modelId: 'gpt-5.4', capabilities: ['chat'] }],
    });
  });
});
