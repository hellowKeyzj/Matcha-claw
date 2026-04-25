import { describe, expect, it } from 'vitest';
import { buildChatAutoFollowSignal } from '@/pages/Chat/chat-auto-follow';
import type { RawMessage } from '@/stores/chat';

describe('chat auto follow signal', () => {
  const sessionKey = 'agent:test:main';

  it('keeps the same signal when assistant handoff keeps the same committed tail message', () => {
    const streamingMessages: RawMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'first chunk',
        timestamp: 2,
      },
    ];

    const finalMessages: RawMessage[] = [...streamingMessages];

    expect(buildChatAutoFollowSignal(sessionKey, finalMessages)).toBe(
      buildChatAutoFollowSignal(sessionKey, streamingMessages),
    );
  });

  it('keeps the same signal when the last assistant text grows within the same committed message', () => {
    const previousMessages: RawMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
        timestamp: 1,
      },
    ];
    const nextMessages: RawMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello world',
        timestamp: 1,
      },
    ];

    expect(buildChatAutoFollowSignal(sessionKey, nextMessages)).toBe(
      buildChatAutoFollowSignal(sessionKey, previousMessages),
    );
  });

  it('changes the signal when the last committed message transitions from empty to non-empty content', () => {
    const previousMessages: RawMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: 1,
      },
    ];
    const nextMessages: RawMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello world',
        timestamp: 1,
      },
    ];

    expect(buildChatAutoFollowSignal(sessionKey, nextMessages)).not.toBe(
      buildChatAutoFollowSignal(sessionKey, previousMessages),
    );
  });

  it('changes the signal when a new committed message is appended', () => {
    const previousMessages: RawMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ];
    const nextMessages: RawMessage[] = [
      ...previousMessages,
      {
        id: 'assistant-1',
        role: 'assistant',
        content: 'world',
        timestamp: 2,
      },
    ];

    expect(buildChatAutoFollowSignal(sessionKey, nextMessages)).not.toBe(
      buildChatAutoFollowSignal(sessionKey, previousMessages),
    );
  });

  it('ignores runtime-only tail churn before the committed transcript changes', () => {
    const previousMessages: RawMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ];
    const nextMessages: RawMessage[] = [...previousMessages];

    expect(buildChatAutoFollowSignal(sessionKey, nextMessages)).toBe(
      buildChatAutoFollowSignal(sessionKey, previousMessages),
    );
  });
});
