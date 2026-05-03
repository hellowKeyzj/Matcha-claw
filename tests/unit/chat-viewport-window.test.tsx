import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildTimelineEntriesFromMessages } from '@/stores/chat/timeline-message';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { RawMessage } from '@/stores/chat';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function buildSessionMessages(count: number, prefix = 'session message') {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix} ${index + 1}`,
    timestamp: index + 1,
    id: `${prefix.replace(/\s+/g, '-')}-${index + 1}`,
  }));
}

function buildSessionRecord(
  sessionKey: string,
  overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & { messages?: RawMessage[] },
) {
  const base = createEmptySessionRecord();
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    timelineEntries: overrides?.messages
      ? buildTimelineEntriesFromMessages(sessionKey, overrides.messages)
      : (overrides?.timelineEntries ?? base.timelineEntries),
    window: overrides?.window ?? base.window,
  };
}

function renderChat() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <TooltipProvider>
        <Chat />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

describe('chat viewport window', () => {
  beforeEach(() => {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  it('renders viewport messages directly and exposes load older when more history exists', async () => {
    const currentSessionKey = 'agent:test:main';
    const allMessages = buildSessionMessages(35);
    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: vi.fn().mockResolvedValue({}),
    } as never);
    useSubagentsStore.setState({
      agents: [
        { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as never);
    useTaskInboxStore.setState({
      tasks: [],
      loading: false,
      initialized: true,
      error: null,
      workspaceDirs: [],
      workspaceLabel: null,
      submittingTaskIds: [],
      init: vi.fn().mockResolvedValue(undefined),
      refreshTasks: vi.fn().mockResolvedValue(undefined),
      submitDecision: vi.fn().mockResolvedValue(undefined),
      submitFreeText: vi.fn().mockResolvedValue(undefined),
      openTaskSession: vi.fn().mockReturnValue({ switched: false, reason: 'task_not_found' }),
      handleGatewayNotification: vi.fn(),
      clearError: vi.fn(),
    } as never);
    useChatStore.setState({
      foregroundHistorySessionKey: null,
      mutating: false,
      error: null,
      showThinking: true,
      currentSessionKey,
      pendingApprovalsBySession: {},
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        [currentSessionKey]: buildSessionRecord(currentSessionKey, {
          messages: allMessages,
          window: createViewportWindowState({
            totalMessageCount: allMessages.length,
            windowStartOffset: 15,
            windowEndOffset: 35,
            hasMore: true,
            hasNewer: false,
            isAtLatest: true,
          }),
          meta: {
            ready: true,
            lastActivityAt: Date.now(),
          },
        }),
      },
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadOlderMessages: vi.fn().mockResolvedValue(undefined),
      jumpToLatest: vi.fn().mockResolvedValue(undefined),
      setViewportLastVisibleMessageId: vi.fn(),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    } as never);

    renderChat();

    expect(screen.queryByText('session message 1')).toBeNull();
    expect(screen.getByText('session message 16')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load older messages' })).toBeInTheDocument();
  });

  it('detached viewport send does not require页面层先 jumpToLatest', async () => {
    const currentSessionKey = 'agent:test:main';
    const jumpToLatest = vi.fn().mockResolvedValue(undefined);
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const allMessages = buildSessionMessages(20);

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
      rpc: vi.fn().mockResolvedValue({}),
    } as never);
    useSubagentsStore.setState({
      agents: [
        { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      ],
      loadAgents: vi.fn().mockResolvedValue(undefined),
      updateAgent: vi.fn().mockResolvedValue(undefined),
    } as never);
    useTaskInboxStore.setState({
      tasks: [],
      loading: false,
      initialized: true,
      error: null,
      workspaceDirs: [],
      workspaceLabel: null,
      submittingTaskIds: [],
      init: vi.fn().mockResolvedValue(undefined),
      refreshTasks: vi.fn().mockResolvedValue(undefined),
      submitDecision: vi.fn().mockResolvedValue(undefined),
      submitFreeText: vi.fn().mockResolvedValue(undefined),
      openTaskSession: vi.fn().mockReturnValue({ switched: false, reason: 'task_not_found' }),
      handleGatewayNotification: vi.fn(),
      clearError: vi.fn(),
    } as never);
    useChatStore.setState({
      foregroundHistorySessionKey: null,
      mutating: false,
      error: null,
      showThinking: true,
      currentSessionKey,
      pendingApprovalsBySession: {},
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        [currentSessionKey]: buildSessionRecord(currentSessionKey, {
          messages: allMessages,
          window: createViewportWindowState({
            totalMessageCount: 20,
            windowStartOffset: 0,
            windowEndOffset: 10,
            hasMore: false,
            hasNewer: true,
            isAtLatest: false,
          }),
          meta: {
            ready: true,
            lastActivityAt: Date.now(),
          },
        }),
      },
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadOlderMessages: vi.fn().mockResolvedValue(undefined),
      jumpToLatest,
      setViewportLastVisibleMessageId: vi.fn(),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      sendMessage,
    } as never);

    const { container } = renderChat();
    fireEvent.change(
      screen.getByPlaceholderText('Message (Type / to see skills, Enter to send, Shift+Enter for new line)'),
      { target: { value: 'reply from detached viewport' } },
    );
    fireEvent.click(container.querySelector('button[title="Send"]') as HTMLButtonElement);

    await waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith('reply from detached viewport', undefined);
    });
    expect(jumpToLatest).not.toHaveBeenCalled();
  });
});
