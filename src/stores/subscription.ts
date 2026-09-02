import { create } from 'zustand';
import {
  fetchActiveSubscriptions,
  fetchPlatformQuotas,
  fetchSubscriptionProgress,
  fetchSubscriptionSummary,
} from '@/lib/subscription';

export type SubscriptionSummary = Awaited<ReturnType<typeof fetchSubscriptionSummary>>;
export type ActiveSubscriptions = Awaited<ReturnType<typeof fetchActiveSubscriptions>>;
export type SubscriptionProgress = Awaited<ReturnType<typeof fetchSubscriptionProgress>>;
export type PlatformQuotas = Awaited<ReturnType<typeof fetchPlatformQuotas>>;
export type SubscriptionStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface SubscriptionStoreState {
  summary: SubscriptionSummary | null;
  active: ActiveSubscriptions | null;
  progress: SubscriptionProgress | null;
  platformQuotas: PlatformQuotas | null;
  status: SubscriptionStatus;
  errorMessage: string | null;
  refreshAll: () => Promise<void>;
  refreshSummary: () => Promise<void>;
  refreshUsage: () => Promise<void>;
  clear: () => void;
}

let latestSubscriptionRequestId = 0;

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const useSubscriptionStore = create<SubscriptionStoreState>((set) => ({
  summary: null,
  active: null,
  progress: null,
  platformQuotas: null,
  status: 'idle',
  errorMessage: null,

  refreshAll: async () => {
    const requestId = ++latestSubscriptionRequestId;
    set({ status: 'loading', errorMessage: null });

    try {
      const [summary, active, progress, platformQuotas] = await Promise.all([
        fetchSubscriptionSummary(),
        fetchActiveSubscriptions(),
        fetchSubscriptionProgress(),
        fetchPlatformQuotas(),
      ]);
      if (requestId !== latestSubscriptionRequestId) return;

      set({
        summary,
        active,
        progress,
        platformQuotas,
        status: 'ready',
        errorMessage: null,
      });
    } catch (error) {
      if (requestId !== latestSubscriptionRequestId) return;
      set({ status: 'error', errorMessage: messageFromError(error) });
    }
  },

  refreshSummary: async () => {
    const requestId = ++latestSubscriptionRequestId;
    set({ status: 'loading', errorMessage: null });

    try {
      const [summary, active] = await Promise.all([
        fetchSubscriptionSummary(),
        fetchActiveSubscriptions(),
      ]);
      if (requestId !== latestSubscriptionRequestId) return;

      set({
        summary,
        active,
        status: 'ready',
        errorMessage: null,
      });
    } catch (error) {
      if (requestId !== latestSubscriptionRequestId) return;
      set({ status: 'error', errorMessage: messageFromError(error) });
    }
  },

  refreshUsage: async () => {
    const requestId = ++latestSubscriptionRequestId;
    set({ status: 'loading', errorMessage: null });

    try {
      const [progress, platformQuotas] = await Promise.all([
        fetchSubscriptionProgress(),
        fetchPlatformQuotas(),
      ]);
      if (requestId !== latestSubscriptionRequestId) return;

      set({
        progress,
        platformQuotas,
        status: 'ready',
        errorMessage: null,
      });
    } catch (error) {
      if (requestId !== latestSubscriptionRequestId) return;
      set({ status: 'error', errorMessage: messageFromError(error) });
    }
  },

  clear: () => {
    latestSubscriptionRequestId += 1;
    set({
      summary: null,
      active: null,
      progress: null,
      platformQuotas: null,
      status: 'idle',
      errorMessage: null,
    });
  },
}));
