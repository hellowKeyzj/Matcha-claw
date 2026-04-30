import { describe, expect, it } from 'vitest';
import { buildChatAutoFollowSignal } from '@/pages/Chat/chat-auto-follow';
import { buildStaticChatRows, type ChatRow } from '@/pages/Chat/chat-row-model';

function buildMessageRow(id: string, role: 'user' | 'assistant', content: string, timestamp = 1): ChatRow {
  return buildStaticChatRows({
    sessionKey: 'agent:test:main',
    messages: [{
      id,
      role,
      content,
      timestamp,
    }],
  })[0]!;
}

describe('chat auto follow signal', () => {
  it('keeps the same signal when assistant handoff keeps the same committed tail row', () => {
    const streamingRows: ChatRow[] = [
      buildMessageRow('user-1', 'user', 'hello'),
      buildMessageRow('assistant-1', 'assistant', 'first chunk', 2),
    ];
    const finalRows: ChatRow[] = [...streamingRows];

    expect(buildChatAutoFollowSignal(finalRows)).toBe(
      buildChatAutoFollowSignal(streamingRows),
    );
  });

  it('keeps the same signal when the same tail message only grows in text length', () => {
    const previousRows = [buildMessageRow('assistant-1', 'assistant', 'hello')];
    const nextRows = [buildMessageRow('assistant-1', 'assistant', 'hello world')];

    expect(buildChatAutoFollowSignal(nextRows)).toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

  it('changes the signal when the tail message transitions from empty to non-empty', () => {
    const previousRows = [buildMessageRow('assistant-1', 'assistant', '')];
    const nextRows = [buildMessageRow('assistant-1', 'assistant', 'hello world')];

    expect(buildChatAutoFollowSignal(nextRows)).not.toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

  it('changes the signal when a new tail row is appended', () => {
    const previousRows: ChatRow[] = [
      buildMessageRow('user-1', 'user', 'hello'),
    ];
    const nextRows: ChatRow[] = [
      ...previousRows,
      buildMessageRow('assistant-1', 'assistant', 'world', 2),
    ];

    expect(buildChatAutoFollowSignal(nextRows)).not.toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

  it('changes the signal when the tail row key changes even if row count stays the same', () => {
    const previousRows = [buildMessageRow('assistant-1', 'assistant', 'hello')];
    const nextRows = [buildMessageRow('assistant-2', 'assistant', 'hello')];

    expect(buildChatAutoFollowSignal(nextRows)).not.toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

  it('only tracks the message tail, not its text growth state outside empty/non-empty transition', () => {
    const previousRows = [buildMessageRow('assistant-1', 'assistant', 'hello')];
    const nextRows = [buildMessageRow('assistant-1', 'assistant', 'hello world hello world')];

    expect(buildChatAutoFollowSignal(nextRows)).toBe(
      buildChatAutoFollowSignal(previousRows),
    );
  });

});
