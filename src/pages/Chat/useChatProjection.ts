import { useCallback, useEffect, useRef, useState } from 'react';
import type { RawMessage } from '@/stores/chat';
import { loadCronFallbackMessages } from '@/stores/chat/history-fetch-helpers';

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

interface UseChatProjectionInput {
  currentSessionKey: string;
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
  gatewayRpc,
}: UseChatProjectionInput): UseChatProjectionResult {
  const [readProjection, setReadProjection] = useState<ChatReadProjection>('live');
  const [historyState, setHistoryState] = useState<HistoryResourceState>({
    sessionKey: currentSessionKey,
    status: 'idle',
    messages: [],
    error: null,
  });
  const historyCacheRef = useRef<Map<string, HistoryCacheEntry>>(new Map());
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

  const enterHistory = useCallback(() => {
    setReadProjection('history');

    const cached = historyCacheRef.current.get(currentSessionKey);
    if (cached) {
      setHistoryState({
        sessionKey: currentSessionKey,
        status: 'ready',
        messages: cached.messages,
        error: null,
      });
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setHistoryState({
      sessionKey: currentSessionKey,
      status: 'loading',
      messages: [],
      error: null,
    });

    void fetchHistoryMessages(gatewayRpc, currentSessionKey)
      .then((messages) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        historyCacheRef.current.set(currentSessionKey, { messages });
        setHistoryState({
          sessionKey: currentSessionKey,
          status: 'ready',
          messages,
          error: null,
        });
      })
      .catch((fetchError: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setHistoryState({
          sessionKey: currentSessionKey,
          status: 'error',
          messages: [],
          error: toErrorMessage(fetchError),
        });
      });
  }, [currentSessionKey, gatewayRpc]);

  const isHistoryProjection = readProjection === 'history';
  const projectionMessages = isHistoryProjection && historyState.sessionKey === currentSessionKey
    ? historyState.messages
    : [];

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
