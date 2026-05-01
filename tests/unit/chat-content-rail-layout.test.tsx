import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { createChatScrollChromeStore } from '@/pages/Chat/chat-scroll-chrome-store';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import { ChatListSurface } from '@/pages/Chat/components/ChatList';

const chatMessageRenderSpy = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/pages/Chat/ChatMessage', async () => {
  const React = await import('react');
  return {
    ChatMessage: React.memo(function MockChatMessage() {
      chatMessageRenderSpy();
      return <div data-testid="chat-message-item" />;
    }),
  };
});

vi.mock('@/pages/Chat/pending-assistant-shell', () => ({
  PendingAssistantShell: () => <div data-testid="chat-pending-shell" />,
}));

vi.mock('@/pages/Chat/components/ChatStates', () => ({
  FailureScreen: () => <div data-testid="chat-failure-screen" />,
}));

describe('chat content rail layout', () => {
  beforeEach(() => {
    chatMessageRenderSpy.mockClear();
  });

  function buildScrollChromeStore(options?: {
    isBottomLocked?: boolean;
    visible?: boolean;
    isAtLatest?: boolean;
    jumpActionLabel?: string;
    onJumpAction?: () => void;
  }) {
    const store = createChatScrollChromeStore({
      isBottomLocked: options?.isBottomLocked ?? true,
      visible: options?.visible ?? true,
      isAtLatest: options?.isAtLatest ?? true,
      jumpActionLabel: options?.jumpActionLabel ?? 'Jump to bottom',
    });
    store.setJumpAction(options?.onJumpAction ?? vi.fn());
    return store;
  }

  it('chat list uses a centered narrow content rail with composer-driven viewport bottom padding', () => {
    const { container } = render(
      <ChatListSurface
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        showBlockingError={false}
        errorMessage={null}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        rows={[{
          kind: 'message',
          key: 'row:1',
          message: {
            id: 'message-1',
            role: 'assistant',
            content: 'hello',
          },
        } as never]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        streamingTools={[]}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        executionGraphSlots={{
          anchoredGraphsByRowKey: new Map(),
          suppressedToolCardRowKeys: new Set(),
        }}
        pendingAssistantShell={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-message-item')).toBeInTheDocument();
    const viewport = container.querySelector('[style*="overflow-anchor"]');
    expect(viewport?.className).toContain('min-h-0');
    expect(viewport?.className).toContain('flex-1');
    expect(viewport?.className).toContain('overflow-y-auto');
    expect(viewport).toHaveStyle({ scrollbarGutter: 'stable' });
    const classNames = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .map((node) => node.className)
      .filter((value): value is string => typeof value === 'string');

    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.threadRail))).toBe(true);
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.threadViewportPadding))).toBe(true);
    expect(CHAT_LAYOUT_TOKENS.threadRail).toContain('mx-auto');
    expect(CHAT_LAYOUT_TOKENS.threadRail).toContain('max-w-');
    expect(CHAT_LAYOUT_TOKENS.threadViewportPadding).not.toContain('pb-');
    expect(viewport?.style.paddingBottom).toContain('--chat-thread-bottom-padding');
  });

  it('chat list places the load-older affordance above the message stack instead of burying it in the top padding gap', () => {
    render(
      <ChatListSurface
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        showBlockingError={false}
        errorMessage={null}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        rows={[{
          kind: 'message',
          key: 'row:1',
          message: {
            id: 'message-1',
            role: 'assistant',
            content: 'hello',
          },
        } as never]}
        showLoadOlder
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        streamingTools={[]}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        executionGraphSlots={{
          anchoredGraphsByRowKey: new Map(),
          suppressedToolCardRowKeys: new Set(),
        }}
        pendingAssistantShell={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-load-older-rail')).toBeInTheDocument();
    expect(CHAT_LAYOUT_TOKENS.threadTopAffordanceRail).toContain('-mt-10');
    expect(screen.getByTestId('chat-message-stack').className).toContain(CHAT_LAYOUT_TOKENS.threadMessageStackPaddingTop);
    expect(screen.getByRole('button', { name: 'Load older' }).className).toContain('h-7');
  });

  it('chat list exposes a jump-to-bottom button only when requested', () => {
    const onJumpAction = vi.fn();
    const scrollChromeStore = buildScrollChromeStore({
      isBottomLocked: false,
      onJumpAction,
    });

    const { container } = render(
      <ChatListSurface
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        showBlockingError={false}
        errorMessage={null}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        rows={[{
          kind: 'message',
          key: 'row:1',
          message: {
            id: 'message-1',
            role: 'assistant',
            content: 'hello',
          },
        } as never]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={scrollChromeStore}
        showThinking={false}
        streamingTools={[]}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        executionGraphSlots={{
          anchoredGraphsByRowKey: new Map(),
          suppressedToolCardRowKeys: new Set(),
        }}
        pendingAssistantShell={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    const jumpButton = screen.getByRole('button', { name: 'Jump to bottom' });
    jumpButton.click();
    expect(onJumpAction).toHaveBeenCalledTimes(1);
    const floatingRail = jumpButton.parentElement as HTMLElement | null;
    expect(floatingRail?.className).toContain('max-w-[56rem]');
    const jumpRail = floatingRail?.parentElement as HTMLElement | null;
    expect(jumpRail?.className).toContain('inset-x-0');
    expect(jumpRail?.style.bottom).toContain('--chat-composer-safe-offset');
  });

  it('chat list renders execution graphs on a sibling rail below the anchored message row', () => {
    render(
      <ChatListSurface
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        showBlockingError={false}
        errorMessage={null}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        rows={[{
          kind: 'message',
          key: 'assistant-1',
          message: {
            id: 'assistant-1',
            role: 'assistant',
            content: 'hello',
          },
        } as never]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        streamingTools={[]}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        executionGraphSlots={{
          anchoredGraphsByRowKey: new Map([['assistant-1', [{
            id: 'graph-1',
            anchorMessageKey: 'assistant-1',
            triggerMessageKey: 'assistant-1',
            agentLabel: 'main',
            sessionLabel: 'session',
            steps: [],
            active: false,
          }]]]),
          suppressedToolCardRowKeys: new Set(),
        }}
        pendingAssistantShell={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-message-item')).toBeInTheDocument();
    expect(screen.getByTestId('chat-execution-graph-rail')).toBeInTheDocument();
    expect(screen.getByTestId('chat-execution-graph')).toBeInTheDocument();
  });

  it('jump-to-bottom chrome toggle should not rerender static message rows', () => {
    const rows = [{
      kind: 'message',
      key: 'assistant-1',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
        streaming: false,
      },
    }] as never;
    const sharedStreamingTools: never[] = [];
    const executionGraphSlots = {
      anchoredGraphsByRowKey: new Map(),
      suppressedToolCardRowKeys: new Set(),
    };
    const commonProps = {
      messagesViewportRef: { current: null },
      messageContentRef: { current: null },
      isEmptyState: false,
      showBlockingLoading: false,
      showBlockingError: false,
      errorMessage: null,
      onPointerDown: vi.fn(),
      onScroll: vi.fn(),
      onTouchMove: vi.fn(),
      onWheel: vi.fn(),
      rows,
      showLoadOlder: false,
      isLoadingOlder: false,
      onLoadOlder: vi.fn(),
      loadOlderLabel: 'Load older',
      scrollChromeStore: buildScrollChromeStore(),
      showThinking: false,
      streamingTools: sharedStreamingTools,
      assistantAgentId: 'main',
      assistantAgentName: 'Main',
      userAvatarImageUrl: null,
      executionGraphSlots,
      pendingAssistantShell: null,
      onJumpToRowKey: vi.fn(),
    };

    render(
      <ChatListSurface
        {...commonProps}
      />,
    );

    expect(chatMessageRenderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      commonProps.scrollChromeStore.setBottomLocked(false);
    });

    expect(chatMessageRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Jump to bottom' })).toBeInTheDocument();
  });

  it('chat input uses a floating narrow composer rail instead of a full-width dock strip', () => {
    const { container } = render(<ChatInput onSend={vi.fn()} />);

    const classNames = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .map((node) => node.className)
      .filter((value): value is string => typeof value === 'string');

    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.inputRail))).toBe(true);
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.inputCard))).toBe(true);
    expect(CHAT_LAYOUT_TOKENS.inputRail).toContain('mx-auto');
    expect(CHAT_LAYOUT_TOKENS.inputRail).toContain('max-w-');
    expect(CHAT_LAYOUT_TOKENS.inputCard).toContain('backdrop-blur');
    expect(CHAT_LAYOUT_TOKENS.inputCard).toContain('shadow-');
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('empty state no longer renders welcome content inside the message viewport rail', () => {
    const { container } = render(
      <ChatListSurface
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState
        showBlockingLoading={false}
        showBlockingError={false}
        errorMessage={null}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        rows={[]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        streamingTools={[]}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        executionGraphSlots={{
          anchoredGraphsByRowKey: new Map(),
          suppressedToolCardRowKeys: new Set(),
        }}
        pendingAssistantShell={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    const viewport = container.querySelector('.chat-scroll-sync-viewport') as HTMLElement | null;
    expect(viewport?.className).toContain(CHAT_LAYOUT_TOKENS.threadViewportPadding);
    const classNames = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .map((node) => node.className)
      .filter((value): value is string => typeof value === 'string');
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.threadRail))).toBe(true);
    expect(screen.queryByTestId('chat-message-item')).toBeNull();
  });
});
