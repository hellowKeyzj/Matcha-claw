import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import { CHAT_LAYOUT_TOKENS } from '@/pages/Chat/chat-layout-tokens';
import type { RawMessage } from '@/stores/chat';

describe('chat message avatar', () => {
  it('assistant message renders generated agent avatar', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'hello',
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
        assistantAgentId="writer"
        assistantAgentName="Writer"
        assistantAvatarSeed="agent:writer"
        assistantAvatarStyle="bottts"
      />,
    );

    const img = screen.getByTestId('assistant-message-avatar').querySelector('img') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('alt')).toBe('Writer avatar');
    expect(img?.src.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('uses the OpenClaw-style message shrink model instead of a fixed 80% shell', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'layout-check',
    };

    const { container } = render(
      <ChatMessage
        message={message}
        showThinking={false}
        assistantAgentId="writer"
        assistantAgentName="Writer"
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
    const body = container.querySelector('[data-chat-body-mode="full"]') as HTMLElement | null;
    expect(body?.className).toContain(CHAT_LAYOUT_TOKENS.assistantSurface);
  });

  it('user message renders custom avatar image when provided', () => {
    const message: RawMessage = {
      role: 'user',
      content: 'hi',
    };
    const avatarDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';

    render(
      <ChatMessage
        message={message}
        showThinking={false}
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
    const message: RawMessage = {
      role: 'user',
      content: 'bubble-check',
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
      />,
    );

    const bubble = screen.getByText('bubble-check').parentElement as HTMLElement | null;
    expect(bubble?.className).toContain(CHAT_LAYOUT_TOKENS.userBubble);
    expect(CHAT_LAYOUT_TOKENS.userBubble).toContain('rounded-tr-md');
    expect(CHAT_LAYOUT_TOKENS.userBubble).not.toContain('bg-secondary');
  });
});
