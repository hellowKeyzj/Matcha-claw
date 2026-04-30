import { describe, expect, it } from 'vitest';
import { buildStaticChatRows, type ChatMessageRow } from '@/pages/Chat/chat-row-model';
import type { ExecutionGraphData } from '@/pages/Chat/execution-graph-model';
import { buildExecutionGraphSlots } from '@/pages/Chat/chat-render-model';

describe('chat execution graph slots', () => {
  it('anchors execution graphs onto their message row and folds missing anchors into the final row', () => {
    const rows: ChatMessageRow[] = buildStaticChatRows({
      sessionKey: 'agent:test:main',
      messages: [
        { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
        { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
      ],
    });
    const userRowKey = rows[0]!.key;
    const assistantRowKey = rows[1]!.key;
    const executionGraphs: ExecutionGraphData[] = [
      {
        id: 'graph-1',
        anchorMessageKey: assistantRowKey,
        triggerMessageKey: assistantRowKey,
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
      },
      {
        id: 'graph-2',
        anchorMessageKey: 'missing-row',
        triggerMessageKey: 'missing-row',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
      },
    ];

    const slots = buildExecutionGraphSlots(rows, executionGraphs);

    expect(slots.anchoredGraphsByRowKey.get(userRowKey)).toBeUndefined();
    expect(slots.anchoredGraphsByRowKey.get(assistantRowKey)?.map((graph) => graph.id)).toEqual(['graph-1', 'graph-2']);
  });

  it('collects tool-card suppression separately from the message row model', () => {
    const rows: ChatMessageRow[] = buildStaticChatRows({
      sessionKey: 'agent:test:main',
      messages: [
        { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
      ],
    });
    const assistantRowKey = rows[0]!.key;
    const executionGraphs: ExecutionGraphData[] = [{
      id: 'graph-1',
      anchorMessageKey: assistantRowKey,
      triggerMessageKey: assistantRowKey,
      agentLabel: 'agent',
      sessionLabel: 'session',
      steps: [],
      active: false,
      suppressToolCardMessageKeys: [assistantRowKey],
    }];

    const slots = buildExecutionGraphSlots(rows, executionGraphs);

    expect(slots.suppressedToolCardRowKeys.has(assistantRowKey)).toBe(true);
  });
});
