import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { createEmptySessionRecord, createEmptySessionViewportState } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function buildMessages(count: number, prefix = 'message') {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${prefix} ${index + 1}`,
    timestamp: index + 1,
    id: `${prefix}-${index + 1}`,
  }));
}

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>>) {
  const base = createEmptySessionRecord();
  return {
    transcript: overrides?.transcript ?? base.transcript,
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
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

function setupChatSessions() {
  const currentSessionKey = 'agent:test:main';
  const anotherSessionKey = 'agent:another:main';
  const currentMessages = buildMessages(12, 'current');
  const anotherMessages = buildMessages(6, 'another');

  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
    rpc: vi.fn().mockResolvedValue({}),
  } as never);
  useSubagentsStore.setState({
    agents: [
      { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      { id: 'another', name: 'Another Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
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
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    showThinking: true,
    currentSessionKey,
    viewportBySession: {
      [currentSessionKey]: createViewportWindowState({
        ...createEmptySessionViewportState(),
        messages: currentMessages,
        totalMessageCount: currentMessages.length,
        windowStartOffset: 0,
        windowEndOffset: currentMessages.length,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      }),
      [anotherSessionKey]: createViewportWindowState({
        ...createEmptySessionViewportState(),
        messages: anotherMessages,
        totalMessageCount: anotherMessages.length,
        windowStartOffset: 0,
        windowEndOffset: anotherMessages.length,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      }),
    },
    pendingApprovalsBySession: {},
    sessions: [
      { key: currentSessionKey, displayName: currentSessionKey },
      { key: anotherSessionKey, displayName: anotherSessionKey },
    ],
    sessionsByKey: {
      [currentSessionKey]: buildSessionRecord({
        transcript: currentMessages,
        meta: {
          ready: true,
          lastActivityAt: Date.now(),
        },
        runtime: {
          sending: true,
          pendingFinal: true,
          activeRunId: 'run-current',
        },
      }),
      [anotherSessionKey]: buildSessionRecord({
        transcript: anotherMessages,
        meta: {
          ready: true,
          lastActivityAt: Date.now() - 1000,
        },
      }),
    },
    loadHistory: vi.fn().mockResolvedValue(undefined),
    loadOlderMessages: vi.fn().mockResolvedValue(undefined),
    jumpToLatest: vi.fn().mockResolvedValue(undefined),
    trimTopMessages: vi.fn(),
    setViewportLastVisibleMessageId: vi.fn(),
    loadSessions: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  } as never);

  return { currentSessionKey, anotherSessionKey };
}

describe('chat 会话切换 UX', () => {
  beforeEach(() => {
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  });

  it('发送中切到其它会话再切回，应保留原会话 transcript 和活跃 runtime', async () => {
    const { currentSessionKey, anotherSessionKey } = setupChatSessions();
    renderChat();

    act(() => {
      useChatStore.getState().switchSession(anotherSessionKey);
    });
    await waitFor(() => {
      expect(screen.getByText('another 1')).toBeInTheDocument();
    });

    act(() => {
      useChatStore.getState().switchSession(currentSessionKey);
    });
    await waitFor(() => {
      expect(screen.getByText('current 1')).toBeInTheDocument();
    });

    const record = useChatStore.getState().sessionsByKey[currentSessionKey];
    expect(record?.transcript).toHaveLength(12);
    expect(record?.runtime.activeRunId).toBe('run-current');
    expect(record?.runtime.sending).toBe(true);
  });

  it('切到目标会话时应直接显示目标 viewport messages', async () => {
    const { anotherSessionKey } = setupChatSessions();
    renderChat();

    act(() => {
      useChatStore.getState().switchSession(anotherSessionKey);
    });

    await waitFor(() => {
      expect(screen.getByText('another 1')).toBeInTheDocument();
      expect(screen.getByText('another 6')).toBeInTheDocument();
    });
    expect(screen.queryByText('current 12')).toBeNull();
  });

  it('切回 live 会话时应保持最新窗口可见', async () => {
    const { currentSessionKey, anotherSessionKey } = setupChatSessions();
    renderChat();

    act(() => {
      useChatStore.getState().switchSession(anotherSessionKey);
      useChatStore.getState().switchSession(currentSessionKey);
    });

    await waitFor(() => {
      expect(screen.getByText('current 12')).toBeInTheDocument();
    });
    expect(screen.getByText('current 11')).toBeInTheDocument();
  });
});
