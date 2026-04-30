import { describe, expect, it } from 'vitest';
import type { ChatMessageRow } from '@/pages/Chat/chat-row-model';
import type { ExecutionGraphData } from '@/pages/Chat/execution-graph-model';
import { buildExecutionGraphSlots } from '@/pages/Chat/chat-render-model';

describe('chat execution graph slots', () => {
  it('anchors execution graphs onto their message row and folds missing anchors into the final row', () => {
    const rows: ChatMessageRow[] = [
      {
        key: 'user-1',
        kind: 'message',
        role: 'user',
        text: 'u1',
        message: { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      },
      {
        key: 'assistant-1',
        kind: 'message',
        role: 'assistant',
        text: 'a1',
        message: { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
      },
    ];
    const executionGraphs: ExecutionGraphData[] = [
      {
        id: 'graph-1',
        anchorMessageKey: 'assistant-1',
        triggerMessageKey: 'assistant-1',
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

    expect(slots.anchoredGraphsByRowKey.get('user-1')).toBeUndefined();
    expect(slots.anchoredGraphsByRowKey.get('assistant-1')?.map((graph) => graph.id)).toEqual(['graph-1', 'graph-2']);
  });

  it('collects tool-card suppression separately from the message row model', () => {
    const rows: ChatMessageRow[] = [
      {
        key: 'assistant-1',
        kind: 'message',
        role: 'assistant',
        text: 'a1',
        message: { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
      },
    ];
    const executionGraphs: ExecutionGraphData[] = [{
      id: 'graph-1',
      anchorMessageKey: 'assistant-1',
      triggerMessageKey: 'assistant-1',
      agentLabel: 'agent',
      sessionLabel: 'session',
      steps: [],
      active: false,
      suppressToolCardMessageKeys: ['assistant-1'],
    }];

    const slots = buildExecutionGraphSlots(rows, executionGraphs);

    expect(slots.suppressedToolCardRowKeys.has('assistant-1')).toBe(true);
  });
});
