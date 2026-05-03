import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@/stores/chat';
import { buildMessageKeyIndex } from '@/pages/Chat/exec-graph-index';
import { materializeExecutionGraphAtIndex } from '@/pages/Chat/exec-graph-materialize';
import type { CompletionEventAnchor } from '@/pages/Chat/exec-graph-types';
import { buildTimelineEntriesFromMessages } from '@/stores/chat/timeline-message';

describe('exec graph materialize lane anchoring', () => {
  it('materializes execution graph with assistant reply lane+turn anchor and lane-based tool suppression', () => {
    const messages: RawMessage[] = [
      {
        id: 'user-1',
        role: 'user',
        content: 'please delegate',
        timestamp: 1,
      },
      {
        id: 'assistant-a',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-a', name: 'sessions_spawn', input: { agentId: 'agent-a' } },
        ],
        timestamp: 2,
        agentId: 'agent-a',
        uniqueId: 'turn-1',
        requestId: 'user-1',
      },
      {
        id: 'assistant-b',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-b', name: 'search', input: {} },
        ],
        timestamp: 3,
        agentId: 'agent-b',
        uniqueId: 'turn-1',
        requestId: 'user-1',
      },
    ];
    const anchors: CompletionEventAnchor[] = [{
      eventIndex: 1,
      triggerIndex: 0,
      replyIndex: 1,
      sessionKey: 'agent:agent-a:child',
      agentId: 'agent-a',
    }];
    const timelineEntries = buildTimelineEntriesFromMessages('agent:main:main', messages);
    const keyIndex = buildMessageKeyIndex('agent:main:main', timelineEntries);
    const executionGraphs: Array<{
      id: string;
      anchorMessageKey: string;
      triggerMessageKey: string;
      agentLabel: string;
      sessionLabel: string;
      steps: unknown[];
      active: boolean;
      anchorTurnKey?: string;
      anchorLaneKey?: string;
      suppressToolCardLaneTurnKeys?: string[];
    }> = [];
    const graphByAnchor = [null];

    materializeExecutionGraphAtIndex({
      anchorIndex: 0,
      anchors,
      graphSignature: 'graph-1',
      graphByAnchor,
      keyIndex,
      timelineEntries,
      currentSessionKey: 'agent:main:main',
      showThinking: false,
      subagentHistoryBySession: new Map(),
      agentNameById: new Map([['agent-a', 'Agent A']]),
      previousGraphCache: new Map(),
      nextGraphCache: new Map(),
      mainStepsCacheBySignature: new Map(),
      childStepsCacheBySignature: new Map(),
      executionGraphs,
    });

    expect(executionGraphs).toHaveLength(1);
    expect(executionGraphs[0]).toMatchObject({
      anchorMessageKey: keyIndex.keyByIndex.get(1),
      triggerMessageKey: keyIndex.keyByIndex.get(0),
      anchorTurnKey: 'turn-1',
      anchorLaneKey: 'member:agent-a',
      suppressToolCardLaneTurnKeys: ['turn-1|member:agent-a', 'turn-1|member:agent-b'],
    });
  });
});
