import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { ChatList, ChatListSurface } from '@/pages/Chat/components/ChatList';
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
  phase?: 'follow' | 'detached';
  visible?: boolean;
  isAtLatest?: boolean;
  jumpActionLabel?: string;
  onJumpAction?: () => void;
}) {
  const store = createChatScrollChromeStore({
    phase: options?.phase ?? 'follow',
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

function buildChatListProps(items: ChatRenderItem[]) {
  return {
    runtime: {
      activeRunId: null,
      runPhase: 'idle',
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      lastUserMessageAt: null,
    },
    items,
    window: {
      totalItemCount: items.length,
      windowStartOffset: 0,
      windowEndOffset: items.length,
      hasMore: false,
      hasNewer: false,
      isLoadingMore: false,
      isLoadingNewer: false,
      isAtLatest: true,
      anchorItemKey: null,
    },
    liveView: {
      showBlockingLoading: false,
      showBlockingError: false,
      isEmptyState: false,
    },
  };
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
    expect(CHAT_LAYOUT_TOKENS.threadViewportPadding).not.toContain('pt-');
    expect(CHAT_LAYOUT_TOKENS.threadViewportPadding).not.toContain('pb-');
    expect(viewport?.style.paddingTop).toContain('--chat-thread-top-padding');
    expect(viewport?.style.paddingBottom).toContain('--chat-thread-bottom-padding');
  });

  it('chat list passes matching user send time to assistant turns by run and lane', () => {
    const items = decorateItems([
      {
        key: 'session:agent:test:main|user:run-timer-1',
        kind: 'user-message',
        sessionKey: 'agent:test:main',
        role: 'user',
        text: 'hello',
        images: [],
        attachedFiles: [],
        runId: 'run-timer-1',
        laneKey: 'main',
        createdAt: 1000,
      },
      {
        key: 'session:agent:test:main|assistant-turn:main:assistant-message-timer-1',
        kind: 'assistant-turn',
        sessionKey: 'agent:test:main',
        role: 'assistant',
        text: 'world',
        status: 'final',
        runId: 'run-timer-1',
        laneKey: 'main',
        turnKey: 'assistant-message-timer-1',
        identitySource: 'run',
        identityMode: 'run',
        identityConfidence: 'strong',
        segments: [{ kind: 'message', key: 'message:timer-1:main:0', text: 'world' }],
        thinking: null,
        tools: [],
        images: [],
        attachedFiles: [],
        createdAt: 3000,
        updatedAt: 5300,
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

    expect(assistantTurnPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      replyStartedAt: 1000,
    }));
  });

  it('chat list keeps active assistant timer when exact run identity is not projected yet', () => {
    const items = decorateItems([
      {
        key: 'session:agent:test:main|user:run-timer-active-fallback',
        kind: 'user-message',
        sessionKey: 'agent:test:main',
        role: 'user',
        text: 'hello',
        images: [],
        attachedFiles: [],
        runId: 'run-timer-active-fallback',
        laneKey: 'main',
        createdAt: 1000,
      },
      {
        key: 'session:agent:test:main|assistant-turn:main:assistant-message-active-fallback',
        kind: 'assistant-turn',
        sessionKey: 'agent:test:main',
        role: 'assistant',
        text: 'world',
        status: 'streaming',
        laneKey: 'main',
        turnKey: 'assistant-message-active-fallback',
        identitySource: 'run',
        identityMode: 'run',
        identityConfidence: 'strong',
        segments: [{ kind: 'message', key: 'message:timer-active-fallback:main:0', text: 'world' }],
        thinking: null,
        tools: [],
        images: [],
        attachedFiles: [],
        createdAt: 3000,
        updatedAt: 5300,
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

    expect(assistantTurnPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      replyStartedAt: 1000,
    }));
  });

  it('chat list keeps completed assistant timer when exact run identity is not projected', () => {
    const items = decorateItems([
      {
        key: 'session:agent:test:main|user:run-timer-final-no-match',
        kind: 'user-message',
        sessionKey: 'agent:test:main',
        role: 'user',
        text: 'hello',
        images: [],
        attachedFiles: [],
        runId: 'run-timer-final-no-match',
        laneKey: 'main',
        createdAt: 1000,
      },
      {
        key: 'session:agent:test:main|assistant-turn:main:assistant-message-final-no-match',
        kind: 'assistant-turn',
        sessionKey: 'agent:test:main',
        role: 'assistant',
        text: 'world',
        status: 'final',
        laneKey: 'main',
        turnKey: 'assistant-message-final-no-match',
        identitySource: 'run',
        identityMode: 'run',
        identityConfidence: 'strong',
        segments: [{ kind: 'message', key: 'message:timer-final-no-match:main:0', text: 'world' }],
        thinking: null,
        tools: [],
        images: [],
        attachedFiles: [],
        createdAt: 3000,
        updatedAt: 5300,
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

    expect(assistantTurnPropsSpy).toHaveBeenCalledWith(expect.objectContaining({
      replyStartedAt: 1000,
    }));
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
      phase: 'detached',
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
      commonProps.scrollChromeStore.setPhase('detached');
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
        content: [{
          type: 'text',
          text: 'Alpha',
        }, {
          type: 'toolCall',
          id: 'tool-a',
          name: 'read_file',
        }],
        streaming: true,
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

    expect(assistantTurnPropsSpy).toHaveBeenCalledTimes(4);
    const agentATurn = assistantTurnPropsSpy.mock.calls.find(
      (call: any[]) => call[0]?.item?.kind === 'assistant-turn' && call[0]?.item?.turnKey !== 'tool:tool-a',
    );
    const agentATool = assistantTurnPropsSpy.mock.calls.find(
      (call: any[]) => call[0]?.item?.kind === 'assistant-turn' && call[0]?.item?.turnKey === 'tool:tool-a',
    );
    const agentBTool = assistantTurnPropsSpy.mock.calls.find(
      (call: any[]) => call[0]?.item?.kind === 'assistant-turn' && call[0]?.item?.turnKey === 'tool:tool-b',
    );
    expect(agentATurn?.[0]).toMatchObject({
      item: {
        kind: 'assistant-turn',
        agentId: 'agent-a',
        tools: [],
        assistantPresentation: {
          agentId: 'agent-a',
          agentName: 'Agent A',
        },
      },
    });
    expect(agentATool?.[0]).toMatchObject({
      item: {
        kind: 'assistant-turn',
        tools: [expect.objectContaining({ id: 'tool-a', name: 'read_file' })],
        assistantPresentation: {
          agentId: 'agent-a',
          agentName: 'Agent A',
        },
      },
    });
    expect(agentBTool?.[0]).toMatchObject({
      item: {
        kind: 'assistant-turn',
        tools: [expect.objectContaining({ id: 'tool-b', name: 'search' })],
        assistantPresentation: {
          agentId: 'agent-b',
          agentName: 'Agent B',
        },
      },
    });
  });

  it('chat list should reuse unchanged render-items when only one assistant turn settles', () => {
    const sessionKey = 'agent:test:main';
    const onOpenArtifactFile = vi.fn();
    const onOpenAttachedArtifact = vi.fn();
    const initialItems = decorateItems(buildRenderItemsFromMessages(sessionKey, [
      {
        id: 'assistant-stable-1',
        role: 'assistant',
        messageId: 'turn-stable-1',
        content: '稳定消息',
        timestamp: 1,
      },
      {
        id: 'assistant-live-1',
        role: 'assistant',
        messageId: 'turn-live-1',
        content: '第一段',
        streaming: true,
        timestamp: 2,
      },
    ]));
    const settledLiveItem = decorateItems(buildRenderItemsFromMessages(sessionKey, [
      {
        id: 'assistant-live-1',
        role: 'assistant',
        messageId: 'turn-live-1',
        content: '第一段，最终版',
        timestamp: 2,
      },
    ]))[0]!;

    const view = render(
      <ChatList
        isActive={false}
        currentSessionKey={sessionKey}
        runtime={buildChatListProps(initialItems).runtime}
        viewport={buildChatListProps(initialItems).window}
        items={buildChatListProps(initialItems).items}
        liveView={buildChatListProps(initialItems).liveView}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        onJumpToLatest={vi.fn()}
        jumpToBottomLabel="Jump to bottom"
        artifactGroups={[]}
        onOpenArtifactFile={onOpenArtifactFile}
        onOpenAttachedArtifact={onOpenAttachedArtifact}
      />,
    );

    expect(assistantTurnRenderSpy).toHaveBeenCalledTimes(2);

    view.rerender(
      <ChatList
        isActive={false}
        currentSessionKey={sessionKey}
        runtime={buildChatListProps([
          initialItems[0]!,
          settledLiveItem,
        ]).runtime}
        viewport={buildChatListProps([
          initialItems[0]!,
          settledLiveItem,
        ]).window}
        items={buildChatListProps([
          initialItems[0]!,
          settledLiveItem,
        ]).items}
        liveView={buildChatListProps([
          initialItems[0]!,
          settledLiveItem,
        ]).liveView}
        errorMessage={null}
        showThinking={false}
        userAvatarDataUrl={null}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        onJumpToLatest={vi.fn()}
        jumpToBottomLabel="Jump to bottom"
        artifactGroups={[]}
        onOpenArtifactFile={onOpenArtifactFile}
        onOpenAttachedArtifact={onOpenAttachedArtifact}
      />,
    );

    expect(assistantTurnRenderSpy).toHaveBeenCalledTimes(3);
  });

  it('chat input uses a floating narrow composer rail instead of a full-width dock strip', () => {
    const { container } = render(
      <ChatInput
        onSend={vi.fn()}
        modelPicker={{
          currentModelId: 'openai/gpt-5.4',
          currentLabel: 'OpenAI / gpt-5.4',
          options: [
            { id: 'openai/gpt-5.4', label: 'OpenAI / gpt-5.4' },
            { id: 'anthropic/claude-opus-4-6', label: 'Anthropic / claude-opus-4-6' },
          ],
          loading: false,
          switching: false,
          onSelect: vi.fn(),
        }}
      />,
    );

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
    expect(screen.getByTestId('chat-model-picker').tagName).toBe('BUTTON');
  });

  it('chat input keeps the action controls inside the card when the composer narrows', () => {
    render(
      <div className="w-[320px]">
        <ChatInput
          onSend={vi.fn()}
          modelPicker={{
            currentModelId: 'anthropic/claude-opus-4-6',
            currentLabel: 'anthropic / claude-opus-4-6',
            options: [
              { id: 'anthropic/claude-opus-4-6', label: 'anthropic / claude-opus-4-6' },
              { id: 'openai/gpt-5.4', label: 'openai / gpt-5.4' },
            ],
            loading: false,
            switching: false,
            onSelect: vi.fn(),
          }}
        />
      </div>,
    );

    const picker = screen.getByTestId('chat-model-picker');
    const pickerWrap = picker.parentElement as HTMLElement | null;
    const controlsRow = pickerWrap?.parentElement as HTMLElement | null;
    const statusRow = controlsRow?.nextElementSibling as HTMLElement | null;

    expect(pickerWrap?.className).toContain('w-[clamp(0px,calc(100%-7.5rem),148px)]');
    expect(pickerWrap?.className).toContain('max-sm:w-[clamp(0px,calc(100%-7.5rem),132px)]');
    expect(pickerWrap?.className).toContain('flex-none');
    expect(controlsRow?.className).toContain('w-full');
    expect(controlsRow?.className).toContain('min-w-0');
    expect(controlsRow?.className).not.toContain('flex-wrap');
    expect(controlsRow?.className).toContain('items-end');
    expect(controlsRow?.className).toContain('gap-1.5');
    expect(statusRow).toBeNull();
    expect(CHAT_LAYOUT_TOKENS.inputActionsRow).toContain('flex-col');
    expect(CHAT_LAYOUT_TOKENS.inputModelPickerTrigger).toContain('w-full');
    expect(CHAT_LAYOUT_TOKENS.inputModelPickerTrigger).toContain('h-9');
    expect(CHAT_LAYOUT_TOKENS.inputModelPickerTrigger).toContain('bg-card');
    expect(CHAT_LAYOUT_TOKENS.inputAttachButton).toContain('h-9');
    expect(CHAT_LAYOUT_TOKENS.inputSendButton).toContain('h-9');
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
