import { describe, expect, it } from 'vitest';
import { buildStaticChatRows, type ChatRow } from '@/pages/Chat/chat-row-model';
import { buildExecutionGraphSlots } from '@/pages/Chat/components/ChatList';
import type { ExecutionGraphData } from '@/pages/Chat/execution-graph-model';
import { buildTimelineEntriesFromMessages } from './helpers/timeline-fixtures';

describe('chat execution graph slots', () => {
  it('anchors execution graphs onto their message row and folds missing anchors into the final row', () => {
    const rows: ChatRow[] = buildStaticChatRows({
      sessionKey: 'agent:test:main',
      entries: buildTimelineEntriesFromMessages('agent:test:main', [
        { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
        { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
      ]),
    });
    const userRowKey = rows[0]!.key;
    const assistantRowKey = rows[1]!.key;
    const executionGraphs: ExecutionGraphData[] = [
      {
        id: 'graph-1',
        anchorEntryId: rows[1]!.entry.entryId,
        triggerEntryId: rows[1]!.entry.entryId,
        childSessionKey: 'child-1',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
      },
      {
        id: 'graph-2',
        anchorEntryId: 'missing-entry',
        triggerEntryId: 'missing-entry',
        childSessionKey: 'child-2',
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

  it('prioritizes assistant lane+turn anchor over stale message row keys', () => {
    const rows: ChatRow[] = buildStaticChatRows({
      sessionKey: 'agent:test:main',
      entries: buildTimelineEntriesFromMessages('agent:test:main', [
        { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
        {
          role: 'assistant',
          content: 'a1',
          timestamp: 2,
          id: 'a1',
          agentId: 'agent-a',
          uniqueId: 'turn-1',
          requestId: 'user-1',
        },
      ]),
    });
    const assistantRowKey = rows[1]!.key;
    const executionGraphs: ExecutionGraphData[] = [{
      id: 'graph-lane-1',
      anchorEntryId: 'stale-entry-id',
      anchorTurnKey: 'turn-1',
      anchorLaneKey: 'member:agent-a',
      triggerEntryId: 'stale-entry-id',
      childSessionKey: 'child-1',
      agentLabel: 'agent-a',
      sessionLabel: 'session',
      steps: [],
      active: false,
    }];

    const slots = buildExecutionGraphSlots(rows, executionGraphs);

    expect(slots.anchoredGraphsByRowKey.get(assistantRowKey)?.map((graph) => graph.id)).toEqual(['graph-lane-1']);
  });
});

