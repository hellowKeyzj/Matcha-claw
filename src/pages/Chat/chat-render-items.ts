import { useMemo } from 'react';
import type { ChatRow } from './chat-row-model';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';

export interface ChatRenderItem {
  key: string;
  row: ChatRow;
}

interface SessionRenderItemsCache {
  rowsRef: ChatRow[];
  items: ChatRenderItem[];
}

const globalRenderItemsCache = new Map<string, SessionRenderItemsCache>();

export interface RenderItemsCacheStats {
  cachedSessionCount: number;
  cachedItemCount: number;
}

export function buildChatRenderItems(rows: ChatRow[]): ChatRenderItem[] {
  return rows.map((row) => ({
    key: row.key,
    row,
  }));
}

export function useChatRenderItems(
  currentSessionKey: string,
  rows: ChatRow[],
): ChatRenderItem[] {
  return useMemo(() => {
    const cached = getSessionCacheValue(globalRenderItemsCache, currentSessionKey);
    if (cached && cached.rowsRef === rows) {
      return cached.items;
    }

    const items = buildChatRenderItems(rows);
    rememberSessionCacheValue(globalRenderItemsCache, currentSessionKey, {
      rowsRef: rows,
      items,
    });
    return items;
  }, [currentSessionKey, rows]);
}

export function getRenderItemsCacheStats(): RenderItemsCacheStats {
  let cachedItemCount = 0;
  for (const cache of globalRenderItemsCache.values()) {
    cachedItemCount += cache.items.length;
  }

  return {
    cachedSessionCount: globalRenderItemsCache.size,
    cachedItemCount,
  };
}
