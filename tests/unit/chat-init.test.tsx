import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatInit } from '@/pages/Chat/useChatInit';
import { useChatStore } from '@/stores/chat';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { useSubagentsStore } from '@/stores/subagents';

const openClawTestRuntimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

const matchaAgentTestRuntimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'matcha-agent',
  runtimeInstanceId: 'local',
} as const;

function createOpenClawTestSessionIdentity(sessionKey: string, agentId: string) {
  return { endpoint: openClawTestRuntimeEndpoint, agentId, sessionKey };
}

const idleResource = {
  data: [],
  status: 'idle' as const,
  error: null,
  hasLoadedOnce: false,
  lastLoadedAt: null,
};

const readyResource = {
  data: [],
  status: 'ready' as const,
  error: null,
  hasLoadedOnce: true,
  lastLoadedAt: 1,
};

const mainSessionIdentity = createOpenClawTestSessionIdentity('agent:main:main', 'main');
const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);
const mainAgentScope = { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' };
const matchaAgentScope = { kind: 'agent' as const, endpoint: matchaAgentTestRuntimeEndpoint, agentId: 'matcha' };

function markSessionRuntimeReady() {
  useChatStore.setState({
    sessionRuntimeCatalog: {
      status: 'ready',
      error: null,
      endpoints: [{
        endpointId: 'openclaw-local',
        protocolId: 'openclaw-v4',
        endpoint: openClawTestRuntimeEndpoint,
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        displayName: 'OpenClaw Local',
        agentIds: ['main'],
        acceptsDynamicAgents: true,
        agentCatalog: {
          source: 'subagent-management' as const,
          seedAgents: [{ id: 'main', name: 'main' }],
        },
        sessionPromptScopes: [mainAgentScope],
        defaultSessionPromptScope: mainAgentScope,
      }],
      defaultSessionPromptScope: mainAgentScope,
    },
  } as never);
}

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
    items: overrides?.items ?? base.items,
    window: overrides?.window ?? base.window,
  };
}

describe('useChatInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as unknown as Record<string, unknown>).__MATCHACLAW_HOST_EVENT_HUB__;
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
    useChatStore.setState(useChatStore.getInitialState(), true);
    useRuntimeEndpointsStore.setState({
      status: 'idle',
      error: null,
      endpoints: [],
      hasLoadedOnce: false,
    });
    useSubagentsStore.setState({
      agents: [],
      agentsResource: idleResource,
    } as never);
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord({
          meta: {
            runtimeScopeKey: buildRuntimeScopeKey(mainSessionIdentity.endpoint),
            agentId: 'main',
            protocolId: 'openclaw-v4',
            runtimeEndpointId: 'local',
            sessionIdentity: mainSessionIdentity,
          },
        }),
      },
      sessionCatalogStatus: idleResource,
    } as never);
  });

  it('active 后直接加载 runtime endpoint catalog', async () => {
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
    const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
      markSessionRuntimeReady();
    });
    const { unmount } = renderHook(() => useChatInit({
      isActive: true,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime,
      loadAgents,
      loadSessions,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(1);
    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(bootstrapSessionRuntime.mock.invocationCallOrder[0]).toBeLessThan(loadSessions.mock.invocationCallOrder[0]);

    await act(async () => {
      resolveAgentsLoad?.();
      await Promise.resolve();
    });

    unmount();
  });

  it('Matcha-only runtime catalog 不加载 OpenClaw subagent management 列表', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockImplementation(async () => {
      useChatStore.setState({
        sessionCatalogStatus: readyResource,
      } as never);
    });
    const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
      useChatStore.setState({
        sessionRuntimeCatalog: {
          status: 'ready',
          error: null,
          endpoints: [{
            endpointId: 'matcha-agent-local',
            protocolId: 'matcha-agent-app-server',
            endpoint: matchaAgentTestRuntimeEndpoint,
            runtimeAdapterId: 'matcha-agent',
            runtimeInstanceId: 'local',
            displayName: 'Matcha Agent',
            agentIds: ['matcha'],
            acceptsDynamicAgents: true,
            agentCatalog: {
              source: 'runtime-endpoint' as const,
              agents: [{ id: 'matcha', name: 'matcha' }],
            },
            sessionPromptScopes: [matchaAgentScope],
            defaultSessionPromptScope: matchaAgentScope,
          }],
          defaultSessionPromptScope: matchaAgentScope,
        },
      } as never);
    });

    renderHook(() => useChatInit({
      isActive: true,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime,
      loadAgents,
      loadSessions,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(1);
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });

  it('session runtime catalog 首次恢复失败后重试并继续加载目录', async () => {
    vi.useFakeTimers();
    try {
      const loadAgents = vi.fn().mockResolvedValue(undefined);
      const loadSessions = vi.fn().mockImplementation(async () => {
        useChatStore.setState({
          sessionCatalogStatus: readyResource,
        } as never);
      });
      const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
        if (bootstrapSessionRuntime.mock.calls.length === 1) {
          useChatStore.setState({
            sessionRuntimeCatalog: {
              status: 'error',
              error: 'Runtime endpoint directory is unavailable',
              endpoints: [],
              defaultSessionPromptScope: null,
            },
          } as never);
          return;
        }
        markSessionRuntimeReady();
      });

      renderHook(() => useChatInit({
        isActive: true,
        locationSearch: '',
        navigate: vi.fn(),
        switchSession: vi.fn(),
        openAgentConversation: vi.fn(),
        bootstrapSessionRuntime,
        loadAgents,
        loadSessions,
        loadHistory: vi.fn().mockResolvedValue(undefined),
        cleanupEmptySession: vi.fn(),
      }));

      await act(async () => {
        await Promise.resolve();
      });
      expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(1);
      expect(loadAgents).not.toHaveBeenCalled();
      expect(loadSessions).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });

      expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(2);
      expect(loadAgents).toHaveBeenCalledTimes(1);
      expect(loadSessions).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runtime endpoint store 更新后重新恢复 session runtime catalog', async () => {
    vi.useFakeTimers();
    let unmount: (() => void) | null = null;
    try {
      const loadAgents = vi.fn().mockResolvedValue(undefined);
      const loadSessions = vi.fn().mockImplementation(async () => {
        useChatStore.setState({
          sessionCatalogStatus: readyResource,
        } as never);
      });
      const loadHistory = vi.fn().mockResolvedValue(undefined);
      const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
        if (bootstrapSessionRuntime.mock.calls.length === 1) {
          useChatStore.setState({
            sessionRuntimeCatalog: {
              status: 'error',
              error: 'Runtime endpoint directory is unavailable',
              endpoints: [],
              defaultSessionPromptScope: null,
            },
          } as never);
          return;
        }
        markSessionRuntimeReady();
      });

      ({ unmount } = renderHook(() => useChatInit({
        isActive: true,
        locationSearch: '',
        navigate: vi.fn(),
        switchSession: vi.fn(),
        openAgentConversation: vi.fn(),
        bootstrapSessionRuntime,
        loadAgents,
        loadSessions,
        loadHistory,
        cleanupEmptySession: vi.fn(),
      })));

      await act(async () => {
        await Promise.resolve();
      });
      expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(1);

      await act(async () => {
        useRuntimeEndpointsStore.setState({
          status: 'ready',
          endpoints: [],
          error: null,
          hasLoadedOnce: true,
        });
        await vi.advanceTimersByTimeAsync(120);
      });

      expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(2);
      expect(loadAgents).toHaveBeenCalledTimes(1);
      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(loadHistory).toHaveBeenCalledTimes(1);
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('inactive 时不加载 runtime endpoint catalog', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
      markSessionRuntimeReady();
    });
    const { rerender } = renderHook(({ isActive }) => useChatInit({
      isActive,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime,
      loadAgents,
      loadSessions,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
    }), { initialProps: { isActive: false } });

    await act(async () => {
      await Promise.resolve();
    });
    expect(bootstrapSessionRuntime).not.toHaveBeenCalled();
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();

    rerender({ isActive: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(1);
    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledTimes(1);
  });

  it('重试未完成的 peer 目录加载', async () => {
    vi.useFakeTimers();
    try {
      const loadAgents = vi.fn().mockResolvedValue(undefined);
      const loadSessions = vi.fn().mockResolvedValue(undefined);

      renderHook(() => useChatInit({
        isActive: true,
        locationSearch: '',
        navigate: vi.fn(),
        switchSession: vi.fn(),
        openAgentConversation: vi.fn(),
        bootstrapSessionRuntime: vi.fn().mockImplementation(async () => {
          markSessionRuntimeReady();
        }),
        loadAgents,
        loadSessions,
        loadHistory: vi.fn().mockResolvedValue(undefined),
        cleanupEmptySession: vi.fn(),
      }));

      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(5_000);
      });

      expect(loadAgents).toHaveBeenCalledTimes(3);
      expect(loadSessions).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('没有当前会话时，启动只加载目录，不自动加载默认历史', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockImplementation(async () => {
      useChatStore.setState({
        sessionCatalogStatus: readyResource,
      } as never);
    });
    useChatStore.setState({
      currentSessionKey: '',
      loadedSessions: {},
      sessionCatalogStatus: idleResource,
    } as never);

    renderHook(() => useChatInit({
      isActive: true,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime: vi.fn().mockImplementation(async () => {
        markSessionRuntimeReady();
      }),
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
    expect(useChatStore.getState().currentSessionKey).toBe('');
  });

  it('固定 target 初始化失败时，不加载目录或声明 timeline 成功', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockResolvedValue(undefined);

    renderHook(() => useChatInit({
      isActive: true,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime: vi.fn().mockImplementation(async () => {
        useChatStore.setState({
          sessionRuntimeCatalog: {
            status: 'error',
            error: 'OpenClaw local session target is unavailable',
            endpoints: [],
            defaultSessionPromptScope: null,
          },
        } as never);
      }),
      loadAgents,
      loadSessions,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();
  });

  it('目录加载后再解析 query session，避免冷启动先创建空记录', async () => {
    const switchSession = vi.fn();
    const navigate = vi.fn();
    useChatStore.setState({
      currentSessionKey: '',
      loadedSessions: {},
      sessionCatalogStatus: idleResource,
    } as never);
    const loadSessions = vi.fn().mockImplementation(async () => {
      useChatStore.setState((state) => ({
        loadedSessions: {
          ...state.loadedSessions,
          [mainRecordKey]: buildSessionRecord({
            meta: {
                runtimeScopeKey: buildRuntimeScopeKey(mainSessionIdentity.endpoint),
              agentId: 'main',
              protocolId: 'openclaw-v4',
              runtimeEndpointId: 'local',
              sessionIdentity: mainSessionIdentity,
            },
          }),
        },
        sessionCatalogStatus: readyResource,
      } as never));
    });

    renderHook(() => useChatInit({
      isActive: true,
      locationSearch: `?session=${encodeURIComponent('agent:main:main')}`,
      navigate,
      switchSession,
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime: vi.fn().mockImplementation(async () => {
        markSessionRuntimeReady();
      }),
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadSessions,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
    }));

    expect(switchSession).not.toHaveBeenCalled();

    await act(async () => {
      await Promise.resolve();
    });

    expect(switchSession).toHaveBeenCalledWith(mainRecordKey);
    expect(navigate).toHaveBeenCalledWith('/', { replace: true });
  });
});
