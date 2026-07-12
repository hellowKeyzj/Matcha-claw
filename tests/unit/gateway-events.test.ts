import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawMessage } from './helpers/timeline-fixtures';
import { getSessionItems } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { SessionApprovalRequestItem, SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { buildSessionIdentityKey } from '../../runtime-host/shared/runtime-address';

const hostApiFetchMock = vi.fn();
const hostSessionAbortMock = vi.fn();
const subscribeHostEventMock = vi.fn();
const rendererTerminalDeliveryLogMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  hostFileThumbnail: (...args: unknown[]) => hostApiFetchMock(...args),
  hostSessionAbort: (...args: unknown[]) => hostSessionAbortMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

vi.mock('@/lib/debug-logging', () => ({
  logRendererMatchaTerminalDelivery: (...args: unknown[]) => rendererTerminalDeliveryLogMock(...args),
}));

function createTestEndpoint() {
  return {
    kind: 'native-runtime' as const,
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  };
}

function createTestSessionIdentity(sessionKey = 'agent:main:main') {
  return {
    endpoint: createTestEndpoint(),
    agentId: 'main',
    sessionKey,
  };
}

function createTestCatalog(sessionKey = 'agent:main:main') {
  return {
    key: sessionKey,
    agentId: 'main',
    protocolId: 'openclaw-v4',
    runtimeEndpointId: 'openclaw-local',
    sessionIdentity: createTestSessionIdentity(sessionKey),
    kind: 'main' as const,
    preferred: true,
    displayName: sessionKey,
  };
}

function createRunningGatewayStatus(updatedAt = 1) {
  return {
    processState: 'running' as const,
    port: 18789,
    gatewayReady: true,
    healthSummary: 'healthy' as const,
    transportState: 'connected' as const,
    portReachable: true,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    updatedAt,
  };
}

function createSessionRecord(input?: {
  messages?: RawMessage[];
  runtime?: Partial<{
    activeRunId: string | null;
    runPhase: 'idle' | 'submitted' | 'streaming' | 'waiting_tool' | 'done' | 'error' | 'aborted';
  }>;
}) {
  const messages = input?.messages ?? [];
  const items = buildRenderItemsFromMessages('agent:main:main', messages);
  return {
    meta: {
      label: null,
      lastActivityAt: null,
      historyStatus: 'ready' as const,
      thinkingLevel: null,
    },
    runtime: {
      activeRunId: input?.runtime?.activeRunId ?? null,
      runPhase: input?.runtime?.runPhase ?? 'idle' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      lastUserMessageAt: null,
    },
    items,
    window: createViewportWindowState({
      totalItemCount: items.length,
      windowStartOffset: 0,
      windowEndOffset: items.length,
      isAtLatest: true,
    }),
  };
}

function createSessionInfoUpdate(payload: {
  phase: 'started' | 'final' | 'error' | 'aborted' | 'unknown';
  runId?: string | null;
  sessionKey?: string | null;
  error?: string | null;
  approvals?: SessionApprovalRequestItem[];
}) {
  const sessionKey = payload.sessionKey ?? 'agent:main:main';
  return {
    sessionUpdate: 'session_info_update' as const,
    phase: payload.phase,
    runId: payload.runId ?? null,
    sessionKey: payload.sessionKey ?? null,
    error: payload.error ?? null,
    snapshot: {
      sessionKey,
      catalog: createTestCatalog(sessionKey),
      items: [],
      approvals: payload.approvals ?? [],
      usage: [],
      artifacts: [],
      replayComplete: true,
      runtime: {
        activeRunId: payload.phase === 'started' ? (payload.runId ?? null) : null,
        runPhase: payload.phase === 'started' ? 'submitted' : (
          payload.phase === 'final' ? 'done' : (
            payload.phase === 'error' ? 'error' : (
              payload.phase === 'aborted' ? 'aborted' : 'idle'
            )
          )
        ),
        activeTurnItemKey: null,
        pendingTurnKey: payload.phase === 'started' && payload.runId ? payload.runId : null,
        pendingTurnLaneKey: payload.phase === 'started' ? 'main' : null,
        lastUserMessageAt: null,
        lastError: payload.error ?? null,
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
    },
  };
}

function createSessionItemUpdate(payload: {
  sessionUpdate: 'session_item' | 'session_item_chunk';
  runId?: string | null;
  sessionKey?: string | null;
  sequenceId?: number;
  message: Record<string, unknown>;
}) {
  const sessionKey = payload.sessionKey ?? 'agent:main:main';
  const entryId = String(
    payload.message.id
    ?? payload.message.messageId
    ?? (
      payload.runId && payload.sequenceId != null
        ? `run:${payload.runId}:seq:${payload.sequenceId}`
        : `${payload.sessionUpdate}-entry`
    ),
  );
    const turnIdentity = String(
    payload.message.id
    ?? payload.message.messageId
    ?? payload.runId
    ?? 'turn',
  );
  const assistantToolCalls = Array.isArray(payload.message.content)
    ? payload.message.content
        .filter((item): item is { id?: string; name?: string; input?: unknown; type?: unknown } => Boolean(item) && typeof item === 'object')
        .flatMap((item) => item.type === 'toolCall'
          ? [{
              id: item.id ?? 'tool',
              name: item.name ?? 'tool',
              input: item.input,
            }]
          : [])
    : [];
  const isAssistant = payload.message.role === 'assistant';
  const assistantItemKey = `session:${payload.sessionKey ?? ''}|assistant-turn:main:${turnIdentity}`;
  const item: SessionRenderItem = isAssistant
    ? {
        key: assistantItemKey,
        kind: 'assistant-turn',
        sessionKey: payload.sessionKey ?? '',
        role: 'assistant',
        laneKey: 'main',
        turnKey: turnIdentity,
        identitySource: 'run',
        identityMode: 'run',
        identityConfidence: 'strong',
        status: payload.sessionUpdate === 'session_item_chunk'
          ? 'streaming'
          : 'final',
        segments: typeof payload.message.content === 'string'
          ? [{
              kind: 'message' as const,
              key: `${assistantItemKey}:message`,
              text: payload.message.content,
            }]
          : assistantToolCalls.map((tool) => ({
              kind: 'tool' as const,
              key: `${assistantItemKey}:tool:${tool.id}`,
              tool: {
                id: tool.id ?? 'tool',
                toolCallId: tool.id ?? 'tool',
                name: tool.name ?? 'tool',
                displayTitle: tool.name ?? 'tool',
                input: tool.input,
                status: 'running' as const,
                result: {
                  kind: 'none' as const,
                  surface: 'tool-card' as const,
                },
              },
            })),
        thinking: null,
        tools: assistantToolCalls.map((tool) => ({
          id: tool.id ?? 'tool',
          toolCallId: tool.id ?? 'tool',
          name: tool.name ?? 'tool',
          displayTitle: tool.name ?? 'tool',
          input: tool.input,
          status: 'running' as const,
          result: {
            kind: 'none' as const,
            surface: 'tool-card' as const,
          },
        })),
        embeddedToolResults: [],
        text: typeof payload.message.content === 'string' ? payload.message.content : '',
        images: [],
        attachedFiles: [],
        pendingState: payload.sessionUpdate === 'session_item_chunk' ? 'typing' : null,
        createdAt: 1,
        updatedAt: 1,
      }
    : {
        key: `session:${payload.sessionKey ?? ''}|entry:${entryId}`,
        kind: 'user-message',
        sessionKey: payload.sessionKey ?? '',
        role: 'user',
        text: typeof payload.message.content === 'string' ? payload.message.content : '',
        images: [],
        attachedFiles: [],
        messageId: entryId,
        createdAt: 1,
        updatedAt: 1,
      };
  return {
    sessionUpdate: payload.sessionUpdate,
    runId: payload.runId ?? null,
    sessionKey: payload.sessionKey ?? null,
    item,
    snapshot: {
      sessionKey,
      catalog: createTestCatalog(sessionKey),
      items: [item],
      approvals: [],
      usage: [],
      artifacts: [],
      replayComplete: true,
      runtime: {
        activeRunId: payload.runId ?? null,
        runPhase: payload.sessionUpdate === 'session_item_chunk' ? 'streaming' : 'done',
        activeTurnItemKey: payload.sessionUpdate === 'session_item_chunk' ? assistantItemKey : null,
        pendingTurnKey: isAssistant ? turnIdentity : null,
        pendingTurnLaneKey: isAssistant ? 'main' : null,
        lastUserMessageAt: null,
        updatedAt: 1,
      },
      window: {
        totalItemCount: 1,
        windowStartOffset: 0,
        windowEndOffset: 1,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
    },
  };
}

function createSessionPlanUpdate(payload: {
  runId?: string | null;
  sessionKey?: string | null;
  items?: SessionRenderItem[];
}) {
  const sessionKey = payload.sessionKey ?? 'agent:main:main';
  const items = payload.items ?? [];
  return {
    sessionUpdate: 'plan' as const,
    runId: payload.runId ?? null,
    sessionKey: payload.sessionKey ?? null,
    taskSnapshot: {
      sessionKey,
      source: 'todo' as const,
      tasks: [],
      todos: [
        { content: '分析页面结构', status: 'completed' as const },
      ],
    },
    snapshot: {
      sessionKey,
      catalog: createTestCatalog(sessionKey),
      items,
      approvals: [],
      usage: [],
      artifacts: [],
      replayComplete: true,
      runtime: {
        activeRunId: null,
        runPhase: 'done' as const,
        activeTurnItemKey: null,
        pendingTurnKey: null,
        pendingTurnLaneKey: null,
        lastUserMessageAt: null,
        lastError: null,
        lastIssue: null,
        updatedAt: 1,
      },
      window: {
        totalItemCount: items.length,
        windowStartOffset: 0,
        windowEndOffset: items.length,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
    },
  };
}

describe('gateway store event wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    hostSessionAbortMock.mockReset();
    rendererTerminalDeliveryLogMock.mockReset();
  });

  it('subscribes to host events through subscribeHostEvent on init', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      processState: 'running',
      port: 18789,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 1,
    });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('session:update', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('task:snapshot', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:restart', expect.any(Function));

    handlers.get('gateway:status')?.({
      processState: 'stopped',
      port: 18789,
      gatewayReady: false,
      healthSummary: 'unresponsive',
      transportState: 'disconnected',
      portReachable: false,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 2,
    });
    expect(useGatewayStore.getState().status.processState).toBe('stopped');
  });

  it('gateway:status 事件直接同步统一 gateway 快照', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      processState: 'running',
      port: 18789,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 1,
    });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:status')?.({
      processState: 'running',
      port: 18789,
      transportState: 'disconnected',
      healthSummary: 'unresponsive',
      lastError: 'socket closed',
      gatewayReady: false,
      portReachable: false,
      diagnostics: { consecutiveHeartbeatMisses: 1, consecutiveRpcFailures: 0 },
      updatedAt: 2,
    });

    let state = useGatewayStore.getState().status;
    expect(state.transportState).toBe('disconnected');
    expect(state.healthSummary).toBe('unresponsive');
    expect(state.lastError).toBe('socket closed');

    handlers.get('gateway:status')?.({
      processState: 'running',
      port: 18789,
      transportState: 'connected',
      healthSummary: 'healthy',
      gatewayReady: true,
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 3,
    });

    state = useGatewayStore.getState().status;
    expect(state.transportState).toBe('connected');
    expect(state.healthSummary).toBe('healthy');
  });

  it('gateway:error 事件会把结构化 transport issue 写回 gateway store', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:error')?.({
      message: 'Gateway socket closed: code=1006 reason=network down',
      issue: {
        message: 'Gateway socket closed: code=1006 reason=network down',
        source: 'socket-close',
        at: 123,
        code: '1006',
        details: { reason: 'network down' },
      },
    });

    const state = useGatewayStore.getState().status;
    expect(state.lastError).toBe('Gateway socket closed: code=1006 reason=network down');
    expect(state.lastIssue).toMatchObject({
      source: 'socket-close',
      code: '1006',
      details: { reason: 'network down' },
    });
  });

  it('runtime-host 事件会更新 renderer 侧运行时状态', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      processState: 'running',
      port: 18789,
      gatewayReady: true,
      healthSummary: 'healthy',
      transportState: 'connected',
      portReachable: true,
      diagnostics: { consecutiveHeartbeatMisses: 0, consecutiveRpcFailures: 0 },
      updatedAt: 1,
    });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('runtime-host:status')?.({
      status: 'degraded',
      pid: 4321,
      error: 'health check failed',
      updatedAt: 1001,
    });
    handlers.get('runtime-host:restart')?.({
      previousPid: 4321,
      pid: 6789,
      recoveredAt: 1002,
    });
    handlers.get('runtime-host:error')?.({
      status: 'error',
      message: 'runtime-host crashed',
      updatedAt: 1003,
    });

    const state = useGatewayStore.getState().runtimeHost;
    expect(state.lifecycle).toBe('error');
    expect(state.pid).toBe(6789);
    expect(state.error).toBe('runtime-host crashed');
    expect(state.restartCount).toBe(1);
    expect(state.lastRestartAt).toBe(1002);
    expect(state.updatedAt).toBe(1003);
  });

  it('runtime-host 恢复运行或重启完成后会清理过渡错误', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('runtime-host:error')?.({
      status: 'degraded',
      message: 'Runtime-host transport health failed: fetch failed',
      updatedAt: 1001,
    });
    expect(useGatewayStore.getState().runtimeHost.error).toBe('Runtime-host transport health failed: fetch failed');

    handlers.get('runtime-host:status')?.({
      status: 'restarting',
      updatedAt: 1002,
    });
    expect(useGatewayStore.getState().runtimeHost.lifecycle).toBe('restarting');
    expect(useGatewayStore.getState().runtimeHost.error).toBeUndefined();

    handlers.get('runtime-host:error')?.({
      status: 'degraded',
      message: 'Runtime-host transport health failed: fetch failed',
      updatedAt: 1003,
    });
    handlers.get('runtime-host:restart')?.({
      pid: 6789,
      recoveredAt: 1004,
    });

    const state = useGatewayStore.getState().runtimeHost;
    expect(state.lifecycle).toBe('running');
    expect(state.error).toBeUndefined();
    expect(state.pid).toBe(6789);
  });

  it('forwards exec.approval.requested/resolved notifications into chat approval state', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord(),
      },
      pendingApprovalsBySession: {},
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'unknown',
      runId: 'run-evt-1',
      sessionKey: 'agent:main:main',
      approvals: [{
        id: 'approval-evt-1',
        sessionKey: 'agent:main:main',
        sessionIdentity: createTestSessionIdentity('agent:main:main'),
        runId: 'run-evt-1',
        title: 'gateway',
        command: 'Remove-Item demo.txt',
        allowedDecisions: ['allow-once', 'deny'],
        createdAtMs: 1,
      }],
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    let chatState = useChatStore.getState();
    expect(chatState.loadedSessions['agent:main:main']?.runtime.runPhase).toBe('idle');
    expect(chatState.pendingApprovalsBySession['agent:main:main']?.map((item) => item.id)).toEqual([
      'approval-evt-1',
    ]);
    expect(chatState.pendingApprovalsBySession['agent:main:main']?.[0]).toMatchObject({
      title: 'gateway',
      command: 'Remove-Item demo.txt',
      allowedDecisions: ['allow-once', 'deny'],
    });

    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'unknown',
      runId: 'run-evt-1',
      sessionKey: 'agent:main:main',
      approvals: [],
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    chatState = useChatStore.getState();
    expect(chatState.loadedSessions['agent:main:main']?.runtime.runPhase).toBe('idle');
    expect(chatState.pendingApprovalsBySession['agent:main:main'] ?? []).toEqual([]);
  });

  it('session_info_update unknown phase keeps active run state', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-active',
            runPhase: 'waiting_tool',
          },
        }),
      },
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'unknown',
      runId: 'run-active',
      sessionKey: 'agent:main:main',
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const runtime = useChatStore.getState().loadedSessions['agent:main:main']?.runtime;
    expect(runtime?.activeRunId).toBe('run-active');
    expect(runtime?.runPhase).toBe('waiting_tool');
  });

  it('run.phase completed 事件应清理 chat.send 超时残留错误', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-cleanup',
          },
        }),
      },
      error: 'RPC timeout: chat.send',
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'final',
      runId: 'run-cleanup',
      sessionKey: 'agent:main:main',
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:main:main']?.runtime.activeRunId).toBeNull();
    expect(state.loadedSessions['agent:main:main']?.runtime.lastError).toBeNull();
  });

  it('session_info_update applies the authoritative terminal snapshot even when the local activeRunId is stale', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-local-stale',
            runPhase: 'streaming',
          },
        }),
      },
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'final',
      runId: 'run-runtime-authoritative',
      sessionKey: 'agent:main:main',
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const runtime = useChatStore.getState().loadedSessions['agent:main:main']?.runtime;
    expect(runtime?.activeRunId).toBeNull();
    expect(runtime?.runPhase).toBe('done');
  });

  it('records terminal delivery receipt and target-session active-to-inactive application', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: { activeRunId: 'run-current', runPhase: 'streaming' },
        }),
        'agent:other:main': createSessionRecord({
          runtime: { activeRunId: 'run-target', runPhase: 'streaming' },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.({
      ...createSessionInfoUpdate({
        phase: 'final',
        runId: 'run-target',
        sessionKey: 'agent:other:main',
      }),
      _meta: {
        matchaTerminalDelivery: {
          bridgeTraceId: 'matcha-bridge-1',
          runTraceId: 'matcha-run-1',
          eventClass: 'terminal' as const,
          terminalPhase: 'final' as const,
        },
      },
    });

    expect(rendererTerminalDeliveryLogMock).toHaveBeenCalledWith('renderer_event_received', {
      bridgeTraceId: 'matcha-bridge-1',
      runTraceId: 'matcha-run-1',
      eventClass: 'terminal',
      terminalPhase: 'final',
      snapshotActiveRunIdIsNull: true,
    });
    expect(rendererTerminalDeliveryLogMock).toHaveBeenCalledWith('renderer_event_applied', {
      bridgeTraceId: 'matcha-bridge-1',
      runTraceId: 'matcha-run-1',
      eventClass: 'terminal',
      terminalPhase: 'final',
      runtimeActiveToInactive: true,
      runtimeInactive: true,
    });
  });

  it('records rejected terminal delivery when the renderer handler throws', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: { activeRunId: 'run-rejected', runPhase: 'streaming' },
        }),
      },
      handleSessionUpdateEvent: () => {
        throw new TypeError('renderer handler rejected terminal delivery');
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.({
      ...createSessionInfoUpdate({
        phase: 'error',
        runId: 'run-rejected',
        sessionKey: 'agent:main:main',
      }),
      _meta: {
        matchaTerminalDelivery: {
          bridgeTraceId: 'matcha-bridge-2',
          runTraceId: 'matcha-run-2',
          eventClass: 'terminal' as const,
          terminalPhase: 'error' as const,
        },
      },
    });

    expect(rendererTerminalDeliveryLogMock).toHaveBeenCalledWith('renderer_event_rejected', {
      bridgeTraceId: 'matcha-bridge-2',
      runTraceId: 'matcha-run-2',
      eventClass: 'terminal',
      terminalPhase: 'error',
      errorCategory: 'error',
    });
  });

  it('records terminal trace shape rejection without exposing the malformed payload', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.({
      _meta: {
        matchaTerminalDelivery: {
          bridgeTraceId: 'matcha-bridge-3',
          runTraceId: 'matcha-run-3',
          eventClass: 'terminal' as const,
          terminalPhase: 'aborted' as const,
        },
      },
    });

    expect(rendererTerminalDeliveryLogMock).toHaveBeenCalledWith('renderer_event_rejected_shape', {
      bridgeTraceId: 'matcha-bridge-3',
      runTraceId: 'matcha-run-3',
      eventClass: 'terminal',
      terminalPhase: 'aborted',
    });
  });

  it('run.phase error 事件应写入当前 session runtime.lastError', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-error-1',
          },
        }),
      },
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'error',
      runId: 'run-error-1',
      sessionKey: 'agent:main:main',
      error: 'model unavailable',
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    const state = useChatStore.getState();
    expect(state.loadedSessions['agent:main:main']?.runtime.runPhase).toBe('error');
    expect(state.loadedSessions['agent:main:main']?.runtime.lastError).toBe('model unavailable');
  });

  it('session_item_chunk patches only the affected session identity index entry', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const sessionIdentity = createTestSessionIdentity('agent:main:main');
    const identityKey = buildSessionIdentityKey(sessionIdentity);
    const initialIndex = { [identityKey]: 'agent:main:main' };
    const initialRecord = createSessionRecord();
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': {
          ...initialRecord,
          meta: {
            ...initialRecord.meta,
            backendSessionKey: 'agent:main:main',
            runtimeScopeKey: null,
            agentId: 'main',
            protocolId: 'openclaw-v4',
            runtimeEndpointId: 'openclaw-local',
            sessionIdentity,
            kind: 'main',
            preferred: true,
            displayName: 'agent:main:main',
            model: null,
          },
        },
      },
      sessionRecordKeyByIdentityKey: initialIndex,
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item_chunk',
      runId: 'run-delta-index-1',
      sessionKey: 'agent:main:main',
      sequenceId: 1,
      message: {
        role: 'assistant',
        content: 'hello timeline',
      },
    }));

    const state = useChatStore.getState();
    expect(state.sessionRecordKeyByIdentityKey).toBe(initialIndex);
    expect(state.sessionRecordKeyByIdentityKey[identityKey]).toBe('agent:main:main');
  });

  it('structured session:update delta 会直接驱动 chat store 写入 streaming assistant turn', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-delta-direct-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item_chunk',
      runId: 'run-delta-direct-1',
      sessionKey: 'agent:main:main',
      sequenceId: 1,
      message: {
        role: 'assistant',
        content: 'hello timeline',
      },
    }));

    const state = useChatStore.getState();
    expect(getSessionItems(state, 'agent:main:main')).toMatchObject([{
      kind: 'assistant-turn',
      text: 'hello timeline',
      status: 'streaming',
      laneKey: 'main',
      turnKey: 'run-delta-direct-1',
    }]);
  });

  it('structured session:update 会按 event.sessionKey 写入对应 session，而不是 currentSessionKey', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord(),
        'agent:other:main': createSessionRecord(),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item_chunk',
      runId: 'run-other-1',
      sessionKey: 'agent:other:main',
      sequenceId: 1,
      message: {
        role: 'assistant',
        content: 'hello other session',
      },
    }));

    const state = useChatStore.getState();
    expect(getSessionItems(state, 'agent:main:main')).toEqual([]);
    expect(getSessionItems(state, 'agent:other:main')).toMatchObject([{
      kind: 'assistant-turn',
      text: 'hello other session',
    }]);
  });

  it('structured session:update tool delta 即使 sequenceId 不是从 1 开始，也会立即写入 assistant turn 供工具卡片渲染', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-tool-direct-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item_chunk',
      runId: 'run-tool-direct-1',
      sessionKey: 'agent:main:main',
      sequenceId: 8,
      message: {
        role: 'assistant',
        id: 'run:run-tool-direct-1:tool:tool-1',
        content: [{
          type: 'toolCall',
          id: 'tool-1',
          name: 'memory_store',
          input: { text: '记住偏好' },
        }],
      },
    }));

    const state = useChatStore.getState();
    const [item] = getSessionItems(state, 'agent:main:main');
    expect(item).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'run:run-tool-direct-1:tool:tool-1',
      tools: [{
        toolCallId: 'tool-1',
        name: 'memory_store',
        status: 'running',
      }],
    });
  });

  it('terminal assistant updates do not trigger renderer-side tool result reconciliation', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-tool-reconcile-1',
            runPhase: 'streaming',
          },
        }),
      },
      loadHistory: loadHistoryMock,
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item_chunk',
      runId: 'run-tool-reconcile-1',
      sessionKey: 'agent:main:main',
      sequenceId: 1,
      message: {
        role: 'assistant',
        id: 'run:run-tool-reconcile-1:tool:tool-1',
        content: [{
          type: 'toolCall',
          id: 'tool-1',
          name: 'Read',
          input: { file_path: 'demo.txt' },
        }],
      },
    }));

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-tool-reconcile-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-tool-1',
        content: 'done',
      },
    }));
    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'final',
      runId: 'run-tool-reconcile-1',
      sessionKey: 'agent:main:main',
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(loadHistoryMock).not.toHaveBeenCalled();
  });

  it('plan session:update applies authoritative snapshot to clear stale visible tool cards', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-todo-plan-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item_chunk',
      runId: 'run-todo-plan-1',
      sessionKey: 'agent:main:main',
      sequenceId: 8,
      message: {
        role: 'assistant',
        id: 'run:run-todo-plan-1:tool:todo-write-1',
        content: [{
          type: 'toolCall',
          id: 'todo-write-1',
          name: 'TodoWrite',
          input: {
            newTodos: [
              { content: '分析页面结构', status: 'completed' },
            ],
          },
        }],
      },
    }));

    expect(getSessionItems(useChatStore.getState(), 'agent:main:main')).toHaveLength(1);

    handlers.get('session:update')?.(createSessionPlanUpdate({
      runId: 'run-todo-plan-1',
      sessionKey: 'agent:main:main',
      items: [],
    }));

    expect(getSessionItems(useChatStore.getState(), 'agent:main:main')).toEqual([]);
  });

  it('session_item final applies authoritative snapshot even when compaction leaves local activeRunId stale', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-before-compaction',
            runPhase: 'streaming',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-after-compaction',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-after-compaction',
        content: 'compaction finished response',
      },
    }));

    const state = useChatStore.getState();
    expect(getSessionItems(state, 'agent:main:main')).toMatchObject([{
      kind: 'assistant-turn',
      text: 'compaction finished response',
      status: 'final',
    }]);
    expect(state.loadedSessions['agent:main:main']?.runtime).toMatchObject({
      activeRunId: 'run-after-compaction',
      runPhase: 'done',
    });
  });

  it('plan session:update applies authoritative snapshot even when compaction leaves local activeRunId stale', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-before-compaction-plan',
            runPhase: 'streaming',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionPlanUpdate({
      runId: 'run-after-compaction-plan',
      sessionKey: 'agent:main:main',
      items: [],
    }));

    const state = useChatStore.getState();
    expect(getSessionItems(state, 'agent:main:main')).toEqual([]);
    expect(state.loadedSessions['agent:main:main']?.runtime).toMatchObject({
      activeRunId: null,
      runPhase: 'done',
    });
  });

  it('run.phase completed 只应进入单一 session update 入口', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const handleSessionUpdateEventMock = vi.fn();
    useChatStore.setState({
      handleSessionUpdateEvent: handleSessionUpdateEventMock,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord(),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionInfoUpdate({
      phase: 'final',
      runId: 'run-lifecycle-1',
      sessionKey: 'agent:main:main',
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(1);
    expect(handleSessionUpdateEventMock).toHaveBeenCalledWith(createSessionInfoUpdate({
      phase: 'final',
      runId: 'run-lifecycle-1',
      sessionKey: 'agent:main:main',
    }));
  });

  it('agent 通知与 conversation chat.message 同时到达时，不应重复转发到 chat store', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const handleSessionUpdateEventMock = vi.fn();
    useChatStore.setState({
      handleSessionUpdateEvent: handleSessionUpdateEventMock,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord(),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-1',
        messageId: 'assistant-final-1',
        content: 'hello',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(1);
    expect(handleSessionUpdateEventMock).toHaveBeenCalledWith(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        id: 'assistant-final-1',
        messageId: 'assistant-final-1',
        content: 'hello',
      },
    }));
  });

  it('非结构化 session:update 载荷应直接忽略（不再 renderer 侧兜底归一化）', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const handleSessionUpdateEventMock = vi.fn();
    useChatStore.setState({
      handleSessionUpdateEvent: handleSessionUpdateEventMock,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-non-structured',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.({
      message: {
        role: 'assistant',
        content: 'legacy payload without state',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).not.toHaveBeenCalled();
  });

  it('legacy chat 与结构化 final 同时到达时，应只消费结构化 final', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const handleSessionUpdateEventMock = vi.fn();
    useChatStore.setState({
      handleSessionUpdateEvent: handleSessionUpdateEventMock,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-legacy-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.({
      type: 'chat.message',
      event: {
        role: 'assistant',
        content: '[[reply_to_current]]你好呀！有什么想让我帮你做的吗?',
      },
    });
    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-legacy-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '你好呀！有什么想让我帮你做的吗?',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(1);
    expect(handleSessionUpdateEventMock).toHaveBeenLastCalledWith(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-legacy-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '你好呀！有什么想让我帮你做的吗?',
      },
    }));
  });

  it('user legacy metadata 与结构化 final 同时到达时，应只消费结构化 final', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const handleSessionUpdateEventMock = vi.fn();
    useChatStore.setState({
      handleSessionUpdateEvent: handleSessionUpdateEventMock,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-user-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.({
      type: 'chat.message',
      event: {
        role: 'user',
        content: '[Tue 2026-04-14 20:11 GMT+8]你好',
      },
    });
    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-user-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'user',
        content: '你好',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(1);
    expect(handleSessionUpdateEventMock).toHaveBeenLastCalledWith(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-user-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'user',
        content: '你好',
      },
    }));
  });

  it('assistant legacy 与结构化 final 同时到达时，应只消费结构化 final', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    const handleSessionUpdateEventMock = vi.fn();
    useChatStore.setState({
      handleSessionUpdateEvent: handleSessionUpdateEventMock,
      loadHistory: vi.fn().mockResolvedValue(undefined),
      loadSessions: vi.fn().mockResolvedValue(undefined),
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          runtime: {
            activeRunId: 'run-assistant-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.({
      type: 'chat.message',
      event: {
        role: 'assistant',
        content: '我能做的事情挺多，  简单说：\n\n- 回答问题，陪你聊天',
      },
    });
    handlers.get('session:update')?.(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-assistant-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '我能做的事情挺多，简单说： - 回答问题，陪你聊天',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(1);
    expect(handleSessionUpdateEventMock).toHaveBeenLastCalledWith(createSessionItemUpdate({
      sessionUpdate: 'session_item',
      runId: 'run-assistant-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '我能做的事情挺多，简单说： - 回答问题，陪你聊天',
      },
    }));
  });

  it('structured session:update media attachments reuse missing preview hydration', async () => {
    hostApiFetchMock
      .mockResolvedValueOnce(createRunningGatewayStatus())
      .mockResolvedValueOnce({
        preview: 'data:image/png;base64,abc',
        fileSize: 123,
      });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useChatStore } = await import('@/stores/chat');
    useChatStore.setState({
      currentSessionKey: 'agent:main:main',
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord(),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    const item: SessionRenderItem = {
      key: 'session:agent:main:main|assistant-turn:main:assistant-media-1',
      kind: 'assistant-turn',
      sessionKey: 'agent:main:main',
      role: 'assistant',
      laneKey: 'main',
      turnKey: 'assistant-media-1',
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [{
        kind: 'media',
        key: 'media:assistant-media-1',
        images: [],
        attachedFiles: [{
          fileName: 'artifact.png',
          mimeType: 'image/png',
          fileSize: 0,
          preview: null,
          gatewayUrl: '/api/chat/media/outgoing/agent%3Amain%3Amain/attachment-1/full',
          source: 'tool-result',
        }],
      }],
      thinking: null,
      tools: [],
      embeddedToolResults: [],
      text: '',
      images: [],
      attachedFiles: [{
        fileName: 'artifact.png',
        mimeType: 'image/png',
        fileSize: 0,
        preview: null,
        gatewayUrl: '/api/chat/media/outgoing/agent%3Amain%3Amain/attachment-1/full',
        source: 'tool-result',
      }],
      pendingState: null,
      createdAt: 1,
      updatedAt: 1,
    };

    handlers.get('session:update')?.({
      sessionUpdate: 'session_item',
      runId: 'run-media-1',
      sessionKey: 'agent:main:main',
      item,
      snapshot: {
        sessionKey: 'agent:main:main',
        catalog: createTestCatalog('agent:main:main'),
        items: [item],
        approvals: [],
        usage: [],
        artifacts: [],
        replayComplete: true,
        runtime: {
          activeRunId: null,
          runPhase: 'done' as const,
          activeTurnItemKey: null,
          pendingTurnKey: null,
          pendingTurnLaneKey: null,
          lastUserMessageAt: null,
          lastError: null,
          lastIssue: null,
          updatedAt: 1,
        },
        window: {
          totalItemCount: 1,
          windowStartOffset: 0,
          windowEndOffset: 1,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(hostApiFetchMock).toHaveBeenCalledWith({
      path: '/api/chat/media/outgoing/agent%3Amain%3Amain/attachment-1/full',
      mimeType: 'image/png',
      sessionIdentity: createTestSessionIdentity('agent:main:main'),
      workspaceId: undefined,
      sourceId: undefined,
    });
    expect(getSessionItems(useChatStore.getState(), 'agent:main:main')).toMatchObject([{
      kind: 'assistant-turn',
      segments: [{
        kind: 'media',
        attachedFiles: [{
          preview: 'data:image/png;base64,abc',
          fileSize: 123,
        }],
      }],
      attachedFiles: [{
        preview: 'data:image/png;base64,abc',
        fileSize: 123,
      }],
    }]);
  });

  it('task:snapshot 事件会实时写入 task snapshot store', async () => {
    hostApiFetchMock.mockResolvedValueOnce(createRunningGatewayStatus());
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    const { useTaskSnapshotStore } = await import('@/stores/chat/task-snapshot-store');
    await useGatewayStore.getState().init();

    handlers.get('task:snapshot')?.({
      sessionKey: 'agent:main:main',
      tasks: [],
      todos: [
        { content: '分析页面结构', status: 'completed' },
        { content: '实现任务状态', status: 'completed' },
      ],
      source: 'todo',
    });

    expect(useTaskSnapshotStore.getState().getTaskDataList('agent:main:main')).toEqual([
      expect.objectContaining({ subject: '分析页面结构', status: 'completed' }),
      expect.objectContaining({ subject: '实现任务状态', status: 'completed' }),
    ]);
  });
});
