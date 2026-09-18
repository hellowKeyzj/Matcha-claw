import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCapabilityRoutingStore } from '@/stores/capability-routing';

const fetchCapabilityRoutingMock = vi.hoisted(() => vi.fn());
const persistCapabilityRoutingMock = vi.hoisted(() => vi.fn());
const providerSnapshotRefreshMock = vi.hoisted(() => vi.fn());
const providerModelCatalogRefreshMock = vi.hoisted(() => vi.fn());
const subagentsLoadAvailableModelsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/capability-routing', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/capability-routing')>(),
  fetchCapabilityRouting: fetchCapabilityRoutingMock,
  persistCapabilityRouting: persistCapabilityRoutingMock,
}));

vi.mock('@/stores/providers', () => ({
  useProviderStore: {
    getState: () => ({
      refreshProviderSnapshot: providerSnapshotRefreshMock,
    }),
  },
}));

vi.mock('@/stores/provider-model-catalog', () => ({
  useProviderModelCatalogStore: {
    getState: () => ({
      refresh: providerModelCatalogRefreshMock,
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

const currentRouting = {
  chat: {
    primary: { accountId: 'account-a', modelId: 'model-a' },
    fallbacks: [],
  },
};

describe('capability routing store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCapabilityRoutingStore.setState({
      routing: {},
      revision: null,
      ready: false,
      loading: false,
      saving: false,
      error: null,
      warning: null,
    });
  });

  it('keeps the revision returned by the routing list', async () => {
    fetchCapabilityRoutingMock.mockResolvedValue({ revision: 3, routing: currentRouting });

    await useCapabilityRoutingStore.getState().refresh();

    expect(useCapabilityRoutingStore.getState()).toMatchObject({
      routing: currentRouting,
      revision: 3,
      ready: true,
      loading: false,
    });
  });

  it('creates the first routing at the domain initial revision', async () => {
    const route = {
      primary: { accountId: 'account-a', modelId: 'model-a' },
      fallbacks: [],
    };
    persistCapabilityRoutingMock.mockResolvedValue({ success: true, revision: 1, routing: { chat: route } });

    await useCapabilityRoutingStore.getState().setRoute('chat', route);

    expect(persistCapabilityRoutingMock).toHaveBeenCalledWith({ chat: route }, 1);
    expect(useCapabilityRoutingStore.getState()).toMatchObject({
      routing: { chat: route },
      revision: 1,
      saving: false,
      error: null,
    });
    expect(providerSnapshotRefreshMock).toHaveBeenCalledWith({
      trigger: 'reconcile',
      reason: 'provider_post_mutation',
    });
    expect(providerModelCatalogRefreshMock).toHaveBeenCalledTimes(1);
    expect(subagentsLoadAvailableModelsMock).toHaveBeenCalledWith({ force: true });
  });

  it('writes the current revision and commits only the returned routing snapshot', async () => {
    useCapabilityRoutingStore.setState({ routing: currentRouting, revision: 3, ready: true });
    const returnedRouting = {
      chat: {
        primary: { accountId: 'account-b', modelId: 'model-b' },
        fallbacks: [],
      },
    };
    persistCapabilityRoutingMock.mockResolvedValue({
      success: true,
      revision: 4,
      routing: returnedRouting,
    });

    await useCapabilityRoutingStore.getState().setRoute('chat', {
      primary: { accountId: 'account-c', modelId: 'model-c' },
      fallbacks: [],
    });

    expect(persistCapabilityRoutingMock).toHaveBeenCalledWith({
      chat: {
        primary: { accountId: 'account-c', modelId: 'model-c' },
        fallbacks: [],
      },
    }, 4);
    expect(useCapabilityRoutingStore.getState()).toMatchObject({
      routing: returnedRouting,
      revision: 4,
      saving: false,
      error: null,
    });
  });

  it('commits desired routing and surfaces configuration projection failure separately', async () => {
    useCapabilityRoutingStore.setState({ routing: currentRouting, revision: 3, ready: true });
    persistCapabilityRoutingMock.mockResolvedValue({
      success: true,
      revision: 4,
      routing: { ...currentRouting },
      warning: 'Provider routing configuration is unavailable',
    });

    await useCapabilityRoutingStore.getState().setRoute('chat', currentRouting.chat);

    expect(useCapabilityRoutingStore.getState()).toMatchObject({
      routing: currentRouting,
      revision: 4,
      saving: false,
      error: null,
      warning: 'Provider routing configuration is unavailable',
    });
  });

  it('does not optimistically update routing when desired replacement is rejected', async () => {
    useCapabilityRoutingStore.setState({ routing: currentRouting, revision: 3, ready: true });
    persistCapabilityRoutingMock.mockResolvedValue({
      success: false,
      revision: 3,
      routing: {},
      error: 'Provider routing request was rejected',
    });

    await useCapabilityRoutingStore.getState().setRoute('chat', {
      primary: { accountId: 'account-b', modelId: 'model-b' },
      fallbacks: [],
    });

    expect(useCapabilityRoutingStore.getState()).toMatchObject({
      routing: currentRouting,
      revision: 3,
      saving: false,
      error: 'Provider routing request was rejected',
    });
  });
});
