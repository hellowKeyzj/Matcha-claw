import type { SessionRenderRow } from '../../../runtime-host/shared/session-adapter-types';
import { applyAssistantPresentationToRows, type ChatRow } from './chat-row-model';

export interface SessionStaticRowsCacheEntry {
  rowsRef: SessionRenderRow[];
  rows: ChatRow[];
}

export interface StaticRowsCacheStats {
  cachedSessionCount: number;
  cachedRowCount: number;
  cachedRenderableMessageCount: number;
}

const globalStaticRowsCache = new Map<string, SessionStaticRowsCacheEntry>();

export function getOrBuildStaticRowsCacheEntry(
  sessionKey: string,
  rows: SessionRenderRow[],
): SessionStaticRowsCacheEntry {
  const cached = globalStaticRowsCache.get(sessionKey);
  if (cached && cached.rowsRef === rows) {
    return cached;
  }
  const nextEntry = {
    rowsRef: rows,
    rows: applyAssistantPresentationToRows({
      rows,
      agents: [],
      defaultAssistant: null,
    }),
  } satisfies SessionStaticRowsCacheEntry;
  globalStaticRowsCache.set(sessionKey, nextEntry);
  return nextEntry;
}

export function prewarmStaticRowsForTimeline(
  sessionKey: string,
  rows: SessionRenderRow[],
): SessionStaticRowsCacheEntry {
  return getOrBuildStaticRowsCacheEntry(sessionKey, rows);
}

export function getStaticRowsCacheStats(): StaticRowsCacheStats {
  let cachedRowCount = 0;
  for (const cache of globalStaticRowsCache.values()) {
    cachedRowCount += cache.rows.length;
  }
  return {
    cachedSessionCount: globalStaticRowsCache.size,
    cachedRowCount,
    cachedRenderableMessageCount: cachedRowCount,
  };
}
