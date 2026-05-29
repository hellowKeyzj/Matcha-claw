import { describe, expect, it } from 'vitest';
import { getOrBuildChatMessageView } from '@/pages/Chat/chat-message-view';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import type { SessionAssistantTurnItem } from '../../runtime-host/shared/session-adapter-types';
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
  function buildAssistantTurnItem(
    overrides: Partial<SessionAssistantTurnItem>,
  ): SessionAssistantTurnItem {
    return {
      key: 'assistant-turn-1',
      kind: 'assistant-turn',
      sessionKey: 'agent:test:main',
      role: 'assistant',
      turnKey: 'main:turn:1',
      laneKey: 'main',
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [],
      ...overrides,
    };
  }

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
    expect(view.attachedFiles.map((file) => file.fileName)).toEqual(['README.md']);
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

  it('keeps assistant bubble tool previews on the turn item while exposing tool uses normally', () => {
    const item = buildItem([
      {
        type: 'toolCall',
        id: 'tool-canvas-1',
        name: 'canvas_render',
        input: { source: { type: 'handle', id: 'cv-inline' } },
      },
      {
        type: 'tool_result',
        id: 'tool-canvas-1',
        name: 'canvas_render',
        content: {
          kind: 'canvas',
          view: {
            backend: 'canvas',
            id: 'cv-inline',
            url: '/__openclaw__/canvas/documents/cv_inline/index.html',
          },
          presentation: {
            target: 'assistant_message',
          },
        },
      },
    ]);
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant-turn');
    }

    const view = getOrBuildChatMessageView(item);
    expect(view.toolUses).toEqual([{
      id: 'tool-canvas-1',
      name: 'canvas_render',
      input: { source: { type: 'handle', id: 'cv-inline' } },
    }]);
    expect(item.embeddedToolResults).toHaveLength(1);
  });

  it('uses Runtime Host projected assistant attachments without segment re-filtering', () => {
    const item = buildAssistantTurnItem({
      segments: [{
        kind: 'message',
        key: 'message:main:0',
        text: '分析完了，结论如下。',
      }, {
        kind: 'media',
        key: 'media:main:0',
        images: [],
        attachedFiles: [{
          fileName: 'CHECKLIST.md',
          mimeType: 'text/markdown',
          fileSize: 433,
          preview: null,
          filePath: 'C:/workspace/CHECKLIST.md',
          source: 'tool-result',
        }],
      }],
      text: '分析完了，结论如下。',
      attachedFiles: [],
    });

    const view = getOrBuildChatMessageView(item);
    expect(view.attachedFiles).toEqual([]);
  });

  it('uses Runtime Host projected attachment-only assistant replies', () => {
    const item = buildAssistantTurnItem({
      segments: [{
        kind: 'media',
        key: 'media:main:0',
        images: [],
        attachedFiles: [{
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: 'data:image/png;base64,abc',
          filePath: 'C:/workspace/artifact.png',
          source: 'tool-result',
        }],
      }],
      attachedFiles: [{
        fileName: 'artifact.png',
        mimeType: 'image/png',
        fileSize: 0,
        preview: 'data:image/png;base64,abc',
        filePath: 'C:/workspace/artifact.png',
        source: 'tool-result',
      }],
    });

    const view = getOrBuildChatMessageView(item);
    expect(view.attachedFiles).toEqual([
      expect.objectContaining({
        fileName: 'artifact.png',
        source: 'tool-result',
      }),
    ]);
  });

  it('keeps gateway media attachments visible when the assistant turn also has text', () => {
    const item = buildAssistantTurnItem({
      segments: [{
        kind: 'message',
        key: 'message:main:0',
        text: '这是生成的图片。',
      }, {
        kind: 'media',
        key: 'media:main:0',
        images: [],
        attachedFiles: [{
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: 'data:image/png;base64,abc',
          gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
          source: 'tool-result',
        }],
      }],
      text: '这是生成的图片。',
      attachedFiles: [{
        fileName: 'artifact.png',
        mimeType: 'image/png',
        fileSize: 0,
        preview: 'data:image/png;base64,abc',
        gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
        source: 'tool-result',
      }],
    });

    expect(getOrBuildChatMessageView(item).attachedFiles).toEqual([
      expect.objectContaining({
        fileName: 'artifact.png',
        gatewayUrl: '/api/chat/media/outgoing/agent%3Atest%3Amain/attachment-1/full',
      }),
    ]);
  });
});
