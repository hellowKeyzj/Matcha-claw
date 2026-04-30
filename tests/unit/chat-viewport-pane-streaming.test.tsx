import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatViewportPane } from '@/pages/Chat/components/ChatViewportPane';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

vi.mock('@/lib/idle-ready', () => ({
  scheduleIdleReady: () => () => {},
}));

vi.mock('@/pages/Chat/useExecutionGraphs', () => ({
  useExecutionGraphs: () => ({
    executionGraphs: [],
    suppressedToolCardRowKeys: new Set<string>(),
  }),
}));

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
        viewport={createViewportWindowState({
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'first chunk',
              timestamp: now,
              streaming: true,
            },
          ],
          totalMessageCount: 1,
          windowStartOffset: 0,
          windowEndOffset: 1,
          isAtLatest: true,
        })}
        agents={[]}
        isGatewayRunning={false}
        gatewayRpc={vi.fn()}
        currentSessionStatus="ready"
        errorMessage={null}
        sending
        pendingFinal={false}
        waitingApproval={false}
        showThinking={false}
        streamingTools={[]}
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
        viewport={createViewportWindowState({
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'first chunk second chunk',
              timestamp: now,
              streaming: true,
            },
          ],
          totalMessageCount: 1,
          windowStartOffset: 0,
          windowEndOffset: 1,
          isAtLatest: true,
        })}
        agents={[]}
        isGatewayRunning={false}
        gatewayRpc={vi.fn()}
        currentSessionStatus="ready"
        errorMessage={null}
        sending
        pendingFinal={false}
        waitingApproval={false}
        showThinking={false}
        streamingTools={[]}
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
});
