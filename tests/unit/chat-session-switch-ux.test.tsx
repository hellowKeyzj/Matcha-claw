import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { clearUiTelemetry, getUiTelemetrySnapshot } from '@/lib/telemetry';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { createAssistantOverlay } from '@/stores/chat/stream-overlay-message';
import type { RawMessage } from '@/stores/chat';

let triggerResizeObserver: (() => void) | null = null;
let resizeObserverCallbacks: Array<() => void> = [];

class ResizeObserverStub {
  private readonly trigger: () => void;

  constructor(callback: ResizeObserverCallback) {
    this.trigger = () => callback([], this as unknown as ResizeObserver);
    resizeObserverCallbacks.push(this.trigger);
    triggerResizeObserver = () => {
      act(() => {
        for (const observerCallback of [...resizeObserverCallbacks]) {
          observerCallback();
        }
      });
    };
  }

  observe() {}
  unobserve() {}

  disconnect() {
    resizeObserverCallbacks = resizeObserverCallbacks.filter((callback) => callback !== this.trigger);
  }
}

function createSessionRecord(input?: {
  transcript?: RawMessage[];
  ready?: boolean;
  lastActivityAt?: number | null;
  runtime?: Partial<ReturnType<typeof useChatStore.getState>['sessionsByKey'][string]['runtime']>;
}) {
  return {
    transcript: input?.transcript ?? [],
    meta: {
      label: null,
      lastActivityAt: input?.lastActivityAt ?? null,
      ready: input?.ready ?? false,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      assistantOverlay: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
      ...input?.runtime,
    },
  };
}

function setupStores() {
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);
  const now = Date.now();

  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
  } as never);

  useSubagentsStore.setState({
    agentsResource: {
      status: 'ready',
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: now,
      data: [
        { id: 'test', name: 'Test Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
        { id: 'another', name: 'Another Agent', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
      ],
    },
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
    sessionsResource: {
      status: 'ready',
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: now,
      data: [
        { key: 'agent:test:main', displayName: 'agent:test:main' },
        { key: 'agent:another:main', displayName: 'agent:another:main' },
      ],
    },
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    pendingApprovalsBySession: {},
    currentSessionKey: 'agent:test:main',
    sessionsByKey: {
      'agent:test:main': createSessionRecord({
        transcript: [
          {
            role: 'user',
            content: 'pending user message',
            timestamp: now / 1000,
            id: 'user-1',
          },
        ],
        ready: true,
        lastActivityAt: now,
        runtime: {
          sending: true,
          activeRunId: 'run-current',
          runPhase: 'streaming',
          assistantOverlay: createAssistantOverlay({
            runId: 'run-current',
            messageId: 'assistant-final',
            sourceMessage: {
              id: 'assistant-final',
              role: 'assistant',
              content: 'partial answer',
              timestamp: now / 1000,
            },
            committedText: 'partial answer',
            targetText: 'partial answer',
            status: 'streaming',
          }),
          pendingFinal: true,
          lastUserMessageAt: now,
        },
      }),
      'agent:another:main': createSessionRecord({
        transcript: [
          {
            role: 'assistant',
            content: 'another session latest message',
            timestamp: now / 1000,
            id: 'another-1',
          },
        ],
        ready: true,
        lastActivityAt: now - 1_000,
      }),
    },
    showThinking: true,
    loadHistory,
    loadSessions,
  } as never);
}

function buildSessionMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `session message ${index + 1}`,
    timestamp: (Date.now() / 1000) + index,
    id: `msg-${index + 1}`,
  }));
}

function buildHeavyMarkdownMessage(index: number) {
  return Array.from(
    { length: 320 },
    (_, line) => `message-${index}-line-${line}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
  ).join('\n\n');
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

function installViewportMetrics(
  viewport: HTMLDivElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(viewport, 'scrollHeight', {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(viewport, 'clientHeight', {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(viewport, 'scrollTop', {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (value: number) => {
      metrics.scrollTop = value;
    },
  });
}

function installChatLayoutMetrics(
  container: HTMLElement,
  viewport: HTMLDivElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  installViewportMetrics(viewport, metrics);
  Object.defineProperty(viewport, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      bottom: metrics.clientHeight,
      left: 0,
      right: 800,
      width: 800,
      height: metrics.clientHeight,
      toJSON: () => ({}),
    }),
  });

  const rows = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
  rows.forEach((row, index) => {
    const top = index * 88;
    Object.defineProperty(row, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: top,
        top,
        bottom: top + 72,
        left: 0,
        right: 800,
        width: 800,
        height: 72,
        toJSON: () => ({}),
      }),
    });
  });
}

describe('chat 会话切换 UX', () => {
  beforeEach(() => {
    clearUiTelemetry();
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupStores();
  });

  it('发送中切到其它会话再切回，应保留原会话 transcript 和活跃 runtime', async () => {
    renderChat();

    expect(screen.getByText('pending user message')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });
    expect(screen.getByText('another session latest message')).toBeInTheDocument();

    act(() => {
      useChatStore.getState().switchSession('agent:test:main');
    });

    await waitFor(() => {
      expect(screen.getByText('pending user message')).toBeInTheDocument();
    });

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe('agent:test:main');
    expect(state.sessionsByKey['agent:test:main']?.runtime.sending).toBe(true);
    expect(state.sessionsByKey['agent:test:main']?.runtime.pendingFinal).toBe(true);
    expect(state.sessionsByKey['agent:test:main']?.runtime.assistantOverlay).toMatchObject({
      runId: 'run-current',
    });
  });

  it('切会话时应直接贴到底部，而不是等旧虚拟列表命令', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 900,
      clientHeight: 320,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      metrics.scrollHeight = 760;
      useChatStore.getState().switchSession('agent:another:main');
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(440);
    });
  });

  it('主聊天页只渲染最近 30 条，并给出完整历史入口', async () => {
    const messages = buildSessionMessages(35);
    useChatStore.setState({
      sessionsByKey: {
        ...useChatStore.getState().sessionsByKey,
        'agent:test:main': createSessionRecord({
          transcript: messages,
          ready: true,
          lastActivityAt: Date.now(),
        }),
      },
    } as never);

    renderChat();

    expect(screen.getByText('session message 35')).toBeInTheDocument();
    expect(screen.getByText('session message 34')).toBeInTheDocument();
    expect(screen.getByText('session message 6')).toBeInTheDocument();
    expect(screen.queryByText('session message 5')).toBeNull();
    expect(screen.queryByText('session message 1')).toBeNull();
    expect(screen.queryByText('Showing the latest 30 messages in live chat.')).toBeNull();
    expect(screen.getByRole('button', { name: 'View history' })).toBeInTheDocument();
    expect(screen.queryByText('session message 5')).toBeNull();
  });

  it('切到缓存会话时应一次切到稳定 live rows，而不是经历两次可见数据切换', async () => {
    const messages = Array.from({ length: 32 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: index % 2 === 0 ? buildHeavyMarkdownMessage(index + 1) : `user message ${index + 1}`,
      timestamp: (Date.now() / 1000) + index,
      id: `heavy-${index + 1}`,
    }));

    useChatStore.setState({
      sessionsByKey: {
        ...useChatStore.getState().sessionsByKey,
        'agent:another:main': createSessionRecord({
          transcript: messages,
          ready: true,
          lastActivityAt: Date.now(),
        }),
      },
    } as never);

    renderChat();

    act(() => {
      useChatStore.getState().switchSession('agent:another:main');
    });

    expect(screen.getByText(/message-3-line-0/i)).toBeInTheDocument();
    expect(screen.getByText(/user message 4/i)).toBeInTheDocument();
    expect(screen.getByText(/user message 32/i)).toBeInTheDocument();
    expect(screen.getByText(/message-31-line-0/i)).toBeInTheDocument();
    expect(screen.queryByText(/message-1-line-0/i)).toBeNull();
    expect(screen.getByRole('button', { name: 'View history' })).toBeInTheDocument();
    expect(document.querySelector('[data-chat-body-mode="shell"]')).toBeNull();
    expect(document.querySelector('[data-chat-body-mode="lite"]')).toBeNull();
  });

  it('切到已就绪长消息会话时，不应在切换瞬间同步重算整批 markdown', async () => {
    vi.useFakeTimers();
    try {
      const messages = Array.from({ length: 32 }, (_, index) => ({
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: index % 2 === 0 ? buildHeavyMarkdownMessage(index + 1) : `user message ${index + 1}`,
        timestamp: (Date.now() / 1000) + index,
        id: `warm-heavy-${index + 1}`,
      }));

      useChatStore.setState({
        sessionsByKey: {
          ...useChatStore.getState().sessionsByKey,
          'agent:another:main': createSessionRecord({
            transcript: messages,
            ready: true,
            lastActivityAt: Date.now(),
          }),
        },
      } as never);

      renderChat();

      await act(async () => {
        for (let round = 0; round < 12; round += 1) {
          vi.runOnlyPendingTimers();
          await Promise.resolve();
        }
      });

      clearUiTelemetry();

      act(() => {
        useChatStore.getState().switchSession('agent:another:main');
      });

      expect(screen.getByText(/message-3-line-0/i)).toBeInTheDocument();
      expect(
        getUiTelemetrySnapshot().filter((entry) => entry.event === 'chat.md_process_cost'),
      ).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('切会话首屏时应先完成 live thread 首绘，再延后 execution graph 计算', async () => {
    vi.useFakeTimers();
    try {
      renderChat();

      act(() => {
        useChatStore.getState().switchSession('agent:another:main');
      });

      await act(async () => {
        await Promise.resolve();
      });

      const immediateTelemetry = getUiTelemetrySnapshot(50);
      const targetFirstPaintIndex = immediateTelemetry.findIndex((entry) => (
        entry.event === 'chat.session_first_paint'
        && entry.payload.sessionKey === 'agent:another:main::live'
      ));
      const targetExecGraphIndex = immediateTelemetry.findIndex((entry) => (
        entry.event === 'chat.exec_graph_pipeline'
        && entry.payload.sessionKey === 'agent:another:main::live'
      ));

      expect(targetFirstPaintIndex).toBeGreaterThanOrEqual(0);
      expect(targetExecGraphIndex).toBe(-1);

      await act(async () => {
        for (let round = 0; round < 5; round += 1) {
          vi.runOnlyPendingTimers();
          await Promise.resolve();
        }
      });

      const settledTelemetry = getUiTelemetrySnapshot(100);
      const settledFirstPaintIndex = settledTelemetry.findIndex((entry) => (
        entry.event === 'chat.session_first_paint'
        && entry.payload.sessionKey === 'agent:another:main::live'
      ));
      const settledExecGraphIndex = settledTelemetry.findIndex((entry) => (
        entry.event === 'chat.exec_graph_pipeline'
        && entry.payload.sessionKey === 'agent:another:main::live'
      ));

      expect(settledFirstPaintIndex).toBeGreaterThanOrEqual(0);
      expect(settledExecGraphIndex).toBeGreaterThan(settledFirstPaintIndex);
    } finally {
      vi.useRealTimers();
    }
  });
});
