import {
  CHAT_HISTORY_FULL_LIMIT,
  loadCronFallbackMessages,
} from './history-fetch-helpers';
import {
  buildHistoryFingerprint,
  buildQuickRawHistoryFingerprint,
  buildRenderMessagesFingerprint,
} from './store-state-helpers';
import type { StoreHistoryCache } from './history-cache';
import type { ChatStoreState, RawMessage } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface HandleHistoryLoadFailureInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  requestedSessionKey: string;
  quiet: boolean;
  historyRuntime: StoreHistoryCache;
  error: unknown;
  applyLoadedMessages: (rawMessages: RawMessage[], thinkingLevel: string | null) => Promise<void>;
}

export async function handleHistoryLoadFailure(
  input: HandleHistoryLoadFailureInput,
): Promise<void> {
  const {
    set,
    get,
    requestedSessionKey,
    quiet,
    historyRuntime,
    error,
    applyLoadedMessages,
  } = input;

  const fallbackMessages = await loadCronFallbackMessages(requestedSessionKey, CHAT_HISTORY_FULL_LIMIT);
  if (get().currentSessionKey !== requestedSessionKey) {
    return;
  }
  if (fallbackMessages.length > 0) {
    const fallbackFingerprint = buildHistoryFingerprint(fallbackMessages, null);
    historyRuntime.historyFingerprintBySession.set(requestedSessionKey, fallbackFingerprint);
    historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, fallbackFingerprint);
    await applyLoadedMessages(fallbackMessages, null);
    return;
  }

  if (quiet) {
    return;
  }

  const emptyFingerprint = buildHistoryFingerprint([], null);
  historyRuntime.historyFingerprintBySession.set(requestedSessionKey, emptyFingerprint);
  historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, emptyFingerprint);
  historyRuntime.historyQuickFingerprintBySession.set(requestedSessionKey, buildQuickRawHistoryFingerprint([], null));
  historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, buildRenderMessagesFingerprint([]));
  set({
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    sessionReadyByKey: {
      ...get().sessionReadyByKey,
      [requestedSessionKey]: true,
    },
    error: error instanceof Error ? error.message : String(error),
  });
}

