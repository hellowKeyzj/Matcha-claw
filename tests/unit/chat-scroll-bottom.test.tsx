import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import { createAssistantOverlay } from '@/stores/chat/stream-overlay-message';
import { computeBottomLockedScrollTopOnResize, isChatViewportNearBottom } from '@/pages/Chat/useChatScroll';

let triggerResizeObserver: (() => void) | null = null;
let resizeObserverCallbacks: Array<() => void> = [];

class ResizeObserverStub {
  private readonly trigger: () => void;

  constructor(callback: ResizeObserverCallback) {
    this.trigger = () => {
      callback([], this as unknown as ResizeObserver);
    };
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

function setupCommonStores() {
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const loadSessions = vi.fn().mockResolvedValue(undefined);
  const sessionKey = 'agent:test:main';
  const now = Date.now();

  useGatewayStore.setState({
    status: { state: 'running', port: 18789 },
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
    sessionsByKey: {
      [sessionKey]: {
        transcript: [
          {
            role: 'user',
            content: 'hello',
            timestamp: now / 1000,
            id: 'user-1',
          },
        ],
        meta: {
          label: null,
          lastActivityAt: now,
          ready: true,
          thinkingLevel: null,
        },
        runtime: {
          sending: true,
          activeRunId: 'run-1',
          runPhase: 'streaming',
          assistantOverlay: createAssistantOverlay({
            runId: 'run-1',
            messageId: 'assistant-1',
            sourceMessage: {
              id: 'assistant-1',
              role: 'assistant',
              content: 'first chunk',
              timestamp: now / 1000,
            },
            committedText: 'first chunk',
            targetText: 'first chunk',
            status: 'streaming',
          }),
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: now,
          pendingToolImages: [],
          approvalStatus: 'idle',
        },
      },
    },
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    mutating: false,
    error: null,
    pendingApprovalsBySession: {},
    sessions: [{ key: 'agent:test:main', displayName: 'agent:test:main' }],
    currentSessionKey: sessionKey,
    showThinking: true,
    sessionsResource: {
      status: 'ready',
      data: [{ key: sessionKey, displayName: sessionKey }],
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: now,
    },
    loadHistory,
    loadSessions,
  } as never);
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

function installRowHeight(element: HTMLElement, height: number) {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => DOMRect.fromRect({
      x: 0,
      y: 0,
      width: 400,
      height,
    }),
  });
}

describe('chat 主线程滚动锁', () => {
  beforeEach(() => {
    resizeObserverCallbacks = [];
    triggerResizeObserver = null;
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    setupCommonStores();
  });

  it('锁底时流式增长应持续贴底', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);
    installRowHeight(rowElements[0]!, 120);
    installRowHeight(rowElements[1]!, 80);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1300;
      useChatStore.setState({
        sessionsByKey: {
          'agent:test:main': {
            ...useChatStore.getState().sessionsByKey['agent:test:main'],
            runtime: {
              ...useChatStore.getState().sessionsByKey['agent:test:main']!.runtime,
              assistantOverlay: createAssistantOverlay({
                runId: 'run-1',
                messageId: 'assistant-1',
                sourceMessage: {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: 'first chunk second chunk',
                  timestamp: Date.now() / 1000,
                },
                committedText: 'first chunk second chunk',
                targetText: 'first chunk second chunk',
                status: 'streaming',
              }),
            },
          },
        },
      } as never);
      const nextRowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
      installRowHeight(nextRowElements[0]!, 120);
      installRowHeight(nextRowElements[1]!, 140);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(980);
    });
  });

  it('发送中旧消息高度变化时，不应因为非尾部 resize 抢滚动', async () => {
    useChatStore.setState({
      sessionsByKey: {
        'agent:test:main': {
          transcript: [
            {
              role: 'user',
              content: 'older message',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'tail message',
              timestamp: Date.now() / 1000,
              id: 'assistant-1',
            },
          ],
          meta: {
            label: null,
            lastActivityAt: Date.now(),
            ready: true,
            thinkingLevel: null,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            assistantOverlay: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: Date.now(),
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
        },
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);
    const initialRows = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    installRowHeight(initialRows[0]!, 120);
    installRowHeight(initialRows[1]!, 80);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1180;
      const nextRows = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
      installRowHeight(nextRows[0]!, 220);
      installRowHeight(nextRows[1]!, 80);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('锁底时发送中的 user overlay 出现后应立即贴底', async () => {
    useChatStore.setState({
      sessionsByKey: {
        'agent:test:main': {
          ...useChatStore.getState().sessionsByKey['agent:test:main'],
          transcript: [
            {
              role: 'user',
              content: 'hello',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
          ],
          runtime: {
            ...useChatStore.getState().sessionsByKey['agent:test:main']!.runtime,
            sending: true,
            assistantOverlay: null,
            pendingFinal: false,
            pendingUserMessage: null,
          },
        },
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      metrics.scrollHeight = 1180;
      useChatStore.setState({
        sessionsByKey: {
          'agent:test:main': {
            ...useChatStore.getState().sessionsByKey['agent:test:main'],
            runtime: {
              ...useChatStore.getState().sessionsByKey['agent:test:main']!.runtime,
              pendingUserMessage: {
                id: 'pending-user-2',
                role: 'user',
                content: 'pending send',
                timestamp: Date.now() / 1000,
              },
            },
          },
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(860);
    });
  });

  it('首次启动主会话在历史内容落地后应自动贴到底部', async () => {
    useChatStore.setState({
      sessionsByKey: {
        'agent:test:main': {
          transcript: [],
          meta: {
            label: null,
            lastActivityAt: null,
            ready: false,
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            assistantOverlay: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
        },
      },
      snapshotReady: false,
      initialLoading: true,
      currentSessionKey: 'agent:test:main',
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      useChatStore.setState({
        sessionsByKey: {
          'agent:test:main': {
            transcript: [
              {
                role: 'user',
                content: 'older message',
                timestamp: Date.now() / 1000,
                id: 'user-1',
              },
              {
                role: 'assistant',
                content: 'latest message',
                timestamp: Date.now() / 1000,
                id: 'assistant-1',
              },
            ],
            meta: {
              label: null,
              lastActivityAt: Date.now(),
              ready: true,
              thinkingLevel: null,
            },
            runtime: useChatStore.getState().sessionsByKey['agent:test:main']!.runtime,
          },
        },
        snapshotReady: true,
        initialLoading: false,
      } as never);
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('用户向上滚后应立即脱离锁底，后续增长不能再抢滚动', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    act(() => {
      metrics.scrollHeight = 1320;
      useChatStore.setState({
        sessionsByKey: {
          'agent:test:main': {
            ...useChatStore.getState().sessionsByKey['agent:test:main'],
            runtime: {
              ...useChatStore.getState().sessionsByKey['agent:test:main']!.runtime,
              assistantOverlay: createAssistantOverlay({
                runId: 'run-1',
                messageId: 'assistant-1',
                sourceMessage: {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: 'first chunk second chunk',
                  timestamp: Date.now() / 1000,
                },
                committedText: 'first chunk second chunk',
                targetText: 'first chunk second chunk',
                status: 'streaming',
              }),
            },
          },
        },
      } as never);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(420);
    });
  });

  it('用户重新滚到底部后应恢复跟随，后续增长继续贴底', async () => {
    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const rowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);
    installRowHeight(rowElements[0]!, 120);
    installRowHeight(rowElements[1]!, 80);

    act(() => {
      triggerResizeObserver?.();
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: -120 });
      metrics.scrollTop = 420;
      fireEvent.scroll(viewport);
    });

    act(() => {
      fireEvent.wheel(viewport, { deltaY: 180 });
      metrics.scrollTop = 660;
      fireEvent.scroll(viewport);
    });

    act(() => {
      metrics.scrollHeight = 1320;
      useChatStore.setState({
        sessionsByKey: {
          'agent:test:main': {
            ...useChatStore.getState().sessionsByKey['agent:test:main'],
            runtime: {
              ...useChatStore.getState().sessionsByKey['agent:test:main']!.runtime,
              assistantOverlay: createAssistantOverlay({
                runId: 'run-1',
                messageId: 'assistant-1',
                sourceMessage: {
                  id: 'assistant-1',
                  role: 'assistant',
                  content: 'first chunk second chunk',
                  timestamp: Date.now() / 1000,
                },
                committedText: 'first chunk second chunk',
                targetText: 'first chunk second chunk',
                status: 'streaming',
              }),
            },
          },
        },
      } as never);
      const nextRowElements = Array.from(container.querySelectorAll<HTMLElement>('[data-chat-row-key][data-chat-row-kind="message"]'));
      installRowHeight(nextRowElements[0]!, 120);
      installRowHeight(nextRowElements[1]!, 140);
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(1000);
    });
  });

  it('正文二次渲染只导致高度变化时，不应再次自动贴底', async () => {
    useChatStore.setState({
      sessionsByKey: {
        'agent:test:main': {
          transcript: [
            {
              role: 'user',
              content: 'older message',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'assistant body',
              timestamp: Date.now() / 1000,
              id: 'assistant-1',
            },
          ],
          meta: {
            label: null,
            lastActivityAt: Date.now(),
            ready: true,
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            assistantOverlay: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
        },
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });

    act(() => {
      metrics.scrollHeight = 1280;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });
  });

  it('锁底时 assistant final 完成后的尾部继续增高，仍应保持贴底', async () => {
    useChatStore.setState({
      sessionsByKey: {
        'agent:test:main': {
          transcript: [
            {
              role: 'user',
              content: 'hello',
              timestamp: Date.now() / 1000,
              id: 'user-1',
            },
            {
              role: 'assistant',
              content: 'first chunk',
              timestamp: Date.now() / 1000,
              id: 'assistant-1',
            },
          ],
          meta: {
            label: null,
            lastActivityAt: Date.now(),
            ready: true,
            thinkingLevel: null,
          },
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            assistantOverlay: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: Date.now(),
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
        },
      },
    } as never);

    const { container } = renderChat();
    const viewport = container.querySelector('.overflow-y-auto') as HTMLDivElement;
    const metrics = {
      scrollHeight: 980,
      clientHeight: 320,
      scrollTop: 660,
    };
    installViewportMetrics(viewport, metrics);

    act(() => {
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(660);
    });

    act(() => {
      useChatStore.setState({
        sessionsByKey: {
          'agent:test:main': {
            ...useChatStore.getState().sessionsByKey['agent:test:main'],
            runtime: {
              ...useChatStore.getState().sessionsByKey['agent:test:main']!.runtime,
              sending: false,
              activeRunId: null,
              runPhase: 'done',
              pendingFinal: false,
            },
          },
        },
      } as never);
    });

    act(() => {
      metrics.scrollHeight = 1400;
      triggerResizeObserver?.();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(1080);
    });
  });

  it('helper 只按真实布局量判断近底和目标滚动位', () => {
    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 690,
    }, 12)).toBe(true);

    expect(isChatViewportNearBottom({
      scrollHeight: 1000,
      clientHeight: 300,
      scrollTop: 650,
    }, 12)).toBe(false);

    expect(computeBottomLockedScrollTopOnResize(
      { scrollHeight: 900, clientHeight: 300, scrollTop: 600 },
      { scrollHeight: 1180, clientHeight: 320, scrollTop: 0 },
    )).toBe(860);
  });
});
