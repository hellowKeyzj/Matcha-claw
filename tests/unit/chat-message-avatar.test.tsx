import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatMessage } from '@/pages/Chat/ChatMessage';
import type { RawMessage } from '@/stores/chat';

describe('chat message avatar rendering', () => {
  it('assistant 消息显示当前 agent 的 emoji 头像', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: 'hello',
    };

    render(
      <ChatMessage
        message={message}
        showThinking={false}
        assistantAvatarEmoji="🧠"
      />,
    );

    expect(screen.getByText('🧠')).toBeInTheDocument();
  });

  it('user 消息在配置后显示用户上传头像', () => {
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

    const avatarImage = screen.getByAltText('User avatar');
    expect(avatarImage).toBeInTheDocument();
    expect(avatarImage).toHaveAttribute('src', avatarDataUrl);
  });
});
