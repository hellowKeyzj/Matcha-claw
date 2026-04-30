import { createRef } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChatViewportPane, type ChatViewportPaneHandle } from '@/pages/Chat/components/ChatViewportPane';
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

vi.mock('@/pages/Chat/useChatRenderModel', () => ({
  useChatRenderModel: () => ({
    rows: [],
    executionGraphSlots: {
      anchoredGraphsByRowKey: new Map(),
      suppressedToolCardRowKeys: new Set(),
    },
    pendingAssistantShell: null,
  }),
}));

vi.mock('@/pages/Chat/useChatView', () => ({
  useChatView: () => ({
    showBlockingLoading: false,
    showBlockingError: false,
    isEmptyState: false,
  }),
}));

vi.mock('@/pages/Chat/components/ChatList', () => ({
  ChatList: (props: { onLoadOlder: () => void }) => (
    <button type="button" onClick={props.onLoadOlder}>
      Load older
    </button>
  ),
}));

function buildCurrentSession(hasMore = true) {
  const base = createEmptySessionRecord();
  return {
    ...base,
    meta: {
      ...base.meta,
      historyStatus: 'ready' as const,
    },
    window: createViewportWindowState({
      messages: [],
      totalMessageCount: 0,
      windowStartOffset: hasMore ? 1 : 0,
      windowEndOffset: 0,
      hasMore,
      isAtLatest: true,
    }),
  };
}

describe('chat viewport pane command shell', () => {
  beforeEach(() => {
    scrollHandlers.prepareScopeAnchorRestore.mockReset();
    scrollHandlers.prepareScopeBottomAlign.mockReset();
    scrollHandlers.jumpToBottom.mockReset();
  });

  it('load older after session switch uses the latest scroll restore handler and session key', () => {
    const loadOlderFirst = vi.fn();
    const loadOlderSecond = vi.fn();

    const view = render(
      <ChatViewportPane
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
        jumpToLatestLabel="Jump latest"
        jumpToBottomLabel="Jump bottom"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(scrollHandlers.prepareScopeAnchorRestore).toHaveBeenCalledWith('agent:test:first');
    expect(loadOlderFirst).toHaveBeenCalledTimes(1);

    const nextPrepareScopeAnchorRestore = vi.fn<(nextScopeKey: string) => void>();
    scrollHandlers.prepareScopeAnchorRestore = nextPrepareScopeAnchorRestore;

    view.rerender(
      <ChatViewportPane
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
        jumpToLatestLabel="Jump latest"
        jumpToBottomLabel="Jump bottom"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load older' }));
    expect(nextPrepareScopeAnchorRestore).toHaveBeenCalledWith('agent:test:second');
    expect(loadOlderSecond).toHaveBeenCalledTimes(1);
  });

  it('prepareCurrentLatestBottomAlign after session switch uses the latest bottom-align handler and session key', () => {
    const paneRef = createRef<ChatViewportPaneHandle>();

    const view = render(
      <ChatViewportPane
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
        jumpToLatestLabel="Jump latest"
        jumpToBottomLabel="Jump bottom"
      />,
    );

    paneRef.current?.prepareCurrentLatestBottomAlign();
    expect(scrollHandlers.prepareScopeBottomAlign).toHaveBeenCalledWith('agent:test:first');

    const nextPrepareScopeBottomAlign = vi.fn<(nextScopeKey: string) => void>();
    scrollHandlers.prepareScopeBottomAlign = nextPrepareScopeBottomAlign;

    view.rerender(
      <ChatViewportPane
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
        jumpToLatestLabel="Jump latest"
        jumpToBottomLabel="Jump bottom"
      />,
    );

    paneRef.current?.prepareCurrentLatestBottomAlign();
    expect(nextPrepareScopeBottomAlign).toHaveBeenCalledWith('agent:test:second');
  });
});
