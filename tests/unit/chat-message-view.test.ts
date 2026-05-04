import { describe, expect, it } from 'vitest';
import { getOrBuildChatMessageView } from '@/pages/Chat/chat-message-view';
import type { SessionMessageRow, SessionToolActivityRow } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderRowsFromMessages } from './helpers/timeline-fixtures';

function buildMessageRow(content: unknown): SessionMessageRow | SessionToolActivityRow {
  const row = buildRenderRowsFromMessages('agent:test:main', [{
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
  if (!row || (row.kind !== 'message' && row.kind !== 'tool-activity')) {
    throw new Error('expected assistant content row');
  }
  return row;
}

describe('chat message view', () => {
  it('exposes render fields from the row protocol object', () => {
    const row = buildMessageRow([
      { type: 'text', text: 'hello' },
      { type: 'thinking', thinking: 'reviewing options' },
      { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
      { type: 'image', data: 'base64-image', mimeType: 'image/png' },
    ]);

    const view = getOrBuildChatMessageView(row);

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

  it('returns the latest row fields on repeated reads', () => {
    const row = buildMessageRow('hello');

    expect(getOrBuildChatMessageView(row)).toStrictEqual(getOrBuildChatMessageView(row));
  });

  it('extracts tool cards from live assistant tool blocks', () => {
    const row = buildMessageRow([{
      type: 'toolCall',
      id: 'tool-3',
      name: 'read',
      input: { filePath: 'README.md' },
    }]) as SessionToolActivityRow;

    expect(getOrBuildChatMessageView(row).toolUses).toEqual([{
      id: 'tool-3',
      name: 'read',
      input: { filePath: 'README.md' },
    }]);
  });
});
