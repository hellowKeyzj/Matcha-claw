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

const liveThreadProjectionCache = new WeakMap<RawMessage[], Map<number, LiveThreadProjection>>();

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

  let cacheByLimit = liveThreadProjectionCache.get(messages);
  if (!cacheByLimit) {
    cacheByLimit = new Map<number, LiveThreadProjection>();
    liveThreadProjectionCache.set(messages, cacheByLimit);
  }
  const cached = cacheByLimit.get(limit);
  if (cached) {
    return cached;
  }

  const expandedMessages = limit === LIVE_THREAD_RENDER_LIMIT
    ? pickExpandedLiveMessages(messages)
    : pickRenderableTailMessages(messages, Math.max(1, limit));
  const projection = expandedMessages === messages
    ? {
        messages,
        hiddenRenderableCount: 0,
      }
    : {
        messages: expandedMessages,
        hiddenRenderableCount: Math.max(0, countRenderableLiveMessages(messages) - countRenderableLiveMessages(expandedMessages)),
      };
  cacheByLimit.set(limit, projection);
  return projection;
}
