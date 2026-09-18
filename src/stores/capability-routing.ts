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

async function applyRoutingMutation(
  current: CapabilityRouting,
  revision: number,
  mutate: (draft: CapabilityRouting) => CapabilityRouting,
): Promise<{ next: CapabilityRouting; revision: number; error?: string; warning?: string }> {
  const next = mutate({ ...current });
  const result = await persistCapabilityRouting(next, revision);
  if (!result.success) {
    return { next: current, revision, error: result.error || 'Failed to persist capability routing' };
  }
  return { next: result.routing, revision: result.revision, ...(result.warning ? { warning: result.warning } : {}) };
}

export const useCapabilityRoutingStore = create<CapabilityRoutingState>((set, get) => ({
  routing: {},
  revision: null,
  ready: false,
  loading: false,
  saving: false,
  error: null,
  warning: null,

  refresh: async () => {
    set({ loading: true, error: null, warning: null });
    try {
      const snapshot = await fetchCapabilityRouting();
      set({ routing: snapshot.routing, revision: snapshot.revision, ready: true, loading: false, warning: null });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  setRoute: async (capability, route) => {
    set({ saving: true, error: null, warning: null });
    try {
      const currentRevision = get().revision;
      const nextRevision = currentRevision === null ? 1 : currentRevision + 1;
      const { next, revision: persistedRevision, error, warning } = await applyRoutingMutation(get().routing, nextRevision, (draft) => {
        if (route) {
          draft[capability] = route;
        } else {
          delete draft[capability];
        }
        return draft;
      });
      if (error && next === get().routing) {
        set({ saving: false, error });
        return;
      }
      set({ routing: next, revision: persistedRevision, saving: false, ready: true, error: null, warning: warning ?? null });
      await refreshProviderPostMutationProjections({
        refreshCapabilityRouting: false,
      });
    } catch (error) {
      set({ saving: false, error: String(error) });
    }
  },
}));
