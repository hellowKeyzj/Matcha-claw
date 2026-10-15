import { create } from 'zustand';
import {
  fetchProviderModels,
  persistProviderModels,
  type ProviderModel,
  type ProviderModelDraft,
} from '@/lib/provider-model-catalog';
import { refreshProviderPostMutationProjections } from '@/stores/provider-post-mutation-refresh';

let inflightRefreshTask: Promise<void> | null = null;
let latestCatalogRequestId = 0;
let pendingSaves = 0;

interface ProviderModelCatalogState {
  models: ProviderModel[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  warning: string | null;
  refresh: () => Promise<void>;
  replaceAccountModels: (
    accountId: string,
    models: readonly ProviderModelDraft[],
  ) => Promise<void>;
}

export const useProviderModelCatalogStore = create<ProviderModelCatalogState>((set) => ({
  models: [],
  ready: false,
  loading: false,
  saving: false,
  error: null,
  warning: null,

  refresh: async () => {
    if (inflightRefreshTask) {
      await inflightRefreshTask;
      return;
    }
    const requestId = ++latestCatalogRequestId;
    inflightRefreshTask = (async () => {
      set({ loading: true, error: null });
      try {
        const models = await fetchProviderModels();
        if (requestId === latestCatalogRequestId) {
          set({ models, ready: true, loading: false, warning: null });
        }
      } catch (error) {
        if (requestId === latestCatalogRequestId) {
          set({ loading: false, error: String(error) });
        }
      } finally {
        if (requestId === latestCatalogRequestId) inflightRefreshTask = null;
      }
    })();
    await inflightRefreshTask;
  },

  replaceAccountModels: async (accountId, next) => {
    ++pendingSaves;
    set({ saving: true, error: null, warning: null });
    try {
      const result = await persistProviderModels(accountId, next);
      const requestId = ++latestCatalogRequestId;
      inflightRefreshTask = null;
      set({ loading: false, warning: result.warning ?? null });
      try {
        const models = await fetchProviderModels();
        if (requestId === latestCatalogRequestId) {
          set({ models, ready: true });
        }
      } catch (refreshError) {
        if (requestId === latestCatalogRequestId) {
          set({ ready: true, error: String(refreshError) });
        }
      }
      await refreshProviderPostMutationProjections({
        refreshProviderModelCatalog: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: --pendingSaves > 0 });
    }
  },
}));
