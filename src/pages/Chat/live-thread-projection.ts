import type { RawMessage } from '@/stores/chat';
import {
  countRenderableLiveMessages,
  pickRenderableTailMessages,
  pickExpandedLiveMessages,
} from '@/stores/chat/history-first-paint-budget';

export const LIVE_THREAD_RENDER_LIMIT = 30;

export interface LiveThreadProjection {
  messages: RawMessage[];
  hiddenRenderableCount: number;
}

export function projectLiveThreadMessages(
  messages: RawMessage[],
  limit = LIVE_THREAD_RENDER_LIMIT,
): LiveThreadProjection {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      messages: [],
      hiddenRenderableCount: 0,
    };
  }

  const expandedMessages = limit === LIVE_THREAD_RENDER_LIMIT
    ? pickExpandedLiveMessages(messages)
    : pickRenderableTailMessages(messages, Math.max(1, limit));
  if (expandedMessages === messages) {
    return {
      messages,
      hiddenRenderableCount: 0,
    };
  }

  return {
    messages: expandedMessages,
    hiddenRenderableCount: Math.max(0, countRenderableLiveMessages(messages) - countRenderableLiveMessages(expandedMessages)),
  };
}
