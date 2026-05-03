import { describe, expect, it } from 'vitest';
import {
  readSessionAssistantTurnState,
} from '@/stores/chat/session-turn-state';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildTimelineEntriesFromMessages } from './helpers/timeline-fixtures';

function createSession(input: {
  messages: RawMessage[];
  streamingMessageId?: string | null;
}) {
  const sessionKey = 'agent:test:main';
  return {
    timelineEntries: buildTimelineEntriesFromMessages(sessionKey, input.messages),
    runtime: {
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'streaming' as const,
      streamingMessageId: input.streamingMessageId ?? null,
      pendingFinal: false,
      lastUserMessageAt: Date.now(),
    },
  };
}

describe('chat session turn state', () => {
  it('按当前 reply window 收口 team lane，并聚合各 lane 的 tool 状态', () => {
    const session = createSession({
      messages: [
        {
          id: 'older-user',
          role: 'user',
          content: 'older',
        },
        {
          id: 'older-assistant',
          role: 'assistant',
          agentId: 'agent-old',
          content: 'older assistant',
          streaming: true,
          toolStatuses: [{
            id: 'tool-old',
            name: 'older_tool',
            status: 'running',
            updatedAt: 1,
          }],
        },
        {
          id: 'current-user',
          role: 'user',
          content: 'current',
        },
        {
          id: 'assistant-agent-a',
          role: 'assistant',
          agentId: 'agent-a',
          uniqueId: 'team-turn-1',
          requestId: 'user-1',
          content: 'Alpha',
          streaming: true,
          toolStatuses: [{
            id: 'tool-a',
            name: 'read_file',
            status: 'running',
            updatedAt: 2,
          }],
        },
        {
          id: 'assistant-agent-b',
          role: 'assistant',
          agentId: 'agent-b',
          uniqueId: 'team-turn-1',
          requestId: 'user-1',
          content: 'Beta',
          streaming: true,
          toolStatuses: [{
            id: 'tool-b',
            name: 'search',
            status: 'running',
            updatedAt: 3,
          }],
        },
      ],
      streamingMessageId: null,
    });

    const turnState = readSessionAssistantTurnState(session);

    expect(turnState.activeTurnKey).toBe('team-turn-1');
    expect(turnState.turns.map((turn) => turn.turnKey)).toEqual([
      'older-assistant',
      'team-turn-1',
    ]);
    expect(turnState.activeTurn?.turnKey).toBe('team-turn-1');
    expect(turnState.lanes.map((lane) => lane.entry.message.id)).toEqual([
      'assistant-agent-a',
      'assistant-agent-b',
    ]);
    expect(turnState.currentStreamingTurn?.message.id).toBe('assistant-agent-b');
    expect(turnState.currentTurn?.message.id).toBe('assistant-agent-b');
    expect(turnState.lanes.flatMap((lane) => lane.toolStatuses)).toMatchObject([
      {
        id: 'tool-a',
        name: 'read_file',
        status: 'running',
      },
      {
        id: 'tool-b',
        name: 'search',
        status: 'running',
      },
    ]);
  });

  it('当前 turn 按统一 identity 收口，不会被同一 agent 的旧 turn 串进去', () => {
    const session = createSession({
      messages: [
        {
          id: 'assistant-agent-a-old',
          role: 'assistant',
          agentId: 'agent-a',
          uniqueId: 'team-turn-old',
          requestId: 'user-old',
          content: 'Old turn',
          streaming: false,
        },
        {
          id: 'assistant-agent-a-new',
          role: 'assistant',
          agentId: 'agent-a',
          uniqueId: 'team-turn-new',
          requestId: 'user-new',
          content: 'New turn',
          streaming: true,
        },
        {
          id: 'assistant-agent-b-new',
          role: 'assistant',
          agentId: 'agent-b',
          uniqueId: 'team-turn-new',
          requestId: 'user-new',
          content: 'New turn B',
          streaming: true,
        },
      ],
      streamingMessageId: 'assistant-agent-b-new',
    });

    const turnState = readSessionAssistantTurnState(session);

    expect(turnState.activeTurnKey).toBe('team-turn-new');
    expect(turnState.turns.map((turn) => turn.turnKey)).toEqual([
      'team-turn-old',
      'team-turn-new',
    ]);
    expect(turnState.activeTurn?.turnKey).toBe('team-turn-new');
    expect(turnState.lanes.map((lane) => lane.entry.message.id)).toEqual([
      'assistant-agent-a-new',
      'assistant-agent-b-new',
    ]);
  });
});

