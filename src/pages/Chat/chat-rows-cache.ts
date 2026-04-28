import type { RawMessage } from '@/stores/chat';
import {
  appendMessageRows,
  buildMessageRowsWithMeta,
  canAppendMessageList,
  canPrependMessageList,
  prependMessageRows,
  type ChatRow,
} from './chat-row-model';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';

export interface SessionStaticRowsCacheEntry {
  messagesRef: RawMessage[];
  rows: ChatRow[];
  renderableCount: number;
}

export interface StaticRowsCacheStats {
  cachedSessionCount: number;
  cachedRowCount: number;
  cachedRenderableMessageCount: number;
}

const globalStaticRowsCache = new Map<string, SessionStaticRowsCacheEntry>();

function buildStaticRowsCacheEntry(
  sessionKey: string,
  rowSourceMessages: RawMessage[],
): SessionStaticRowsCacheEntry {
  const previousCache = getSessionCacheValue(globalStaticRowsCache, sessionKey);
  if (
    previousCache
    && previousCache.messagesRef === rowSourceMessages
  ) {
    return previousCache;
  }

  let rows: ChatRow[];
  let renderableCount: number;
  const canIncrementalAppend = Boolean(
    previousCache
    && canAppendMessageList(previousCache.messagesRef, rowSourceMessages),
  );
  const canIncrementalPrepend = Boolean(
    previousCache
    && canPrependMessageList(previousCache.messagesRef, rowSourceMessages),
  );

  if (canIncrementalAppend && previousCache) {
    const appended = appendMessageRows(
      sessionKey,
      previousCache.rows,
      rowSourceMessages,
      previousCache.messagesRef.length,
      previousCache.renderableCount,
    );
    rows = appended.rows;
    renderableCount = appended.renderableCount;
  } else if (canIncrementalPrepend && previousCache) {
    const prepended = prependMessageRows(
      sessionKey,
      previousCache.rows,
      rowSourceMessages,
      rowSourceMessages.length - previousCache.messagesRef.length,
      previousCache.renderableCount,
    );
    rows = prepended.rows;
    renderableCount = prepended.renderableCount;
  } else {
    const built = buildMessageRowsWithMeta({
      sessionKey,
      messages: rowSourceMessages,
    });
    rows = built.rows;
    renderableCount = built.renderableCount;
  }

  const nextEntry = {
    messagesRef: rowSourceMessages,
    rows,
    renderableCount,
  } satisfies SessionStaticRowsCacheEntry;
  rememberSessionCacheValue(globalStaticRowsCache, sessionKey, nextEntry);
  return nextEntry;
}

export function peekStaticRowsCacheEntry(
  sessionKey: string,
  rowSourceMessages: RawMessage[],
): SessionStaticRowsCacheEntry | undefined {
  const cached = getSessionCacheValue(globalStaticRowsCache, sessionKey);
  if (
    cached
    && cached.messagesRef === rowSourceMessages
  ) {
    return cached;
  }
  return undefined;
}

export function getOrBuildStaticRowsCacheEntry(
  sessionKey: string,
  rowSourceMessages: RawMessage[],
): SessionStaticRowsCacheEntry {
  return buildStaticRowsCacheEntry(sessionKey, rowSourceMessages);
}

export function prewarmStaticRowsForMessages(
  sessionKey: string,
  rowSourceMessages: RawMessage[],
): SessionStaticRowsCacheEntry {
  return buildStaticRowsCacheEntry(sessionKey, rowSourceMessages);
}

export function getStaticRowsCacheStats(): StaticRowsCacheStats {
  let cachedRowCount = 0;
  let cachedRenderableMessageCount = 0;

  for (const cache of globalStaticRowsCache.values()) {
    cachedRowCount += cache.rows.length;
    cachedRenderableMessageCount += cache.renderableCount;
  }

  return {
    cachedSessionCount: globalStaticRowsCache.size,
    cachedRowCount,
    cachedRenderableMessageCount,
  };
}
