import { describe, expect, it } from 'vitest';
import type { RawMessage } from '@/stores/chat';
import { buildStaticChatRows } from '@/pages/Chat/chat-row-model';
import { buildTimelineEntriesFromMessages } from '@/stores/chat/timeline-message';

describe('chat row model', () => {
  it('builds rows from renderable messages and filters tool_result messages', () => {
    const rowSourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a1', timestamp: 1 },
      { role: 'tool_result', content: 'tool', timestamp: 2 },
      { role: 'user', content: 'u1', timestamp: 3 },
    ];

    const rows = buildStaticChatRows({
      sessionKey: 'agent:main:main',
      entries: buildTimelineEntriesFromMessages('agent:main:main', rowSourceMessages),
    });

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'message')).toBe(true);
    expect(rows.map((row) => row.entry.message.role)).toEqual(['assistant', 'user']);
    expect(rows[0]).toMatchObject({
      role: 'assistant',
      text: 'a1',
    });
    expect(rows[0]?.messageView.thinking).toBeNull();
    expect(rows[0]?.messageView.toolUses).toEqual([]);
    expect(rows[0]?.messageView.images).toEqual([]);
    expect(rows[0]?.messageView.attachedFiles).toEqual([]);
  });

  it('keeps the same row key for one assistant entity from streaming to final commit', () => {
    const sessionKey = 'agent:main:main';

    const rowsDuringStreaming = buildStaticChatRows({
      sessionKey,
      entries: buildTimelineEntriesFromMessages(sessionKey, [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello', timestamp: 2, id: 'assistant-1', streaming: true },
      ]),
    });
    const finalRows = buildStaticChatRows({
      sessionKey,
      entries: buildTimelineEntriesFromMessages(sessionKey, [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-1' },
      ]),
    });

    expect(rowsDuringStreaming[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|entry:assistant-1',
    });
    expect(finalRows[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|entry:assistant-1',
    });
  });

  it('does not create duplicate assistant rows once the transcript message exists', () => {
    const rows = buildStaticChatRows({
      sessionKey: 'agent:main:main',
      entries: buildTimelineEntriesFromMessages('agent:main:main', [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-1' },
      ]),
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|entry:assistant-1',
      entry: {
        message: {
          id: 'assistant-1',
          content: 'hello world',
        },
      },
    });
  });

  it('keeps streaming assistant content in the transcript row instead of creating a second runtime row', () => {
    const rows = buildStaticChatRows({
      sessionKey: 'agent:main:main',
      entries: buildTimelineEntriesFromMessages('agent:main:main', [
        { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
        { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-stream-1', streaming: true },
      ]),
    });

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|entry:assistant-stream-1',
      entry: {
        message: {
          id: 'assistant-stream-1',
          content: 'hello world',
          streaming: true,
        },
      },
    });
  });

  it('builds no rows for an empty transcript', () => {
    const rows = buildStaticChatRows({
      sessionKey: 'agent:main:main',
      entries: [],
    });

    expect(rows).toEqual([]);
  });
});
