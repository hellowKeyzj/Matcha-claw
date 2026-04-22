import type { RawMessage } from '@/stores/chat';
import { isRenderableChatMessage } from './chat-row-model';

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

  const renderableIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (isRenderableChatMessage(messages[index])) {
      renderableIndexes.push(index);
    }
  }

  if (renderableIndexes.length <= limit) {
    return {
      messages,
      hiddenRenderableCount: 0,
    };
  }

  const startIndex = renderableIndexes[renderableIndexes.length - limit];
  return {
    messages: messages.slice(startIndex),
    hiddenRenderableCount: renderableIndexes.length - limit,
  };
}
