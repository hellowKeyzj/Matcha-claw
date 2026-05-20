import { create } from 'zustand';
import {
  fetchCapabilityRouting,
  persistCapabilityRouting,
  type CapabilityKey,
  type CapabilityRouting,
  type ModelRoute,
} from '@/lib/capability-routing';

interface CapabilityRoutingState {
  routing: CapabilityRouting;
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setRoute: (capability: CapabilityKey, route: ModelRoute | undefined) => Promise<void>;
}

async function applyRoutingMutation(
  current: CapabilityRouting,
  mutate: (draft: CapabilityRouting) => CapabilityRouting,
): Promise<{ next: CapabilityRouting; error?: string }> {
  const next = mutate({ ...current });
  const result = await persistCapabilityRouting(next);
  if (!result.success) {
    return { next: current, error: result.error || 'Failed to persist capability routing' };
  }
  return { next: result.routing };
}

export const useCapabilityRoutingStore = create<CapabilityRoutingState>((set, get) => ({
  routing: {},
  ready: false,
  loading: false,
  saving: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const routing = await fetchCapabilityRouting();
      set({ routing, ready: true, loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  setRoute: async (capability, route) => {
    set({ saving: true, error: null });
    try {
      const { next, error } = await applyRoutingMutation(get().routing, (draft) => {
        if (route) {
          draft[capability] = route;
        } else {
          delete draft[capability];
        }
        return draft;
      });
      if (error) {
        set({ saving: false, error });
        return;
      }
      set({ routing: next, saving: false, ready: true });
    } catch (error) {
      set({ saving: false, error: String(error) });
    }
  },
}));
