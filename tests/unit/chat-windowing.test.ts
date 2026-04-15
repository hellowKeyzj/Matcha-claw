import { describe, expect, it } from 'vitest';
import { sliceMessagesForFirstPaint } from '@/pages/Chat/useWindowing';
import type { RawMessage } from '@/stores/chat';

describe('chat render windowing', () => {
  it('returns empty slice for empty message list', () => {
    const result = sliceMessagesForFirstPaint([], 8);
    expect(result.messages).toEqual([]);
    expect(result.hasOlderRenderableMessages).toBe(false);
  });

  it('slices tail by renderable limit and reports older renderable rows', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'u1', timestamp: 1 },
      { role: 'assistant', content: 'a1', timestamp: 2 },
      { role: 'tool_result', content: 'tool', timestamp: 3 },
      { role: 'assistant', content: 'a2', timestamp: 4 },
      { role: 'assistant', content: 'a3', timestamp: 5 },
    ];

    const result = sliceMessagesForFirstPaint(messages, 2);
    expect(result.messages).toEqual(messages.slice(3));
    expect(result.hasOlderRenderableMessages).toBe(true);
  });

  it('keeps full list when renderable messages are below limit', () => {
    const messages: RawMessage[] = [
      { role: 'assistant', content: 'a1', timestamp: 1 },
      { role: 'tool_result', content: 'tool', timestamp: 2 },
      { role: 'assistant', content: 'a2', timestamp: 3 },
    ];

    const result = sliceMessagesForFirstPaint(messages, 8);
    expect(result.messages).toBe(messages);
    expect(result.hasOlderRenderableMessages).toBe(false);
  });

  it('ignores non-renderable older rows when reporting older availability', () => {
    const messages: RawMessage[] = [
      { role: 'tool_result', content: 'tool', timestamp: 1 },
      { role: 'assistant', content: 'a1', timestamp: 2 },
      { role: 'assistant', content: 'a2', timestamp: 3 },
    ];

    const result = sliceMessagesForFirstPaint(messages, 2);
    expect(result.messages).toEqual(messages.slice(1));
    expect(result.hasOlderRenderableMessages).toBe(false);
  });
});

