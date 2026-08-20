import { create } from 'zustand';
import {
  fetchProviderModels,
  persistProviderModels,
  type ProviderModel,
  type ProviderModelDraft,
} from '@/lib/provider-model-catalog';

let inflightRefreshTask: Promise<void> | null = null;

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
    inflightRefreshTask = (async () => {
      set({ loading: true, error: null });
      try {
        const models = await fetchProviderModels();
        set({ models, ready: true, loading: false, warning: null });
      } catch (error) {
        set({ loading: false, error: String(error) });
      } finally {
        inflightRefreshTask = null;
      }
    })();
    await inflightRefreshTask;
  },

  replaceAccountModels: async (accountId, next) => {
    set({ saving: true, error: null, warning: null });
    try {
      const result = await persistProviderModels(accountId, next);
      try {
        const models = await fetchProviderModels();
        set({ models, saving: false, ready: true, error: null, warning: result.warning ?? null });
      } catch (refreshError) {
        set({ saving: false, ready: true, error: String(refreshError), warning: result.warning ?? null });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ saving: false, error: message });
      throw error;
    }
  },
}));
