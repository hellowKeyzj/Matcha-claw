import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatInit } from '@/pages/Chat/useChatInit';
import { useChatStore } from '@/stores/chat';
import { useSubagentsStore } from '@/stores/subagents';

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
      messages: [],
      sessions: [],
      currentSessionKey: 'agent:main:main',
      sessionReadyByKey: {},
      sessionRuntimeByKey: {},
      sessionLabels: {},
      sessionLastActivity: {},
      sessionsResource: idleResource,
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
        sessionsResource: readyResource,
      } as never);
    });
    const loadHistory = vi.fn().mockResolvedValue(undefined);

    const { unmount } = renderHook(() => useChatInit({
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
            sessionsResource: {
              status: 'error',
              error: 'sessions failed',
              hasLoadedOnce: false,
              lastLoadedAt: null,
            },
          } as never);
          return;
        }
        useChatStore.setState({
          sessionsResource: readyResource,
        } as never);
      });

      renderHook(() => useChatInit({
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
      expect(useChatStore.getState().sessionsResource.status).toBe('error');

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_600);
      });

      expect(loadAgents).toHaveBeenCalledTimes(2);
      expect(loadSessions).toHaveBeenCalledTimes(2);
      expect(useSubagentsStore.getState().agentsResource.status).toBe('ready');
      expect(useChatStore.getState().sessionsResource.status).toBe('ready');
    } finally {
      vi.useRealTimers();
    }
  });
});
