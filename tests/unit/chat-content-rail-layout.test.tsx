import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { createChatScrollChromeStore } from '@/pages/Chat/chat-scroll-chrome-store';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import { ChatListSurface } from '@/pages/Chat/components/ChatList';
import type { ChatMessageRow, ChatRow, ChatToolActivityRow } from '@/pages/Chat/chat-row-model';

const chatMessageRenderSpy = vi.fn();
const chatMessagePropsSpy = vi.fn();
const chatToolActivityRenderSpy = vi.fn();
const chatToolActivityPropsSpy = vi.fn();
const pendingAssistantShellPropsSpy = vi.fn();

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

vi.mock('@/pages/Chat/ChatToolActivityRow', async () => {
  const React = await import('react');
  return {
    ChatToolActivityRowView: React.memo(function MockChatToolActivityRow(props: unknown) {
      chatToolActivityRenderSpy();
      chatToolActivityPropsSpy(props);
      return <div data-testid="chat-tool-activity-item" />;
    }),
  };
});

vi.mock('@/pages/Chat/pending-assistant-shell', () => ({
  PendingAssistantShell: (props: unknown) => {
    pendingAssistantShellPropsSpy(props);
    return <div data-testid="chat-pending-shell" />;
  },
}));

vi.mock('@/pages/Chat/components/ChatStates', () => ({
  FailureScreen: () => <div data-testid="chat-failure-screen" />,
}));

describe('chat content rail layout', () => {
  beforeEach(() => {
    chatMessageRenderSpy.mockClear();
    chatMessagePropsSpy.mockClear();
    chatToolActivityRenderSpy.mockClear();
    chatToolActivityPropsSpy.mockClear();
    pendingAssistantShellPropsSpy.mockClear();
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

  function buildTestRow(input: {
    key: string;
    message: Record<string, unknown>;
    text?: string;
    assistantTurnKey?: string | null;
    assistantLaneKey?: string | null;
    assistantLaneAgentId?: string | null;
    assistantPresentation?: ChatMessageRow['assistantPresentation'];
  }): ChatMessageRow {
    const role = input.message.role === 'user' || input.message.role === 'system'
      ? input.message.role
      : 'assistant';
    return {
      kind: 'message',
      key: input.key,
      sessionKey: 'agent:test:main',
      role,
      text: input.text ?? (typeof input.message.content === 'string' ? input.message.content : ''),
      status: input.message.streaming ? 'streaming' : 'final',
      rowId: typeof input.message.id === 'string' ? input.message.id : input.key,
      laneKey: input.assistantLaneKey ?? 'main',
      turnKey: input.assistantTurnKey ?? input.key,
      agentId: typeof input.message.agentId === 'string' ? input.message.agentId : undefined,
      renderSignature: input.key,
      assistantTurnKey: input.assistantTurnKey ?? null,
      assistantLaneKey: input.assistantLaneKey ?? null,
      assistantLaneAgentId: input.assistantLaneAgentId ?? null,
      assistantPresentation: input.assistantPresentation ?? null,
      assistantMarkdownHtml: null,
      thinking: null,
      images: [],
      toolUses: [],
      attachedFiles: [],
      toolStatuses: Array.isArray(input.message.toolStatuses) ? input.message.toolStatuses as ChatMessageRow['toolStatuses'] : [],
      isStreaming: Boolean(input.message.streaming),
      messageId: typeof input.message.id === 'string' ? input.message.id : undefined,
    };
  }

  function buildToolActivityRow(input: {
    key: string;
    message: Record<string, unknown>;
    assistantTurnKey?: string | null;
    assistantLaneKey?: string | null;
    assistantLaneAgentId?: string | null;
    assistantPresentation?: ChatToolActivityRow['assistantPresentation'];
  }): ChatToolActivityRow {
    return {
      kind: 'tool-activity',
      key: input.key,
      sessionKey: 'agent:test:main',
      role: 'assistant',
      text: '',
      status: input.message.streaming ? 'streaming' : 'final',
      rowId: typeof input.message.id === 'string' ? input.message.id : input.key,
      laneKey: input.assistantLaneKey ?? 'main',
      turnKey: input.assistantTurnKey ?? input.key,
      agentId: typeof input.message.agentId === 'string' ? input.message.agentId : undefined,
      renderSignature: input.key,
      assistantTurnKey: input.assistantTurnKey ?? null,
      assistantLaneKey: input.assistantLaneKey ?? null,
      assistantLaneAgentId: input.assistantLaneAgentId ?? null,
      assistantPresentation: input.assistantPresentation ?? null,
      toolUses: [{
        id: 'tool-1',
        name: 'read_file',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read_file',
        status: 'completed',
      }],
      attachedFiles: [],
      isStreaming: false,
    };
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
        rows={[buildTestRow({
          key: 'row:1',
          message: {
            id: 'message-1',
            role: 'assistant',
            content: 'hello',
          },
        })]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
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

  it('chat list writes assistant turn/lane identity onto the rendered row wrapper for page-level lane rendering', () => {
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
        rows={[buildTestRow({
          key: 'assistant-a-row',
          text: 'Alpha',
          assistantTurnKey: 'team-turn-1',
          assistantLaneKey: 'team:agent-a',
          assistantLaneAgentId: 'agent-a',
          assistantPresentation: {
            agentId: 'agent-a',
            agentName: 'Agent A',
          },
          message: {
            id: 'assistant-a',
            role: 'assistant',
            agentId: 'agent-a',
            uniqueId: 'team-turn-1',
            requestId: 'user-1',
            content: 'Alpha',
          },
        })]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    const rowWrapper = container.querySelector('[data-chat-row-key="assistant-a-row"]');
    expect(rowWrapper).toHaveAttribute('data-chat-assistant-turn-key', 'team-turn-1');
    expect(rowWrapper).toHaveAttribute('data-chat-assistant-lane-key', 'team:agent-a');
    expect(rowWrapper).toHaveAttribute('data-chat-assistant-agent-id', 'agent-a');
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
        rows={[buildTestRow({
          key: 'row:1',
          message: {
            id: 'message-1',
            role: 'assistant',
            content: 'hello',
          },
        })]}
        showLoadOlder
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
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
        rows={[buildTestRow({
          key: 'row:1',
          message: {
            id: 'message-1',
            role: 'assistant',
            content: 'hello',
          },
        })]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={scrollChromeStore}
        showThinking={false}
        userAvatarImageUrl={null}
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
        rows={[buildTestRow({
          key: 'assistant-1',
          message: {
            id: 'assistant-1',
            role: 'assistant',
            content: 'hello',
          },
        }), {
          kind: 'execution-graph',
          key: 'graph-1',
          sessionKey: 'agent:test:main',
          role: 'assistant',
          text: '',
          status: 'final',
          renderSignature: 'graph-1',
          assistantPresentation: null,
          graphId: 'graph-1',
          anchorRowKey: 'assistant-1',
          childSessionKey: 'child-1',
          agentLabel: 'main',
          sessionLabel: 'session',
          steps: [],
          active: false,
          assistantTurnKey: null,
          assistantLaneKey: null,
          assistantLaneAgentId: null,
        } satisfies ChatRow]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-message-item')).toBeInTheDocument();
    expect(screen.getByTestId('chat-execution-graph-rail')).toBeInTheDocument();
    expect(screen.getByTestId('chat-execution-graph')).toBeInTheDocument();
  });

  it('jump-to-bottom chrome toggle should not rerender static message rows', () => {
    const rows: ChatRow[] = [buildTestRow({
      key: 'assistant-1',
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello',
        streaming: false,
      },
    })];
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
      userAvatarImageUrl: null,
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

  it('tool activity rows are dispatched to the dedicated tool row component instead of ChatMessage', () => {
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
        rows={[buildToolActivityRow({
          key: 'tool-row-1',
          message: {
            id: 'assistant-tool-1',
            role: 'assistant',
            content: [{
              type: 'toolCall',
              id: 'tool-1',
              name: 'read_file',
              input: { filePath: 'README.md' },
            }],
          },
        })]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-tool-activity-item')).toBeInTheDocument();
    expect(chatToolActivityRenderSpy).toHaveBeenCalledTimes(1);
    expect(chatMessageRenderSpy).toHaveBeenCalledTimes(0);
    expect(chatToolActivityPropsSpy.mock.calls[0]?.[0]).toMatchObject({
      row: {
        key: 'tool-row-1',
        kind: 'tool-activity',
      },
    });
  });

  it('每条 streaming assistant row 只接收自己的 tool 状态，不复用全局单值', () => {
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
        rows={[buildTestRow({
          key: 'assistant-a',
          message: {
            id: 'assistant-a',
            role: 'assistant',
            content: 'Alpha',
            streaming: true,
            toolStatuses: [{
              id: 'tool-a',
              name: 'read_file',
              status: 'running',
              updatedAt: 1,
            }],
          },
        }), buildTestRow({
          key: 'assistant-b',
          message: {
            id: 'assistant-b',
            role: 'assistant',
            content: 'Beta',
            streaming: true,
            toolStatuses: [{
              id: 'tool-b',
              name: 'search',
              status: 'running',
              updatedAt: 2,
            }],
          },
        })]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(chatMessagePropsSpy).toHaveBeenCalledTimes(2);
    expect(chatMessagePropsSpy.mock.calls[0]?.[0]).toMatchObject({
      row: {
        messageId: 'assistant-a',
        toolStatuses: [{
          id: 'tool-a',
          name: 'read_file',
          status: 'running',
        }],
      },
    });
    expect(chatMessagePropsSpy.mock.calls[1]?.[0]).toMatchObject({
      row: {
        messageId: 'assistant-b',
        toolStatuses: [{
          id: 'tool-b',
          name: 'search',
          status: 'running',
        }],
      },
    });
  });

  it('每条 assistant row 使用自己的 lane presentation，pending shell 也按 lane 呈现', () => {
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
        rows={[buildTestRow({
          key: 'assistant-a',
          text: 'Alpha',
          assistantPresentation: {
            agentId: 'agent-a',
            agentName: 'Agent A',
          },
          message: {
            id: 'assistant-a',
            role: 'assistant',
            agentId: 'agent-a',
            content: 'Alpha',
          },
        }), buildTestRow({
          key: 'assistant-b',
          text: 'Beta',
          assistantPresentation: {
            agentId: 'agent-b',
            agentName: 'Agent B',
          },
          message: {
            id: 'assistant-b',
            role: 'assistant',
            agentId: 'agent-b',
            content: 'Beta',
          },
        }), {
          kind: 'pending-assistant',
          key: 'pending:agent-a',
          sessionKey: 'agent:test:main',
          role: 'assistant',
          text: '',
          status: 'pending',
          renderSignature: 'pending:agent-a',
          assistantPresentation: {
            agentId: 'agent-a',
            agentName: 'Agent A',
          },
          assistantTurnKey: null,
          assistantLaneKey: null,
          assistantLaneAgentId: 'agent-a',
          pendingState: 'activity',
        }, {
          kind: 'pending-assistant',
          key: 'pending:agent-b',
          sessionKey: 'agent:test:main',
          role: 'assistant',
          text: '',
          status: 'pending',
          renderSignature: 'pending:agent-b',
          assistantPresentation: {
            agentId: 'agent-b',
            agentName: 'Agent B',
          },
          assistantTurnKey: null,
          assistantLaneKey: null,
          assistantLaneAgentId: 'agent-b',
          pendingState: 'typing',
        }]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(chatMessagePropsSpy.mock.calls[0]?.[0]).toMatchObject({
      row: {
        assistantPresentation: {
          agentId: 'agent-a',
          agentName: 'Agent A',
        },
      },
    });
    expect(chatMessagePropsSpy.mock.calls[1]?.[0]).toMatchObject({
      row: {
        assistantPresentation: {
          agentId: 'agent-b',
          agentName: 'Agent B',
        },
      },
    });
    expect(screen.getAllByTestId('chat-pending-shell')).toHaveLength(2);
    expect(pendingAssistantShellPropsSpy.mock.calls[0]?.[0]).toMatchObject({
      assistantAgentId: 'agent-a',
      assistantAgentName: 'Agent A',
      state: 'activity',
    });
    expect(pendingAssistantShellPropsSpy.mock.calls[1]?.[0]).toMatchObject({
      assistantAgentId: 'agent-b',
      assistantAgentName: 'Agent B',
      state: 'typing',
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
        rows={[]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        scrollChromeStore={buildScrollChromeStore()}
        showThinking={false}
        userAvatarImageUrl={null}
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
