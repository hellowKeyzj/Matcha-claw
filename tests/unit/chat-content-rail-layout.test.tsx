import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import { ChatList } from '@/pages/Chat/components/ChatList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/pages/Chat/ChatMessage', () => ({
  ChatMessage: () => <div data-testid="chat-message-item" />,
}));

vi.mock('@/pages/Chat/components/ChatStates', () => ({
  ActivityIndicator: () => <div data-testid="chat-activity-item" />,
  TypingIndicator: () => <div data-testid="chat-typing-item" />,
  WelcomeScreen: () => <div data-testid="chat-welcome-screen" />,
}));

describe('chat content rail layout', () => {
  it('chat list uses a centered narrow content rail with viewport-safe bottom padding', () => {
    const { container } = render(
      <ChatList
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        items={[{
          kind: 'message',
          key: 'row:1',
          row: {
            kind: 'message',
            key: 'row:1',
            message: {
              id: 'message-1',
              role: 'assistant',
              content: 'hello',
            },
          },
        } as never]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        showJumpToBottom={false}
        onJumpAction={vi.fn()}
        jumpActionLabel="Jump to bottom"
        showThinking={false}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        suppressedToolCardRowKeys={new Set<string>()}
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
    expect(CHAT_LAYOUT_TOKENS.threadViewportPadding).toContain('pb-');
  });

  it('chat list places the load-older affordance above the message stack instead of burying it in the top padding gap', () => {
    render(
      <ChatList
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        items={[{
          kind: 'message',
          key: 'row:1',
          row: {
            kind: 'message',
            key: 'row:1',
            message: {
              id: 'message-1',
              role: 'assistant',
              content: 'hello',
            },
          },
        } as never]}
        showLoadOlder
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        showJumpToBottom={false}
        onJumpAction={vi.fn()}
        jumpActionLabel="Jump to bottom"
        showThinking={false}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        suppressedToolCardRowKeys={new Set<string>()}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-load-older-rail')).toBeInTheDocument();
    expect(screen.getByTestId('chat-message-stack').className).toContain(CHAT_LAYOUT_TOKENS.threadMessageStackPaddingTop);
  });

  it('chat list exposes a jump-to-bottom button only when requested', () => {
    const onJumpToBottom = vi.fn();

    const { container } = render(
      <ChatList
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        items={[{
          kind: 'message',
          key: 'row:1',
          row: {
            kind: 'message',
            key: 'row:1',
            message: {
              id: 'message-1',
              role: 'assistant',
              content: 'hello',
            },
          },
        } as never]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        showJumpToBottom
        onJumpAction={onJumpToBottom}
        jumpActionLabel="Jump to bottom"
        showThinking={false}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        suppressedToolCardRowKeys={new Set<string>()}
        onJumpToRowKey={vi.fn()}
      />,
    );

    const jumpButton = screen.getByRole('button', { name: 'Jump to bottom' });
    jumpButton.click();
    expect(onJumpToBottom).toHaveBeenCalledTimes(1);
    const floatingRail = jumpButton.parentElement as HTMLElement | null;
    expect(floatingRail?.className).toContain('max-w-[56rem]');
    const jumpRail = floatingRail?.parentElement as HTMLElement | null;
    expect(jumpRail?.className).toContain('inset-x-0');
    expect(jumpRail?.style.bottom).toContain('--chat-composer-safe-offset');
  });

  it('chat list renders non-message viewport items directly without a row forwarding layer', () => {
    render(
      <ChatList
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState={false}
        showBlockingLoading={false}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        items={[
          {
            kind: 'activity',
            key: 'activity:1',
            row: { kind: 'activity', key: 'activity:1' },
          },
          {
            kind: 'typing',
            key: 'typing:1',
            row: { kind: 'typing', key: 'typing:1' },
          },
        ] as never}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        showJumpToBottom={false}
        onJumpAction={vi.fn()}
        jumpActionLabel="Jump to bottom"
        showThinking={false}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        suppressedToolCardRowKeys={new Set<string>()}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-activity-item')).toBeInTheDocument();
    expect(screen.getByTestId('chat-typing-item')).toBeInTheDocument();
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

  it('empty state stays on the same viewport rail instead of switching to a dedicated hero rail', () => {
    const { container } = render(
      <ChatList
        messagesViewportRef={{ current: null }}
        messageContentRef={{ current: null }}
        isEmptyState
        showBlockingLoading={false}
        onPointerDown={vi.fn()}
        onScroll={vi.fn()}
        onTouchMove={vi.fn()}
        onWheel={vi.fn()}
        items={[]}
        showLoadOlder={false}
        isLoadingOlder={false}
        onLoadOlder={vi.fn()}
        loadOlderLabel="Load older"
        showJumpToBottom={false}
        onJumpAction={vi.fn()}
        jumpActionLabel="Jump to bottom"
        showThinking={false}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        suppressedToolCardRowKeys={new Set<string>()}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-welcome-screen')).toBeInTheDocument();
    const viewport = container.querySelector('.chat-scroll-sync-viewport') as HTMLElement | null;
    expect(viewport?.className).toContain(CHAT_LAYOUT_TOKENS.threadViewportPadding);
    const classNames = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .map((node) => node.className)
      .filter((value): value is string => typeof value === 'string');
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.threadRail))).toBe(true);
  });
});
