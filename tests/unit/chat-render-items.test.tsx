import { describe, expect, it } from 'vitest';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

describe('chat render item fixtures', () => {
  it('builds render items from renderable messages and filters tool_result messages', () => {
    const rowSourceMessages: RawMessage[] = [
      { role: 'assistant', content: 'a1', timestamp: 1 },
      { role: 'tool_result', content: 'tool', timestamp: 2 },
      { role: 'user', content: 'u1', timestamp: 3 },
    ];

    const items = buildRenderItemsFromMessages('agent:main:main', rowSourceMessages);

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.kind)).toEqual(['assistant-turn', 'user-message']);
    expect(items[0]).toMatchObject({
      kind: 'assistant-turn',
      text: 'a1',
      thinking: null,
      toolCalls: [],
      images: [],
      attachedFiles: [],
    });
  });

  it('keeps the same item key for one assistant turn from streaming to final commit', () => {
    const sessionKey = 'agent:main:main';

    const itemsDuringStreaming = buildRenderItemsFromMessages(sessionKey, [
      { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'hello', timestamp: 2, id: 'assistant-1', streaming: true },
    ]);
    const finalItems = buildRenderItemsFromMessages(sessionKey, [
      { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-1' },
    ]);

    expect(itemsDuringStreaming[1]).toMatchObject({
      kind: 'assistant-turn',
      key: 'session:agent:main:main|assistant-turn:assistant-1:main',
    });
    expect(finalItems[1]).toMatchObject({
      kind: 'assistant-turn',
      key: 'session:agent:main:main|assistant-turn:assistant-1:main',
    });
  });

  it('keeps streaming assistant content inside the same assistant-turn item', () => {
    const items = buildRenderItemsFromMessages('agent:main:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-stream-1', streaming: true },
    ]);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: 'assistant-turn',
      key: 'session:agent:main:main|assistant-turn:assistant-stream-1:main',
      text: 'hello world',
      status: 'streaming',
    });
  });

  it('builds no items for an empty transcript', () => {
    expect(buildRenderItemsFromMessages('agent:main:main', [])).toEqual([]);
  });

  it('materializes tool-only assistant messages as assistant-turn items', () => {
    const items = buildRenderItemsFromMessages('agent:main:main', [{
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

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'assistant-turn',
      key: 'session:agent:main:main|assistant-turn:assistant-tool-1:main',
      toolCalls: [{
        id: 'tool-1',
        name: 'read_file',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read_file',
        status: 'completed',
      }],
      text: '',
    });
  });
});
