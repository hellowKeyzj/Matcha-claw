import { describe, expect, it } from 'vitest';
import { applyAssistantPresentationToItems, type ChatRenderItem } from '@/pages/Chat/chat-render-item-model';
import { collectChatArtifactGroups } from '@/pages/Chat/artifacts';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { SessionRenderExecutionGraphItem } from '../../runtime-host/shared/session-adapter-types';

describe('chat artifacts', () => {
  it('collects generated files from the assistant reply anchored by an execution graph', () => {
    const sessionKey = 'agent:test:main';
    const protocolItems = buildRenderItemsFromMessages(sessionKey, [
      {
        id: 'user-1',
        role: 'user',
        content: 'Patch the file',
        timestamp: 1,
      },
      {
        id: 'assistant-1',
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'edit-1',
            name: 'edit',
            input: {
              file_path: '/workspace/demo.ts',
              old_string: 'const value = 1;\n',
              new_string: 'const value = 2;\n',
            },
          },
        ],
        timestamp: 2,
      },
      {
        id: 'assistant-2',
        role: 'assistant',
        content: 'Done',
        timestamp: 3,
      },
    ]);

    const toolTurn = protocolItems.find((item) => item.kind === 'assistant-turn' && item.turnKey === 'tool:edit-1');
    if (!toolTurn || toolTurn.kind !== 'assistant-turn') {
      throw new Error('expected tool assistant-turn');
    }

    const graph: SessionRenderExecutionGraphItem = {
      key: 'graph-1',
      kind: 'execution-graph',
      sessionKey,
      role: 'assistant',
      text: '',
      graphId: 'graph-1',
      completionItemKey: 'completion-1',
      childSessionKey: 'agent:test:child',
      agentLabel: 'writer',
      sessionLabel: 'child',
      steps: [],
      active: false,
      replyItemKey: toolTurn.key,
    };

    const items = applyAssistantPresentationToItems({
      items: [graph, ...protocolItems],
      agents: [],
      defaultAssistant: null,
    }) as ChatRenderItem[];

    const groups = collectChatArtifactGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.files).toEqual([
      expect.objectContaining({
        filePath: '/workspace/demo.ts',
        content: 'const value = 2;\n',
      }),
    ]);
  });
});
