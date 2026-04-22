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

function setupStores() {
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);

  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
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
    messages: [
      {
        role: 'user',
        content: 'pending user message',
        timestamp: Date.now() / 1000,
        id: 'user-1',
      },
    ],
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    sending: true,
    activeRunId: 'run-current',
    runPhase: 'streaming',
    streamingMessage: {
      id: 'assistant-final',
      role: 'assistant',
      content: 'partial answer',
      timestamp: Date.now() / 1000,
    },
    streamRuntime: {
      sessionKey: 'agent:test:main',
      runId: 'run-current',
      chunks: ['partial answer'],
      rawChars: 14,
      displayedChars: 14,
      status: 'streaming',
      rafId: null,
    },
    streamingTools: [],
    pendingFinal: true,
    lastUserMessageAt: Date.now(),
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
    sessions: [
      { key: 'agent:test:main', displayName: 'agent:test:main' },
      { key: 'agent:another:main', displayName: 'agent:another:main' },
    ],
    currentSessionKey: 'agent:test:main',
    sessionLabels: {},
    sessionLastActivity: {
      'agent:test:main': Date.now(),
      'agent:another:main': Date.now() - 1_000,
    },
    sessionReadyByKey: {
      'agent:test:main': true,
      'agent:another:main': true,
    },
    sessionRuntimeByKey: {
      'agent:another:main': {
        messages: [
          {
            role: 'assistant',
            content: 'another session latest message',
            timestamp: Date.now() / 1000,
            id: 'another-1',
          },
        ],
        sending: false,
        activeRunId: null,
        runPhase: 'idle',
        streamingMessage: null,
        streamRuntime: null,
        streamingTools: [],
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        approvalStatus: 'idle',
      },
    },
    showThinking: true,
    thinkingLevel: null,
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
    expect(state.sending).toBe(true);
    expect(state.pendingFinal).toBe(true);
    expect(state.streamRuntime).toMatchObject({
      sessionKey: 'agent:test:main',
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
      messages,
      sending: false,
      streamingMessage: null,
      streamRuntime: null,
      pendingFinal: false,
      sessionRuntimeByKey: {},
    } as never);

    renderChat();

    expect(screen.getByText('session message 35')).toBeInTheDocument();
    expect(screen.getByText('session message 34')).toBeInTheDocument();
    expect(screen.queryByText('session message 5')).toBeNull();
    expect(screen.queryByText('session message 1')).toBeNull();
    expect(screen.queryByText('Showing the latest 30 messages in live chat.')).toBeNull();
    expect(screen.getByRole('button', { name: 'View history' })).toBeInTheDocument();
  });

  it('超长会话首屏应只让近处 assistant 正文进入 full，其余保留 lite 或 shell', async () => {
    const messages = Array.from({ length: 32 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: index % 2 === 0 ? buildHeavyMarkdownMessage(index + 1) : `user message ${index + 1}`,
      timestamp: (Date.now() / 1000) + index,
      id: `heavy-${index + 1}`,
    }));

    useChatStore.setState({
      messages,
      sending: false,
      streamingMessage: null,
      streamRuntime: null,
      pendingFinal: false,
      sessionRuntimeByKey: {},
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    installChatLayoutMetrics(container, viewport, {
      scrollHeight: 3200,
      clientHeight: 320,
      scrollTop: 0,
    });

    await waitFor(() => {
      const fullBodies = container.querySelectorAll('[data-chat-body-mode="full"]');
      expect(fullBodies.length).toBeGreaterThan(0);
    });

    expect(container.querySelectorAll('[data-chat-body-mode="shell"]').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('[data-chat-body-mode="lite"]').length).toBeGreaterThan(0);
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
