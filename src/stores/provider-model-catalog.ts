import { create } from 'zustand';
import {
  fetchProviderModels,
  persistProviderModels,
  type ProviderModel,
} from '@/lib/provider-model-catalog';
import { useCapabilityRoutingStore } from '@/stores/capability-routing';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

interface ProviderModelCatalogState {
  models: ProviderModel[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: (runtimeAddress: RuntimeAddress) => Promise<void>;
  replaceCredentialModels: (
    credentialId: string,
    models: readonly Omit<ProviderModel, 'credentialId'>[],
    runtimeAddress: RuntimeAddress,
  ) => Promise<void>;
}

export const useProviderModelCatalogStore = create<ProviderModelCatalogState>((set) => ({
  models: [],
  ready: false,
  loading: false,
  saving: false,
  error: null,

  refresh: async (runtimeAddress) => {
    set({ loading: true, error: null });
    try {
      const models = await fetchProviderModels(runtimeAddress);
      set({ models, ready: true, loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  replaceCredentialModels: async (credentialId, next, runtimeAddress) => {
    set({ saving: true, error: null });
    try {
      const result = await persistProviderModels(credentialId, next, runtimeAddress);
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
      void useCapabilityRoutingStore.getState().refresh(runtimeAddress);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ saving: false, error: message });
      throw error;
    }
  },
}));
