import { create } from 'zustand';
import {
  fetchCapabilityRouting,
  persistCapabilityRouting,
  type CapabilityKey,
  type CapabilityRouting,
  type ModelRoute,
} from '@/lib/capability-routing';
import { refreshProviderPostMutationProjections } from '@/stores/provider-post-mutation-refresh';

interface CapabilityRoutingState {
  routing: CapabilityRouting;
  revision: number | null;
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  warning: string | null;
  refresh: () => Promise<void>;
  setRoute: (capability: CapabilityKey, route: ModelRoute | undefined) => Promise<void>;
}

let latestRefreshId = 0;
let pendingSaves = 0;

export const useCapabilityRoutingStore = create<CapabilityRoutingState>((set, get) => ({
  routing: {},
  revision: null,
  ready: false,
  loading: false,
  saving: false,
  error: null,
  warning: null,

  refresh: async () => {
    const refreshId = ++latestRefreshId;
    set({ loading: true, error: null, warning: null });
    try {
      const snapshot = await fetchCapabilityRouting();
      if (refreshId !== latestRefreshId) return;
      if ((snapshot.revision ?? 0) >= (get().revision ?? 0)) {
        set({ routing: snapshot.routing, revision: snapshot.revision, ready: true });
      }
      set({ loading: false });
    } catch (error) {
      if (refreshId === latestRefreshId) set({ loading: false, error: String(error) });
    }
  },

  setRoute: async (capability, route) => {
    ++pendingSaves;
    set({ saving: true, error: null, warning: null });
    try {
      const { routing, revision } = get();
      const next = { ...routing };
      if (route) {
        next[capability] = route;
      } else {
        delete next[capability];
      }
      const result = await persistCapabilityRouting(next, revision === null ? 1 : revision + 1);
      if (!result.success) {
        set({ error: result.error || 'Failed to persist capability routing' });
        return;
      }
      ++latestRefreshId;
      set({ loading: false });
      if ((result.revision ?? 0) >= (get().revision ?? 0)) {
        set({ routing: result.routing, revision: result.revision, ready: true, warning: result.warning ?? null });
      }
      await refreshProviderPostMutationProjections({
        refreshCapabilityRouting: false,
      });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ saving: --pendingSaves > 0 });
    }
  },
}));
