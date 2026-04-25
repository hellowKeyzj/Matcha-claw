import { describe, expect, it } from 'vitest';
import type { ChatRow } from '@/pages/Chat/chat-row-model';
import { buildChatRenderItems } from '@/pages/Chat/chat-render-items';

describe('chat render items', () => {
  it('应直接按 row 维度投影渲染项，避免 group key 驱动整块重挂', () => {
    const rows: ChatRow[] = [
      {
        key: 'user-1',
        kind: 'message',
        message: { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      },
      {
        key: 'user-2',
        kind: 'message',
        message: { role: 'user', content: 'u2', timestamp: 2, id: 'u2' },
      },
      {
        key: 'assistant-1',
        kind: 'message',
        message: { role: 'assistant', content: 'a1', timestamp: 3, id: 'a1' },
      },
      {
        key: 'assistant-2',
        kind: 'message',
        message: { role: 'assistant', content: 'a2', timestamp: 4, id: 'a2' },
      },
      {
        key: 'graph-1',
        kind: 'execution_graph',
        graph: {
          id: 'graph-1',
          anchorMessageKey: 'assistant-2',
          triggerMessageKey: 'assistant-2',
          agentLabel: 'agent',
          sessionLabel: 'session',
          steps: [],
          active: false,
        },
      },
      {
        key: 'stream-1',
        kind: 'message',
        message: { role: 'assistant', content: 'live', timestamp: 5, id: 'live' },
        isStreaming: true,
        streamingTools: [],
      },
    ];

    const items = buildChatRenderItems(rows);

    expect(items.map((item) => item.key)).toEqual([
      'user-1',
      'user-2',
      'assistant-1',
      'assistant-2',
      'graph-1',
      'stream-1',
    ]);
    expect(items.map((item) => item.row.key)).toEqual([
      'user-1',
      'user-2',
      'assistant-1',
      'assistant-2',
      'graph-1',
      'stream-1',
    ]);
  });
});
