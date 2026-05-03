import { describe, expect, it } from 'vitest';
import { getOrBuildChatMessageView } from '@/pages/Chat/chat-message-view';
import type { SessionTimelineEntry } from '../../runtime-host/shared/session-adapter-types';

function buildEntry(input: Partial<SessionTimelineEntry>): SessionTimelineEntry {
  const message = {
    role: input.role ?? 'assistant',
    content: '',
    ...input.message,
  };
  const { message: _message, ...entryPatch } = input;
  void _message;
  return {
    entryId: 'entry-1',
    sessionKey: 'agent:test:main',
    laneKey: 'main',
    turnKey: 'main:entry-1',
    role: 'assistant',
    status: 'final',
    text: '',
    ...entryPatch,
    message,
  };
}

describe('chat message view', () => {
  it('extracts render fields directly from the timeline entry', () => {
    const entry = buildEntry({
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'thinking', thinking: 'reviewing options' },
          { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'README.md' } },
          { type: 'image', data: 'base64-image', mimeType: 'image/png' },
        ],
        _attachedFiles: [{
          fileName: 'README.md',
          mimeType: 'text/markdown',
          fileSize: 123,
          preview: null,
          filePath: 'C:/workspace/README.md',
        }],
      },
    });

    const view = getOrBuildChatMessageView(entry);

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

  it('reuses the same derived view for the same timeline entry object', () => {
    const entry = buildEntry({
      message: {
        role: 'assistant',
        content: 'hello',
      },
    });

    const first = getOrBuildChatMessageView(entry);
    const second = getOrBuildChatMessageView(entry);

    expect(second).toBe(first);
  });

  it('extracts tool cards from live agent toolCall content blocks', () => {
    const entry = buildEntry({
      message: {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool-3',
          name: 'read',
          input: { filePath: 'README.md' },
        }],
      },
    });

    expect(getOrBuildChatMessageView(entry).toolUses).toEqual([{
      id: 'tool-3',
      name: 'read',
      input: { filePath: 'README.md' },
    }]);
  });
});
