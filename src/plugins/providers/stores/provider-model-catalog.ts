import { create } from 'zustand';
import i18n from '@/i18n';
import {
  fetchProviderModels,
  persistProviderModels,
  type ProviderModel,
  type ProviderModelDraft,
} from '@/plugins/providers/services/provider-model-catalog';
import { refreshProviderPostMutationProjections } from '@/plugins/providers/stores/provider-post-mutation-refresh';

let inflightRefreshTask: Promise<void> | null = null;
let latestCatalogRequestId = 0;
let pendingSaves = 0;

interface ProviderModelCatalogState {
  models: ProviderModel[];
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: (options?: { force?: boolean }) => Promise<void>;
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

  refresh: async (options) => {
    if (inflightRefreshTask && !options?.force) {
      await inflightRefreshTask;
      return;
    }
    const requestId = ++latestCatalogRequestId;
    inflightRefreshTask = (async () => {
      set({ loading: true, error: null });
      try {
        const models = await fetchProviderModels();
        if (requestId === latestCatalogRequestId) {
          set({ models, ready: true, loading: false });
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
    set({ saving: true, error: null });
    try {
      await persistProviderModels(accountId, next);
      const requestId = ++latestCatalogRequestId;
      inflightRefreshTask = null;
      set({ loading: false });
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
      }).catch(() => { set({ error: i18n.t('settings:aiProviders.dialog.projectionsUnavailable') }); });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({ error: message });
      throw error;
    } finally {
      set({ saving: --pendingSaves > 0 });
    }
  },
}));
