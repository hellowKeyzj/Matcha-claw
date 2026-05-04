import { describe, expect, it } from 'vitest';
import {
  getOrBuildStaticRenderItemsCacheEntry,
  prewarmStaticRenderItems,
} from '@/pages/Chat/chat-render-items-cache';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function buildMessages(count: number): RawMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index + 1}`,
    timestamp: index + 1,
  }));
}

describe('chat render items cache', () => {
  it('returns the same static items cache entry for the same message reference', () => {
    const messages = buildMessages(40);
    const items = buildRenderItemsFromMessages('agent:cache:main', messages);

    const firstEntry = getOrBuildStaticRenderItemsCacheEntry('agent:cache:main', items);
    const secondEntry = getOrBuildStaticRenderItemsCacheEntry('agent:cache:main', items);

    expect(secondEntry).toBe(firstEntry);
    expect(secondEntry.items).toBe(firstEntry.items);
  });

  it('reuses prewarmed static items on later reads', () => {
    const sessionKey = 'agent:cache:main';
    const items = buildRenderItemsFromMessages(sessionKey, buildMessages(12));

    const prewarmed = prewarmStaticRenderItems(sessionKey, items);
    const reused = getOrBuildStaticRenderItemsCacheEntry(sessionKey, items);

    expect(reused).toBe(prewarmed);
    expect(reused.items).toBe(prewarmed.items);
  });

  it('same-length message updates should only rebuild the changed item', () => {
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

    const initialItems = buildRenderItemsFromMessages(sessionKey, initialMessages);
    const firstEntry = getOrBuildStaticRenderItemsCacheEntry(sessionKey, initialItems);
    const nextMessages: RawMessage[] = [
      initialMessages[0]!,
      {
        ...initialMessages[1]!,
        content: 'first chunk second chunk',
        streaming: false,
      },
    ];

    const nextAssistantItem = buildRenderItemsFromMessages(sessionKey, [nextMessages[1]!])[0]!;
    const secondEntry = getOrBuildStaticRenderItemsCacheEntry(sessionKey, [
      initialItems[0]!,
      nextAssistantItem,
    ]);

    expect(secondEntry.items[0]).toStrictEqual(firstEntry.items[0]);
    expect(secondEntry.items[1]).not.toBe(firstEntry.items[1]);
    expect(secondEntry.items[1]?.key).toBe(firstEntry.items[1]?.key);
  });
});

