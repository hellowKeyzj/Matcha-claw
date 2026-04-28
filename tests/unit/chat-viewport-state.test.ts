import { describe, expect, it } from 'vitest';
import {
  appendViewportMessage,
  createViewportWindowState,
  removeViewportMessageById,
  upsertViewportMessage,
} from '@/stores/chat/viewport-state';
import type { RawMessage } from '@/stores/chat';

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('viewport window state', () => {
  it('preserves the supplied viewport window metadata', () => {
    const messages = buildMessages(40);
    const window = createViewportWindowState({
      messages: messages.slice(-30),
      totalMessageCount: 40,
      windowStartOffset: 10,
      windowEndOffset: 40,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });

    expect(window.messages).toHaveLength(30);
    expect(window.messages[0]?.id).toBe('message-11');
    expect(window.windowStartOffset).toBe(10);
    expect(window.windowEndOffset).toBe(40);
    expect(window.totalMessageCount).toBe(40);
    expect(window.hasMore).toBe(true);
    expect(window.isAtLatest).toBe(true);
  });

  it('appends optimistic messages directly into the viewport window', () => {
    const messages = buildMessages(3);
    const nextWindow = appendViewportMessage(createViewportWindowState({
      messages,
      totalMessageCount: 3,
      windowStartOffset: 0,
      windowEndOffset: 3,
      isAtLatest: true,
    }), {
      id: 'pending-user-1',
      role: 'user',
      content: 'pending user',
      timestamp: 10,
    });

    expect(nextWindow.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
      'message-3',
      'pending-user-1',
    ]);
    expect(nextWindow.totalMessageCount).toBe(4);
    expect(nextWindow.windowEndOffset).toBe(4);
  });

  it('upserts streaming messages in place and removes failed optimistic messages', () => {
    const baseWindow = createViewportWindowState({
      messages: [
        ...buildMessages(2),
        {
          id: 'stream-1',
          role: 'assistant',
          content: 'draft',
          timestamp: 3,
        },
      ],
      totalMessageCount: 3,
      windowStartOffset: 0,
      windowEndOffset: 3,
      isAtLatest: true,
    });

    const streamedWindow = upsertViewportMessage(baseWindow, {
      id: 'stream-1',
      role: 'assistant',
      content: 'streaming answer',
      timestamp: 3,
    });
    const clearedWindow = removeViewportMessageById(streamedWindow, 'stream-1');

    expect(streamedWindow.messages.at(-1)?.content).toBe('streaming answer');
    expect(clearedWindow.messages.map((message) => message.id)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(clearedWindow.totalMessageCount).toBe(2);
  });
});
