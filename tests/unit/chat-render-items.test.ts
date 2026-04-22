import { describe, expect, it } from 'vitest';
import type { ChatRow } from '@/pages/Chat/chat-row-model';
import { buildChatRenderItems } from '@/pages/Chat/chat-render-items';

describe('chat render items', () => {
  it('应将连续的用户或助手消息投影为更轻的分组渲染项', () => {
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
        kind: 'streaming',
        message: { role: 'assistant', content: 'live', timestamp: 5, id: 'live' },
        streamingTools: [],
      },
    ];

    const items = buildChatRenderItems(rows);

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      kind: 'group',
      role: 'user',
    });
    expect(items[0]?.kind === 'group' ? items[0].rows.map((row) => row.key) : []).toEqual(['user-1', 'user-2']);
    expect(items[1]).toMatchObject({
      kind: 'group',
      role: 'assistant',
    });
    expect(items[1]?.kind === 'group' ? items[1].rows.map((row) => row.key) : []).toEqual(['assistant-1', 'assistant-2']);
    expect(items[2]).toMatchObject({
      kind: 'row',
      key: 'graph-1',
    });
    expect(items[3]).toMatchObject({
      kind: 'row',
      key: 'stream-1',
    });
  });
});
