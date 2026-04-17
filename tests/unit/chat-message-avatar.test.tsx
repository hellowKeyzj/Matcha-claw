import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
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
  });
});
