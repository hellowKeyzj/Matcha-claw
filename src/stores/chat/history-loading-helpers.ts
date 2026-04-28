import type { StoreHistoryCache } from './history-cache';
import type {
  ChatHistoryLoadMode,
  ChatHistoryLoadScope,
  ChatStoreState,
} from './types';

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

  const snapshot = get();
  const session = snapshot.sessionsByKey[requestedSessionKey];
  const viewport = snapshot.viewportBySession[requestedSessionKey];
  const hasSnapshot = Boolean(session?.meta.ready) || (viewport?.messages.length ?? 0) > 0;
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
    scope,
    historyLoadRunId,
    historyRuntime,
    loadingSafetyTimer,
  } = input;

  if (loadingSafetyTimer) {
    clearTimeout(loadingSafetyTimer);
  }
  if (scope === 'foreground') {
    set((state) => {
      if (historyLoadRunId !== historyRuntime.getHistoryLoadRunId() || (!state.initialLoading && !state.refreshing)) {
        return state;
      }
      return { initialLoading: false, refreshing: false };
    });
  }
}
