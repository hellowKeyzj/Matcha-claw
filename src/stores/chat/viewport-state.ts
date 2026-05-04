import type { ChatSessionViewportState } from './types';

export type ChatViewportWindow = ChatSessionViewportState;

export interface ChatViewportCacheStats {
  cachedSessionCount: number;
  cachedItemCount: number;
}

export function createViewportWindowState(
  partial: Partial<ChatSessionViewportState> = {},
): ChatViewportWindow {
  const totalItemCount = typeof partial.totalItemCount === 'number'
    ? partial.totalItemCount
    : (typeof partial.windowEndOffset === 'number' ? partial.windowEndOffset : 0);
  const windowStartOffset = typeof partial.windowStartOffset === 'number'
    ? partial.windowStartOffset
    : 0;
  const windowEndOffset = typeof partial.windowEndOffset === 'number'
    ? partial.windowEndOffset
    : totalItemCount;
  return {
    totalItemCount,
    windowStartOffset,
    windowEndOffset,
    hasMore: Boolean(partial.hasMore),
    hasNewer: Boolean(partial.hasNewer),
    isLoadingMore: Boolean(partial.isLoadingMore),
    isLoadingNewer: Boolean(partial.isLoadingNewer),
    isAtLatest: partial.isAtLatest ?? (windowEndOffset >= totalItemCount),
    lastVisibleItemKey: partial.lastVisibleItemKey ?? null,
  };
}

export function syncViewportState(
  viewport: ChatSessionViewportState,
  next: ChatSessionViewportState,
): ChatViewportWindow {
  return createViewportWindowState({
    ...viewport,
    ...next,
  });
}

export function getChatViewportCacheStats(): ChatViewportCacheStats {
  return {
    cachedSessionCount: 0,
    cachedItemCount: 0,
  };
}
