import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatList } from '@/pages/Chat/components/ChatList';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { RawMessage } from './helpers/timeline-fixtures';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

function buildCurrentSession(messages: RawMessage[]) {
  const base = createEmptySessionRecord();
  const items = buildRenderItemsFromMessages('agent:test:main', messages);
  return {
    runtime: {
      ...base.runtime,
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'submitted' as const,
    },
    items: applyAssistantPresentationToItems({
      items,
      agents: [],
      defaultAssistant: { agentId: 'test', agentName: 'Test Agent' },
    }),
    window: createViewportWindowState({
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

describe('chat list streaming render', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('updates the active assistant row immediately when the streaming target text grows', () => {
    const now = Date.now() / 1000;
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const view = render(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        runtime={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk',
            timestamp: now,
            streaming: true,
          },
        ]).runtime}
        viewport={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk',
            timestamp: now,
            streaming: true,
          },
        ]).window}
        items={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk',
            timestamp: now,
            streaming: true,
          },
        ]).items}
        liveView={{
          showBlockingLoading: false,
          showBlockingError: false,
          showBackgroundStatus: false,
          isEmptyState: false,
        }}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
        artifactGroups={[]}
        onOpenArtifactFile={() => {}}
        onOpenAttachedArtifact={() => {}}
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('first chunk') ?? false
    )).length).toBeGreaterThan(0);

    view.rerender(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        runtime={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk second chunk',
            timestamp: now,
            streaming: true,
          },
        ]).runtime}
        viewport={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk second chunk',
            timestamp: now,
            streaming: true,
          },
        ]).window}
        items={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk second chunk',
            timestamp: now,
            streaming: true,
          },
        ]).items}
        liveView={{
          showBlockingLoading: false,
          showBlockingError: false,
          showBackgroundStatus: false,
          isEmptyState: false,
        }}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
        artifactGroups={[]}
        onOpenArtifactFile={() => {}}
        onOpenAttachedArtifact={() => {}}
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('first chunk second chunk') ?? false
    )).length).toBeGreaterThan(0);
    expect(rafQueue).toHaveLength(0);
  });

  it('renders a single assistant streaming shell before the first assistant token lands', () => {
    const streamingShellSession = buildCurrentSession([
      {
        id: 'assistant-1',
        role: 'assistant',
        content: '',
        timestamp: Date.now() / 1000,
        streaming: true,
      },
    ]);
    streamingShellSession.items = streamingShellSession.items.map((item) => (
      item.kind === 'assistant-turn'
        ? { ...item, pendingState: 'typing' }
        : item
    ));

    render(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        runtime={streamingShellSession.runtime}
        viewport={streamingShellSession.window}
        items={streamingShellSession.items}
        liveView={{
          showBlockingLoading: false,
          showBlockingError: false,
          showBackgroundStatus: false,
          isEmptyState: false,
        }}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
        artifactGroups={[]}
        onOpenArtifactFile={() => {}}
        onOpenAttachedArtifact={() => {}}
      />,
    );

    expect(screen.getByTestId('assistant-message-avatar')).toBeInTheDocument();
    expect(document.querySelector('[data-chat-pending-mode="typing"]')).not.toBeNull();
  });
});

