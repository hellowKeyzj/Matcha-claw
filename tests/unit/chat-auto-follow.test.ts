import { describe, expect, it } from 'vitest';
import { buildChatAutoFollowSignal } from '@/pages/Chat/chat-auto-follow';
import type { ViewportListItem } from '@/pages/Chat/viewport-list-items';

function buildMessageItem(id: string, role: 'user' | 'assistant', content: string, timestamp = 1): ViewportListItem {
  return {
    key: `session:agent:test:main|id:${id}`,
    kind: 'message',
    row: {
      key: `session:agent:test:main|id:${id}`,
      kind: 'message',
      message: {
        id,
        role,
        content,
        timestamp,
      },
    },
  };
}

describe('chat auto follow signal', () => {
  it('keeps the same signal when assistant handoff keeps the same committed tail row', () => {
    const streamingRows: ViewportListItem[] = [
      buildMessageItem('user-1', 'user', 'hello'),
      buildMessageItem('assistant-1', 'assistant', 'first chunk', 2),
    ];
    const finalRows: ViewportListItem[] = [...streamingRows];

    expect(buildChatAutoFollowSignal(finalRows)).toBe(
      buildChatAutoFollowSignal(streamingRows),
    );
  });

  it('keeps the same signal when the same tail message only grows in text length', () => {
    const previousRows = [buildMessageItem('assistant-1', 'assistant', 'hello')];
    const nextRows = [buildMessageItem('assistant-1', 'assistant', 'hello world')];

    expect(buildChatAutoFollowSignal(nextRows)).toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

  it('changes the signal when the tail message transitions from empty to non-empty', () => {
    const previousRows = [buildMessageItem('assistant-1', 'assistant', '')];
    const nextRows = [buildMessageItem('assistant-1', 'assistant', 'hello world')];

    expect(buildChatAutoFollowSignal(nextRows)).not.toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

  it('changes the signal when a new tail row is appended', () => {
    const previousRows: ViewportListItem[] = [
      buildMessageItem('user-1', 'user', 'hello'),
    ];
    const nextRows: ViewportListItem[] = [
      ...previousRows,
      buildMessageItem('assistant-1', 'assistant', 'world', 2),
    ];

    expect(buildChatAutoFollowSignal(nextRows)).not.toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

  it('changes the signal when the tail row key changes even if row count stays the same', () => {
    const previousRows = [buildMessageItem('assistant-1', 'assistant', 'hello')];
    const nextRows = [buildMessageItem('assistant-2', 'assistant', 'hello')];

    expect(buildChatAutoFollowSignal(nextRows)).not.toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });
});
