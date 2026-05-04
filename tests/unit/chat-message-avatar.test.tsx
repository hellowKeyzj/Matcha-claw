import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatAssistantTurn } from '@/pages/Chat/ChatAssistantTurn';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import { applyAssistantPresentationToItems } from '@/pages/Chat/chat-render-item-model';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

function buildRenderItem(message: RawMessage) {
  return applyAssistantPresentationToItems({
    items: buildRenderItemsFromMessages('agent:test:main', [message]),
    agents: [{
      id: 'writer',
      agentName: 'Writer',
      avatarSeed: 'agent:writer',
      avatarStyle: 'bottts',
    }],
    defaultAssistant: null,
  })[0]!;
}

describe('chat message avatar', () => {
  it('assistant turn renders generated agent avatar', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: 'hello',
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const img = screen.getByTestId('assistant-message-avatar').querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('Agent avatar');
    expect(img?.src.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('uses the OpenClaw-style assistant shrink layout instead of a fixed 80% shell', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: 'layout-check',
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    const { container } = render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    const shell = container.firstElementChild as HTMLElement | null;
    expect(shell?.className).toContain(CHAT_LAYOUT_TOKENS.messageShellAssistantColumns);

    const avatarShell = shell?.children[0] as HTMLElement | undefined;
    const contentShell = shell?.children[1] as HTMLElement | undefined;
    expect(avatarShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageAvatar);
    expect(avatarShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageAvatarAssistantOrder);
    expect(contentShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageContentColumn);
    expect(contentShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageContentAssistantOrder);
    expect(contentShell?.className).not.toContain('max-w-[80%]');
    const body = container.querySelector('[data-chat-body-mode="settled"]') as HTMLElement | null;
    expect(body?.className).toContain(CHAT_LAYOUT_TOKENS.assistantSurface);
  });

  it('tool-only assistant turn renders expandable tool cards without empty assistant body shell', () => {
    const item = buildRenderItem({
      role: 'assistant',
      content: [{
        type: 'toolCall',
        id: 'tool-1',
        name: 'read',
        input: { filePath: 'README.md' },
      }],
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'read',
        status: 'running',
        updatedAt: 1,
      }],
      streaming: true,
    });
    if (item.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn');
    }

    const { container } = render(
      <ChatAssistantTurn
        item={item}
        showThinking={false}
      />,
    );

    expect(container.querySelector('[data-chat-body-mode="streaming"]')).not.toBeNull();
    const toggle = screen.getAllByText('read')[1]?.closest('button') as HTMLButtonElement | null;
    expect(toggle).not.toBeNull();
    act(() => {
      toggle?.click();
    });
    expect(screen.getByText(/README\.md/)).toBeInTheDocument();
    expect(screen.getAllByText('read').length).toBeGreaterThanOrEqual(1);
  });

  it('user message renders custom avatar image when provided', () => {
    const item = buildRenderItem({
      role: 'user',
      content: 'hi',
    });
    if (item.kind !== 'user-message') {
      throw new Error('expected user message');
    }
    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

    render(
      <ChatMessage
        item={item}
        userAvatarImageUrl={avatarDataUrl}
      />,
    );

    const img = screen.getByAltText('user-avatar') as HTMLImageElement;
    expect(img.src).toBe(avatarDataUrl);

    const shell = img.closest('.group') as HTMLElement | null;
    const avatarShell = shell?.children[0] as HTMLElement | undefined;
    const contentShell = shell?.children[1] as HTMLElement | undefined;
    expect(shell?.className).toContain(CHAT_LAYOUT_TOKENS.messageShellUserColumns);
    expect(avatarShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageAvatarUserOrder);
    expect(contentShell?.className).toContain(CHAT_LAYOUT_TOKENS.messageContentUserOrder);
  });

  it('renders user content as a light asymmetric card instead of the old secondary bubble', () => {
    const item = buildRenderItem({
      role: 'user',
      content: 'bubble-check',
    });
    if (item.kind !== 'user-message') {
      throw new Error('expected user message');
    }

    render(
      <ChatMessage
        item={item}
      />,
    );

    const bubble = screen.getByText('bubble-check').parentElement as HTMLElement | null;
    expect(bubble?.className).toContain(CHAT_LAYOUT_TOKENS.userBubble);
    expect(CHAT_LAYOUT_TOKENS.userBubble).toContain('rounded-tr-md');
    expect(CHAT_LAYOUT_TOKENS.userBubble).not.toContain('bg-secondary');
  });
});
