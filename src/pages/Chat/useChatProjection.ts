import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RawMessage } from '@/stores/chat';
import { loadCronFallbackMessages } from '@/stores/chat/history-fetch-helpers';
import { buildHistoryProjectionMessages } from './chat-projection-model';

const CHAT_HISTORY_LIMIT = 1000;

type ChatReadProjection = 'live' | 'history';
type HistoryResourceStatus = 'idle' | 'loading' | 'ready' | 'error';

interface HistoryResourceState {
  sessionKey: string;
  status: HistoryResourceStatus;
  messages: RawMessage[];
  error: string | null;
}

interface HistoryCacheEntry {
  messages: RawMessage[];
}

interface HistoryProjectionCacheEntry {
  sessionKey: string;
  historyBaseFingerprint: string;
  liveTailFingerprint: string;
  mergedMessages: RawMessage[];
}

export interface ChatProjectionCacheStats {
  cachedSessionCount: number;
  cachedMessageCount: number;
}

const globalHistoryCache = new Map<string, HistoryCacheEntry>();

interface UseChatProjectionInput {
  currentSessionKey: string;
  liveMessages: RawMessage[];
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
}

interface UseChatProjectionResult {
  readProjection: ChatReadProjection;
  projectionScopeKey: string;
  isHistoryProjection: boolean;
  loading: boolean;
  error: string | null;
  messages: RawMessage[];
  enterHistory: () => void;
  returnToLive: () => void;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) {
    return error;
  }
  return 'Failed to load history';
}

async function fetchHistoryMessages(
  gatewayRpc: UseChatProjectionInput['gatewayRpc'],
  sessionKey: string,
): Promise<RawMessage[]> {
  try {
    const sessionsGetData = await gatewayRpc<Record<string, unknown>>(
      'sessions.get',
      { key: sessionKey, limit: CHAT_HISTORY_LIMIT },
    );
    if (Array.isArray(sessionsGetData?.messages)) {
      const rawMessages = sessionsGetData.messages as RawMessage[];
      if (rawMessages.length > 0) {
        return rawMessages;
      }
    }
  } catch {
    // Fall through to chat.history.
  }

  const chatHistoryData = await gatewayRpc<Record<string, unknown>>(
    'chat.history',
    { sessionKey, limit: CHAT_HISTORY_LIMIT },
  );
  const rawMessages = Array.isArray(chatHistoryData?.messages)
    ? chatHistoryData.messages as RawMessage[]
    : [];
  if (rawMessages.length > 0) {
    return rawMessages;
  }
  return loadCronFallbackMessages(sessionKey, CHAT_HISTORY_LIMIT);
}

export function useChatProjection({
  currentSessionKey,
  liveMessages,
  gatewayRpc,
}: UseChatProjectionInput): UseChatProjectionResult {
  const emptyMessagesRef = useRef<RawMessage[]>([]);
  const [readProjection, setReadProjection] = useState<ChatReadProjection>('live');
  const [historyState, setHistoryState] = useState<HistoryResourceState>({
    sessionKey: currentSessionKey,
    status: 'idle',
    messages: [],
    error: null,
  });
  const historyCacheRef = useRef<Map<string, HistoryCacheEntry>>(globalHistoryCache);
  const projectionCacheRef = useRef<HistoryProjectionCacheEntry | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    requestIdRef.current += 1;
    setReadProjection('live');
    setHistoryState({
      sessionKey: currentSessionKey,
      status: 'idle',
      messages: historyCacheRef.current.get(currentSessionKey)?.messages ?? [],
      error: null,
    });
  }, [currentSessionKey]);

  const returnToLive = useCallback(() => {
    requestIdRef.current += 1;
    setReadProjection('live');
    setHistoryState((previous) => (
      previous.sessionKey === currentSessionKey
        ? { ...previous, error: null }
        : previous
    ));
  }, [currentSessionKey]);

  const refreshHistoryResource = useCallback((
    sessionKey: string,
    requestId: number,
  ) => {
    void fetchHistoryMessages(gatewayRpc, sessionKey)
      .then((messages) => {
        historyCacheRef.current.set(sessionKey, { messages });
        if (requestIdRef.current !== requestId) {
          return;
        }
        setHistoryState({
          sessionKey,
          status: 'ready',
          messages,
          error: null,
        });
      })
      .catch((fetchError: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setHistoryState((previous) => ({
          sessionKey,
          status: previous.messages.length > 0 ? 'ready' : 'error',
          messages: previous.sessionKey === sessionKey ? previous.messages : [],
          error: previous.messages.length > 0 ? null : toErrorMessage(fetchError),
        }));
      });
  }, [gatewayRpc]);

  const enterHistory = useCallback(() => {
    setReadProjection('history');
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;

    const cached = historyCacheRef.current.get(currentSessionKey);
    if (cached) {
      setHistoryState({
        sessionKey: currentSessionKey,
        status: 'ready',
        messages: cached.messages,
        error: null,
      });
      refreshHistoryResource(currentSessionKey, requestId);
      return;
    }

    setHistoryState({
      sessionKey: currentSessionKey,
      status: 'loading',
      messages: [],
      error: null,
    });
    refreshHistoryResource(currentSessionKey, requestId);
  }, [currentSessionKey, refreshHistoryResource]);

  const isHistoryProjection = readProjection === 'history';
  const projectionMessages = useMemo(() => {
    if (!isHistoryProjection || historyState.sessionKey !== currentSessionKey) {
      return emptyMessagesRef.current;
    }

    const projectionResult = buildHistoryProjectionMessages(historyState.messages, liveMessages);
    const cachedProjection = projectionCacheRef.current;
    if (
      cachedProjection
      && cachedProjection.sessionKey === currentSessionKey
      && cachedProjection.historyBaseFingerprint === projectionResult.historyBaseFingerprint
      && cachedProjection.liveTailFingerprint === projectionResult.liveTailFingerprint
    ) {
      return cachedProjection.mergedMessages;
    }

    projectionCacheRef.current = {
      sessionKey: currentSessionKey,
      historyBaseFingerprint: projectionResult.historyBaseFingerprint,
      liveTailFingerprint: projectionResult.liveTailFingerprint,
      mergedMessages: projectionResult.mergedMessages,
    };
    return projectionResult.mergedMessages;
  }, [currentSessionKey, historyState.messages, historyState.sessionKey, isHistoryProjection, liveMessages]);

  return {
    readProjection,
    projectionScopeKey: `${currentSessionKey}::${readProjection}`,
    isHistoryProjection,
    loading: isHistoryProjection && historyState.sessionKey === currentSessionKey && historyState.status === 'loading',
    error: isHistoryProjection && historyState.sessionKey === currentSessionKey ? historyState.error : null,
    messages: projectionMessages,
    enterHistory,
    returnToLive,
  };
}

export function getChatProjectionCacheStats(): ChatProjectionCacheStats {
  let cachedMessageCount = 0;
  for (const entry of globalHistoryCache.values()) {
    cachedMessageCount += entry.messages.length;
  }

  return {
    cachedSessionCount: globalHistoryCache.size,
    cachedMessageCount,
  };
}
