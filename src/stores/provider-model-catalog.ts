import { create } from 'zustand';
import {
  fetchProviderModels,
  persistProviderModels,
  type ProviderModel,
} from '@/lib/provider-model-catalog';
import { useCapabilityRoutingStore } from '@/stores/capability-routing';

let inflightRefreshTask: Promise<void> | null = null;

interface ProviderModelCatalogState {
  models: ProviderModel[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  replaceCredentialModels: (
    credentialId: string,
    models: readonly Omit<ProviderModel, 'credentialId'>[],
    vendorId?: string,
  ) => Promise<void>;
}

export const useProviderModelCatalogStore = create<ProviderModelCatalogState>((set) => ({
  models: [],
  ready: false,
  loading: false,
  saving: false,
  error: null,

  refresh: async () => {
    if (inflightRefreshTask) {
      await inflightRefreshTask;
      return;
    }
    inflightRefreshTask = (async () => {
      set({ loading: true, error: null });
      try {
        const models = await fetchProviderModels();
        set({ models, ready: true, loading: false });
      } catch (error) {
        set({ loading: false, error: String(error) });
      } finally {
        inflightRefreshTask = null;
      }
    })();
    await inflightRefreshTask;
  },

  replaceCredentialModels: async (credentialId, next, vendorId) => {
    set({ saving: true, error: null });
    try {
      const result = await persistProviderModels(credentialId, next, vendorId);
      if (!result.success) {
        const message = result.error || 'Failed to persist provider models';
        set({ saving: false, error: message });
        throw new Error(message);
      }
      set((state) => ({
        models: [
          ...state.models.filter((model) => model.credentialId !== credentialId),
          ...result.models,
        ],
        saving: false,
        ready: true,
      }));
      void useCapabilityRoutingStore.getState().refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ saving: false, error: message });
      throw error;
    }
  },
}));
