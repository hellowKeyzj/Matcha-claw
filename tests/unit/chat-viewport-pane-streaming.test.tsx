import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatList } from '@/pages/Chat/components/ChatList';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildTimelineEntriesFromMessages } from '@/stores/chat/timeline-message';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { RawMessage } from '@/stores/chat';

vi.mock('@/pages/Chat/useExecutionGraphs', () => ({
  useExecutionGraphs: () => [],
}));

function buildCurrentSession(messages: RawMessage[]) {
  const base = createEmptySessionRecord();
  return {
    ...base,
    meta: {
      ...base.meta,
      historyStatus: 'ready' as const,
    },
    runtime: {
      ...base.runtime,
      sending: true,
      activeRunId: 'run-1',
      runPhase: 'submitted' as const,
    },
    timelineEntries: buildTimelineEntriesFromMessages('agent:test:main', messages),
    window: createViewportWindowState({
      totalMessageCount: messages.length,
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
        currentSession={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk',
            timestamp: now,
            streaming: true,
          },
        ])}
        agents={[]}
        isGatewayRunning={false}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        defaultAssistant={{ agentId: 'test', agentName: 'Test Agent' }}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('first chunk') ?? false
    )).length).toBeGreaterThan(0);

    view.rerender(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        currentSession={buildCurrentSession([
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'first chunk second chunk',
            timestamp: now,
            streaming: true,
          },
        ])}
        agents={[]}
        isGatewayRunning={false}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        defaultAssistant={{ agentId: 'test', agentName: 'Test Agent' }}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('first chunk second chunk') ?? false
    )).length).toBeGreaterThan(0);
    expect(rafQueue).toHaveLength(0);
  });

  it('renders a single assistant streaming shell before the first assistant token lands', () => {
    render(
      <ChatList
        isActive={false}
        currentSessionKey="agent:test:main"
        currentSession={buildCurrentSession([])}
        agents={[]}
        isGatewayRunning={false}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        defaultAssistant={{ agentId: 'test', agentName: 'Test Agent' }}
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
      />,
    );

    expect(screen.getByTestId('assistant-message-avatar')).toBeInTheDocument();
    expect(document.querySelector('[data-chat-body-mode="streaming"]')).not.toBeNull();
  });
});
