import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';
import {
  appendTimelineRows,
  buildTimelineRowsWithMeta,
  canAppendReferenceList,
  canPrependReferenceList,
  patchTimelineRows,
  prependTimelineRows,
  type ChatMessageRow,
} from './chat-row-model';
import { getSessionCacheValue, rememberSessionCacheValue } from './chat-session-cache';

export interface SessionStaticRowsCacheEntry {
  timelineEntriesRef: SessionTimelineEntry[];
  rows: ChatMessageRow[];
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
  timelineEntries: SessionTimelineEntry[],
): SessionStaticRowsCacheEntry {
  const previousCache = getSessionCacheValue(globalStaticRowsCache, sessionKey);
  if (
    previousCache
    && previousCache.timelineEntriesRef === timelineEntries
  ) {
    return previousCache;
  }

  let rows: ChatMessageRow[];
  let renderableCount: number;
  const canIncrementalAppend = Boolean(
    previousCache
    && canAppendReferenceList(previousCache.timelineEntriesRef, timelineEntries),
  );
  const canIncrementalPrepend = Boolean(
    previousCache
    && canPrependReferenceList(previousCache.timelineEntriesRef, timelineEntries),
  );
  const canPatchInPlace = Boolean(
    previousCache
    && previousCache.timelineEntriesRef.length === timelineEntries.length,
  );

  if (canIncrementalAppend && previousCache) {
    const appended = appendTimelineRows(
      sessionKey,
      previousCache.rows,
      timelineEntries,
      previousCache.timelineEntriesRef.length,
      previousCache.renderableCount,
    );
    rows = appended.rows;
    renderableCount = appended.renderableCount;
  } else if (canIncrementalPrepend && previousCache) {
    const prepended = prependTimelineRows(
      sessionKey,
      previousCache.rows,
      timelineEntries,
      timelineEntries.length - previousCache.timelineEntriesRef.length,
      previousCache.renderableCount,
    );
    rows = prepended.rows;
    renderableCount = prepended.renderableCount;
  } else if (canPatchInPlace && previousCache) {
    const patched = patchTimelineRows(
      sessionKey,
      previousCache.rows,
      previousCache.timelineEntriesRef,
      timelineEntries,
    );
    if (patched) {
      rows = patched.rows;
      renderableCount = patched.renderableCount;
    } else {
      const built = buildTimelineRowsWithMeta({
        sessionKey,
        entries: timelineEntries,
      });
      rows = built.rows;
      renderableCount = built.renderableCount;
    }
  } else {
    const built = buildTimelineRowsWithMeta({
      sessionKey,
      entries: timelineEntries,
    });
    rows = built.rows;
    renderableCount = built.renderableCount;
  }

  const nextEntry = {
    timelineEntriesRef: timelineEntries,
    rows,
    renderableCount,
  } satisfies SessionStaticRowsCacheEntry;
  rememberSessionCacheValue(globalStaticRowsCache, sessionKey, nextEntry);
  return nextEntry;
}

export function getOrBuildStaticRowsCacheEntry(
  sessionKey: string,
  timelineEntries: SessionTimelineEntry[],
): SessionStaticRowsCacheEntry {
  return buildStaticRowsCacheEntry(sessionKey, timelineEntries);
}

export function prewarmStaticRowsForTimeline(
  sessionKey: string,
  timelineEntries: SessionTimelineEntry[],
): SessionStaticRowsCacheEntry {
  return buildStaticRowsCacheEntry(sessionKey, timelineEntries);
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
