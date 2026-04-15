import type { StoreHistoryCache } from './history-cache';
import type { ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateHistoryLoadAbortGuardInput {
  get: ChatStoreGetFn;
  requestedSessionKey: string;
  quiet: boolean;
  historyLoadRunId: number;
  historyRuntime: StoreHistoryCache;
  abortSignal?: AbortSignal;
}

interface BeginHistoryLoadUiStateInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  requestedSessionKey: string;
  quiet: boolean;
  historyLoadRunId: number;
  historyRuntime: StoreHistoryCache;
  timeoutMs: number;
}

interface FinalizeHistoryLoadUiStateInput {
  set: ChatStoreSetFn;
  quiet: boolean;
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
    quiet,
    historyLoadRunId,
    historyRuntime,
    abortSignal,
  } = input;
  return () => (
    Boolean(abortSignal?.aborted)
    ||
    get().currentSessionKey !== requestedSessionKey
    || (!quiet && historyLoadRunId !== historyRuntime.getHistoryLoadRunId())
  );
}

export function beginHistoryLoadUiState(
  input: BeginHistoryLoadUiStateInput,
): ReturnType<typeof setTimeout> | null {
  const {
    set,
    get,
    requestedSessionKey,
    quiet,
    historyLoadRunId,
    historyRuntime,
    timeoutMs,
  } = input;

  if (quiet) {
    return null;
  }

  const snapshot = get();
  const hasSnapshot = Boolean(snapshot.sessionReadyByKey[requestedSessionKey]) || snapshot.messages.length > 0;
  set({
    initialLoading: !hasSnapshot,
    refreshing: hasSnapshot,
    error: null,
  });

  return setTimeout(() => {
    set((state) => {
      if (historyLoadRunId !== historyRuntime.getHistoryLoadRunId() || (!state.initialLoading && !state.refreshing)) {
        return state;
      }
      return { initialLoading: false, refreshing: false };
    });
  }, timeoutMs);
}

export function finalizeHistoryLoadUiState(input: FinalizeHistoryLoadUiStateInput): void {
  const {
    set,
    quiet,
    historyLoadRunId,
    historyRuntime,
    loadingSafetyTimer,
  } = input;

  if (loadingSafetyTimer) {
    clearTimeout(loadingSafetyTimer);
  }
  if (!quiet) {
    set((state) => {
      if (historyLoadRunId !== historyRuntime.getHistoryLoadRunId() || (!state.initialLoading && !state.refreshing)) {
        return state;
      }
      return { initialLoading: false, refreshing: false };
    });
  }
}

