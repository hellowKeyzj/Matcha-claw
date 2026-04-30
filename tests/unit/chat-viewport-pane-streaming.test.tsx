import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatViewportPane } from '@/pages/Chat/components/ChatViewportPane';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

vi.mock('@/pages/Chat/useExecutionGraphs', () => ({
  useExecutionGraphs: () => [],
}));

function buildCurrentSession(messages: Array<Record<string, unknown>>) {
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
    window: createViewportWindowState({
      messages: messages as never,
      totalMessageCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      isAtLatest: true,
    }),
  };
}

describe('chat viewport pane streaming render', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('updates the active assistant row immediately when overlay target text grows', () => {
    const now = Date.now() / 1000;
    const rafQueue: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());

    const view = render(
      <ChatViewportPane
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
        gatewayRpc={vi.fn()}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        assistantAgentId="test"
        assistantAgentName="Test Agent"
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToLatestLabel="Jump latest"
        jumpToBottomLabel="Jump bottom"
      />,
    );

    expect(screen.getAllByText((_, element) => (
      element?.textContent?.includes('first chunk') ?? false
    )).length).toBeGreaterThan(0);

    view.rerender(
      <ChatViewportPane
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
        gatewayRpc={vi.fn()}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        assistantAgentId="test"
        assistantAgentName="Test Agent"
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToLatestLabel="Jump latest"
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
      <ChatViewportPane
        isActive={false}
        currentSessionKey="agent:test:main"
        currentSession={buildCurrentSession([])}
        agents={[]}
        isGatewayRunning={false}
        gatewayRpc={vi.fn()}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        assistantAgentId="test"
        assistantAgentName="Test Agent"
        onLoadOlder={() => {}}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToLatestLabel="Jump latest"
        jumpToBottomLabel="Jump bottom"
      />,
    );

    expect(screen.getByTestId('assistant-message-avatar')).toBeInTheDocument();
    expect(document.querySelector('[data-chat-body-mode="streaming"]')).not.toBeNull();
  });
});
