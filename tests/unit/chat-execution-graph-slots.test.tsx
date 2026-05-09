import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatListSurface } from '@/pages/Chat/components/ChatList';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { createChatScrollChromeStore } from '@/pages/Chat/chat-scroll-chrome-store';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { GeneratedFile } from '@/lib/generated-files';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'executionGraph.generatedFiles') {
        return `${String(options?.count ?? 0)} generated files`;
      }
      return key;
    },
  }),
}));

function renderSurface(items: SessionRenderItem[], options?: {
  artifactFilesByGraphKey?: ReadonlyMap<string, GeneratedFile[]>;
  onOpenArtifactFile?: (file: GeneratedFile) => void;
}) {
  return render(
    <ChatListSurface
      messagesViewportRef={{ current: null }}
      messageContentRef={{ current: null }}
      isEmptyState={false}
      showBlockingLoading={false}
      showBlockingError={false}
      errorMessage={null}
      onPointerDown={() => {}}
      onScroll={() => {}}
      onTouchMove={() => {}}
      onWheel={() => {}}
      items={applyAssistantPresentationToItems({
        items,
        agents: [],
        defaultAssistant: null,
      })}
      showLoadOlder={false}
      isLoadingOlder={false}
      onLoadOlder={() => {}}
      loadOlderLabel="Load older"
      scrollChromeStore={createChatScrollChromeStore({
        isBottomLocked: true,
        visible: true,
        isAtLatest: true,
        jumpActionLabel: 'Jump',
      })}
      showThinking={false}
      userAvatarImageUrl={null}
      onJumpToItemKey={() => {}}
      artifactFilesByGraphKey={options?.artifactFilesByGraphKey ?? new Map()}
      onOpenArtifactFile={options?.onOpenArtifactFile ?? (() => {})}
    />,
  );
}

describe('chat execution graph items', () => {
  it('renders execution graph items inline after their anchor message item', () => {
    const messageItems = buildRenderItemsFromMessages('agent:test:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
    ]);
    const items = [
      messageItems[0]!,
      messageItems[1]!,
      {
        key: 'session:agent:test:main|graph:graph-1',
        kind: 'execution-graph' as const,
        sessionKey: 'agent:test:main',
        role: 'assistant' as const,
        text: '',
        createdAt: 2,
        updatedAt: 2,
        status: 'final' as const,
        laneKey: messageItems[1]!.laneKey,
        turnKey: messageItems[1]!.turnKey,
        agentId: messageItems[1]!.agentId,
        graphId: 'graph-1',
        completionItemKey: messageItems[1]!.key,
        childSessionKey: 'child-1',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
        triggerItemKey: messageItems[1]!.key,
      },
    ] satisfies SessionRenderItem[];

    renderSurface(items);

    expect(screen.getByTestId('chat-execution-graph-rail')).toBeInTheDocument();
  });

  it('renders generated file entries for execution graphs and opens them from the message rail', () => {
    const messageItems = buildRenderItemsFromMessages('agent:test:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
    ]);
    const graphKey = 'session:agent:test:main|graph:graph-1';
    const items = [
      messageItems[0]!,
      messageItems[1]!,
      {
        key: graphKey,
        kind: 'execution-graph' as const,
        sessionKey: 'agent:test:main',
        role: 'assistant' as const,
        text: '',
        createdAt: 2,
        updatedAt: 2,
        status: 'final' as const,
        laneKey: messageItems[1]!.laneKey,
        turnKey: messageItems[1]!.turnKey,
        agentId: messageItems[1]!.agentId,
        graphId: 'graph-1',
        completionItemKey: messageItems[1]!.key,
        childSessionKey: 'child-1',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
        triggerItemKey: messageItems[1]!.key,
      },
    ] satisfies SessionRenderItem[];
    const file: GeneratedFile = {
      filePath: '/workspace/demo.ts',
      fileName: 'demo.ts',
      ext: '.ts',
      mimeType: 'text/typescript',
      contentType: 'code',
      sourceTool: 'edit',
      action: 'modified',
      baseline: 'const value = 1;\n',
      content: 'const value = 2;\n',
      lineStats: { added: 1, removed: 1 },
      toolId: 'edit-1',
    };
    const onOpenArtifactFile = vi.fn();

    renderSurface(items, {
      artifactFilesByGraphKey: new Map([[graphKey, [file]]]),
      onOpenArtifactFile,
    });

    expect(screen.getByText('1 generated files')).toBeInTheDocument();
    expect(screen.getByText('demo.ts')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /demo\.ts/i }));
    expect(onOpenArtifactFile).toHaveBeenCalledWith(file);
  });

  it('opens generated file entries on pointer down so real pointer clicks are not lost to scroll capture', () => {
    const messageItems = buildRenderItemsFromMessages('agent:test:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
    ]);
    const graphKey = 'session:agent:test:main|graph:graph-1';
    const items = [
      messageItems[0]!,
      messageItems[1]!,
      {
        key: graphKey,
        kind: 'execution-graph' as const,
        sessionKey: 'agent:test:main',
        role: 'assistant' as const,
        text: '',
        createdAt: 2,
        updatedAt: 2,
        status: 'final' as const,
        laneKey: messageItems[1]!.laneKey,
        turnKey: messageItems[1]!.turnKey,
        agentId: messageItems[1]!.agentId,
        graphId: 'graph-1',
        completionItemKey: messageItems[1]!.key,
        childSessionKey: 'child-1',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
        triggerItemKey: messageItems[1]!.key,
      },
    ] satisfies SessionRenderItem[];
    const file: GeneratedFile = {
      filePath: '/workspace/demo.ts',
      fileName: 'demo.ts',
      ext: '.ts',
      mimeType: 'text/typescript',
      contentType: 'code',
      sourceTool: 'edit',
      action: 'modified',
      baseline: 'const value = 1;\n',
      content: 'const value = 2;\n',
      lineStats: { added: 1, removed: 1 },
      toolId: 'edit-1',
    };
    const onOpenArtifactFile = vi.fn();

    renderSurface(items, {
      artifactFilesByGraphKey: new Map([[graphKey, [file]]]),
      onOpenArtifactFile,
    });

    fireEvent.pointerDown(screen.getByRole('button', { name: /demo\.ts/i }), { button: 0 });
    expect(onOpenArtifactFile).toHaveBeenCalledWith(file);
  });

  it('opens generated file entries on mouse down for environments that dispatch mouse events without stable pointer activation', () => {
    const messageItems = buildRenderItemsFromMessages('agent:test:main', [
      { role: 'user', content: 'u1', timestamp: 1, id: 'u1' },
      { role: 'assistant', content: 'a1', timestamp: 2, id: 'a1' },
    ]);
    const graphKey = 'session:agent:test:main|graph:graph-1';
    const items = [
      messageItems[0]!,
      messageItems[1]!,
      {
        key: graphKey,
        kind: 'execution-graph' as const,
        sessionKey: 'agent:test:main',
        role: 'assistant' as const,
        text: '',
        createdAt: 2,
        updatedAt: 2,
        status: 'final' as const,
        laneKey: messageItems[1]!.laneKey,
        turnKey: messageItems[1]!.turnKey,
        agentId: messageItems[1]!.agentId,
        graphId: 'graph-1',
        completionItemKey: messageItems[1]!.key,
        childSessionKey: 'child-1',
        agentLabel: 'agent',
        sessionLabel: 'session',
        steps: [],
        active: false,
        triggerItemKey: messageItems[1]!.key,
      },
    ] satisfies SessionRenderItem[];
    const file: GeneratedFile = {
      filePath: '/workspace/demo.ts',
      fileName: 'demo.ts',
      ext: '.ts',
      mimeType: 'text/typescript',
      contentType: 'code',
      sourceTool: 'edit',
      action: 'modified',
      baseline: 'const value = 1;\n',
      content: 'const value = 2;\n',
      lineStats: { added: 1, removed: 1 },
      toolId: 'edit-1',
    };
    const onOpenArtifactFile = vi.fn();

    renderSurface(items, {
      artifactFilesByGraphKey: new Map([[graphKey, [file]]]),
      onOpenArtifactFile,
    });

    fireEvent.mouseDown(screen.getByRole('button', { name: /demo\.ts/i }), { button: 0 });
    expect(onOpenArtifactFile).toHaveBeenCalledWith(file);
  });
});
