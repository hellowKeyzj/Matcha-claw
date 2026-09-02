import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '@/pages/Chat/ChatInput';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (typeof options?.count === 'number') {
        return `${key}:${String(options.count)}`;
      }
      return key;
    },
  }),
}));

const testSessionIdentity = {
  endpoint: {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
  agentId: 'default',
  sessionKey: 'test-session',
};

const readySendGate = {
  canSend: true as const,
  kind: 'session' as const,
  sessionKey: testSessionIdentity.sessionKey,
  endpointSessionId: undefined,
  sessionIdentity: testSessionIdentity,
};

describe('chat input mention', () => {
  it('shows mention candidates and inserts selected mention', () => {
    const onSend = vi.fn();

    render(
      <MemoryRouter><ChatInput
        onSend={onSend}
        sendGate={readySendGate}
        sessionIdentity={testSessionIdentity}
        mentionCandidates={[
          { id: 'team-controller', label: 'Team Controller', insertText: '@team-controller ' },
          { id: 'coding-agent', label: 'Coding Agent', insertText: '@coding-agent ' },
        ]}
      /></MemoryRouter>,
    );

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@co', selectionStart: 3 } });

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /@coding-agent/i })).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByRole('option', { name: /@coding-agent/i }));
    expect(textarea.value).toBe('@coding-agent ');
  });

  it('uses enter to select mention before sending message', () => {
    const onSend = vi.fn();

    render(
      <MemoryRouter><ChatInput
        onSend={onSend}
        sendGate={readySendGate}
        sessionIdentity={testSessionIdentity}
        mentionCandidates={[
          { id: 'a1', label: 'Agent A', insertText: '@a1 ' },
          { id: 'a2', label: 'Agent B', insertText: '@a2 ' },
        ]}
      /></MemoryRouter>,
    );

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '@a', selectionStart: 2 } });
    fireEvent.keyDown(textarea, { key: 'Enter' });

    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toBe('@a1 ');
  });
});
