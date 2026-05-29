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
      tools: [],
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
      text: 'hello',
    });
    expect(finalItems[1]).toMatchObject({
      kind: 'assistant-turn',
      text: 'hello world',
    });
    expect(itemsDuringStreaming[1].key).toBe(finalItems[1].key);
  });

  it('keeps streaming assistant content inside the same assistant-turn item', () => {
    const items = buildRenderItemsFromMessages('agent:main:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'hello world', timestamp: 2, id: 'assistant-stream-1', streaming: true },
    ]);

    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({
      kind: 'assistant-turn',
      text: 'hello world',
      status: 'streaming',
    });
  });

  it('builds no items for an empty transcript', () => {
    expect(buildRenderItemsFromMessages('agent:main:main', [])).toEqual([]);
  });

  it('does not render pure bootstrap and metadata injected user messages', () => {
    const items = buildRenderItemsFromMessages('agent:main:main', [{
      role: 'user',
      content: [
        '[Bootstrap pending]',
        'Please read BOOTSTRAP.md from the workspace and follow it before replying normally.',
        'Do not pretend bootstrap is complete when it is not.',
        '',
        'Conversation info (untrusted metadata):',
        '```json',
        '{ "chat_id": "user_1" }',
        '```',
      ].join('\n'),
      timestamp: 1,
      id: 'user-injection-1',
    }]);

    expect(items).toEqual([]);
  });

  it('renders only the real external user text after bootstrap and metadata injection', () => {
    const items = buildRenderItemsFromMessages('agent:main:main', [{
      role: 'user',
      content: [
        '[Bootstrap pending]',
        'Please read BOOTSTRAP.md from the workspace and follow it before replying normally.',
        'Your first user-visible reply for a bootstrap-pending workspace must follow BOOTSTRAP.md.',
        '',
        'Sender (untrusted metadata):',
        '```json',
        '{ "id": "gateway-client" }',
        '```',
        '',
        '你好',
      ].join('\n'),
      timestamp: 1,
      id: 'user-external-1',
    }]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'user-message',
      text: '你好',
    });
  });

  it('renders only the real external user text after channel system envelope injection', () => {
    const items = buildRenderItemsFromMessages('agent:main:main', [{
      role: 'user',
      content: [
        'System: [2026-05-18 01:07:22 GMT+8] Feishu[default] DM | ou_41b96165b0b61187832087517df1deed [msg:om_x100b6fab12662468b3704885b5c1abf]',
        '',
        'Conversation info (untrusted metadata):',
        '```json',
        '{ "message_id": "om_x100b6fab12662468b3704885b5c1abf" }',
        '```',
        '',
        'Sender (untrusted metadata):',
        '```json',
        '{ "id": "ou_41b96165b0b61187832087517df1deed" }',
        '```',
        '',
        '在吗',
      ].join('\n'),
      timestamp: 1,
      id: 'user-feishu-envelope-1',
    }]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'user-message',
      text: '在吗',
    });
  });

  it('materializes tool-only assistant messages as assistant-turn items', () => {
    const items = buildRenderItemsFromMessages('agent:main:main', [{
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-1',
        name: 'read_file',
        input: { filePath: 'README.md' },
      }, {
        type: 'tool_result',
        toolCallId: 'tool-1',
        name: 'read_file',
      }],
      timestamp: 1,
      id: 'assistant-tool-1',
    }]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'assistant-turn',
      tools: [{
        id: 'tool-1',
        name: 'read_file',
        input: { filePath: 'README.md' },
        status: 'completed',
      }],
      text: '',
    });
  });
});
