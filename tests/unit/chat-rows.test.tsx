import { describe, expect, it } from 'vitest';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderRowsFromMessages } from './helpers/timeline-fixtures';

describe('chat row protocol fixtures', () => {
  it('builds rows from renderable messages and filters tool_result messages', () => {
    const rowSourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a1', timestamp: 1 },
      { role: 'tool_result', content: 'tool', timestamp: 2 },
      { role: 'user', content: 'u1', timestamp: 3 },
    ];

    const rows = buildRenderRowsFromMessages('agent:main:main', rowSourceMessages);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.kind === 'message')).toBe(true);
    expect(rows.map((row) => row.role)).toEqual(['assistant', 'user']);
    expect(rows[0]).toMatchObject({
      role: 'assistant',
      text: 'a1',
      thinking: null,
      toolUses: [],
      images: [],
      attachedFiles: [],
    });
  });

  it('keeps the same row key for one assistant entity from streaming to final commit', () => {
    const sessionKey = 'agent:main:main';

    const rowsDuringStreaming = buildRenderRowsFromMessages(sessionKey, [
      { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'hello', timestamp: 2, id: 'assistant-1', streaming: true },
    ]);
    const finalRows = buildRenderRowsFromMessages(sessionKey, [
      { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-1' },
    ]);

    expect(rowsDuringStreaming[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|row:assistant-1',
    });
    expect(finalRows[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|row:assistant-1',
    });
  });

  it('keeps streaming assistant content inside the same protocol row', () => {
    const rows = buildRenderRowsFromMessages('agent:main:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-stream-1', streaming: true },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      kind: 'message',
      key: 'session:agent:main:main|row:assistant-stream-1',
      text: 'hello world',
      isStreaming: true,
    });
  });

  it('builds no rows for an empty transcript', () => {
    expect(buildRenderRowsFromMessages('agent:main:main', [])).toEqual([]);
  });

  it('materializes tool-only assistant messages as tool-activity rows', () => {
    const rows = buildRenderRowsFromMessages('agent:main:main', [{
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-1',
        name: 'read_file',
        input: { filePath: 'README.md' },
      }],
      timestamp: 1,
      id: 'assistant-tool-1',
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read_file',
        status: 'completed',
        updatedAt: 1,
      }],
    }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'tool-activity',
      key: 'session:agent:main:main|row:assistant-tool-1',
      toolUses: [{
        id: 'tool-1',
        name: 'read_file',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read_file',
        status: 'completed',
      }],
    });
  });
});
