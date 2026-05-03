import { describe, expect, it } from 'vitest';
import {
  applyAssistantPresentationToRows,
  buildStaticChatRows,
  type ChatMessageRow,
} from '@/pages/Chat/chat-row-model';
import type { SessionTimelineEntry } from '../../runtime-host/shared/session-adapter-types';

function buildAssistantEntry(input: {
  entryId: string;
  laneKey: string;
  turnKey: string;
  agentId?: string;
  text: string;
}): SessionTimelineEntry {
  return {
    entryId: input.entryId,
    sessionKey: 'agent:main:main',
    laneKey: input.laneKey,
    turnKey: input.turnKey,
    role: 'assistant',
    status: 'final',
    ...(input.agentId ? { agentId: input.agentId } : {}),
    text: input.text,
    message: {
      id: input.entryId,
      role: 'assistant',
      content: input.text,
      ...(input.agentId ? { agentId: input.agentId } : {}),
    },
  };
}

describe('chat row model lane identity', () => {
  it('builds explicit assistant turn/lane identity onto rows from the same normalized message model', () => {
    const rows = buildStaticChatRows({
      sessionKey: 'agent:main:main',
      entries: [
        buildAssistantEntry({
          entryId: 'assistant-a-1',
          laneKey: 'member:agent-a',
          turnKey: 'team-turn-1',
          agentId: 'agent-a',
          text: 'Alpha',
        }),
        buildAssistantEntry({
          entryId: 'assistant-direct-1',
          laneKey: 'main',
          turnKey: 'direct-turn-1',
          text: 'Direct',
        }),
      ],
    });

    expect(rows.map((row) => ({
      key: row.key,
      assistantTurnKey: row.assistantTurnKey ?? null,
      assistantLaneKey: row.assistantLaneKey ?? null,
      assistantLaneAgentId: row.assistantLaneAgentId ?? null,
    }))).toEqual([
      {
        key: 'session:agent:main:main|entry:assistant-a-1',
        assistantTurnKey: 'team-turn-1',
        assistantLaneKey: 'member:agent-a',
        assistantLaneAgentId: 'agent-a',
      },
      {
        key: 'session:agent:main:main|entry:assistant-direct-1',
        assistantTurnKey: 'direct-turn-1',
        assistantLaneKey: 'main',
        assistantLaneAgentId: null,
      },
    ]);
  });

  it('resolves assistant presentation from row lane identity instead of falling back to the page default assistant', () => {
    const row: ChatMessageRow = {
      key: 'assistant-a-1',
      kind: 'message',
      role: 'assistant',
      text: 'Alpha',
      assistantTurnKey: 'team-turn-1',
      assistantLaneKey: 'team:agent-a',
      assistantLaneAgentId: 'agent-a',
      assistantPresentation: null,
      assistantMarkdownHtml: null,
      messageView: {
        thinking: null,
        toolUses: [],
        images: [],
        attachedFiles: [],
      },
      entry: {
        entryId: 'assistant-a-1',
        sessionKey: 'agent:main:main',
        laneKey: 'team:agent-a',
        turnKey: 'team-turn-1',
        role: 'assistant',
        status: 'final',
        text: 'Alpha',
        message: {
          id: 'assistant-a-1',
          role: 'assistant',
          content: 'Alpha',
        },
      },
    };

    const rows = applyAssistantPresentationToRows({
      rows: [row],
      agents: [{
        id: 'agent-a',
        agentName: 'Agent A',
        avatarSeed: 'seed-a',
      }],
      defaultAssistant: {
        agentId: 'main',
        agentName: 'Main Assistant',
      },
    });

    expect(rows[0]?.assistantPresentation).toEqual({
      agentId: 'agent-a',
      agentName: 'Agent A',
      avatarSeed: 'seed-a',
      avatarStyle: undefined,
    });
  });
});
