import { create } from 'zustand';
import {
  fetchCapabilityRouting,
  persistCapabilityRouting,
  type CapabilityKey,
  type CapabilityRouting,
  type ModelRoute,
} from '@/lib/capability-routing';
import type { RuntimeAddress } from '../../runtime-host/shared/runtime-address';

interface CapabilityRoutingState {
  routing: CapabilityRouting;
  ready: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  refresh: (runtimeAddress: RuntimeAddress) => Promise<void>;
  setRoute: (capability: CapabilityKey, route: ModelRoute | undefined, runtimeAddress: RuntimeAddress) => Promise<void>;
}

async function applyRoutingMutation(
  current: CapabilityRouting,
  runtimeAddress: RuntimeAddress,
  mutate: (draft: CapabilityRouting) => CapabilityRouting,
): Promise<{ next: CapabilityRouting; error?: string }> {
  const next = mutate({ ...current });
  const result = await persistCapabilityRouting(next, runtimeAddress);
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

  refresh: async (runtimeAddress) => {
    set({ loading: true, error: null });
    try {
      const routing = await fetchCapabilityRouting(runtimeAddress);
      set({ routing, ready: true, loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  setRoute: async (capability, route, runtimeAddress) => {
    set({ saving: true, error: null });
    try {
      const { next, error } = await applyRoutingMutation(get().routing, runtimeAddress, (draft) => {
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
