import { describe, expect, it } from 'vitest';
import { getOrBuildChatMessageView } from '@/pages/Chat/chat-message-view';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function buildItem(content: unknown): SessionRenderItem {
  const item = buildRenderItemsFromMessages('agent:test:main', [{
    role: 'assistant',
    content,
    _attachedFiles: [{
      fileName: 'README.md',
      mimeType: 'text/markdown',
      fileSize: 123,
      preview: null,
      filePath: 'C:/workspace/README.md',
    }],
  }])[0];
  if (!item) {
    throw new Error('expected assistant item');
  }
  return item;
}

describe('chat message view', () => {
  it('exposes render fields from the assistant turn item', () => {
    const item = buildItem([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'reviewing options' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
      { type: 'image', data: 'base64-image', mimeType: 'image/png' },
    ]);
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant-turn');
    }

    const view = getOrBuildChatMessageView(item);

    expect(view.thinking).toBe('reviewing options');
    expect(view.toolUses).toEqual([{
      id: 'tool-1',
      name: 'read_file',
      input: { path: 'README.md' },
    }]);
    expect(view.images).toEqual([{
      mimeType: 'image/png',
      data: 'base64-image',
    }]);
    expect(view.attachedFiles).toHaveLength(1);
    expect(view.attachedFiles[0]?.fileName).toBe('README.md');
  });

  it('returns the latest item fields on repeated reads', () => {
    const item = buildItem('hello');
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant-turn');
    }

    expect(getOrBuildChatMessageView(item)).toStrictEqual(getOrBuildChatMessageView(item));
  });

  it('extracts tool cards from live assistant tool calls', () => {
    const item = buildItem([{
      type: 'toolCall',
      id: 'tool-3',
      name: 'read',
      input: { filePath: 'README.md' },
    }]);
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant-turn');
    }

    expect(getOrBuildChatMessageView(item).toolUses).toEqual([{
      id: 'tool-3',
      name: 'read',
      input: { filePath: 'README.md' },
    }]);
  });
});
