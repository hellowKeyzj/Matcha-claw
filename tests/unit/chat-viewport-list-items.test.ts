import { describe, expect, it } from 'vitest';
import type { ChatRow } from '@/pages/Chat/chat-row-model';
import type { ExecutionGraphData } from '@/pages/Chat/execution-graph-model';
import { buildViewportListItems } from '@/pages/Chat/viewport-list-items';

describe('chat viewport list items', () => {
  it('builds one final viewport list and inserts execution graphs by anchor message key', () => {
    const rows: ChatRow[] = [
      {
        key: 'user-1',
        kind: 'message',
        message: { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      },
      {
        key: 'assistant-1',
        kind: 'message',
        message: { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
      },
      {
        key: 'activity-1',
        kind: 'activity',
      },
      {
        key: 'assistant-2',
        kind: 'message',
        message: { role: 'assistant', content: 'a2', timestamp: 3, id: 'a2' },
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
    ];

    const items = buildViewportListItems(rows, executionGraphs);

    expect(items.map((item) => item.key)).toEqual([
      'user-1',
      'assistant-1',
      'execution_graph:graph-1',
      'activity-1',
      'assistant-2',
    ]);
    expect(items[0]).toMatchObject({
      kind: 'message',
      row: { key: 'user-1' },
    });
    expect(items[2]).toMatchObject({
      kind: 'execution_graph',
      graph: { id: 'graph-1' },
    });
    expect(items[3]).toMatchObject({
      kind: 'activity',
      row: { key: 'activity-1' },
    });
  });
});
