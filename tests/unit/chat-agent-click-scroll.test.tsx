import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentSessionsPane } from '@/components/layout/AgentSessionsPane';
import Chat from '@/pages/Chat';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useChatStore } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useSubagentsStore } from '@/stores/subagents';
import { useTaskInboxStore } from '@/stores/task-inbox-store';
import i18n from '@/i18n';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>>) {
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
    window: overrides?.window ?? base.window,
  };
}

function findClosestScrollViewport(node: HTMLElement | null): HTMLDivElement | null {
  let current = node?.parentElement ?? null;
  while (current) {
    if (typeof current.className === 'string' && current.className.includes('overflow-y-auto')) {
      return current as HTMLDivElement;
    }
    current = current.parentElement;
  }
  return null;
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

describe('chat 左侧点击链路回归', () => {
  beforeEach(() => {
    i18n.changeLanguage('en');

    useGatewayStore.setState({
      status: { state: 'running', port: 18789 },
    } as never);

    useSubagentsStore.setState({
      agentsResource: {
        status: 'ready',
        data: [
          { id: 'main', name: 'main', workspace: '.', isDefault: true, createdAt: 1, updatedAt: 1 },
          { id: 'another', name: 'another', workspace: '.', isDefault: false, createdAt: 1, updatedAt: 1 },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: Date.now(),
      },
      loadAgents: vi.fn().mockResolvedValue(undefined),
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
      pendingApprovalsBySession: {},
      sessionMetasResource: {
        status: 'ready',
        data: [
          { key: 'agent:main:main', displayName: 'agent:main:main' },
          { key: 'agent:another:main', displayName: 'agent:another:main' },
        ],
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          window: createViewportWindowState({
            messages: [
              {
                role: 'user',
                content: 'current session user message',
                timestamp: 1,
                id: 'current-msg-1',
              },
              {
                role: 'assistant',
                content: 'current session mid message',
                timestamp: 2,
                id: 'current-msg-2',
              },
              {
                role: 'assistant',
                content: 'current session old message',
                timestamp: 3,
                id: 'current-msg-3',
              },
            ],
            totalMessageCount: 3,
            windowStartOffset: 0,
            windowEndOffset: 3,
            isAtLatest: true,
          }),
          meta: {
            ready: true,
          },
        }),
        'agent:another:main': buildSessionRecord({
          window: createViewportWindowState({
            messages: [
              {
                role: 'user',
                content: 'another user message',
                timestamp: 1,
                id: 'another-msg-1',
              },
              {
                role: 'assistant',
                content: 'another assistant mid message',
                timestamp: 2,
                id: 'another-msg-2',
              },
              {
                role: 'assistant',
                content: 'another assistant latest message',
                timestamp: 3,
                id: 'another-msg-3',
              },
            ],
            totalMessageCount: 3,
            windowStartOffset: 0,
            windowEndOffset: 3,
            isAtLatest: true,
          }),
          meta: {
            label: 'another latest session',
            lastActivityAt: 3,
            ready: true,
          },
        }),
      },
      showThinking: true,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
    } as never);
  });

  it('用户先上翻当前会话，再点击左侧 AGENT 时，仍应落到目标会话最新消息底部', async () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <TooltipProvider>
          <div className="flex h-screen">
            <AgentSessionsPane />
            <div className="min-h-0 flex-1">
              <Chat />
            </div>
          </div>
        </TooltipProvider>
      </MemoryRouter>,
    );

    const currentMessage = screen.getByText('current session old message');
    const viewport = findClosestScrollViewport(currentMessage as HTMLElement);
    expect(viewport).toBeTruthy();
    if (!viewport) {
      return;
    }

    const metrics = {
      scrollHeight: 2200,
      clientHeight: 320,
      scrollTop: 0,
    };
    installViewportMetrics(viewport, metrics);

    fireEvent.scroll(viewport);

    metrics.scrollHeight = 760;
    fireEvent.click(screen.getByTestId('agent-item-another'));

    await waitFor(() => {
      expect(screen.getByText('another assistant latest message')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(metrics.scrollTop).toBe(440);
    });
  });
});


