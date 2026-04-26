import { describe, expect, it } from 'vitest';
import { EMPTY_EXECUTION_GRAPHS } from '@/pages/Chat/exec-graph-types';
import { projectLiveThreadMessages } from '@/pages/Chat/live-thread-projection';
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
  it('returns the same live projection object for the same transcript reference', () => {
    const messages = buildMessages(40);

    const firstProjection = projectLiveThreadMessages(messages);
    const secondProjection = projectLiveThreadMessages(messages);

    expect(secondProjection).toBe(firstProjection);
    expect(secondProjection.messages).toBe(firstProjection.messages);
  });

  it('reuses prewarmed static rows on later reads', () => {
    const sessionKey = 'agent:cache:main';
    const transcript = buildMessages(12);
    const liveMessages = projectLiveThreadMessages(transcript).messages;

    const prewarmed = prewarmStaticRowsForMessages(sessionKey, liveMessages, EMPTY_EXECUTION_GRAPHS);
    const reused = getOrBuildStaticRowsCacheEntry(sessionKey, liveMessages, EMPTY_EXECUTION_GRAPHS);

    expect(reused).toBe(prewarmed);
    expect(reused.rows).toBe(prewarmed.rows);
  });
});
