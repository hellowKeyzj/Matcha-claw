import { describe, expect, it } from 'vitest';
import { buildStaticChatRows, type ChatMessageRow } from '@/pages/Chat/chat-row-model';
import { buildExecutionGraphSlots } from '@/pages/Chat/components/ChatList';
import type { ExecutionGraphData } from '@/pages/Chat/execution-graph-model';
import { buildTimelineEntriesFromMessages } from '@/stores/chat/timeline-message';

describe('chat execution graph slots', () => {
  it('anchors execution graphs onto their message row and folds missing anchors into the final row', () => {
    const rows: ChatMessageRow[] = buildStaticChatRows({
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
      entries: buildTimelineEntriesFromMessages('agent:test:main', [
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
    const assistantRowKey = rows[0]!.key;
    const executionGraphs: ExecutionGraphData[] = [{
      id: 'graph-1',
      anchorMessageKey: assistantRowKey,
      triggerMessageKey: assistantRowKey,
      agentLabel: 'agent',
      sessionLabel: 'session',
      steps: [],
      active: false,
      suppressToolCardLaneTurnKeys: ['turn-1|member:agent-a'],
    }];

    const slots = buildExecutionGraphSlots(rows, executionGraphs);

    expect(slots.suppressedToolCardRowKeys.has(assistantRowKey)).toBe(true);
  });

  it('prioritizes assistant lane+turn anchor over stale message row keys', () => {
    const rows: ChatMessageRow[] = buildStaticChatRows({
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
      anchorMessageKey: 'stale-row-key',
      anchorTurnKey: 'turn-1',
      anchorLaneKey: 'team:agent-a',
      triggerMessageKey: 'stale-row-key',
      agentLabel: 'agent-a',
      sessionLabel: 'session',
      steps: [],
      active: false,
    }];

    const slots = buildExecutionGraphSlots(rows, executionGraphs);

    expect(slots.anchoredGraphsByRowKey.get(assistantRowKey)?.map((graph) => graph.id)).toEqual(['graph-lane-1']);
  });

  it('suppresses tool cards by assistant lane+turn instead of only exact stale row keys', () => {
    const rows: ChatMessageRow[] = buildStaticChatRows({
      sessionKey: 'agent:test:main',
      entries: buildTimelineEntriesFromMessages('agent:test:main', [
        {
          role: 'assistant',
          content: 'a1',
          timestamp: 2,
          id: 'a1',
          agentId: 'agent-a',
          uniqueId: 'turn-1',
          requestId: 'user-1',
        },
        {
          role: 'assistant',
          content: 'a2',
          timestamp: 3,
          id: 'a2',
          agentId: 'agent-b',
          uniqueId: 'turn-1',
          requestId: 'user-1',
        },
      ]),
    });
    const assistantARowKey = rows[0]!.key;
    const assistantBRowKey = rows[1]!.key;
    const executionGraphs: ExecutionGraphData[] = [{
      id: 'graph-suppress-1',
      anchorMessageKey: assistantARowKey,
      triggerMessageKey: assistantARowKey,
      agentLabel: 'agent-a',
      sessionLabel: 'session',
      steps: [],
      active: false,
      suppressToolCardLaneTurnKeys: ['turn-1|member:agent-a'],
    }];

    const slots = buildExecutionGraphSlots(rows, executionGraphs);

    expect(slots.suppressedToolCardRowKeys.has(assistantARowKey)).toBe(true);
    expect(slots.suppressedToolCardRowKeys.has(assistantBRowKey)).toBe(false);
  });
});
