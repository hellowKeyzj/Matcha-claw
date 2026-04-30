import { describe, expect, it } from 'vitest';
import { getOrBuildChatMessageView } from '@/pages/Chat/chat-message-view';
import type { RawMessage } from '@/stores/chat';

describe('chat message view', () => {
  it('extracts thick render fields directly from the raw message', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'reviewing options' },
        { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
        { type: 'image', data: 'base64-image', mimeType: 'image/png' },
      ] as never,
      _attachedFiles: [{
        fileName: 'README.md',
        mimeType: 'text/markdown',
        fileSize: 123,
        preview: null,
        filePath: 'C:/workspace/README.md',
      }],
    };

    const view = getOrBuildChatMessageView(message);

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

  it('reuses the same derived view for the same raw message object', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'hello',
    };

    const first = getOrBuildChatMessageView(message);
    const second = getOrBuildChatMessageView(message);

    expect(second).toBe(first);
  });
});
