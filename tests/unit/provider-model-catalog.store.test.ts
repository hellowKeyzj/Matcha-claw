import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderModelCatalogStore } from '@/stores/provider-model-catalog';
import type { CallRecord } from '@/types/call-log';

const hostApiFetchMock = vi.hoisted(() => vi.fn());
const providerSnapshotRefreshMock = vi.hoisted(() => vi.fn());
const capabilityRefreshMock = vi.hoisted(() => vi.fn());
const subagentsLoadAvailableModelsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: hostApiFetchMock,
  hostApiFetchDecoded: async (path: string, decode: (value: unknown) => unknown, init: unknown) =>
    decode(await hostApiFetchMock(path, init)),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: () => () => {},
  subscribeBrowserRecovery: () => () => {},
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

const providerModelsReceipt = { callId: '0123456789abcdef0123456789abcdef', accepted: true };
const storedProviderModelsCall: CallRecord<'provider'> = {
  callId: providerModelsReceipt.callId,
  module: 'provider',
  command: 'providerModels.replace',
  status: 'succeeded',
  start: 1,
  end: 2,
  revision: 3,
  detail: {
    kind: 'replaceModels',
    phase: 'terminal',
    outcome: 'stored',
    count: null,
    acceptedCount: null,
    persisted: 'confirmed',
    commit: 'committed',
    accountId: 'custom-1',
    accountRevision: null,
    diagnostic: null,
    native: { changed: true, applied: 'confirmed', observed: 'matches' },
  },
};

describe('provider model catalog store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hostApiFetchMock.mockReset();
    hostApiFetchMock
      .mockResolvedValueOnce(providerModelsReceipt)
      .mockResolvedValueOnce({
        ...storedProviderModelsCall,
        status: 'rejected',
        detail: { ...storedProviderModelsCall.detail, outcome: 'rejected', persisted: null, commit: null, native: null },
      });
    useProviderModelCatalogStore.setState({
      models: [],
      ready: false,
      loading: false,
      saving: false,
      error: null,
      warning: null,
    });
  });

  it('rejects when provider model persistence fails', async () => {
    await expect(useProviderModelCatalogStore.getState().replaceAccountModels('custom-1', [
      { modelId: 'gpt-5.4', capabilities: ['chat'] },
    ])).rejects.toThrow('Provider model request was rejected');

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
    let resolveTerminal!: (call: CallRecord<'provider'>) => void;
    hostApiFetchMock.mockReset()
      .mockResolvedValueOnce(providerModelsReceipt)
      .mockReturnValueOnce(new Promise<CallRecord<'provider'>>((resolve) => { resolveTerminal = resolve; }))
      .mockResolvedValueOnce({ models: [{ accountId: 'custom-1', modelId: 'gpt-5.4', capabilities: ['chat'] }] });

    const replacement = useProviderModelCatalogStore.getState().replaceAccountModels('custom-1', [
      { modelId: 'gpt-5.4', capabilities: ['chat'] },
    ]);
    await vi.waitFor(() => expect(hostApiFetchMock).toHaveBeenCalledTimes(2));
    expect(useProviderModelCatalogStore.getState()).toMatchObject({ saving: true, ready: false, models: [] });
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(2, '/api/calls/get', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ callId: providerModelsReceipt.callId }),
    }));
    expect(providerSnapshotRefreshMock).not.toHaveBeenCalled();
    expect(capabilityRefreshMock).not.toHaveBeenCalled();
    expect(subagentsLoadAvailableModelsMock).not.toHaveBeenCalled();
    resolveTerminal(storedProviderModelsCall);
    await replacement;
    expect(hostApiFetchMock).toHaveBeenNthCalledWith(3, '/api/provider-models');

    expect(useProviderModelCatalogStore.getState()).toMatchObject({
      saving: false,
      ready: true,
      error: null,
      warning: null,
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
    hostApiFetchMock.mockReset().mockReturnValueOnce(new Promise((resolve) => {
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
