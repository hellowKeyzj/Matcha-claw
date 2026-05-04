import type { SessionRenderItem } from '../../../runtime-host/shared/session-adapter-types';
import { applyAssistantPresentationToItems, type ChatRenderItem } from './chat-render-item-model';

export interface SessionStaticRenderItemsCacheEntry {
  itemsRef: SessionRenderItem[];
  items: ChatRenderItem[];
}

export interface StaticRenderItemsCacheStats {
  cachedSessionCount: number;
  cachedItemCount: number;
  cachedRenderableMessageCount: number;
}

const globalStaticRenderItemsCache = new Map<string, SessionStaticRenderItemsCacheEntry>();

export function getOrBuildStaticRenderItemsCacheEntry(
  sessionKey: string,
  items: SessionRenderItem[],
): SessionStaticRenderItemsCacheEntry {
  const cached = globalStaticRenderItemsCache.get(sessionKey);
  if (cached && cached.itemsRef === items) {
    return cached;
  }
  const nextEntry = {
    itemsRef: items,
    items: applyAssistantPresentationToItems({
      items,
      agents: [],
      defaultAssistant: null,
    }),
  } satisfies SessionStaticRenderItemsCacheEntry;
  globalStaticRenderItemsCache.set(sessionKey, nextEntry);
  return nextEntry;
}

export function prewarmStaticRenderItems(
  sessionKey: string,
  items: SessionRenderItem[],
): SessionStaticRenderItemsCacheEntry {
  return getOrBuildStaticRenderItemsCacheEntry(sessionKey, items);
}

export function getStaticRenderItemsCacheStats(): StaticRenderItemsCacheStats {
  let cachedItemCount = 0;
  for (const cache of globalStaticRenderItemsCache.values()) {
    cachedItemCount += cache.items.length;
  }
  return {
    cachedSessionCount: globalStaticRenderItemsCache.size,
    cachedItemCount,
    cachedRenderableMessageCount: cachedItemCount,
  };
}
