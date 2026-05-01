import type { ChatSessionViewportState } from './types';

export interface ChatViewportWindow extends ChatSessionViewportState {}

export interface ChatViewportCacheStats {
  cachedSessionCount: number;
  cachedMessageCount: number;
}

export function createViewportWindowState(
  partial: Partial<ChatSessionViewportState> = {},
): ChatViewportWindow {
  const totalMessageCount = typeof partial.totalMessageCount === 'number'
    ? partial.totalMessageCount
    : (typeof partial.windowEndOffset === 'number' ? partial.windowEndOffset : 0);
  const windowStartOffset = typeof partial.windowStartOffset === 'number'
    ? partial.windowStartOffset
    : 0;
  const windowEndOffset = typeof partial.windowEndOffset === 'number'
    ? partial.windowEndOffset
    : totalMessageCount;
  return {
    totalMessageCount,
    windowStartOffset,
    windowEndOffset,
    hasMore: Boolean(partial.hasMore),
    hasNewer: Boolean(partial.hasNewer),
    isLoadingMore: Boolean(partial.isLoadingMore),
    isLoadingNewer: Boolean(partial.isLoadingNewer),
    isAtLatest: partial.isAtLatest ?? (windowEndOffset >= totalMessageCount),
    lastVisibleMessageId: partial.lastVisibleMessageId ?? null,
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
    cachedMessageCount: 0,
  };
}
