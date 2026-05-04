import { describe, expect, it } from 'vitest';
import {
  applyAssistantPresentationToRows,
  buildAssistantLaneTurnMatchKey,
  resolveRowAssistantLaneTurnMatchKey,
  type ChatMessageRow,
} from '@/pages/Chat/chat-row-model';
import type { SessionRenderRow } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderRowsFromMessages } from './helpers/timeline-fixtures';

function decorateRows(rows: SessionRenderRow[]) {
  return applyAssistantPresentationToRows({
    rows,
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
}

describe('chat row model lane identity', () => {
  it('builds explicit assistant turn/lane identity onto protocol rows', () => {
    const rows = decorateRows(buildRenderRowsFromMessages('agent:main:main', [
      {
        role: 'assistant',
        content: 'Alpha',
        id: 'assistant-a-1',
        uniqueId: 'team-turn-1',
        agentId: 'agent-a',
      },
      {
        role: 'assistant',
        content: 'Direct',
        id: 'assistant-direct-1',
      },
    ]));

    expect(rows.map((row) => ({
      key: row.key,
      assistantTurnKey: row.assistantTurnKey ?? null,
      assistantLaneKey: row.assistantLaneKey ?? null,
      assistantLaneAgentId: row.assistantLaneAgentId ?? null,
    }))).toEqual([
      {
        key: 'session:agent:main:main|row:assistant-a-1',
        assistantTurnKey: 'team-turn-1',
        assistantLaneKey: 'member:agent-a',
        assistantLaneAgentId: 'agent-a',
      },
      {
        key: 'session:agent:main:main|row:assistant-direct-1',
        assistantTurnKey: 'assistant-direct-1',
        assistantLaneKey: 'main',
        assistantLaneAgentId: null,
      },
    ]);
  });

  it('resolves row assistant lane-turn match key from protocol rows', () => {
    const row = decorateRows(buildRenderRowsFromMessages('agent:main:main', [{
      role: 'assistant',
      content: 'Alpha',
      id: 'assistant-a-1',
      uniqueId: 'team-turn-1',
      agentId: 'agent-a',
    }]))[0]!;

    expect(buildAssistantLaneTurnMatchKey('team-turn-1', 'member:agent-a')).toBe('team-turn-1|member:agent-a');
    expect(resolveRowAssistantLaneTurnMatchKey(row)).toBe('team-turn-1|member:agent-a');
  });

  it('resolves assistant presentation from assistant lane agent id', () => {
    const row = decorateRows(buildRenderRowsFromMessages('agent:main:main', [{
      role: 'assistant',
      content: 'Alpha',
      id: 'assistant-a-1',
      uniqueId: 'team-turn-1',
      agentId: 'agent-a',
    }]))[0];

    expect(row?.assistantPresentation).toEqual({
      agentId: 'agent-a',
      agentName: 'Agent A',
      avatarSeed: 'seed-a',
      avatarStyle: undefined,
    });
  });

  it('builds assistant markdown html from protocol message rows', () => {
    const row = decorateRows(buildRenderRowsFromMessages('agent:main:main', [{
      role: 'assistant',
      content: '### Title\n\n```json\n{"ok":true}\n```',
      id: 'assistant-markdown-1',
    }]))[0] as ChatMessageRow;

    expect(row.assistantMarkdownHtml).toContain('<h3>');
    expect(row.assistantMarkdownHtml).toContain('<pre>');
  });

  it('keeps tool-only assistant rows as tool-activity rows', () => {
    const row = decorateRows(buildRenderRowsFromMessages('agent:main:main', [{
      role: 'assistant',
      id: 'assistant-tool-1',
      content: [{
        type: 'toolCall',
        id: 'tool-1',
        name: 'read_file',
        input: { filePath: 'README.md' },
      }],
    }]))[0];

    expect(row?.kind).toBe('tool-activity');
  });
});
