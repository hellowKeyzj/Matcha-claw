import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { trackUiEvent } from '@/lib/telemetry';
import type { UsageHistory } from '@/types/desktop/usage';
import {
  runtimeEndpointsEqual,
  runtimeInstanceScope,
  runtimeScopeQuery,
  type RuntimeEndpointRef,
} from '@/types/desktop/runtime-address';

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

export type UsageSessionDetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | ({ status: 'loaded' } & UsageHistory)
  | { status: 'error'; message: string };

interface DashboardUsageState {
  endpoint: RuntimeEndpointRef | null;
  usageHistory: UsageHistory | null;
  refreshing: boolean;
  sessionDetails: Record<string, UsageSessionDetailState>;
  error: string | null;
  setEndpoint: (endpoint: RuntimeEndpointRef | null) => void;
  loadSessionDetails: (sessionId: string, agentId: string) => Promise<void>;
  refreshUsageHistory: (options?: RefreshUsageHistoryOptions) => Promise<void>;
}

let inflightUsageRefreshTask: Promise<void> | null = null;
let inflightUsageRefreshMarker: string | null = null;
let latestUsageRefreshRequestId = 0;
let usageScopeGeneration = 0;
const inflightSessionDetailTasks = new Map<string, Promise<void>>();

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
  endpoint: null,
  usageHistory: null,
  refreshing: false,
  sessionDetails: {},
  error: null,

  setEndpoint: (endpoint) => {
    const previous = get().endpoint;
    if (previous === endpoint || (previous && endpoint && runtimeEndpointsEqual(previous, endpoint))) return;
    usageScopeGeneration += 1;
    latestUsageRefreshRequestId += 1;
    inflightUsageRefreshTask = null;
    inflightUsageRefreshMarker = null;
    inflightSessionDetailTasks.clear();
    set({
      endpoint,
      usageHistory: null,
      refreshing: false,
      sessionDetails: {},
      error: null,
    });
  },

  loadSessionDetails: async (sessionId, agentId) => {
    const endpoint = get().endpoint;
    if (!endpoint || !sessionId || !agentId) return;
    const scope = runtimeInstanceScope(endpoint);
    const generation = usageScopeGeneration;
    const current = get().sessionDetails[sessionId];
    if (current?.status === 'loaded' || current?.status === 'loading') {
      const inflight = inflightSessionDetailTasks.get(sessionId);
      if (inflight) await inflight;
      return;
    }

    const task = (async () => {
      set((state) => ({
        sessionDetails: { ...state.sessionDetails, [sessionId]: { status: 'loading' } },
      }));

      try {
        const payload = await hostApiFetch<UsageHistory>(`/api/runtime-host/usage/session-timeseries?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId)}&${runtimeScopeQuery(scope)}`);
        if (generation !== usageScopeGeneration) return;
        set((state) => ({
          sessionDetails: { ...state.sessionDetails, [sessionId]: { status: 'loaded', ...payload } },
        }));
      } catch (error) {
        if (generation !== usageScopeGeneration) return;
        const message = error instanceof Error ? error.message : String(error);
        set((state) => ({
          sessionDetails: { ...state.sessionDetails, [sessionId]: { status: 'error', message } },
        }));
      }
    })();

    inflightSessionDetailTasks.set(sessionId, task);
    try {
      await task;
    } finally {
      if (inflightSessionDetailTasks.get(sessionId) === task) {
        inflightSessionDetailTasks.delete(sessionId);
      }
    }
  },

  refreshUsageHistory: async (options) => {
    const endpoint = get().endpoint;
    if (!endpoint) return;
    const scope = runtimeInstanceScope(endpoint);
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
    const hasCache = get().usageHistory !== null;
    if (!hasCache || !silent) {
      set({ refreshing: hasCache, error: null });
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
          const payload = await hostApiFetch<UsageHistory>(`/api/runtime-host/usage/recent?${runtimeScopeQuery(scope)}`);
          if (requestId !== latestUsageRefreshRequestId) {
            return;
          }

          set({ usageHistory: payload, refreshing: false, error: null });

          trackUiEvent('dashboard.token_usage_fetch_succeeded', {
            requestId,
            reason,
            restartMarker,
            attempt,
            records: payload.entries.length,
          });

          const retryEmpty = payload.coverage.kind === 'reported' && payload.entries.length === 0;
          if (retryEmpty && attempt < maxAttempts) {
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

          if (retryEmpty) {
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
