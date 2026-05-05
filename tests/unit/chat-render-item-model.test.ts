import { describe, expect, it } from 'vitest';
import {
  applyAssistantPresentationToItems,
  type ChatAssistantTurnItem,
} from '@/pages/Chat/chat-render-item-model';
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

  it('builds assistant markdown html for assistant-turn text', () => {
    const item = decorateItems()[1] as ChatAssistantTurnItem;

    expect(item.kind).toBe('assistant-turn');
    expect(item.assistantMarkdownHtml).toContain('<h3>');
    expect(item.assistantMarkdownHtml).toContain('<pre>');
  });

  it('keeps tool-only assistant activity inside the assistant-turn item', () => {
    const [item] = applyAssistantPresentationToItems({
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

    if (!item || item.kind !== 'assistant-turn') {
      throw new Error('expected tool-only assistant turn');
    }

    expect(item.text).toBe('');
    expect(item.tools).toMatchObject([{
      id: 'tool-1',
      name: 'read_file',
      status: 'running',
    }]);
    expect(item.segments).toMatchObject([
      {
        kind: 'tool',
        tool: {
          id: 'tool-1',
          name: 'read_file',
        },
      },
    ]);
  });

  it('preserves assistant turn segment order instead of flattening tools and text by type', () => {
    const [item] = applyAssistantPresentationToItems({
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
          toolStatuses: [{
            toolCallId: 'tool-a',
            name: 'read',
            status: 'completed',
            result: { ok: true },
            outputText: '{"ok":true}',
          }, {
            toolCallId: 'tool-b',
            name: 'grep',
            status: 'running',
          }],
        },
      ]),
      agents: [],
      defaultAssistant: null,
    });

    if (!item || item.kind !== 'assistant-turn') {
      throw new Error('expected assistant-turn');
    }

    expect(item.segments.map((segment) => segment.kind)).toEqual([
      'tool',
      'message',
      'tool',
      'message',
    ]);
    expect(item.segments).toMatchObject([
      {
        kind: 'tool',
        tool: {
          toolCallId: 'tool-a',
          name: 'read',
          status: 'completed',
        },
      },
      {
        kind: 'message',
        text: '我先看 README。',
      },
      {
        kind: 'tool',
        tool: {
          toolCallId: 'tool-b',
          name: 'grep',
          status: 'running',
        },
      },
      {
        kind: 'message',
        text: '再补充结论。',
      },
    ]);
  });

  it('preserves embedded tool result previews on assistant-turn items', () => {
    const [item] = applyAssistantPresentationToItems({
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

    if (!item || item.kind !== 'assistant-turn') {
      throw new Error('expected assistant-turn');
    }

    expect(item.embeddedToolResults).toMatchObject([
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
    expect(item.tools).toMatchObject([
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
});
