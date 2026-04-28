import { hostApiFetch, hostSessionWindowFetch, type HostSessionWindowPayload } from '@/lib/host-api';
import { trackUiTiming } from '@/lib/telemetry';
import { useGatewayStore } from '../gateway';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import { resolveSessionThinkingLevelFromList } from './session-helpers';
import {
  buildHistoryFingerprint,
  nowMs,
} from './store-state-helpers';
import {
  throwIfHistoryLoadAborted,
} from './history-abort';
import type { StoreHistoryCache } from './history-cache';
import type {
  ChatHistoryLoadMode,
  ChatHistoryLoadScope,
  ChatSession,
  ChatStoreState,
  RawMessage,
} from './types';

export const CHAT_HISTORY_FULL_LIMIT = 200;
export const CHAT_HISTORY_LOADING_TIMEOUT_MS = 15_000;

export interface HistoryWindowResult {
  rawMessages: RawMessage[];
  canonicalRawMessages: RawMessage[] | null;
  thinkingLevel: string | null;
  totalMessageCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}

interface CreateFetchHistoryWindowInput {
  requestedSessionKey: string;
  getSessions: () => ChatSession[];
}

async function fetchGatewayHistoryFallback(
  requestedSessionKey: string,
  limit: number,
): Promise<RawMessage[]> {
  let rawMessages = await loadCronFallbackMessages(requestedSessionKey, limit);
  if (rawMessages.length > 0) {
    return rawMessages;
  }

  try {
    const sessionsGetData = await useGatewayStore.getState().rpc<Record<string, unknown>>(
      'sessions.get',
      { key: requestedSessionKey, limit },
    );
    if (Array.isArray(sessionsGetData?.messages)) {
      rawMessages = sessionsGetData.messages as RawMessage[];
    }
  } catch {
    void 0;
  }

  if (rawMessages.length > 0) {
    return rawMessages;
  }

  try {
    const data = await useGatewayStore.getState().rpc<Record<string, unknown>>(
      'chat.history',
      { sessionKey: requestedSessionKey, limit },
    );
    rawMessages = Array.isArray(data?.messages) ? data.messages as RawMessage[] : [];
  } catch {
    void 0;
  }

  return rawMessages;
}

interface RunHistoryPipelineInput {
  getState: () => ChatStoreState;
  mode: ChatHistoryLoadMode;
  scope: ChatHistoryLoadScope;
  requestedSessionKey: string;
  historyRuntime: StoreHistoryCache;
  abortSignal: AbortSignal;
  isAborted: () => boolean;
  fetchHistoryWindow: (limit: number) => Promise<HistoryWindowResult>;
  applyLoadedMessages: (window: HistoryWindowResult) => Promise<void>;
}

function shouldSkipByForegroundSessionMismatch(
  scope: ChatHistoryLoadScope,
  state: ChatStoreState,
  requestedSessionKey: string,
): boolean {
  return scope === 'foreground' && state.currentSessionKey !== requestedSessionKey;
}

async function measureHistoryStep<T>(
  event: string,
  payload: Record<string, unknown>,
  task: () => Promise<T>,
): Promise<T> {
  const startedAt = nowMs();
  try {
    return await task();
  } finally {
    trackUiTiming(event, Math.max(0, nowMs() - startedAt), payload);
  }
}

export async function loadCronFallbackMessages(
  sessionKey: string,
  limit = CHAT_HISTORY_FULL_LIMIT,
): Promise<RawMessage[]> {
  if (!isCronSessionKey(sessionKey)) return [];
  try {
    const payload = await hostApiFetch<unknown>(buildCronSessionHistoryPath(sessionKey, limit));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Invalid cron session history payload: expected object');
    }
    const record = payload as Record<string, unknown>;
    if (!Array.isArray(record.messages)) {
      throw new Error('Invalid cron session history payload: expected messages[]');
    }
    return record.messages as RawMessage[];
  } catch {
    return [];
  }
}

export function createFetchHistoryWindow(
  input: CreateFetchHistoryWindowInput,
): (limit: number) => Promise<HistoryWindowResult> {
  const { requestedSessionKey, getSessions } = input;

  return async (limit: number): Promise<HistoryWindowResult> => {
    try {
      const data = await hostSessionWindowFetch({
        sessionKey: requestedSessionKey,
        mode: 'latest',
        limit,
        includeCanonical: true,
      });
      const resolvedWindow: HistoryWindowResult = {
        rawMessages: data.messages as RawMessage[],
        canonicalRawMessages: Array.isArray(data.canonicalMessages)
          ? data.canonicalMessages as RawMessage[]
          : null,
        thinkingLevel: resolveSessionThinkingLevelFromList(getSessions(), requestedSessionKey),
        totalMessageCount: data.totalMessageCount,
        windowStartOffset: data.windowStartOffset,
        windowEndOffset: data.windowEndOffset,
        hasMore: data.hasMore,
        hasNewer: data.hasNewer,
        isAtLatest: data.isAtLatest,
      };
      if (data.totalMessageCount > 0 || data.messages.length > 0) {
        return resolvedWindow;
      }

      const fallbackMessages = await fetchGatewayHistoryFallback(requestedSessionKey, limit);
      if (fallbackMessages.length === 0) {
        return resolvedWindow;
      }

      return {
        rawMessages: fallbackMessages,
        canonicalRawMessages: fallbackMessages,
        thinkingLevel: resolveSessionThinkingLevelFromList(getSessions(), requestedSessionKey),
        totalMessageCount: fallbackMessages.length,
        windowStartOffset: 0,
        windowEndOffset: fallbackMessages.length,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      };
    } catch {
      const rawMessages = await fetchGatewayHistoryFallback(requestedSessionKey, limit);
      const fallbackWindow: HostSessionWindowPayload = {
        messages: rawMessages,
        canonicalMessages: rawMessages,
        totalMessageCount: rawMessages.length,
        windowStartOffset: 0,
        windowEndOffset: rawMessages.length,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      };
      return {
        rawMessages,
        canonicalRawMessages: rawMessages,
        thinkingLevel: resolveSessionThinkingLevelFromList(getSessions(), requestedSessionKey),
        totalMessageCount: rawMessages.length || fallbackWindow.totalMessageCount,
        windowStartOffset: 0,
        windowEndOffset: rawMessages.length || fallbackWindow.windowEndOffset,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      };
    }
  };
}

export async function loadHistoryWindow(input: RunHistoryPipelineInput): Promise<void> {
  const {
    getState,
    mode,
    scope,
    requestedSessionKey,
    historyRuntime,
    abortSignal,
    isAborted,
    fetchHistoryWindow,
    applyLoadedMessages,
  } = input;

  throwIfHistoryLoadAborted(abortSignal, isAborted);
  const window = await measureHistoryStep('chat.history_fetch_window', {
    mode,
    sessionKey: requestedSessionKey,
    limit: CHAT_HISTORY_FULL_LIMIT,
  }, async () => fetchHistoryWindow(CHAT_HISTORY_FULL_LIMIT));
  throwIfHistoryLoadAborted(abortSignal, isAborted);
  if (shouldSkipByForegroundSessionMismatch(scope, getState(), requestedSessionKey)) {
    return;
  }
  const fingerprint = buildHistoryFingerprint(window.canonicalRawMessages ?? window.rawMessages, window.thinkingLevel);
  historyRuntime.historyFingerprintBySession.set(requestedSessionKey, fingerprint);
  await measureHistoryStep('chat.history_apply_window', {
    mode,
    sessionKey: requestedSessionKey,
    rows: window.rawMessages.length,
  }, async () => applyLoadedMessages(window));
}
