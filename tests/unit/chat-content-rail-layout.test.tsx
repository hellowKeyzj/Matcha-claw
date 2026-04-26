import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import { ChatList } from '@/pages/Chat/components/ChatList';

vi.mock('@/pages/Chat/components/ChatRowItem', () => ({
  ChatRowItem: () => <div data-testid="chat-row-item" />,
}));

describe('chat content rail layout', () => {
  it('chat list no longer wraps live threads in a fixed max-width rail', () => {
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
        showHistoryEntry={false}
        onViewHistory={vi.fn()}
        viewFullHistoryLabel="history"
        showThinking={false}
        assistantAgentId="main"
        assistantAgentName="Main"
        userAvatarImageUrl={null}
        suppressedToolCardRowKeys={new Set<string>()}
        onJumpToRowKey={vi.fn()}
      />,
    );

    expect(screen.getByTestId('chat-row-item')).toBeInTheDocument();
    const classNames = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .map((node) => node.className)
      .filter((value): value is string => typeof value === 'string');

    expect(classNames.some((value) => value.includes('max-w-4xl'))).toBe(false);
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.threadRail))).toBe(true);
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.threadViewportPadding))).toBe(true);
  });

  it('chat input no longer wraps the composer in a fixed max-width rail', () => {
    const { container } = render(<ChatInput onSend={vi.fn()} />);

    const classNames = Array.from(container.querySelectorAll<HTMLElement>('div'))
      .map((node) => node.className)
      .filter((value): value is string => typeof value === 'string');

    expect(classNames.some((value) => value.includes('max-w-4xl'))).toBe(false);
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.inputRail))).toBe(true);
    expect(classNames.some((value) => value.includes(CHAT_LAYOUT_TOKENS.inputCard))).toBe(true);
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });
});
