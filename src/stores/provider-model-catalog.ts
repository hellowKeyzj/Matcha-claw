import { create } from 'zustand';
import {
  fetchProviderModels,
  persistProviderModels,
  type ProviderModel,
} from '@/lib/provider-model-catalog';

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
  ) => Promise<void>;
}

export const useProviderModelCatalogStore = create<ProviderModelCatalogState>((set) => ({
  models: [],
  ready: false,
  loading: false,
  saving: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const models = await fetchProviderModels();
      set({ models, ready: true, loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  replaceCredentialModels: async (credentialId, next) => {
    set({ saving: true, error: null });
    try {
      const result = await persistProviderModels(credentialId, next);
      if (!result.success) {
        set({ saving: false, error: result.error || 'Failed to persist provider models' });
        return;
      }
      set((state) => ({
        models: [
          ...state.models.filter((model) => model.credentialId !== credentialId),
          ...result.models,
        ],
        saving: false,
        ready: true,
      }));
    } catch (error) {
      set({ saving: false, error: String(error) });
    }
  },
}));
