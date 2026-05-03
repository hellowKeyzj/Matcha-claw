import { describe, expect, it } from 'vitest';
import {
  getOrBuildStaticRowsCacheEntry,
  prewarmStaticRowsForTimeline,
} from '@/pages/Chat/chat-rows-cache';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildTimelineEntriesFromMessages } from './helpers/timeline-fixtures';

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
    const timelineEntries = buildTimelineEntriesFromMessages('agent:cache:main', messages);

    const firstEntry = getOrBuildStaticRowsCacheEntry('agent:cache:main', timelineEntries);
    const secondEntry = getOrBuildStaticRowsCacheEntry('agent:cache:main', timelineEntries);

    expect(secondEntry).toBe(firstEntry);
    expect(secondEntry.rows).toBe(firstEntry.rows);
  });

  it('reuses prewarmed static rows on later reads', () => {
    const sessionKey = 'agent:cache:main';
    const transcript = buildTimelineEntriesFromMessages(sessionKey, buildMessages(12));

    const prewarmed = prewarmStaticRowsForTimeline(sessionKey, transcript);
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

    const initialTimelineEntries = buildTimelineEntriesFromMessages(sessionKey, initialMessages);
    const firstEntry = getOrBuildStaticRowsCacheEntry(sessionKey, initialTimelineEntries);
    const nextMessages: RawMessage[] = [
      initialMessages[0]!,
      {
        ...initialMessages[1]!,
        content: 'first chunk second chunk',
        streaming: false,
      },
    ];

    const nextAssistantEntry = buildTimelineEntriesFromMessages(sessionKey, [nextMessages[1]!])[0]!;
    const secondEntry = getOrBuildStaticRowsCacheEntry(sessionKey, [
      initialTimelineEntries[0]!,
      nextAssistantEntry,
    ]);

    expect(secondEntry.rows[0]).toBe(firstEntry.rows[0]);
    expect(secondEntry.rows[1]).not.toBe(firstEntry.rows[1]);
    expect(secondEntry.rows[1]?.key).toBe(firstEntry.rows[1]?.key);
  });
});

