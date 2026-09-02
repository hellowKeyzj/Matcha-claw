import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatInit } from '@/pages/Chat/useChatInit';
import { useChatStore } from '@/stores/chat';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import {
  buildCurrentConversationFromSessionRecord,
  buildSessionRuntimeGraph,
  createDraftCurrentConversation,
} from '@/stores/chat/session-runtime-graph';
import { useSubagentsStore } from '@/stores/subagents';
import type { RuntimeEndpointSummary } from '@/types/runtime-topology';

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

const errorResource = {
  data: [],
  status: 'error' as const,
  error: 'failed',
  hasLoadedOnce: false,
  lastLoadedAt: null,
};

const mainSessionIdentity = createOpenClawTestSessionIdentity('agent:main:main', 'main');
const matchaSessionIdentity = { endpoint: matchaAgentTestRuntimeEndpoint, agentId: 'matcha', sessionKey: 'matcha-agent:matcha:main' };
const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);
const matchaRecordKey = buildSessionRecordKey(matchaSessionIdentity);
const mainAgentScope = { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' };
const matchaAgentScope = { kind: 'agent' as const, endpoint: matchaAgentTestRuntimeEndpoint, agentId: 'matcha' };

function markSessionRuntimeReady() {
  useChatStore.setState({
    sessionRuntimeCatalog: {
      status: 'ready',
      error: null,
      endpoints: [buildOpenClawRuntimeTarget()],
      defaultSessionPromptScope: mainAgentScope,
    },
  } as never);
  syncSessionRuntimeState();
}

function buildOpenClawRuntimeTarget() {
  return {
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
  };
}

function buildMatchaAgentRuntimeTarget() {
  return {
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
  };
}

function buildRuntimeEndpointSummary(input: {
  id: string;
  protocolId: string;
  endpoint: typeof openClawTestRuntimeEndpoint | typeof matchaAgentTestRuntimeEndpoint;
  displayName: string;
  agentIds: string[];
  defaultAgentId: string;
  supportsSubagents: boolean;
}): RuntimeEndpointSummary {
  return {
    id: input.id,
    protocolId: input.protocolId,
    runtimeAdapterId: input.endpoint.runtimeAdapterId,
    runtimeInstanceId: input.endpoint.runtimeInstanceId,
    endpointRef: input.endpoint,
    source: {
      kind: 'runtime-adapter',
      runtimeAdapterId: input.endpoint.runtimeAdapterId,
      runtimeInstanceId: input.endpoint.runtimeInstanceId,
    },
    location: { kind: 'local' },
    lifecycle: { phase: 'ready', connected: true, ready: true, updatedAt: 1 },
    displayName: input.displayName,
    agentIds: input.agentIds,
    defaultAgentId: input.defaultAgentId,
    agents: input.agentIds.map((agentId) => ({
      agentId,
      displayName: agentId,
      source: 'declared' as const,
      capabilities: {
        chat: true,
        streaming: true,
        tools: true,
        approvals: true,
        replay: true,
        modelSelection: true,
      },
    })),
    acceptsDynamicAgents: true,
    capabilities: {
      chat: true,
      streaming: true,
      tools: true,
      approvals: true,
      replay: true,
      modelSelection: true,
    },
    capabilityFamilies: [
      { family: 'session', availability: 'supported' },
      { family: 'subagent', availability: input.supportsSubagents ? 'supported' : 'unsupported' },
    ],
    controlState: {
      connection: null,
      readiness: { ready: true, phase: 'ready' },
      capabilities: null,
      updatedAt: null,
    },
  };
}

function buildOpenClawEndpointSummary(): RuntimeEndpointSummary {
  return buildRuntimeEndpointSummary({
    id: 'openclaw-local',
    protocolId: 'openclaw-v4',
    endpoint: openClawTestRuntimeEndpoint,
    displayName: 'OpenClaw Local',
    agentIds: ['main'],
    defaultAgentId: 'main',
    supportsSubagents: true,
  });
}

function buildMatchaAgentEndpointSummary(): RuntimeEndpointSummary {
  return buildRuntimeEndpointSummary({
    id: 'matcha-agent-local',
    protocolId: 'matcha-agent-app-server',
    endpoint: matchaAgentTestRuntimeEndpoint,
    displayName: 'Matcha Agent',
    agentIds: ['matcha'],
    defaultAgentId: 'matcha',
    supportsSubagents: false,
  });
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

function syncSessionRuntimeState() {
  useChatStore.setState((state) => {
    const currentSessionRecord = state.currentSessionKey ? state.loadedSessions[state.currentSessionKey] : null;
    const defaultScope = state.sessionRuntimeCatalog.defaultSessionPromptScope;
    return {
      sessionRuntimeGraph: buildSessionRuntimeGraph(state.sessionRuntimeCatalog, state.loadedSessions),
      currentConversation: currentSessionRecord
        ? buildCurrentConversationFromSessionRecord(currentSessionRecord)
        : defaultScope
          ? createDraftCurrentConversation(defaultScope.endpoint, defaultScope.agentId)
          : null,
    };
  });
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
      revision: 0,
      changedRuntimeScopeKeys: [],
      revisionByRuntimeScopeKey: {},
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
    syncSessionRuntimeState();
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
      syncSessionRuntimeState();
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
          syncSessionRuntimeState();
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

  it('切到 OpenClaw 后确保 subagent 与 session 目录且不加载历史', async () => {
    vi.useFakeTimers();
    let unmount: (() => void) | null = null;
    try {
      const loadAgents = vi.fn().mockImplementation(async () => {
        useSubagentsStore.setState({
          agentsResource: readyResource,
          agents: [{ id: 'main', name: 'main', isDefault: true }],
        } as never);
      });
      const loadSessions = vi.fn().mockImplementation(async () => {
        useChatStore.setState({
          sessionCatalogStatus: readyResource,
        } as never);
      });
      const loadHistory = vi.fn().mockResolvedValue(undefined);
      const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
        useChatStore.setState({
          sessionRuntimeCatalog: {
            status: 'ready',
            error: null,
            endpoints: [buildMatchaAgentRuntimeTarget(), buildOpenClawRuntimeTarget()],
            defaultSessionPromptScope: matchaAgentScope,
          },
        } as never);
        syncSessionRuntimeState();
      });
      useChatStore.setState({
        currentSessionKey: matchaRecordKey,
        loadedSessions: {
          [matchaRecordKey]: buildSessionRecord({
            meta: {
              runtimeScopeKey: buildRuntimeScopeKey(matchaSessionIdentity.endpoint),
              agentId: 'matcha',
              protocolId: 'matcha-agent-app-server',
              runtimeEndpointId: 'local',
              sessionIdentity: matchaSessionIdentity,
              historyStatus: 'ready',
            },
          }),
        },
        sessionCatalogStatus: errorResource,
      } as never);
      syncSessionRuntimeState();

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
      loadAgents.mockClear();
      loadSessions.mockClear();
      loadHistory.mockClear();

      act(() => {
        useChatStore.getState().selectSessionRuntimeEndpoint(openClawTestRuntimeEndpoint);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(useChatStore.getState().currentConversation?.runtimeScopeKey)
        .toBe(buildRuntimeScopeKey(openClawTestRuntimeEndpoint));
      expect(loadAgents).toHaveBeenCalledTimes(1);
      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(loadHistory).not.toHaveBeenCalled();
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('runtime 目录缓存有效时重复切换不重复加载且保留 loadedSessions', async () => {
    vi.useFakeTimers();
    let unmount: (() => void) | null = null;
    try {
      const cachedRuntimeEndpoint = {
        kind: 'native-runtime',
        runtimeAdapterId: 'cached-runtime',
        runtimeInstanceId: 'local',
      } as const;
      const cachedSessionIdentity = { endpoint: cachedRuntimeEndpoint, agentId: 'cached', sessionKey: 'cached:session' };
      const cachedRecordKey = buildSessionRecordKey(cachedSessionIdentity);
      const loadedSessions = {
        [cachedRecordKey]: buildSessionRecord({
          meta: {
            runtimeScopeKey: buildRuntimeScopeKey(cachedSessionIdentity.endpoint),
            agentId: 'cached',
            protocolId: 'cached-v1',
            runtimeEndpointId: 'local',
            sessionIdentity: cachedSessionIdentity,
            historyStatus: 'ready',
          },
        }),
      };
      const loadAgents = vi.fn().mockResolvedValue(undefined);
      const loadSessions = vi.fn().mockResolvedValue(undefined);
      const bootstrapSessionRuntime = vi.fn().mockImplementation(async () => {
        useChatStore.setState({
          sessionRuntimeCatalog: {
            status: 'ready',
            error: null,
            endpoints: [buildMatchaAgentRuntimeTarget(), buildOpenClawRuntimeTarget()],
            defaultSessionPromptScope: matchaAgentScope,
          },
        } as never);
        syncSessionRuntimeState();
      });
      useSubagentsStore.setState({
        agentsResource: {
          ...readyResource,
          data: [{ id: 'main', name: 'main', isDefault: true }],
          lastLoadedAt: Date.now(),
        },
        agents: [{ id: 'main', name: 'main', isDefault: true }],
      } as never);
      useChatStore.setState({
        currentSessionKey: '',
        loadedSessions,
        sessionRuntimeCatalog: {
          status: 'ready',
          error: null,
          endpoints: [buildMatchaAgentRuntimeTarget(), buildOpenClawRuntimeTarget()],
          defaultSessionPromptScope: matchaAgentScope,
        },
        sessionCatalogStatus: {
          ...readyResource,
          lastLoadedAt: Date.now(),
        },
        sessionCatalogLoadedAtByRuntimeScopeKey: {
          [buildRuntimeScopeKey(openClawTestRuntimeEndpoint)]: Date.now(),
          [buildRuntimeScopeKey(matchaAgentTestRuntimeEndpoint)]: Date.now(),
        },
      } as never);
      syncSessionRuntimeState();

      ({ unmount } = renderHook(() => useChatInit({
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
      })));

      await act(async () => {
        await Promise.resolve();
      });
      loadAgents.mockClear();
      loadSessions.mockClear();

      act(() => {
        useChatStore.getState().selectSessionRuntimeEndpoint(openClawTestRuntimeEndpoint);
      });
      act(() => {
        useChatStore.getState().selectSessionRuntimeEndpoint(matchaAgentTestRuntimeEndpoint);
      });
      act(() => {
        useChatStore.getState().selectSessionRuntimeEndpoint(openClawTestRuntimeEndpoint);
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(loadAgents).not.toHaveBeenCalled();
      expect(loadSessions).not.toHaveBeenCalled();
      expect(Object.keys(useChatStore.getState().loadedSessions))
        .toEqual([cachedRecordKey]);
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('runtime ready 事件后 catalog 未 loaded 时补一次 sessions 但不加载历史', async () => {
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
        const hasOpenClaw = useRuntimeEndpointsStore.getState().endpoints
          .some((endpoint) => endpoint.id === 'openclaw-local');
        useChatStore.setState({
          sessionRuntimeCatalog: {
            status: 'ready',
            error: null,
            endpoints: hasOpenClaw
              ? [buildMatchaAgentRuntimeTarget(), buildOpenClawRuntimeTarget()]
              : [buildMatchaAgentRuntimeTarget()],
            defaultSessionPromptScope: matchaAgentScope,
          },
        } as never);
        syncSessionRuntimeState();
      });
      useSubagentsStore.setState({
        agentsResource: {
          ...readyResource,
          data: [{ id: 'main', name: 'main', isDefault: true }],
          lastLoadedAt: Date.now(),
        },
      } as never);
      useChatStore.setState({
        currentSessionKey: matchaRecordKey,
        loadedSessions: {
          [matchaRecordKey]: buildSessionRecord({
            meta: {
              runtimeScopeKey: buildRuntimeScopeKey(matchaSessionIdentity.endpoint),
              agentId: 'matcha',
              protocolId: 'matcha-agent-app-server',
              runtimeEndpointId: 'local',
              sessionIdentity: matchaSessionIdentity,
              historyStatus: 'ready',
            },
          }),
        },
        sessionCatalogStatus: idleResource,
      } as never);
      syncSessionRuntimeState();

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
        await vi.advanceTimersByTimeAsync(80);
      });
      bootstrapSessionRuntime.mockClear();
      loadAgents.mockClear();
      loadSessions.mockClear();
      loadHistory.mockClear();
      useChatStore.setState({
        sessionCatalogStatus: idleResource,
      } as never);

      await act(async () => {
        useRuntimeEndpointsStore.setState({
          status: 'ready',
          endpoints: [buildMatchaAgentEndpointSummary(), buildOpenClawEndpointSummary()],
          error: null,
          hasLoadedOnce: true,
          revision: 1,
          changedRuntimeScopeKeys: [buildRuntimeScopeKey(openClawTestRuntimeEndpoint)],
          revisionByRuntimeScopeKey: {
            [buildRuntimeScopeKey(openClawTestRuntimeEndpoint)]: 1,
          },
        });
        await vi.advanceTimersByTimeAsync(120);
        await Promise.resolve();
      });

      expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(1);
      expect(loadAgents).not.toHaveBeenCalled();
      expect(loadSessions).toHaveBeenCalledTimes(1);
      expect(loadHistory).not.toHaveBeenCalled();
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it('当前 MatchaAgent 会话收到 OpenClaw ready 事件时刷新 catalog 且不重载会话', async () => {
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
        const hasOpenClaw = useRuntimeEndpointsStore.getState().endpoints
          .some((endpoint) => endpoint.id === 'openclaw-local');
        useChatStore.setState({
          sessionRuntimeCatalog: {
            status: 'ready',
            error: null,
            endpoints: hasOpenClaw
              ? [buildOpenClawRuntimeTarget(), buildMatchaAgentRuntimeTarget()]
              : [buildMatchaAgentRuntimeTarget()],
            defaultSessionPromptScope: matchaAgentScope,
          },
        } as never);
        syncSessionRuntimeState();
      });
      useSubagentsStore.setState({
        agentsResource: {
          ...readyResource,
          data: [{ id: 'main', name: 'main', isDefault: true }],
          lastLoadedAt: Date.now(),
        },
      } as never);
      useChatStore.setState({
        currentSessionKey: matchaRecordKey,
        loadedSessions: {
          [matchaRecordKey]: buildSessionRecord({
            meta: {
              runtimeScopeKey: buildRuntimeScopeKey(matchaSessionIdentity.endpoint),
              agentId: 'matcha',
              protocolId: 'matcha-agent-app-server',
              runtimeEndpointId: 'local',
              sessionIdentity: matchaSessionIdentity,
              historyStatus: 'ready',
            },
          }),
        },
        sessionCatalogStatus: readyResource,
        sessionCatalogLoadedAtByRuntimeScopeKey: {
          [buildRuntimeScopeKey(matchaAgentTestRuntimeEndpoint)]: Date.now(),
        },
      } as never);
      syncSessionRuntimeState();

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
        await vi.advanceTimersByTimeAsync(80);
      });
      bootstrapSessionRuntime.mockClear();
      loadAgents.mockClear();
      loadSessions.mockClear();
      loadHistory.mockClear();

      await act(async () => {
        useRuntimeEndpointsStore.setState({
          status: 'ready',
          endpoints: [buildMatchaAgentEndpointSummary(), buildOpenClawEndpointSummary()],
          error: null,
          hasLoadedOnce: true,
          revision: 1,
          changedRuntimeScopeKeys: [buildRuntimeScopeKey(openClawTestRuntimeEndpoint)],
          revisionByRuntimeScopeKey: {
            [buildRuntimeScopeKey(openClawTestRuntimeEndpoint)]: 1,
          },
        });
        await vi.advanceTimersByTimeAsync(120);
        await Promise.resolve();
      });

      expect(bootstrapSessionRuntime).toHaveBeenCalledTimes(1);
      expect(loadAgents).not.toHaveBeenCalled();
      expect(loadSessions).not.toHaveBeenCalled();
      expect(loadHistory).not.toHaveBeenCalled();
      expect(useChatStore.getState().currentConversation?.runtimeScopeKey)
        .toBe(buildRuntimeScopeKey(matchaAgentTestRuntimeEndpoint));
      expect(useChatStore.getState().sessionRuntimeCatalog.endpoints.map((endpoint) => endpoint.endpointId).sort())
        .toEqual(['matcha-agent-local', 'openclaw-local']);
    } finally {
      unmount?.();
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
          syncSessionRuntimeState();
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
          revision: 1,
          changedRuntimeScopeKeys: [buildRuntimeScopeKey(openClawTestRuntimeEndpoint)],
          revisionByRuntimeScopeKey: {
            [buildRuntimeScopeKey(openClawTestRuntimeEndpoint)]: 1,
          },
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
    syncSessionRuntimeState();
    const loadHistory = vi.fn().mockResolvedValue(undefined);

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
      loadHistory,
      cleanupEmptySession: vi.fn(),
    }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(loadAgents).toHaveBeenCalledTimes(1);
    expect(loadSessions).toHaveBeenCalledTimes(1);
    expect(loadHistory).not.toHaveBeenCalled();
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
        syncSessionRuntimeState();
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
    syncSessionRuntimeState();
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
      syncSessionRuntimeState();
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
