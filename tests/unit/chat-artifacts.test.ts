import { describe, expect, it } from 'vitest';
import { extractArtifactRefsFromAssistantText } from '@/pages/Chat/artifact-paths';
import { applyAssistantPresentationToItems, type ChatRenderItem } from '@/pages/Chat/chat-render-item-model';
import { extractGeneratedFilesFromToolCards } from '@/lib/generated-files';
import { collectChatArtifactGroups } from '@/pages/Chat/artifacts';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { SessionRenderExecutionGraphItem } from '../../src/types/session/render-item';
import type { SessionRenderToolCard } from '../../src/types/session/tool-card';

function toolCard(overrides: Pick<SessionRenderToolCard, 'id' | 'name' | 'input'> & Partial<SessionRenderToolCard>): SessionRenderToolCard {
  return {
    displayTitle: overrides.name,
    status: 'completed',
    result: { kind: 'none', surface: 'tool-card' },
    ...overrides,
  };
}

describe('chat artifacts', () => {
  it('extracts svg refs from assistant media markers', () => {
    expect(extractArtifactRefsFromAssistantText([
      String.raw`MEDIA:C:\Users\me\.openclaw\workspace\out.svg`,
      'MEDIA:/tmp/out.svg',
      'MEDIA:~/out.svg',
    ].join('\n'))).toEqual([
      expect.objectContaining({ filePath: String.raw`C:\Users\me\.openclaw\workspace\out.svg`, mimeType: 'image/svg+xml' }),
      expect.objectContaining({ filePath: '/tmp/out.svg', mimeType: 'image/svg+xml' }),
      expect.objectContaining({ filePath: '~/out.svg', mimeType: 'image/svg+xml' }),
    ]);
  });

  it('extracts media markers after punctuation and paths with spaces', () => {
    expect(extractArtifactRefsFromAssistantText([
      String.raw`必备~MEDIA:C:\Users\me\.openclaw\workspace\space name.svg`,
      '✅MEDIA:/tmp/space name.svg',
    ].join('\n'))).toEqual([
      expect.objectContaining({ filePath: String.raw`C:\Users\me\.openclaw\workspace\space name.svg`, mimeType: 'image/svg+xml' }),
      expect.objectContaining({ filePath: '/tmp/space name.svg', mimeType: 'image/svg+xml' }),
    ]);
  });

  it('extracts multi-file generated files from public details patch', () => {
    const patch = [
      'diff --git a/src/one.ts b/src/one.ts',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1 @@',
      '-export const one = 1;',
      '+export const one = 2;',
      'diff --git a/src/two.ts b/src/two.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/two.ts',
      '@@ -0,0 +1 @@',
      '+export const two = true;',
    ].join('\n');

    const files = extractGeneratedFilesFromToolCards([
      toolCard({
        id: 'edit-1',
        toolCallId: 'call-1',
        name: 'Edit',
        input: { file_path: '/workspace/ignored.ts', content: 'private-input-content' },
        details: { patch },
      }),
    ]);

    expect(files).toEqual([
      expect.objectContaining({
        filePath: 'src/one.ts',
        sourceTool: 'edit',
        action: 'modified',
        baseline: 'export const one = 1;',
        content: 'export const one = 2;',
        lineStats: { added: 1, removed: 1 },
        toolCallId: 'call-1',
      }),
      expect.objectContaining({
        filePath: 'src/two.ts',
        sourceTool: 'edit',
        action: 'created',
        baseline: '',
        content: 'export const two = true;',
        lineStats: { added: 1, removed: 0 },
      }),
    ]);
    expect(files.map((file) => file.content).join('\n')).not.toContain('private-input-content');
  });

  it('extracts apply_patch input into created modified and deleted artifact metadata', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const created = true;',
      '*** Update File: src/existing.ts',
      '@@',
      '-export const value = 1;',
      '+export const value = 2;',
      '*** Delete File: src/old.ts',
      '-export const old = true;',
      '*** End Patch',
    ].join('\n');

    const files = extractGeneratedFilesFromToolCards([
      toolCard({ id: 'patch-1', name: 'apply_patch', input: { patch } }),
    ]);

    expect(files).toEqual([
      expect.objectContaining({ filePath: 'src/new.ts', action: 'created', baseline: '', content: 'export const created = true;' }),
      expect.objectContaining({ filePath: 'src/existing.ts', action: 'modified', baseline: 'export const value = 1;', content: 'export const value = 2;' }),
      expect.objectContaining({ filePath: 'src/old.ts', action: 'deleted', baseline: 'export const old = true;', content: '' }),
    ]);
  });

  it('collects artifact groups from ordinary assistant tool turns', () => {
    const tool = toolCard({
      id: 'patch-1',
      name: 'patch',
      input: {
        patch: [
          'diff --git a/src/demo.ts b/src/demo.ts',
          '--- a/src/demo.ts',
          '+++ b/src/demo.ts',
          '@@ -1 +1 @@',
          '-const value = 1;',
          '+const value = 2;',
        ].join('\n'),
      },
    });
    const items: ChatRenderItem[] = [{
      key: 'assistant-tool-turn',
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey: 'session-1',
      identitySource: 'tool_call',
      identityMode: 'tool_call',
      identityConfidence: 'strong',
      status: 'final',
      segments: [{ kind: 'tool', key: 'segment-1', tool }],
      thinking: null,
      tools: [tool],
      text: '',
      images: [],
      attachedFiles: [],
      assistantPresentation: null,
      renderSignature: 'sig-1',
    }];

    const groups = collectChatArtifactGroups(items);

    expect(groups).toEqual([
      expect.objectContaining({
        graphItemKey: 'assistant-tool-turn',
        replyItemKey: 'assistant-tool-turn',
        files: [expect.objectContaining({ filePath: 'src/demo.ts', content: 'const value = 2;' })],
      }),
    ]);
  });

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
