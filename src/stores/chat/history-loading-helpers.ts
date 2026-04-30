import type { StoreHistoryCache } from './history-cache';
import type {
  ChatHistoryLoadMode,
  ChatHistoryLoadScope,
  ChatStoreState,
} from './types';
import { patchSessionMeta } from './store-state-helpers';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateHistoryLoadAbortGuardInput {
  get: ChatStoreGetFn;
  requestedSessionKey: string;
  mode: ChatHistoryLoadMode;
  scope: ChatHistoryLoadScope;
  historyLoadRunId: number;
  historyRuntime: StoreHistoryCache;
  abortSignal?: AbortSignal;
}

interface BeginHistoryLoadUiStateInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  requestedSessionKey: string;
  mode: ChatHistoryLoadMode;
  scope: ChatHistoryLoadScope;
  historyLoadRunId: number;
  historyRuntime: StoreHistoryCache;
  timeoutMs: number;
}

interface FinalizeHistoryLoadUiStateInput {
  set: ChatStoreSetFn;
  scope: ChatHistoryLoadScope;
  requestedSessionKey: string;
  historyLoadRunId: number;
  historyRuntime: StoreHistoryCache;
  loadingSafetyTimer: ReturnType<typeof setTimeout> | null;
}

export function createHistoryLoadAbortGuard(
  input: CreateHistoryLoadAbortGuardInput,
): () => boolean {
  const {
    get,
    requestedSessionKey,
    scope,
    historyLoadRunId,
    historyRuntime,
    abortSignal,
  } = input;
  return () => (
    Boolean(abortSignal?.aborted)
    ||
    (scope === 'foreground' && get().currentSessionKey !== requestedSessionKey)
    || (scope === 'foreground' && historyLoadRunId !== historyRuntime.getHistoryLoadRunId())
  );
}

export function beginHistoryLoadUiState(
  input: BeginHistoryLoadUiStateInput,
): ReturnType<typeof setTimeout> | null {
  const {
    set,
    get,
    requestedSessionKey,
    scope,
    historyLoadRunId,
    historyRuntime,
    timeoutMs,
  } = input;

  if (scope === 'background') {
    return null;
  }

  set({
    foregroundHistorySessionKey: requestedSessionKey,
    error: null,
    ...(input.mode === 'active'
      ? {
          loadedSessions: patchSessionMeta(get(), requestedSessionKey, {
            historyStatus: 'loading',
          }),
        }
      : {}),
  });

  return setTimeout(() => {
    set((state) => {
      if (
        historyLoadRunId !== historyRuntime.getHistoryLoadRunId()
        || state.foregroundHistorySessionKey !== requestedSessionKey
      ) {
        return state;
      }
      return { foregroundHistorySessionKey: null };
    });
  }, timeoutMs);
}

export function finalizeHistoryLoadUiState(input: FinalizeHistoryLoadUiStateInput): void {
  const {
    set,
    scope,
    requestedSessionKey,
    historyLoadRunId,
    historyRuntime,
    loadingSafetyTimer,
  } = input;

  if (loadingSafetyTimer) {
    clearTimeout(loadingSafetyTimer);
  }
  if (scope === 'foreground') {
    set((state) => {
      if (
        historyLoadRunId !== historyRuntime.getHistoryLoadRunId()
        || state.foregroundHistorySessionKey !== requestedSessionKey
      ) {
        return state;
      }
      return { foregroundHistorySessionKey: null };
    });
  }
}
