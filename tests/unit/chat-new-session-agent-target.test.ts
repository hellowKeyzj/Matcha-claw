import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { createEmptySessionRecord, getSessionItems } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { createOpenClawTestSessionIdentity, openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import type { AgentScope, RuntimeEndpointRef, SessionIdentity } from '../../runtime-host/shared/runtime-address';
import type { RuntimeEndpointSummary } from '../../runtime-host/shared/runtime-topology';

const hostSessionNewMock = vi.fn();
const hostRuntimeEndpointsListMock = vi.fn();
const hostSessionListMock = vi.fn();

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

vi.mock('@/lib/host-api', () => ({
  hostSessionNew: (...args: unknown[]) => hostSessionNewMock(...args),
  hostRuntimeEndpointsList: (...args: unknown[]) => hostRuntimeEndpointsListMock(...args),
  hostSessionList: (...args: unknown[]) => hostSessionListMock(...args),
  hostSessionApprovals: vi.fn(),
  hostSessionRename: vi.fn(),
  hostSessionResolveApproval: vi.fn(),
  hostSessionDelete: vi.fn(),
  hostSessionResume: vi.fn(),
  hostSessionSwitch: vi.fn(),
  hostSessionWindowFetch: vi.fn(),
  resolveHydratedSessionSnapshot: vi.fn(),
  hostApiFetch: vi.fn(),
}));

function buildSessionRecord(overrides?: Partial<ReturnType<typeof createEmptySessionRecord>> & { sessionKey?: string }) {
  const base = createEmptySessionRecord();
  const sessionKey = overrides?.sessionKey ?? 'agent:test:main';
  const agentId = sessionKey.split(':')[1] ?? 'main';
  const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey, agentId);
  return {
    meta: {
      ...base.meta,
      backendSessionKey: sessionKey,
      runtimeScopeKey: buildRuntimeScopeKey(sessionIdentity.endpoint),
      agentId,
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
      sessionIdentity,
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

function buildTestSessionIdentity(
  sessionKey: string,
  agentId: string,
  endpoint: RuntimeEndpointRef = openClawTestRuntimeEndpoint,
): SessionIdentity {
  return {
    endpoint,
    agentId,
    sessionKey,
  };
}

function buildRuntimeEndpointSummary(input: {
  id: string;
  endpoint: RuntimeEndpointRef;
  protocolId?: string;
  runtimeAdapterId?: string;
  runtimeInstanceId?: string;
  connectorId?: string;
  displayName?: string;
  agentIds: string[];
  defaultAgentId: string;
  readiness?: RuntimeEndpointSummary['controlState']['readiness'];
}): RuntimeEndpointSummary {
  const defaultScope: AgentScope = {
    kind: 'agent',
    endpoint: input.endpoint,
    agentId: input.defaultAgentId,
  };
  return {
    id: input.id,
    protocolId: input.protocolId ?? 'openclaw-v4',
    ...(input.connectorId ? { connectorId: input.connectorId } : {}),
    ...(input.runtimeAdapterId ? { runtimeAdapterId: input.runtimeAdapterId } : {}),
    ...(input.runtimeInstanceId ? { runtimeInstanceId: input.runtimeInstanceId } : {}),
    endpointRef: input.endpoint,
    source: input.endpoint.kind === 'native-runtime'
      ? {
          kind: 'runtime-adapter',
          runtimeAdapterId: input.runtimeAdapterId ?? input.endpoint.runtimeAdapterId,
          runtimeInstanceId: input.runtimeInstanceId ?? input.endpoint.runtimeInstanceId,
        }
      : {
          kind: 'protocol-connector',
          protocolId: input.endpoint.protocolId,
          connectorId: input.endpoint.connectorId,
          endpointId: input.endpoint.endpointId,
        },
    location: { kind: 'local' },
    lifecycle: {
      phase: 'ready',
      connected: true,
      ready: true,
      updatedAt: 1,
    },
    displayName: input.displayName ?? input.id,
    agentIds: input.agentIds,
    defaultAgentId: input.defaultAgentId,
    agents: input.agentIds.map((agentId) => ({
      agentId,
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
    capabilitySummaries: input.agentIds.map((agentId) => ({
      id: 'session.prompt',
      scopeKind: 'agent' as const,
      scope: {
        ...defaultScope,
        agentId,
      },
      targetKinds: [],
      operations: [],
      availability: 'available' as const,
    })),
    controlState: {
      connection: null,
      readiness: input.readiness ?? {
        ready: true,
        phase: 'ready',
        requiredMethods: [],
        missingMethods: [],
        retryable: false,
      },
      capabilities: null,
      updatedAt: 1,
    },
  };
}

function buildNewSessionSnapshot(
  sessionKey: string,
  endpoint: RuntimeEndpointRef = openClawTestRuntimeEndpoint,
) {
  const agentId = sessionKey.split(':')[1] ?? 'main';
  return {
    sessionKey,
    catalog: {
      key: sessionKey,
      agentId,
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'openclaw-local',
      sessionIdentity: buildTestSessionIdentity(sessionKey, agentId, endpoint),
      kind: 'session' as const,
      preferred: false,
      displayName: sessionKey,
      updatedAt: 1,
    },
    items: [],
    approvals: [],
    usage: [],
    artifacts: [],
    replayComplete: true,
    runtime: {
      activeRunId: null,
      runPhase: 'idle' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      runtimeActivity: null,
      lastUserMessageAt: null,
      lastError: null,
      lastIssue: null,
      updatedAt: 1,
    },
    window: {
      totalItemCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    },
  };
}

describe('chat store newSession agent targeting', () => {
  const loadHistory = vi.fn().mockResolvedValue(undefined);
  const testSessionIdentity = createOpenClawTestSessionIdentity('agent:test:main', 'test');
  const mainSessionIdentity = createOpenClawTestSessionIdentity('agent:main:main', 'main');
  const testAgentScope = { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'test' };
  const mainAgentScope = { kind: 'agent' as const, endpoint: openClawTestRuntimeEndpoint, agentId: 'main' };
  const testRecordKey = buildSessionRecordKey(testSessionIdentity);
  const mainRecordKey = buildSessionRecordKey(mainSessionIdentity);

  beforeEach(() => {
    vi.restoreAllMocks();
    hostSessionNewMock.mockReset();
    hostRuntimeEndpointsListMock.mockReset();
    hostSessionListMock.mockReset();
    hostRuntimeEndpointsListMock.mockResolvedValue({ endpoints: [] });
    hostSessionListMock.mockResolvedValue({ ready: true, sessions: [] });
    hostSessionNewMock.mockImplementation(async (payload?: { agentId?: string; endpoint?: RuntimeEndpointRef }) => {
      const agentId = payload?.agentId ?? 'main';
      const sessionKey = `agent:${agentId}:session-${Date.now()}`;
      return {
        success: true,
        sessionKey,
        snapshot: buildNewSessionSnapshot(sessionKey, payload?.endpoint),
      };
    });
    loadHistory.mockClear();
    useChatStore.setState({
      foregroundHistorySessionKey: null,
      mutating: false,
      error: null,
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      currentSessionKey: testRecordKey,
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [{
          endpointId: 'openclaw-local',
          protocolId: 'openclaw-v4',
          runtimeAdapterId: 'openclaw',
          runtimeInstanceId: 'local',
          displayName: 'OpenClaw Local',
          endpoint: openClawTestRuntimeEndpoint,
          agentIds: ['main', 'test'],
          acceptsDynamicAgents: true,
          sessionPromptScopes: [mainAgentScope, testAgentScope],
          defaultSessionPromptScope: mainAgentScope,
        }],
        defaultSessionPromptScope: mainAgentScope,
      },
      loadedSessions: {
        [mainRecordKey]: buildSessionRecord({ sessionKey: 'agent:main:main' }),
        [testRecordKey]: buildSessionRecord({ sessionKey: 'agent:test:main' }),
      },
      showThinking: true,
      loadHistory,
    } as never);
  });

  it('新会话应继承当前选中 agent，而不是 sessions 首项 agent', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_711_111_111_111);

    await useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe(buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:test:session-1711111111111', 'test')));
    expect(hostSessionNewMock).toHaveBeenCalledWith({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'test',
    });
    expect(useChatStore.getState().loadedSessions[buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:test:session-1711111111111', 'test'))]?.meta.historyStatus).toBe('ready');
    nowSpy.mockRestore();
  });

  it('当前 session meta 缺少 agentId 时，应从 SessionIdentity 读取目标 agent', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_733_222_222_222);
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:test:main', 'runtime-owner');
    useChatStore.setState({
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        [testRecordKey]: buildSessionRecord({
          sessionKey: 'agent:test:main',
          meta: {
            agentId: null,
            sessionIdentity,
          },
        }),
      },
    } as never);

    await useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe(buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:runtime-owner:session-1733222222222', 'runtime-owner')));
    expect(hostSessionNewMock).toHaveBeenCalledWith({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'runtime-owner',
    });
    nowSpy.mockRestore();
  });

  it('显式传入 agentId 时，应强制创建到目标 agent 会话下', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_733_333_333_333);

    await useChatStore.getState().newSession('main');

    expect(useChatStore.getState().currentSessionKey).toBe(buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:main:session-1733333333333', 'main')));
    expect(hostSessionNewMock).toHaveBeenCalledWith({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    });
    nowSpy.mockRestore();
  });

  it('显式传入 AgentScope 时，应使用该 scope 的 endpoint 与 agentId 创建会话', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_733_444_444_444);
    const scopedEndpoint: RuntimeEndpointRef = {
      kind: 'protocol-connector',
      protocolId: 'matcha-test-protocol',
      connectorId: 'connector-a',
      endpointId: 'endpoint-a',
    };
    const scopedAgent: AgentScope = {
      kind: 'agent',
      endpoint: scopedEndpoint,
      agentId: 'scoped-agent',
    };

    await useChatStore.getState().newSessionForScope(scopedAgent);

    expect(useChatStore.getState().currentSessionKey).toBe(buildSessionRecordKey(buildTestSessionIdentity(
      'agent:scoped-agent:session-1733444444444',
      'scoped-agent',
      scopedEndpoint,
    )));
    expect(hostSessionNewMock).toHaveBeenCalledTimes(1);
    expect(hostSessionNewMock).toHaveBeenCalledWith({
      endpoint: scopedEndpoint,
      agentId: 'scoped-agent',
    });
    expect(hostSessionNewMock).not.toHaveBeenCalledWith({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    });
    nowSpy.mockRestore();
  });

  it('无当前会话 endpoint 时，应使用 catalog 显式默认 scope，而不是猜首个 runtime 的 main/default', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_733_555_555_555);
    const matchaEndpoint: RuntimeEndpointRef = {
      kind: 'native-runtime',
      runtimeAdapterId: 'matcha-agent',
      runtimeInstanceId: 'default',
    };
    const matchaDefaultScope: AgentScope = {
      kind: 'agent',
      endpoint: matchaEndpoint,
      agentId: 'matcha',
    };

    useChatStore.setState({
      currentSessionKey: '',
      loadedSessions: {},
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [
          {
            endpointId: 'openclaw-local',
            protocolId: 'openclaw-v4',
            runtimeAdapterId: 'openclaw',
            runtimeInstanceId: 'local',
            displayName: 'OpenClaw Local',
            endpoint: openClawTestRuntimeEndpoint,
            agentIds: ['main', 'test'],
            acceptsDynamicAgents: true,
            sessionPromptScopes: [mainAgentScope, testAgentScope],
            defaultSessionPromptScope: mainAgentScope,
          },
          {
            endpointId: 'matcha-agent-default',
            protocolId: 'matcha-agent',
            runtimeAdapterId: 'matcha-agent',
            runtimeInstanceId: 'default',
            displayName: 'Matcha Agent',
            endpoint: matchaEndpoint,
            agentIds: ['matcha'],
            acceptsDynamicAgents: false,
            sessionPromptScopes: [matchaDefaultScope],
            defaultSessionPromptScope: matchaDefaultScope,
          },
        ],
        defaultSessionPromptScope: matchaDefaultScope,
      },
    } as never);

    await useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe(buildSessionRecordKey(buildTestSessionIdentity(
      'agent:matcha:session-1733555555555',
      'matcha',
      matchaEndpoint,
    )));
    expect(hostSessionNewMock).toHaveBeenCalledTimes(1);
    expect(hostSessionNewMock).toHaveBeenCalledWith({
      endpoint: matchaEndpoint,
      agentId: 'matcha',
    });
    expect(hostSessionNewMock).not.toHaveBeenCalledWith({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    });
    nowSpy.mockRestore();
  });

  it('切换到其他 agent 会话时，应清理当前会话的发送态，避免跨会话锁死输入', () => {
    useChatStore.setState({
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        'agent:test:main': buildSessionRecord({
          runtime: {
            activeRunId: 'run-from-agent-test',
          },
        }),
      },
    } as never);

    useChatStore.getState().switchSession('agent:another:main');

    const state = useChatStore.getState();
    const runtime = state.loadedSessions['agent:another:main']?.runtime;
    expect(state.currentSessionKey).toBe('agent:another:main');
    expect(runtime?.activeRunId).toBeNull();
    expect(runtime?.runPhase).toBe('idle');
  });

  it('切回发送中的会话时，应立即恢复本地消息与等待态，避免出现空白页错觉', () => {
    const userMsg = {
      role: 'user' as const,
      content: '你好，先帮我分析下',
      timestamp: Date.now() / 1000,
      id: 'msg-local-1',
    };
    useChatStore.setState({
      currentSessionKey: 'agent:test:main',
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        'agent:test:main': buildSessionRecord({
          items: buildRenderItemsFromMessages('agent:test:main', [userMsg]),
          window: createViewportWindowState({
            totalItemCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            isAtLatest: true,
          }),
          runtime: {
            activeRunId: 'run-agent-test',
          },
        }),
      },
    } as never);

    useChatStore.getState().switchSession('agent:another:main');
    useChatStore.getState().switchSession('agent:test:main');

    const state = useChatStore.getState();
    const record = state.loadedSessions['agent:test:main'];
    expect(state.currentSessionKey).toBe('agent:test:main');
    expect(getSessionItems(state, 'agent:test:main')).toHaveLength(1);
    expect(record?.items[0]?.key).toContain('msg-local-1');
  });

  it('切换会话时，不应误删“messages 为空但已有历史痕迹”的会话', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-a',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:test:session-a': buildSessionRecord({
          meta: {
            label: '历史会话A',
            lastActivityAt: 1_713_000_000_000,
          },
        }),
        'agent:test:main': buildSessionRecord(),
      },
    } as never);

    useChatStore.getState().switchSession('agent:test:main');

    const state = useChatStore.getState();
    expect(state.sessionCatalogStatus.status).toBe('ready');
    expect(state.loadedSessions['agent:test:session-a']?.meta.label).toBe('历史会话A');
    expect(state.loadedSessions['agent:test:session-a']?.meta.lastActivityAt).toBe(1_713_000_000_000);
  });

  it('cleanupEmptySession 仅清理真正空会话（无消息/无标签/无活动）', () => {
    useChatStore.setState({
      currentSessionKey: 'agent:test:session-b',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:test:session-b': buildSessionRecord({
          meta: { label: 'B' },
        }),
        'agent:test:main': buildSessionRecord(),
      },
    } as never);

    useChatStore.getState().cleanupEmptySession();
    expect(useChatStore.getState().sessionCatalogStatus.status).toBe('ready');
    expect(useChatStore.getState().loadedSessions['agent:test:session-b']).toBeDefined();

    useChatStore.setState({
      currentSessionKey: 'agent:test:session-c',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:test:session-c': buildSessionRecord(),
        'agent:test:main': buildSessionRecord(),
      },
    } as never);

    useChatStore.getState().cleanupEmptySession();
    expect(useChatStore.getState().sessionCatalogStatus.status).toBe('ready');
    expect(useChatStore.getState().loadedSessions['agent:test:session-c']).toBeUndefined();
  });

  it('创建新会话时，应重置发送态，避免继承上一会话的等待状态', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_722_222_222_222);
    useChatStore.setState({
      loadedSessions: {
        ...useChatStore.getState().loadedSessions,
        [testRecordKey]: buildSessionRecord({
          sessionKey: 'agent:test:main',
          runtime: {
            activeRunId: 'run-from-agent-test',
          },
        }),
      },
    } as never);

    await useChatStore.getState().newSession();

    const state = useChatStore.getState();
    const runtime = state.loadedSessions[state.currentSessionKey]?.runtime;
    expect(state.currentSessionKey).toBe(buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:test:session-1722222222222', 'test')));
    expect(runtime?.activeRunId).toBeNull();
    expect(runtime?.runPhase).toBe('idle');
    nowSpy.mockRestore();
  });

  it('newSession 并发乱序 resolve 时，旧请求不得覆盖后一次选择', async () => {
    const firstCreate = createDeferred<ReturnType<typeof buildNewSessionSnapshot>>();
    const secondCreate = createDeferred<ReturnType<typeof buildNewSessionSnapshot>>();
    hostSessionNewMock
      .mockReturnValueOnce(firstCreate.promise.then((snapshot) => ({ success: true, sessionKey: snapshot.sessionKey, snapshot })))
      .mockReturnValueOnce(secondCreate.promise.then((snapshot) => ({ success: true, sessionKey: snapshot.sessionKey, snapshot })));

    const firstRequest = useChatStore.getState().newSession('test');
    const secondRequest = useChatStore.getState().newSession('main');
    const secondSnapshot = buildNewSessionSnapshot('agent:main:session-second');
    const firstSnapshot = buildNewSessionSnapshot('agent:test:session-first');
    const secondRecordKey = buildSessionRecordKey(secondSnapshot.catalog.sessionIdentity);
    const firstRecordKey = buildSessionRecordKey(firstSnapshot.catalog.sessionIdentity);

    secondCreate.resolve(secondSnapshot);
    await secondRequest;
    expect(useChatStore.getState().currentSessionKey).toBe(secondRecordKey);

    firstCreate.resolve(firstSnapshot);
    await firstRequest;

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe(secondRecordKey);
    expect(state.loadedSessions[secondRecordKey]).toBeDefined();
    expect(state.loadedSessions[firstRecordKey]).toBeDefined();
    expect(state.error).toBeNull();
    expect(state.mutating).toBe(false);
    expect(hostSessionNewMock).toHaveBeenNthCalledWith(1, {
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'test',
    });
    expect(hostSessionNewMock).toHaveBeenNthCalledWith(2, {
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    });
  });

  it('starting 的 OpenClaw endpoint 仍可作为新会话 target，terminal unavailable 则保持 endpoint unavailable 错误', async () => {
    const endpoint = buildRuntimeEndpointSummary({
      id: 'openclaw-local',
      endpoint: openClawTestRuntimeEndpoint,
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
      displayName: 'OpenClaw Local',
      agentIds: ['main'],
      defaultAgentId: 'main',
      readiness: {
        ready: false,
        phase: 'starting',
        requiredMethods: [],
        missingMethods: [],
        retryable: true,
      },
    });
    hostRuntimeEndpointsListMock.mockResolvedValueOnce({ endpoints: [endpoint] });

    await useChatStore.getState().bootstrapSessionRuntime();

    let catalog = useChatStore.getState().sessionRuntimeCatalog;
    expect(catalog.status).toBe('ready');
    expect(catalog.endpoints.map((target) => target.endpointId)).toEqual(['openclaw-local']);
    expect(catalog.defaultSessionPromptScope).toEqual({
      kind: 'agent',
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    });

    hostRuntimeEndpointsListMock.mockResolvedValueOnce({
      endpoints: [{
        ...endpoint,
        controlState: {
          ...endpoint.controlState,
          readiness: {
            ...endpoint.controlState.readiness!,
            phase: 'unavailable',
            retryable: false,
          },
        },
      }],
    });

    await useChatStore.getState().bootstrapSessionRuntime();

    catalog = useChatStore.getState().sessionRuntimeCatalog;
    expect(catalog.status).toBe('error');
    expect(catalog.endpoints).toEqual([]);
    expect(catalog.defaultSessionPromptScope).toBeNull();
    expect(catalog.error).toBe('No session runtime endpoint is available');
    expect(useChatStore.getState().error).toBe('No session runtime endpoint is available');
  });

  it('runtime catalog 并发乱序 resolve 时，旧响应不得覆盖新响应', async () => {
    const oldEndpoint: RuntimeEndpointRef = {
      kind: 'protocol-connector',
      protocolId: 'old-protocol',
      connectorId: 'old-connector',
      endpointId: 'old-endpoint',
    };
    const newEndpoint: RuntimeEndpointRef = {
      kind: 'protocol-connector',
      protocolId: 'new-protocol',
      connectorId: 'new-connector',
      endpointId: 'new-endpoint',
    };
    const oldLoad = createDeferred<{ endpoints: RuntimeEndpointSummary[] }>();
    const newLoad = createDeferred<{ endpoints: RuntimeEndpointSummary[] }>();
    hostRuntimeEndpointsListMock
      .mockReturnValueOnce(oldLoad.promise)
      .mockReturnValueOnce(newLoad.promise);
    useChatStore.setState({
      currentSessionKey: '',
      sessionRuntimeCatalog: {
        status: 'idle',
        error: null,
        endpoints: [],
        defaultSessionPromptScope: null,
      },
    } as never);

    const oldRequest = useChatStore.getState().bootstrapSessionRuntime();
    const newRequest = useChatStore.getState().bootstrapSessionRuntime();

    newLoad.resolve({
      endpoints: [buildRuntimeEndpointSummary({
        id: 'new-endpoint',
        endpoint: newEndpoint,
        protocolId: 'new-protocol',
        connectorId: 'new-connector',
        displayName: 'New Runtime',
        agentIds: ['new-agent'],
        defaultAgentId: 'new-agent',
      })],
    });
    await newRequest;
    expect(useChatStore.getState().sessionRuntimeCatalog.defaultSessionPromptScope).toEqual({
      kind: 'agent',
      endpoint: newEndpoint,
      agentId: 'new-agent',
    });

    oldLoad.resolve({
      endpoints: [buildRuntimeEndpointSummary({
        id: 'old-endpoint',
        endpoint: oldEndpoint,
        protocolId: 'old-protocol',
        connectorId: 'old-connector',
        displayName: 'Old Runtime',
        agentIds: ['old-agent'],
        defaultAgentId: 'old-agent',
      })],
    });
    await oldRequest;

    const catalog = useChatStore.getState().sessionRuntimeCatalog;
    expect(catalog.status).toBe('ready');
    expect(catalog.endpoints.map((endpoint) => endpoint.endpointId)).toEqual(['new-endpoint']);
    expect(catalog.defaultSessionPromptScope).toEqual({
      kind: 'agent',
      endpoint: newEndpoint,
      agentId: 'new-agent',
    });
  });

  it('旧 loadSessions 响应不得覆盖更新后的 currentSessionKey', async () => {
    const catalogLoad = createDeferred<{
      ready: boolean;
      sessions: Array<{
        key: string;
        agentId: string;
        sessionIdentity: SessionIdentity;
        kind: 'session';
        preferred: boolean;
        displayName: string;
        updatedAt: number;
      }>;
    }>();
    hostSessionListMock.mockReturnValueOnce(catalogLoad.promise);
    hostSessionNewMock.mockResolvedValueOnce({
      success: true,
      sessionKey: 'agent:main:session-newer',
      snapshot: buildNewSessionSnapshot('agent:main:session-newer'),
    });

    const loadRequest = useChatStore.getState().loadSessions();
    await useChatStore.getState().newSession('main');
    const newerRecordKey = buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:main:session-newer', 'main'));
    expect(useChatStore.getState().currentSessionKey).toBe(newerRecordKey);

    catalogLoad.resolve({
      ready: true,
      sessions: [{
        key: 'agent:main:main',
        agentId: 'main',
        sessionIdentity: mainSessionIdentity,
        kind: 'session',
        preferred: false,
        displayName: 'Old catalog main',
        updatedAt: 1,
      }],
    });
    await loadRequest;

    expect(useChatStore.getState().currentSessionKey).toBe(newerRecordKey);
  });

  it('runtime catalog loading 和错误不应清除用户已有 runtime 选择', async () => {
    const selectedEndpoint: RuntimeEndpointRef = {
      kind: 'protocol-connector',
      protocolId: 'selected-protocol',
      connectorId: 'selected-connector',
      endpointId: 'selected-endpoint',
    };
    const selectedScope: AgentScope = {
      kind: 'agent',
      endpoint: selectedEndpoint,
      agentId: 'selected-agent',
    };
    const loadingRequest = createDeferred<{ endpoints: RuntimeEndpointSummary[] }>();
    hostRuntimeEndpointsListMock.mockReturnValueOnce(loadingRequest.promise);
    useChatStore.setState({
      sessionRuntimeCatalog: {
        status: 'ready',
        error: null,
        endpoints: [buildRuntimeEndpointSummary({
          id: 'selected-endpoint',
          endpoint: selectedEndpoint,
          protocolId: 'selected-protocol',
          connectorId: 'selected-connector',
          displayName: 'Selected Runtime',
          agentIds: ['selected-agent'],
          defaultAgentId: 'selected-agent',
        })].map((endpoint) => ({
          endpointId: endpoint.id,
          protocolId: endpoint.protocolId,
          connectorId: endpoint.connectorId,
          displayName: endpoint.displayName,
          endpoint: endpoint.endpointRef,
          agentIds: endpoint.agentIds,
          acceptsDynamicAgents: endpoint.acceptsDynamicAgents,
          sessionPromptScopes: [selectedScope],
          defaultSessionPromptScope: selectedScope,
        })),
        defaultSessionPromptScope: selectedScope,
      },
    } as never);

    const request = useChatStore.getState().bootstrapSessionRuntime();
    expect(useChatStore.getState().sessionRuntimeCatalog.status).toBe('loading');
    expect(useChatStore.getState().sessionRuntimeCatalog.defaultSessionPromptScope).toBe(selectedScope);

    loadingRequest.reject(new Error('catalog failed'));
    await request;

    const catalog = useChatStore.getState().sessionRuntimeCatalog;
    expect(catalog.status).toBe('error');
    expect(catalog.error).toBe('catalog failed');
    expect(catalog.endpoints).toHaveLength(1);
    expect(catalog.defaultSessionPromptScope).toBe(selectedScope);
  });

  it('newSession 只写 loadedSessions 主链，不改写 session catalog status shell', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_744_444_444_444);

    await useChatStore.getState().newSession();

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe(buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:test:session-1744444444444', 'test')));
    expect(state.sessionCatalogStatus.status).toBe('ready');
    expect(state.loadedSessions[state.currentSessionKey]).toBeDefined();
    nowSpy.mockRestore();
  });
});
