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
        uniqueId: 'team-turn-1',
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
    const item = decorateItems()[2] as ChatAssistantTurnItem;

    expect(item.kind).toBe('assistant-turn');
    expect(item.text).toBe('');
    expect(item.toolCalls).toMatchObject([{
      id: 'tool-1',
      name: 'read_file',
    }]);
  });
});
