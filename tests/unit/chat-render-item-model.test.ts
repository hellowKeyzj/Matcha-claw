import { describe, expect, it } from 'vitest';
import {
  applyAssistantPresentationToItems,
  type ChatAssistantTurnItem,
} from '@/pages/Chat/chat-render-item-model';
import { getOrBuildAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function decorateItems() {
  return applyAssistantPresentationToItems({
    items: buildRenderItemsFromMessages('agent:main:main', [
      {
        role: 'assistant',
        content: 'Alpha',
        id: 'assistant-a-1',
        messageId: 'team-turn-1',
        agentId: 'agent-a',
      },
      {
        role: 'assistant',
        content: '### Title\n\n```json\n{"ok":true}\n```',
        id: 'assistant-markdown-1',
      },
      {
        role: 'assistant',
        id: 'assistant-tool-1',
        content: [{
          type: 'toolCall',
          id: 'tool-1',
          name: 'read_file',
          input: { filePath: 'README.md' },
        }],
      },
    ]),
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
}

describe('chat render item model', () => {
  it('decorates assistant turn items with lane/turn identity and agent presentation', () => {
    const item = decorateItems()[0] as ChatAssistantTurnItem;

    expect(item.kind).toBe('assistant-turn');
    expect(item.turnKey).toBe('team-turn-1');
    expect(item.laneKey).toBe('member:agent-a');
    expect(item.agentId).toBe('agent-a');
    expect(item.assistantPresentation).toEqual({
      agentId: 'agent-a',
      agentName: 'Agent A',
      avatarSeed: 'seed-a',
      avatarStyle: undefined,
    });
  });

  it('builds assistant markdown html on demand for assistant-turn text', () => {
    const item = decorateItems()[1] as ChatAssistantTurnItem;

    expect(item.kind).toBe('assistant-turn');
    const html = getOrBuildAssistantMarkdownBody({
      key: `${item.key}:segment:${item.segments[0]?.key ?? 'missing'}`,
      role: 'assistant',
      createdAt: item.createdAt,
      text: item.segments[0]?.kind === 'message' ? item.segments[0].text : '',
      attachedFiles: [],
    } as never)?.fullHtml ?? '';
    expect(html).toContain('<h3>');
    expect(html).toContain('<pre>');
  });

  it('renders tool-only assistant activity as an independent timeline entry', () => {
    const items = applyAssistantPresentationToItems({
      items: buildRenderItemsFromMessages('agent:main:main', [
        {
          role: 'assistant',
          id: 'assistant-tool-1',
          content: [{
            type: 'toolCall',
            id: 'tool-1',
            name: 'read_file',
            input: { filePath: 'README.md' },
          }],
        },
      ]),
      agents: [],
      defaultAssistant: null,
    });

    const toolItem = items.find(
      (entry): entry is ChatAssistantTurnItem =>
        entry.kind === 'assistant-turn'
        && entry.segments.some((s) => s.kind === 'tool'),
    );
    if (!toolItem) {
      throw new Error('expected independent tool assistant-turn item');
    }

    expect(toolItem.text).toBe('');
    expect(toolItem.tools).toMatchObject([{
      id: 'tool-1',
      name: 'read_file',
      status: 'running',
    }]);
    expect(toolItem.segments).toMatchObject([
      {
        kind: 'tool',
        tool: {
          id: 'tool-1',
          name: 'read_file',
        },
      },
    ]);
  });

  it('tools become independent entries while text segments remain in the assistant turn', () => {
    const items = applyAssistantPresentationToItems({
      items: buildRenderItemsFromMessages('agent:main:main', [
        {
          role: 'assistant',
          id: 'assistant-ordered-1',
          content: [
            {
              type: 'toolCall',
              id: 'tool-a',
              name: 'read',
              input: { filePath: 'README.md' },
            },
            {
              type: 'tool_result',
              toolCallId: 'tool-a',
              name: 'read',
              result: { ok: true },
            },
            {
              type: 'text',
              text: '我先看 README。',
            },
            {
              type: 'toolCall',
              id: 'tool-b',
              name: 'grep',
              input: { query: 'assistant-turn' },
            },
            {
              type: 'text',
              text: '再补充结论。',
            },
          ],
        },
      ]),
      agents: [],
      defaultAssistant: null,
    });

    const textItem = items.find(
      (entry): entry is ChatAssistantTurnItem =>
        entry.kind === 'assistant-turn'
        && entry.segments.some((s) => s.kind === 'message'),
    );
    if (!textItem) {
      throw new Error('expected assistant-turn with text segments');
    }

    expect(textItem.segments.map((segment) => segment.kind)).toEqual([
      'message',
      'message',
    ]);
    expect(textItem.segments).toMatchObject([
      {
        kind: 'message',
        text: '我先看 README。',
      },
      {
        kind: 'message',
        text: '再补充结论。',
      },
    ]);

    const toolItems = items.filter(
      (entry): entry is ChatAssistantTurnItem =>
        entry.kind === 'assistant-turn'
        && entry.segments.some((s) => s.kind === 'tool'),
    );
    expect(toolItems).toHaveLength(2);
    expect(toolItems[0]!.tools).toMatchObject([{
      toolCallId: 'tool-a',
      name: 'read',
      status: 'completed',
    }]);
    expect(toolItems[1]!.tools).toMatchObject([{
      toolCallId: 'tool-b',
      name: 'grep',
      status: 'running',
    }]);
  });

  it('preserves embedded tool result previews on independent tool timeline entries', () => {
    const items = applyAssistantPresentationToItems({
      items: buildRenderItemsFromMessages('agent:main:main', [
        {
          role: 'assistant',
          id: 'assistant-canvas-1',
          content: [
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
          ],
        },
      ]),
      agents: [],
      defaultAssistant: null,
    });

    const toolItem = items.find(
      (entry): entry is ChatAssistantTurnItem =>
        entry.kind === 'assistant-turn'
        && entry.segments.some((s) => s.kind === 'tool'),
    );
    if (!toolItem) {
      throw new Error('expected independent tool assistant-turn item');
    }

    expect(toolItem.embeddedToolResults).toMatchObject([
      {
        toolCallId: 'tool-canvas-1',
        toolName: 'canvas_render',
        preview: {
          kind: 'canvas',
          url: '/__openclaw__/canvas/documents/cv_inline/index.html',
          viewId: 'cv-inline',
        },
      },
    ]);
    expect(toolItem.tools).toMatchObject([
      {
        toolCallId: 'tool-canvas-1',
        result: {
          kind: 'canvas',
          preview: {
            viewId: 'cv-inline',
          },
        },
      },
    ]);
  });


  it('renders tool result image content as assistant media images on the tool entry', () => {
    const items = applyAssistantPresentationToItems({
      items: buildRenderItemsFromMessages('agent:main:main', [
        {
          role: 'assistant',
          id: 'assistant-image-tool-1',
          content: [{
            type: 'toolCall',
            id: 'tool-image-1',
            name: 'render_image',
            input: { prompt: 'draw' },
          }, {
            type: 'tool_result',
            toolCallId: 'tool-image-1',
            name: 'render_image',
            details: { ok: true, path: '/tmp/render.png' },
            content: [{
              type: 'image',
              data: 'base64-image-data',
              mimeType: 'image/png',
            }],
          }],
        },
      ]),
      agents: [],
      defaultAssistant: null,
    });

    const toolItem = items.find(
      (entry): entry is ChatAssistantTurnItem =>
        entry.kind === 'assistant-turn'
        && entry.segments.some((s) => s.kind === 'tool'),
    );
    if (!toolItem) {
      throw new Error('expected independent tool assistant-turn item');
    }

    expect(toolItem.segments).toMatchObject([
      {
        kind: 'tool',
        tool: {
          toolCallId: 'tool-image-1',
          name: 'render_image',
          status: 'completed',
        },
      },
    ]);
    expect(toolItem.images).toEqual([]);
  });

  it('reuses previous assistant-turn item objects when their model content is unchanged', () => {
    const sessionKey = 'agent:main:main';
    const initialProtocolItems = buildRenderItemsFromMessages(sessionKey, [
      {
        id: 'assistant-stable-1',
        role: 'assistant',
        messageId: 'turn-stable-1',
        content: '稳定消息',
        timestamp: 1,
      },
      {
        id: 'assistant-live-1',
        role: 'assistant',
        messageId: 'turn-live-1',
        content: '第一段',
        streaming: true,
        timestamp: 2,
      },
    ]);

    const firstDecorated = applyAssistantPresentationToItems({
      items: initialProtocolItems,
      agents: [],
      defaultAssistant: null,
    });

    const settledSibling = buildRenderItemsFromMessages(sessionKey, [
      {
        id: 'assistant-live-1',
        role: 'assistant',
        messageId: 'turn-live-1',
        content: '第一段，最终版',
        timestamp: 2,
      },
    ])[0]!;

    const secondDecorated = applyAssistantPresentationToItems({
      items: [
        initialProtocolItems[0]!,
        settledSibling,
      ],
      agents: [],
      defaultAssistant: null,
      previousItems: firstDecorated,
    });

    expect(secondDecorated[0]).toBe(firstDecorated[0]);
    expect(secondDecorated[1]).not.toBe(firstDecorated[1]);
    expect(secondDecorated[1]?.key).toBe(firstDecorated[1]?.key);
    expect((secondDecorated[1] as ChatAssistantTurnItem).text).toBe('第一段，最终版');
  });
});
