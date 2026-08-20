import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatInit } from '@/pages/Chat/useChatInit';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { useSubagentsStore } from '@/stores/subagents';

const openClawTestRuntimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

function createOpenClawTestSessionIdentity(sessionKey: string, agentId: string) {
  return { endpoint: openClawTestRuntimeEndpoint, agentId, sessionKey };
}

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

const mainSessionIdentity = createOpenClawTestSessionIdentity('agent:main:main', 'main');
const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);
const mainAgentScope = { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' };

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
    useSubagentsStore.setState(useSubagentsStore.getInitialState(), true);
    useChatStore.setState(useChatStore.getInitialState(), true);
    useSubagentsStore.setState({
      agents: [],
      agentsResource: idleResource,
    } as never);
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord({
          meta: {
            backendSessionKey: 'agent:main:main',
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

  it('OpenClaw running 后并发触发 loadAgents 与 loadSessions', async () => {
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
      isGatewayRunning: true,
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

  it('等待 OpenClaw running 投影后才加载 peer 目录', async () => {
    const loadAgents = vi.fn().mockResolvedValue(undefined);
    const loadSessions = vi.fn().mockResolvedValue(undefined);
    const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
      markSessionRuntimeReady();
    });
    const { rerender } = renderHook(({ isGatewayRunning }) => useChatInit({
      isActive: true,
      isGatewayRunning,
      locationSearch: '',
      navigate: vi.fn(),
      switchSession: vi.fn(),
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime,
      loadAgents,
      loadSessions,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
    }), { initialProps: { isGatewayRunning: false } });

    await act(async () => {
      await Promise.resolve();
    });
    expect(bootstrapSessionRuntime).not.toHaveBeenCalled();
    expect(loadAgents).not.toHaveBeenCalled();
    expect(loadSessions).not.toHaveBeenCalled();

    rerender({ isGatewayRunning: true });
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
        isGatewayRunning: true,
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
      isGatewayRunning: true,
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
      isGatewayRunning: true,
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

  it('目录加载后通过同一 session reselect 触发 sealed timeline projection', async () => {
    const switchSession = vi.fn();
    useChatStore.setState({
      currentSessionKey: mainRecordKey,
      sessionCatalogStatus: readyResource,
    } as never);

    renderHook(() => useChatInit({
      isActive: true,
      isGatewayRunning: true,
      locationSearch: `?session=${encodeURIComponent(mainRecordKey)}`,
      navigate: vi.fn(),
      switchSession,
      openAgentConversation: vi.fn(),
      bootstrapSessionRuntime: vi.fn().mockImplementation(async () => {
        markSessionRuntimeReady();
      }),
      loadAgents: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      loadHistory: vi.fn().mockResolvedValue(undefined),
      cleanupEmptySession: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(switchSession).toHaveBeenCalledWith(mainRecordKey);
  });
});
