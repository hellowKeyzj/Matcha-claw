import { describe, expect, it } from 'vitest';
import {
  getOrBuildStaticRowsCacheEntry,
  prewarmStaticRowsForMessages,
} from '@/pages/Chat/chat-rows-cache';
import type { RawMessage } from '@/stores/chat';

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('chat rows cache', () => {
  it('returns the same static rows cache entry for the same message reference', () => {
    const messages = buildMessages(40);

    const firstEntry = getOrBuildStaticRowsCacheEntry('agent:cache:main', messages);
    const secondEntry = getOrBuildStaticRowsCacheEntry('agent:cache:main', messages);

    expect(secondEntry).toBe(firstEntry);
    expect(secondEntry.rows).toBe(firstEntry.rows);
  });

  it('reuses prewarmed static rows on later reads', () => {
    const sessionKey = 'agent:cache:main';
    const transcript = buildMessages(12);

    const prewarmed = prewarmStaticRowsForMessages(sessionKey, transcript);
    const reused = getOrBuildStaticRowsCacheEntry(sessionKey, transcript);

    expect(reused).toBe(prewarmed);
    expect(reused.rows).toBe(prewarmed.rows);
  });

  it('same-length message updates should only rebuild the changed row', () => {
    const sessionKey = 'agent:cache:main';
    const initialMessages: RawMessage[] = [
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
        streaming: true,
      },
    ];

    const firstEntry = getOrBuildStaticRowsCacheEntry(sessionKey, initialMessages);
    const nextMessages: RawMessage[] = [
      initialMessages[0]!,
      {
        ...initialMessages[1]!,
        content: 'first chunk second chunk',
        streaming: false,
      },
    ];

    const secondEntry = getOrBuildStaticRowsCacheEntry(sessionKey, nextMessages);

    expect(secondEntry.rows[0]).toBe(firstEntry.rows[0]);
    expect(secondEntry.rows[1]).not.toBe(firstEntry.rows[1]);
    expect(secondEntry.rows[1]?.key).toBe(firstEntry.rows[1]?.key);
  });
});
