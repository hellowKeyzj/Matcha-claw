import {
  CHAT_HISTORY_FULL_LIMIT,
  type HistoryWindowResult,
  loadCronFallbackMessages,
} from './history-fetch-helpers';
import {
  buildHistoryFingerprint,
  buildQuickRawHistoryFingerprint,
  buildRenderMessagesFingerprint,
  patchSessionMeta,
} from './store-state-helpers';
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

interface HandleHistoryLoadFailureInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  requestedSessionKey: string;
  mode: ChatHistoryLoadMode;
  scope: ChatHistoryLoadScope;
  historyRuntime: StoreHistoryCache;
  error: unknown;
  applyLoadedMessages: (window: HistoryWindowResult) => Promise<void>;
}

export async function handleHistoryLoadFailure(
  input: HandleHistoryLoadFailureInput,
): Promise<void> {
  const {
    set,
    get,
    requestedSessionKey,
    mode,
    scope,
    historyRuntime,
    error,
    applyLoadedMessages,
  } = input;
  const quiet = mode === 'quiet';

  const fallbackMessages = await loadCronFallbackMessages(requestedSessionKey, CHAT_HISTORY_FULL_LIMIT);
  if (scope === 'foreground' && get().currentSessionKey !== requestedSessionKey) {
    return;
  }
  if (fallbackMessages.length > 0) {
    const fallbackFingerprint = buildHistoryFingerprint(fallbackMessages, null);
    historyRuntime.historyFingerprintBySession.set(requestedSessionKey, fallbackFingerprint);
    await applyLoadedMessages({
      rawMessages: fallbackMessages,
      canonicalRawMessages: fallbackMessages,
      thinkingLevel: null,
      totalMessageCount: fallbackMessages.length,
      windowStartOffset: 0,
      windowEndOffset: fallbackMessages.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    });
    return;
  }

  if (quiet) {
    return;
  }

  const emptyFingerprint = buildHistoryFingerprint([], null);
  historyRuntime.historyFingerprintBySession.set(requestedSessionKey, emptyFingerprint);
  historyRuntime.historyQuickFingerprintBySession.set(requestedSessionKey, buildQuickRawHistoryFingerprint([], null));
  historyRuntime.historyRenderFingerprintBySession.set(requestedSessionKey, buildRenderMessagesFingerprint([]));
  if (scope === 'background') {
    return;
  }
  set({
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    sessionsByKey: patchSessionMeta(get(), requestedSessionKey, {
      ready: true,
    }),
    error: error instanceof Error ? error.message : String(error),
  });
}
