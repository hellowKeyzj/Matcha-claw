import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chat';
import { useRuntimeEndpointsStore } from '@/stores/runtime-endpoints';
import { createEmptySessionRecord, getSessionItems } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRuntimeScopeKey, buildSessionRecordKey } from '@/stores/chat/session-identity';
import type { AgentScope, RuntimeEndpointRef, SessionIdentity } from '../../electron/desktop-contract/runtime-address';
import { completeFact, sessionView, windowView } from './helpers/session-fixtures';

const hostSessionNewMock = vi.fn();
const hostSessionListMock = vi.fn();
const hostSessionLoadMock = vi.fn();
const hostRuntimeEndpointsListMock = vi.fn();

const openClawTestRuntimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

function createOpenClawTestSessionIdentity(sessionKey: string, agentId: string): SessionIdentity {
  return { endpoint: openClawTestRuntimeEndpoint, agentId, sessionKey };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('@/lib/host-api', () => ({
  hostSessionNew: (...args: unknown[]) => hostSessionNewMock(...args),
  hostSessionList: (...args: unknown[]) => hostSessionListMock(...args),
  hostSessionApprovals: vi.fn(),
  hostSessionRespondApproval: vi.fn(),
  hostSessionDelete: vi.fn(),
  hostSessionLoad: (...args: unknown[]) => hostSessionLoadMock(...args),
  hostRuntimeEndpointsList: (...args: unknown[]) => hostRuntimeEndpointsListMock(...args),
  hostSessionWindowFetch: vi.fn(),
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

function buildCreateView(sessionKey: string, agentId = sessionKey.split(':')[1] ?? 'main') {
  return sessionView(sessionKey, {
    identity: createOpenClawTestSessionIdentity(sessionKey, agentId),
    items: completeFact([]),
    window: completeFact(windowView(0)),
  });
}

function buildEmptyTimeline(sessionKey = 'agent:main:main') {
  return buildCreateView(sessionKey);
}

function buildOpenClawEndpointSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 'openclaw-local',
    protocolId: 'openclaw-v4',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
    endpointRef: openClawTestRuntimeEndpoint,
    source: {
      kind: 'runtime-adapter' as const,
      runtimeAdapterId: 'openclaw',
      runtimeInstanceId: 'local',
    },
    location: { kind: 'local' as const },
    lifecycle: {
      phase: 'ready' as const,
      connected: true,
      ready: true,
      updatedAt: null,
    },
    displayName: 'OpenClaw Local',
    agentIds: ['main', 'test'],
    defaultAgentId: 'main',
    agents: ['main', 'test'].map((agentId) => ({
      agentId,
      source: 'discovered' as const,
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
      { family: 'session' as const, availability: 'supported' as const },
      { family: 'task' as const, availability: 'supported' as const },
      { family: 'subagent' as const, availability: 'supported' as const },
      { family: 'team' as const, availability: 'supported' as const },
      { family: 'cron' as const, availability: 'supported' as const },
      { family: 'workspace' as const, availability: 'supported' as const },
      { family: 'skill' as const, availability: 'supported' as const },
      { family: 'channel' as const, availability: 'supported' as const },
      { family: 'lifecycle' as const, availability: 'supported' as const },
    ],
    controlState: {
      connection: null,
      readiness: { ready: true, phase: 'ready' as const },
      capabilities: null,
      updatedAt: null,
    },
    ...overrides,
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
    hostSessionListMock.mockReset();
    hostSessionLoadMock.mockReset();
    hostRuntimeEndpointsListMock.mockReset();
    hostSessionListMock.mockResolvedValue({ ready: true, sessions: [] });
    hostSessionLoadMock.mockImplementation(async (payload?: { sessionKey?: string }) => {
      return buildEmptyTimeline(payload?.sessionKey);
    });
    hostRuntimeEndpointsListMock.mockResolvedValue({ endpoints: [buildOpenClawEndpointSummary()] });
    hostSessionNewMock.mockImplementation(async (payload?: { agentId?: string }) => {
      const agentId = payload?.agentId ?? 'main';
      return buildCreateView(`agent:${agentId}:session-${Date.now()}`, agentId);
    });
    loadHistory.mockClear();
    useRuntimeEndpointsStore.setState({
      status: 'idle',
      error: null,
      endpoints: [],
      hasLoadedOnce: false,
    });
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
          agentCatalog: {
            source: 'subagent-management',
            seedAgents: [{ id: 'main', name: 'main' }, { id: 'test', name: 'test' }],
          },
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

    const createdKey = buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:test:session-1711111111111', 'test'));
    expect(useChatStore.getState().currentSessionKey).toBe(createdKey);
    expect(hostSessionNewMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'test',
    }), expect.objectContaining({ traceId: null }));
    const createdRecord = useChatStore.getState().loadedSessions[createdKey];
    expect(createdRecord?.meta.sessionIdentity).toEqual(expect.objectContaining({
      sessionKey: 'agent:test:session-1711111111111',
      agentId: 'test',
    }));
    expect(createdRecord?.meta.historyStatus).toBe('ready');
    expect(createdRecord?.meta.lastActivityAt).toBeNull();
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
    expect(hostSessionNewMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'runtime-owner',
    }), expect.objectContaining({ traceId: null }));
    nowSpy.mockRestore();
  });

  it('显式传入 agentId 时，应强制创建到目标 agent 会话下', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_733_333_333_333);

    await useChatStore.getState().newSession('main');

    expect(useChatStore.getState().currentSessionKey).toBe(buildSessionRecordKey(createOpenClawTestSessionIdentity('agent:main:session-1733333333333', 'main')));
    expect(hostSessionNewMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    }), expect.objectContaining({ traceId: null }));
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

    hostSessionNewMock.mockResolvedValueOnce({ outcome: 'target_rejected' });

    await useChatStore.getState().newSession();

    expect(useChatStore.getState().currentSessionKey).toBe('');
    expect(useChatStore.getState().error).toBe('Session create target_rejected');
    expect(hostSessionNewMock).toHaveBeenCalledTimes(1);
    expect(hostSessionNewMock).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: matchaEndpoint,
      agentId: 'matcha',
    }), expect.objectContaining({ traceId: null }));
    expect(hostSessionNewMock).not.toHaveBeenCalledWith(expect.objectContaining({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    }));
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
        'agent:another:main': buildSessionRecord({ sessionKey: 'agent:another:main' }),
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
          items: [{
            key: 'msg-local-1',
            kind: 'user-message',
            role: 'user',
            sessionKey: 'agent:test:main',
            text: userMsg.content,
            images: [],
            attachedFiles: [],
            messageId: userMsg.id,
            createdAt: userMsg.timestamp,
          }],
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
        'agent:another:main': buildSessionRecord({ sessionKey: 'agent:another:main' }),
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
    expect(runtime?.runPhase).toBe('done');
    nowSpy.mockRestore();
  });

  it('newSession 并发乱序 resolve 时，旧请求不得覆盖后一次选择', async () => {
    const firstCreate = createDeferred<ReturnType<typeof buildCreateView>>();
    const secondCreate = createDeferred<ReturnType<typeof buildCreateView>>();
    hostSessionNewMock
      .mockReturnValueOnce(firstCreate.promise)
      .mockReturnValueOnce(secondCreate.promise);

    const firstRequest = useChatStore.getState().newSession('test');
    const secondRequest = useChatStore.getState().newSession('main');
    const secondOutcome = buildCreateView('agent:main:session-second');
    const firstOutcome = buildCreateView('agent:test:session-first');
    const secondRecordKey = buildSessionRecordKey(createOpenClawTestSessionIdentity(secondOutcome.sessionKey, 'main'));
    const firstRecordKey = buildSessionRecordKey(createOpenClawTestSessionIdentity(firstOutcome.sessionKey, 'test'));

    secondCreate.resolve(secondOutcome);
    await secondRequest;
    expect(useChatStore.getState().currentSessionKey).toBe(secondRecordKey);

    firstCreate.resolve(firstOutcome);
    await firstRequest;

    const state = useChatStore.getState();
    expect(state.currentSessionKey).toBe(secondRecordKey);
    expect(state.loadedSessions[secondRecordKey]).toBeDefined();
    expect(state.loadedSessions[firstRecordKey]).toBeDefined();
    expect(state.error).toBeNull();
    expect(state.mutating).toBe(false);
    expect(hostSessionNewMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'test',
    }), expect.objectContaining({ traceId: null }));
    expect(hostSessionNewMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      endpoint: openClawTestRuntimeEndpoint,
      agentId: 'main',
    }), expect.objectContaining({ traceId: null }));
  });

  it('keeps startup-only session endpoints in preparing state instead of showing no runtime', async () => {
    hostRuntimeEndpointsListMock.mockResolvedValue({
      endpoints: [buildOpenClawEndpointSummary({
        lifecycle: { phase: 'connecting', connected: true, ready: false, updatedAt: null },
      })],
    });

    await useChatStore.getState().bootstrapSessionRuntime();

    expect(useChatStore.getState().sessionRuntimeCatalog).toEqual(expect.objectContaining({
      status: 'loading',
      error: null,
      endpoints: [],
      defaultSessionPromptScope: null,
    }));
    expect(useChatStore.getState().error).toBeNull();
  });

  it('keeps Host API proxy startup failures in preparing state instead of showing no runtime', async () => {
    hostRuntimeEndpointsListMock.mockRejectedValueOnce(
      Object.assign(new Error('Host API request is unavailable.'), { code: 'UNAVAILABLE' }),
    );

    await useChatStore.getState().bootstrapSessionRuntime();

    expect(useChatStore.getState().sessionRuntimeCatalog).toEqual(expect.objectContaining({
      status: 'loading',
      error: null,
      endpoints: [],
      defaultSessionPromptScope: null,
    }));
    expect(useChatStore.getState().error).toBeNull();
  });

  it('bootstrapSessionRuntime loads ready runtime endpoint catalog', async () => {
    await useChatStore.getState().bootstrapSessionRuntime();

    expect(useChatStore.getState().sessionRuntimeCatalog).toEqual(expect.objectContaining({
      status: 'ready',
      error: null,
      endpoints: [expect.objectContaining({
        endpoint: openClawTestRuntimeEndpoint,
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        acceptsDynamicAgents: true,
      })],
      defaultSessionPromptScope: expect.objectContaining({
        endpoint: openClawTestRuntimeEndpoint,
        agentId: 'main',
      }),
    }));
    expect(useChatStore.getState().error).toBeNull();
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
    hostSessionNewMock.mockResolvedValueOnce(
      buildCreateView('agent:main:session-newer'),
    );

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
