import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';

describe('chat input mention', () => {
  it('shows mention candidates and inserts selected agent command', () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        onSend={onSend}
        mentionCandidates={[
          { id: 'team-controller', label: 'Team Controller', insertText: '@team-controller 回答 ' },
          { id: 'coding-agent', label: 'Coding Agent', insertText: '@coding-agent 回答 ' },
        ]}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@co', selectionStart: 3 } });

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /@coding-agent/i })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('option', { name: /@coding-agent/i }));

    expect(textarea.value).toBe('@coding-agent 回答 ');
  });

  it('uses enter to select mention before sending message', () => {
    const onSend = vi.fn();
    render(
      <ChatInput
        onSend={onSend}
        mentionCandidates={[
          { id: 'a1', label: 'Agent A', insertText: '@a1 回答 ' },
          { id: 'a2', label: 'Agent B', insertText: '@a2 回答 ' },
        ]}
      />,
    );

    const textarea = screen.getByPlaceholderText(/Message/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@a', selectionStart: 2 } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('@a1 回答 ');
  });
});

