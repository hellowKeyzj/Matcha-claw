import type {
  ChatSessionViewportState,
  RawMessage,
} from './types';

export interface ChatViewportWindow extends ChatSessionViewportState {}

export interface ChatViewportCacheStats {
  cachedSessionCount: number;
  cachedMessageCount: number;
}

export function createViewportWindowState(
  partial: Partial<ChatSessionViewportState> = {},
): ChatViewportWindow {
  const messages = Array.isArray(partial.messages) ? partial.messages : [];
  const totalMessageCount = typeof partial.totalMessageCount === 'number'
    ? partial.totalMessageCount
    : messages.length;
  const windowStartOffset = typeof partial.windowStartOffset === 'number'
    ? partial.windowStartOffset
    : 0;
  const windowEndOffset = typeof partial.windowEndOffset === 'number'
    ? partial.windowEndOffset
    : windowStartOffset + messages.length;
  return {
    messages,
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

function hasMessageId(messages: RawMessage[], messageId: string): boolean {
  return messages.some((message) => message.id === messageId);
}

function finalizeViewportMessages(
  viewport: ChatSessionViewportState,
  messages: RawMessage[],
  options?: {
    totalMessageCount?: number;
    hasNewer?: boolean;
    isAtLatest?: boolean;
  },
): ChatViewportWindow {
  const totalMessageCount = typeof options?.totalMessageCount === 'number'
    ? options.totalMessageCount
    : Math.max(viewport.windowStartOffset + messages.length, viewport.totalMessageCount);
  return createViewportWindowState({
    ...viewport,
    messages,
    totalMessageCount,
    windowEndOffset: viewport.windowStartOffset + messages.length,
    hasNewer: options?.hasNewer ?? viewport.hasNewer,
    isAtLatest: options?.isAtLatest ?? viewport.isAtLatest,
  });
}

export function syncViewportMessages(
  viewport: ChatSessionViewportState,
  messages: RawMessage[],
  options?: {
    totalMessageCount?: number;
    hasMore?: boolean;
    hasNewer?: boolean;
    isAtLatest?: boolean;
  },
): ChatViewportWindow {
  return createViewportWindowState({
    ...viewport,
    messages,
    totalMessageCount: typeof options?.totalMessageCount === 'number'
      ? options.totalMessageCount
      : Math.max(viewport.windowStartOffset + messages.length, viewport.totalMessageCount),
    windowEndOffset: viewport.windowStartOffset + messages.length,
    hasMore: options?.hasMore ?? viewport.hasMore,
    hasNewer: options?.hasNewer ?? viewport.hasNewer,
    isAtLatest: options?.isAtLatest ?? viewport.isAtLatest,
  });
}

export function appendViewportMessage(
  viewport: ChatSessionViewportState,
  message: RawMessage,
): ChatViewportWindow {
  const messageId = typeof message.id === 'string' ? message.id.trim() : '';
  if (messageId && hasMessageId(viewport.messages, messageId)) {
    return viewport;
  }
  return finalizeViewportMessages(
    viewport,
    [...viewport.messages, message],
    {
      totalMessageCount: viewport.totalMessageCount + 1,
      hasNewer: false,
      isAtLatest: true,
    },
  );
}

export function upsertViewportMessage(
  viewport: ChatSessionViewportState,
  message: RawMessage,
  options?: {
    appendIfMissing?: boolean;
  },
): ChatViewportWindow {
  const appendIfMissing = options?.appendIfMissing ?? true;
  const messageId = typeof message.id === 'string' ? message.id.trim() : '';
  if (!messageId) {
    return appendIfMissing ? appendViewportMessage(viewport, message) : viewport;
  }

  const matchedIndex = viewport.messages.findIndex((candidate) => candidate.id === messageId);
  if (matchedIndex < 0) {
    return appendIfMissing ? appendViewportMessage(viewport, message) : viewport;
  }
  if (viewport.messages[matchedIndex] === message) {
    return viewport;
  }

  const nextMessages = [...viewport.messages];
  nextMessages[matchedIndex] = message;
  return finalizeViewportMessages(viewport, nextMessages);
}

export function removeViewportMessageById(
  viewport: ChatSessionViewportState,
  messageId: string | null | undefined,
): ChatViewportWindow {
  const normalizedMessageId = typeof messageId === 'string' ? messageId.trim() : '';
  if (!normalizedMessageId) {
    return viewport;
  }

  const matchedIndex = viewport.messages.findIndex((message) => message.id === normalizedMessageId);
  if (matchedIndex < 0) {
    return viewport;
  }

  const nextMessages = viewport.messages.filter((_, index) => index !== matchedIndex);
  return finalizeViewportMessages(
    viewport,
    nextMessages,
    {
      totalMessageCount: Math.max(viewport.windowStartOffset + nextMessages.length, viewport.totalMessageCount - 1),
    },
  );
}

export function getChatViewportCacheStats(): ChatViewportCacheStats {
  return {
    cachedSessionCount: 0,
    cachedMessageCount: 0,
  };
}
