import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatList, type ChatListHandle } from '@/pages/Chat/components/ChatList';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

const scrollHandlers = {
  prepareScopeAnchorRestore: vi.fn<(nextScopeKey: string) => void>(),
  prepareScopeBottomAlign: vi.fn<(nextScopeKey: string) => void>(),
  jumpToBottom: vi.fn(),
};

vi.mock('@/pages/Chat/useChatScroll', () => ({
  useChatScroll: () => ({
    handleViewportPointerDown: vi.fn(),
    handleViewportTouchMove: vi.fn(),
    handleViewportWheel: vi.fn(),
    handleViewportScroll: vi.fn(),
    prepareScopeAnchorRestore: scrollHandlers.prepareScopeAnchorRestore,
    prepareScopeBottomAlign: scrollHandlers.prepareScopeBottomAlign,
    jumpToBottom: scrollHandlers.jumpToBottom,
  }),
}));

vi.mock('@/pages/Chat/useExecutionGraphs', () => ({
  useExecutionGraphs: () => [],
}));

vi.mock('@/pages/Chat/useChatView', () => ({
  useChatView: () => ({
    showBlockingLoading: false,
    showBlockingError: false,
    isEmptyState: false,
  }),
}));

vi.mock('@/pages/Chat/components/ChatList', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/pages/Chat/components/ChatList')>();
  return {
    ...actual,
    ChatListSurface: (props: {
      onLoadOlder: () => void;
      scrollChromeStore: { runJumpAction: () => void };
    }) => (
      <>
        <button type="button" onClick={props.onLoadOlder}>
          Load older
        </button>
        <button type="button" onClick={props.scrollChromeStore.runJumpAction}>
          Jump to bottom
        </button>
      </>
    ),
  };
});

function buildCurrentSession(hasMore = true) {
  const base = createEmptySessionRecord();
  return {
    ...base,
    meta: {
      ...base.meta,
      historyStatus: 'ready' as const,
    },
    messages: [],
    window: createViewportWindowState({
      totalMessageCount: 0,
      windowStartOffset: hasMore ? 1 : 0,
      windowEndOffset: 0,
      hasMore,
      isAtLatest: true,
    }),
  };
}

describe('chat list command shell', () => {
  beforeEach(() => {
    scrollHandlers.prepareScopeAnchorRestore.mockReset();
    scrollHandlers.prepareScopeBottomAlign.mockReset();
    scrollHandlers.jumpToBottom.mockReset();
  });

  it('load older after session switch uses the latest scroll restore handler and session key', () => {
    const loadOlderFirst = vi.fn();
    const loadOlderSecond = vi.fn();

    const view = render(
      <ChatList
        isActive
        currentSessionKey="agent:test:first"
        currentSession={buildCurrentSession(true)}
        agents={[]}
        isGatewayRunning={false}
        gatewayRpc={vi.fn()}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        assistantAgentId="test"
        assistantAgentName="Test Agent"
        onLoadOlder={loadOlderFirst}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(scrollHandlers.prepareScopeAnchorRestore).toHaveBeenCalledWith('agent:test:first');
    expect(loadOlderFirst).toHaveBeenCalledTimes(1);

    const nextPrepareScopeAnchorRestore = vi.fn<(nextScopeKey: string) => void>();
    scrollHandlers.prepareScopeAnchorRestore = nextPrepareScopeAnchorRestore;

    view.rerender(
      <ChatList
        isActive
        currentSessionKey="agent:test:second"
        currentSession={buildCurrentSession(true)}
        agents={[]}
        isGatewayRunning={false}
        gatewayRpc={vi.fn()}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        assistantAgentId="test"
        assistantAgentName="Test Agent"
        onLoadOlder={loadOlderSecond}
        loadOlderLabel="Load older"
        onJumpToLatest={() => {}}
        jumpToBottomLabel="Jump bottom"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(nextPrepareScopeAnchorRestore).toHaveBeenCalledWith('agent:test:second');
    expect(loadOlderSecond).toHaveBeenCalledTimes(1);
  });

  it('prepareCurrentLatestBottomAlign after session switch uses the latest bottom-align handler and session key', () => {
    const paneRef = createRef<ChatListHandle>();

    const view = render(
      <ChatList
        ref={paneRef}
        isActive
        currentSessionKey="agent:test:first"
        currentSession={buildCurrentSession(false)}
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
        jumpToBottomLabel="Jump bottom"
      />,
    );

    paneRef.current?.prepareCurrentLatestBottomAlign();
    expect(scrollHandlers.prepareScopeBottomAlign).toHaveBeenCalledWith('agent:test:first');

    const nextPrepareScopeBottomAlign = vi.fn<(nextScopeKey: string) => void>();
    scrollHandlers.prepareScopeBottomAlign = nextPrepareScopeBottomAlign;

    view.rerender(
      <ChatList
        ref={paneRef}
        isActive
        currentSessionKey="agent:test:second"
        currentSession={buildCurrentSession(false)}
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
        jumpToBottomLabel="Jump bottom"
      />,
    );

    paneRef.current?.prepareCurrentLatestBottomAlign();
    expect(nextPrepareScopeBottomAlign).toHaveBeenCalledWith('agent:test:second');
  });

  it('jump action schedules bottom align before refreshing a detached non-latest window', () => {
    const jumpToLatest = vi.fn();

    render(
      <ChatList
        isActive
        currentSessionKey="agent:test:main"
        currentSession={{
          ...buildCurrentSession(false),
          window: createViewportWindowState({
            totalMessageCount: 12,
            windowStartOffset: 0,
            windowEndOffset: 6,
            hasMore: false,
            hasNewer: true,
            isAtLatest: false,
          }),
        }}
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
        onJumpToLatest={jumpToLatest}
        jumpToBottomLabel="Jump bottom"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Jump bottom' }));

    expect(scrollHandlers.prepareScopeBottomAlign).toHaveBeenCalledWith('agent:test:main');
    expect(jumpToLatest).toHaveBeenCalledTimes(1);
    expect(scrollHandlers.jumpToBottom).not.toHaveBeenCalled();
  });
});
