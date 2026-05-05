import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { ChatListSurface } from '@/pages/Chat/components/ChatList';
import { createChatScrollChromeStore } from '@/pages/Chat/chat-scroll-chrome-store';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import {
  applyAssistantPresentationToItems,
  type ChatRenderItem,
} from '@/pages/Chat/chat-render-item-model';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

const chatMessageRenderSpy = vi.fn();
const chatMessagePropsSpy = vi.fn();
const assistantTurnRenderSpy = vi.fn();
const assistantTurnPropsSpy = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/pages/Chat/ChatMessage', async () => {
  const React = await import('react');
  return {
    ChatMessage: React.memo(function MockChatMessage(props: unknown) {
      chatMessageRenderSpy();
      chatMessagePropsSpy(props);
      return <div data-testid="chat-message-item" />;
    }),
  };
});

vi.mock('@/pages/Chat/ChatAssistantTurn', async () => {
  const React = await import('react');
  return {
    ChatAssistantTurn: React.memo(function MockChatAssistantTurn(props: unknown) {
      assistantTurnRenderSpy();
      assistantTurnPropsSpy(props);
      return <div data-testid="chat-assistant-turn-item" />;
    }),
  };
});

vi.mock('@/pages/Chat/components/ChatStates', () => ({
  FailureScreen: () => <div data-testid="chat-failure-screen" />,
}));

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

function decorateItems(items: SessionRenderItem[]): ChatRenderItem[] {
  return applyAssistantPresentationToItems({
    items,
    agents: [
      {
        id: 'agent-a',
        agentName: 'Agent A',
      },
      {
        id: 'agent-b',
        agentName: 'Agent B',
      },
    ],
    defaultAssistant: null,
  });
}

function buildUserAndAssistantItems(): ChatRenderItem[] {
  return decorateItems(buildRenderItemsFromMessages('agent:test:main', [
    {
      id: 'user-1',
      role: 'user',
      content: 'hello',
      timestamp: 1,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      content: 'world',
      timestamp: 2,
      messageId: 'turn-1',
      agentId: 'agent-a',
    },
  ]));
}

describe('chat content rail layout', () => {
  beforeEach(() => {
    chatMessageRenderSpy.mockClear();
    chatMessagePropsSpy.mockClear();
    assistantTurnRenderSpy.mockClear();
    assistantTurnPropsSpy.mockClear();
  });

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
        items={buildUserAndAssistantItems()}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToItemKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-message-item')).toBeInTheDocument();
    expect(screen.getByTestId('chat-assistant-turn-item')).toBeInTheDocument();
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

  it('chat list writes assistant turn/lane identity onto the rendered item wrapper', () => {
    const items = decorateItems(buildRenderItemsFromMessages('agent:test:main', [
      {
        id: 'assistant-a',
        role: 'assistant',
        agentId: 'agent-a',
        messageId: 'team-turn-1',
        content: 'Alpha',
        timestamp: 1,
      },
    ]));

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
        items={items}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToItemKey={vi.fn()}
      />,
    );

    const itemWrapper = container.querySelector('[data-chat-item-kind="assistant-turn"]');
    expect(itemWrapper).toHaveAttribute('data-chat-assistant-turn-key', 'team-turn-1');
    expect(itemWrapper).toHaveAttribute('data-chat-assistant-lane-key', 'member:agent-a');
    expect(itemWrapper).toHaveAttribute('data-chat-assistant-agent-id', 'agent-a');
  });

  it('chat list places the load-older affordance above the item stack', () => {
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
        items={buildUserAndAssistantItems()}
        showLoadOlder
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToItemKey={vi.fn()}
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
        items={buildUserAndAssistantItems()}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={scrollChromeStore}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToItemKey={vi.fn()}
      />,
    );

    const jumpButton = screen.getByRole('button', { name: 'Jump to bottom' });
    jumpButton.click();
    expect(onJumpAction).toHaveBeenCalledTimes(1);
  });

  it('chat list renders execution graphs as sibling render items below assistant turn items', () => {
    const baseItems = buildRenderItemsFromMessages('agent:test:main', [
      { id: 'user-1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant', content: 'reply', timestamp: 2, messageId: 'turn-1' },
    ]);
    const assistant = baseItems[1]!;
    const items = decorateItems([
      ...baseItems,
      {
        key: 'session:agent:test:main|graph:graph-1',
        kind: 'execution-graph',
        sessionKey: 'agent:test:main',
        role: 'assistant',
        text: '',
        createdAt: 3,
        updatedAt: 3,
        status: 'final',
        laneKey: assistant.laneKey,
        turnKey: assistant.turnKey,
        agentId: assistant.agentId,
        graphId: 'graph-1',
        completionItemKey: assistant.key,
        childSessionKey: 'child-1',
        agentLabel: 'main',
        sessionLabel: 'session',
        steps: [],
        active: false,
        triggerItemKey: assistant.key,
        replyItemKey: assistant.key,
      },
    ]);

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
        items={items}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToItemKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-assistant-turn-item')).toBeInTheDocument();
    expect(screen.getByTestId('chat-execution-graph-rail')).toBeInTheDocument();
    expect(screen.getByTestId('chat-execution-graph')).toBeInTheDocument();
  });

  it('jump-to-bottom chrome toggle should not rerender static content items', () => {
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
      items: buildUserAndAssistantItems(),
      showLoadOlder: false,
      isLoadingOlder: false,
      onLoadOlder: vi.fn(),
      loadOlderLabel: 'Load older',
      scrollChromeStore: buildScrollChromeStore(),
      showThinking: false,
      userAvatarImageUrl: null,
      onJumpToItemKey: vi.fn(),
    };

    render(<ChatListSurface {...commonProps} />);

    expect(chatMessageRenderSpy).toHaveBeenCalledTimes(1);
    expect(assistantTurnRenderSpy).toHaveBeenCalledTimes(1);

    act(() => {
      commonProps.scrollChromeStore.setBottomLocked(false);
    });

    expect(chatMessageRenderSpy).toHaveBeenCalledTimes(1);
    expect(assistantTurnRenderSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Jump to bottom' })).toBeInTheDocument();
  });

  it('assistant turn keeps tool state and presentation inside one render item', () => {
    const items = decorateItems(buildRenderItemsFromMessages('agent:test:main', [
      {
        id: 'assistant-a',
        role: 'assistant',
        agentId: 'agent-a',
        messageId: 'turn-a',
        content: 'Alpha',
        streaming: true,
        toolStatuses: [{
          id: 'tool-a',
          name: 'read_file',
          status: 'running',
          updatedAt: 1,
        }],
      },
      {
        id: 'assistant-b',
        role: 'assistant',
        agentId: 'agent-b',
        messageId: 'turn-b',
        content: [{
          type: 'toolCall',
          id: 'tool-b',
          name: 'search',
          input: { q: 'hello' },
        }],
        streaming: true,
        toolStatuses: [{
          id: 'tool-b',
          name: 'search',
          status: 'running',
          updatedAt: 2,
        }],
      },
    ]));

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
        items={items}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToItemKey={vi.fn()}
      />,
    );

    expect(assistantTurnPropsSpy).toHaveBeenCalledTimes(2);
    expect(assistantTurnPropsSpy.mock.calls[0]?.[0]).toMatchObject({
      item: {
        kind: 'assistant-turn',
        agentId: 'agent-a',
        tools: [{
          id: 'tool-a',
          name: 'read_file',
          status: 'running',
        }],
        assistantPresentation: {
          agentId: 'agent-a',
          agentName: 'Agent A',
        },
      },
    });
    expect(assistantTurnPropsSpy.mock.calls[1]?.[0]).toMatchObject({
      item: {
        kind: 'assistant-turn',
        agentId: 'agent-b',
        tools: [{
          id: 'tool-b',
          name: 'search',
          status: 'running',
        }],
        assistantPresentation: {
          agentId: 'agent-b',
          agentName: 'Agent B',
        },
      },
    });
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
        items={[]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToItemKey={vi.fn()}
      />,
    );

    const viewport = container.querySelector('.chat-scroll-sync-viewport') as HTMLElement | null;
    expect(viewport?.className).toContain(CHAT_LAYOUT_TOKENS.threadViewportPadding);
    const classNames = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .map((node) => node.className)
      .filter((value): value is string => typeof value === 'string');
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.threadRail))).toBe(true);
    expect(screen.queryByTestId('chat-message-item')).toBeNull();
    expect(screen.queryByTestId('chat-assistant-turn-item')).toBeNull();
  });
});
