import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatInit } from '@/pages/Chat/useChatInit';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord, createEmptySessionViewportState } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { useSubagentsStore } from '@/stores/subagents';
import { buildRenderRowsFromMessages } from './helpers/timeline-fixtures';

const idleResource = {
  status: 'idle' as const,
  error: null,
  hasLoadedOnce: false,
  lastLoadedAt: null,
};

const readyResource = {
  status: 'ready' as const,
  error: null,
  hasLoadedOnce: true,
  lastLoadedAt: 1,
};

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & {
  sessionKey?: string;
  messages?: Array<{ id?: string; role: 'user' | 'assistant' | 'system'; content: unknown; timestamp?: number }>;
}) {
  const base = createEmptySessionRecord();
  const sessionKey = overrides?.sessionKey ?? 'agent:main:main';
  return {
    meta: {
      ...base.meta,
      ...overrides?.meta,
    },
    runtime: {
      ...base.runtime,
      ...overrides?.runtime,
    },
    rows: overrides?.messages
      ? buildRenderRowsFromMessages(sessionKey, overrides.messages)
      : (overrides?.rows ?? base.rows),
    window: overrides?.window ?? base.window,
  };
}

describe('useChatInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSubagentsStore.setState({
      agents: [],
      agentsResource: idleResource,
    } as never);
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createEmptySessionRecord(),
      },
      sessionCatalogStatus: idleResource,
    } as never);
  });

  it('gateway running 后并发触发 loadAgents 与 loadSessions', async () => {
    let resolveAgentsLoad: (() => void) | null = null;
    const loadAgents = vi.fn(() => new Promise<void>((resolve) => {
      resolveAgentsLoad = () => {
        useSubagentsStore.setState({
          agentsResource: readyResource,
          agents: [{ id: 'main', name: 'Main', isDefault: true }],
        } as never);
        resolve();
      };
    }));
    const loadSessions = vi.fn().mockImplementation(async () => {
      useChatStore.setState({
        sessionCatalogStatus: readyResource,
      } as never);
    });
    const loadHistory = vi.fn().mockResolvedValue(undefined);

    const { unmount } = renderHook(() => useChatInit({
      isActive: true,
      isGatewayRunning: true,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      loadAgents,
      loadSessions,
      loadHistory,
      cleanupEmptySession: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveAgentsLoad?.();
      await Promise.resolve();
    });

    unmount();
  });

  it('首次失败后会有限重试，并在重试成功后自动恢复 agents/sessions 资源', async () => {
    vi.useFakeTimers();
    try {
      let agentsAttempts = 0;
      const loadAgents = vi.fn().mockImplementation(async () => {
        agentsAttempts += 1;
        if (agentsAttempts === 1) {
          useSubagentsStore.setState({
            agentsResource: {
              status: 'error',
              error: 'agents failed',
              hasLoadedOnce: false,
              lastLoadedAt: null,
            },
          } as never);
          return;
        }
        useSubagentsStore.setState({
          agentsResource: readyResource,
          agents: [{ id: 'main', name: 'Main', isDefault: true }],
        } as never);
      });

      let sessionsAttempts = 0;
      const loadSessions = vi.fn().mockImplementation(async () => {
        sessionsAttempts += 1;
        if (sessionsAttempts === 1) {
          useChatStore.setState({
            sessionCatalogStatus: {
              status: 'error',
              error: 'sessions failed',
              hasLoadedOnce: false,
              lastLoadedAt: null,
            },
          } as never);
          return;
        }
        useChatStore.setState({
          sessionCatalogStatus: readyResource,
        } as never);
      });

      renderHook(() => useChatInit({
        isActive: true,
        isGatewayRunning: true,
        locationSearch: '',
        navigate: vi.fn(),
        switchSession: vi.fn(),
        openAgentConversation: vi.fn(),
        loadAgents,
        loadSessions,
        loadHistory: vi.fn().mockResolvedValue(undefined),
        cleanupEmptySession: vi.fn(),
      }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(loadAgents).toHaveBeenCalledTimes(1);
      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(useSubagentsStore.getState().agentsResource.status).toBe('error');
      expect(useChatStore.getState().sessionCatalogStatus.status).toBe('error');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
      });

      expect(loadAgents).toHaveBeenCalledTimes(2);
      expect(loadSessions).toHaveBeenCalledTimes(2);
      expect(useSubagentsStore.getState().agentsResource.status).toBe('ready');
      expect(useChatStore.getState().sessionCatalogStatus.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('当前会话已有 viewport 快照时，初始化走 quiet refresh，不回退到阻塞加载', async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': buildSessionRecord({
          sessionKey: 'agent:main:main',
          messages: [{ id: 'm1', role: 'assistant', content: 'hello', timestamp: 1 }],
          meta: { historyStatus: 'ready' },
          window: createViewportWindowState({
            ...createEmptySessionViewportState(),
            totalRowCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          }),
        }),
      },
      sessionCatalogStatus: readyResource,
    } as never);

    renderHook(() => useChatInit({
      isActive: true,
      isGatewayRunning: true,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadHistory,
      cleanupEmptySession: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadHistory).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });

    expect(loadHistory).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      mode: 'quiet',
      scope: 'foreground',
      reason: 'chat_init_snapshot_quiet_refresh',
    });
  });
});
