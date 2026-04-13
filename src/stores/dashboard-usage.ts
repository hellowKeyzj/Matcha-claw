import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { trackUiEvent } from '@/lib/telemetry';
import type { UsageHistoryEntry } from '@/pages/Dashboard/usage-history';

const DEFAULT_USAGE_FETCH_MAX_ATTEMPTS = 2;
const USAGE_FETCH_RETRY_DELAY_MS = 1500;
const USAGE_FETCH_BACKGROUND_RETRY_DELAY_MS = 5000;
const USAGE_FETCH_SAFETY_TIMEOUT_MS = 30_000;

interface RefreshUsageHistoryOptions {
  maxAttempts?: number;
  restartMarker?: string;
  reason?: string;
  silent?: boolean;
}

interface DashboardUsageState {
  usageHistory: UsageHistoryEntry[];
  usageHistoryReady: boolean;
  initialLoading: boolean;
  refreshing: boolean;
  usagePanelReady: boolean;
  usageChartReady: boolean;
  usageDetailListReady: boolean;
  error: string | null;
  setUsagePanelReady: (ready: boolean) => void;
  setUsageVisualizationReady: (ready: boolean) => void;
  refreshUsageHistory: (options?: RefreshUsageHistoryOptions) => Promise<void>;
}

let usageHistoryCache: UsageHistoryEntry[] = [];
let usageHistoryReadyCache = false;
let inflightUsageRefreshTask: Promise<void> | null = null;
let inflightUsageRefreshMarker: string | null = null;
let latestUsageRefreshRequestId = 0;

function cloneUsageHistory(entries: UsageHistoryEntry[]): UsageHistoryEntry[] {
  return entries.map((entry) => ({ ...entry }));
}

function resolveRetryDelayMs(): number {
  return document.visibilityState === 'visible'
    ? USAGE_FETCH_RETRY_DELAY_MS
    : USAGE_FETCH_BACKGROUND_RETRY_DELAY_MS;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export const useDashboardUsageStore = create<DashboardUsageState>((set, get) => ({
  usageHistory: cloneUsageHistory(usageHistoryCache),
  usageHistoryReady: usageHistoryReadyCache,
  initialLoading: !usageHistoryReadyCache,
  refreshing: false,
  usagePanelReady: usageHistoryReadyCache,
  usageChartReady: false,
  usageDetailListReady: false,
  error: null,

  setUsagePanelReady: (ready) => {
    set((state) => (state.usagePanelReady === ready ? state : { usagePanelReady: ready }));
  },

  setUsageVisualizationReady: (ready) => {
    set((state) => (
      state.usageChartReady === ready && state.usageDetailListReady === ready
        ? state
        : {
          usageChartReady: ready,
          usageDetailListReady: ready,
        }
    ));
  },

  refreshUsageHistory: async (options) => {
    const restartMarker = options?.restartMarker ?? 'na:na';
    const reason = options?.reason ?? 'background_refresh';
    const silent = options?.silent === true;
    const maxAttemptsRaw = options?.maxAttempts;
    const maxAttempts = Number.isFinite(maxAttemptsRaw) && Number(maxAttemptsRaw) > 0
      ? Math.max(1, Math.floor(Number(maxAttemptsRaw)))
      : DEFAULT_USAGE_FETCH_MAX_ATTEMPTS;

    if (inflightUsageRefreshTask && inflightUsageRefreshMarker === restartMarker) {
      await inflightUsageRefreshTask;
      return;
    }

    const requestId = ++latestUsageRefreshRequestId;
    const hasCache = get().usageHistoryReady;
    if (hasCache) {
      if (!silent) {
        set({ refreshing: true, initialLoading: false, error: null });
      }
    } else {
      set({ initialLoading: true, refreshing: false, error: null });
    }

    trackUiEvent('dashboard.token_usage_fetch_started', {
      requestId,
      reason,
      restartMarker,
      cacheHit: hasCache,
    });

    const startedAt = Date.now();
    const task = (async () => {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        if (requestId !== latestUsageRefreshRequestId) {
          return;
        }

        const elapsed = Date.now() - startedAt;
        if (elapsed >= USAGE_FETCH_SAFETY_TIMEOUT_MS) {
          if (requestId !== latestUsageRefreshRequestId) {
            return;
          }
          const timeoutMessage = `Token usage refresh timed out after ${String(USAGE_FETCH_SAFETY_TIMEOUT_MS)}ms`;
          set({
            error: timeoutMessage,
            initialLoading: false,
            refreshing: false,
          });
          trackUiEvent('dashboard.token_usage_fetch_safety_timeout', {
            requestId,
            reason,
            restartMarker,
          });
          return;
        }

        trackUiEvent('dashboard.token_usage_fetch_attempt', {
          requestId,
          reason,
          restartMarker,
          attempt,
        });

        try {
          const payload = await hostApiFetch<UsageHistoryEntry[]>('/api/runtime-host/usage/recent');
          if (requestId !== latestUsageRefreshRequestId) {
            return;
          }

          const normalized = Array.isArray(payload) ? payload : [];
          const cloned = cloneUsageHistory(normalized);
          usageHistoryCache = cloned;
          usageHistoryReadyCache = true;

          set({
            usageHistory: cloned,
            usageHistoryReady: true,
            initialLoading: false,
            refreshing: false,
            error: null,
          });

          trackUiEvent('dashboard.token_usage_fetch_succeeded', {
            requestId,
            reason,
            restartMarker,
            attempt,
            records: cloned.length,
          });

          if (cloned.length === 0 && attempt < maxAttempts) {
            trackUiEvent('dashboard.token_usage_fetch_retry_scheduled', {
              requestId,
              reason,
              restartMarker,
              attempt,
              retryReason: 'empty',
            });
            await delay(resolveRetryDelayMs());
            continue;
          }

          if (cloned.length === 0) {
            trackUiEvent('dashboard.token_usage_fetch_exhausted', {
              requestId,
              reason,
              restartMarker,
              attempt,
              exhaustedReason: 'empty',
            });
          }
          return;
        } catch (error) {
          if (requestId !== latestUsageRefreshRequestId) {
            return;
          }

          const message = error instanceof Error ? error.message : String(error);
          trackUiEvent('dashboard.token_usage_fetch_failed_attempt', {
            requestId,
            reason,
            restartMarker,
            attempt,
            message,
          });

          if (attempt < maxAttempts) {
            trackUiEvent('dashboard.token_usage_fetch_retry_scheduled', {
              requestId,
              reason,
              restartMarker,
              attempt,
              retryReason: 'error',
            });
            await delay(resolveRetryDelayMs());
            continue;
          }

          set({
            error: message,
            initialLoading: false,
            refreshing: false,
          });
          trackUiEvent('dashboard.token_usage_fetch_exhausted', {
            requestId,
            reason,
            restartMarker,
            attempt,
            exhaustedReason: 'error',
          });
          return;
        }
      }
    })();

    inflightUsageRefreshTask = task;
    inflightUsageRefreshMarker = restartMarker;
    try {
      await task;
    } finally {
      if (inflightUsageRefreshTask === task) {
        inflightUsageRefreshTask = null;
        inflightUsageRefreshMarker = null;
      }
    }
  },
}));
