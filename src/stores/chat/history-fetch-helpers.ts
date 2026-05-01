import { hostApiFetch, hostSessionWindowFetch, type HostSessionWindowPayload } from '@/lib/host-api';
import { useGatewayStore } from '../gateway';
import { buildCronSessionHistoryPath, isCronSessionKey } from './cron-session-utils';
import { CHAT_HISTORY_FULL_LIMIT } from './history-constants';
import { resolveSessionThinkingLevelFromList } from './session-helpers';
import type {
  ChatSession,
  RawMessage,
} from './types';

export interface HistoryWindowResult {
  rawMessages: RawMessage[];
  canonicalRawMessages: RawMessage[] | null;
  normalizedMessages?: RawMessage[] | null;
  thinkingLevel: string | null;
  totalMessageCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}

interface FetchHistoryWindowInput {
  requestedSessionKey: string;
  sessions: ChatSession[];
  limit: number;
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

function buildFullLatestWindow(
  requestedSessionKey: string,
  sessions: ChatSession[],
  rawMessages: RawMessage[],
): HistoryWindowResult {
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
    thinkingLevel: resolveSessionThinkingLevelFromList(sessions, requestedSessionKey),
    totalMessageCount: rawMessages.length || fallbackWindow.totalMessageCount,
    windowStartOffset: 0,
    windowEndOffset: rawMessages.length || fallbackWindow.windowEndOffset,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  };
}

export async function fetchHistoryWindow(
  input: FetchHistoryWindowInput,
): Promise<HistoryWindowResult> {
  const {
    requestedSessionKey,
    sessions,
    limit,
  } = input;

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
      thinkingLevel: resolveSessionThinkingLevelFromList(sessions, requestedSessionKey),
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
    return fallbackMessages.length > 0
      ? buildFullLatestWindow(requestedSessionKey, sessions, fallbackMessages)
      : resolvedWindow;
  } catch {
    const rawMessages = await fetchGatewayHistoryFallback(requestedSessionKey, limit);
    return buildFullLatestWindow(requestedSessionKey, sessions, rawMessages);
  }
}
