import { describe, expect, it } from 'vitest';
import {
  applyAssistantPresentationToRows,
  buildStaticChatRows,
  patchTimelineRows,
  type ChatRow,
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
      renderSignature: 'assistant|final|Alpha',
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

  it('rebuilds assistant markdown html when a timeline entry with the same id receives final markdown text', () => {
    const sessionKey = 'agent:main:main';
    const previousEntry = buildAssistantEntry({
      entryId: 'assistant-markdown-1',
      laneKey: 'main',
      turnKey: 'main:assistant-markdown-1',
      text: '',
    });
    const nextEntry = buildAssistantEntry({
      entryId: 'assistant-markdown-1',
      laneKey: 'main',
      turnKey: 'main:assistant-markdown-1',
      text: '### Title\n\n```json\n{\"ok\":true}\n```',
    });
    const previousRows = buildStaticChatRows({
      sessionKey,
      entries: [previousEntry],
    });

    const patched = patchTimelineRows(
      sessionKey,
      previousRows,
      [previousEntry],
      [nextEntry],
    );

    expect(patched?.rows[0]?.text).toBe('### Title\n\n```json\n{"ok":true}\n```');
    expect(patched?.rows[0]?.assistantMarkdownHtml).toContain('<h3>');
    expect(patched?.rows[0]?.assistantMarkdownHtml).toContain('<pre>');
  });

  it('rebuilds assistant markdown html even when an upstream path mutates the same timeline entry object', () => {
    const sessionKey = 'agent:main:main';
    const entry = buildAssistantEntry({
      entryId: 'assistant-mutated-markdown-1',
      laneKey: 'main',
      turnKey: 'main:assistant-mutated-markdown-1',
      text: '',
    });
    const previousRows = buildStaticChatRows({
      sessionKey,
      entries: [entry],
    });

    entry.text = '### Title\n\n```json\n{"ok":true}\n```';
    entry.message = {
      ...entry.message,
      content: entry.text,
    };
    const patched = patchTimelineRows(
      sessionKey,
      previousRows,
      [entry],
      [entry],
    );

    expect(patched?.rows[0]).not.toBe(previousRows[0]);
    expect(patched?.rows[0]?.text).toBe('### Title\n\n```json\n{"ok":true}\n```');
    expect(patched?.rows[0]?.assistantMarkdownHtml).toContain('<h3>');
    expect(patched?.rows[0]?.assistantMarkdownHtml).toContain('<pre>');
  });

  it('rebuilds the row kind when an assistant entry changes from tool activity to text message', () => {
    const sessionKey = 'agent:main:main';
    const previousEntry: SessionTimelineEntry = {
      entryId: 'assistant-tool-1',
      sessionKey,
      laneKey: 'main',
      turnKey: 'main:assistant-tool-1',
      role: 'assistant',
      status: 'final',
      text: '',
      message: {
        id: 'assistant-tool-1',
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool-1',
          name: 'read_file',
          input: { filePath: 'README.md' },
        }],
      },
    };
    const nextEntry: SessionTimelineEntry = {
      ...previousEntry,
      text: 'Done',
      message: {
        ...previousEntry.message,
        content: 'Done',
      },
    };

    const previousRows = buildStaticChatRows({
      sessionKey,
      entries: [previousEntry],
    });
    expect(previousRows[0]?.kind).toBe('tool-activity');

    const patched = patchTimelineRows(
      sessionKey,
      previousRows,
      [previousEntry],
      [nextEntry],
    );

    expect((patched?.rows[0] as ChatRow | undefined)?.kind).toBe('message');
    expect((patched?.rows[0] as ChatMessageRow | undefined)?.text).toBe('Done');
  });
});
