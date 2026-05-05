import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawMessage } from './helpers/timeline-fixtures';
import { getSessionItems } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';

const hostApiFetchMock = vi.fn();
const subscribeHostEventMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/host-events', () => ({
  subscribeHostEvent: (...args: unknown[]) => subscribeHostEventMock(...args),
}));

function createSessionRecord(input?: {
  messages?: RawMessage[];
  runtime?: Partial<{
    sending: boolean;
    activeRunId: string | null;
    pendingFinal: boolean;
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
      sending: input?.runtime?.sending ?? false,
      activeRunId: input?.runtime?.activeRunId ?? null,
      runPhase: 'idle' as const,
      pendingFinal: input?.runtime?.pendingFinal ?? false,
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
}) {
  const sessionKey = payload.sessionKey ?? 'agent:main:main';
  return {
    sessionUpdate: 'session_info_update' as const,
    phase: payload.phase,
    runId: payload.runId ?? null,
    sessionKey: payload.sessionKey ?? null,
    snapshot: {
      sessionKey,
      catalog: {
        key: sessionKey,
        agentId: 'main',
        kind: 'main' as const,
        preferred: true,
        displayName: sessionKey,
      },
      items: [],
      replayComplete: true,
      runtime: {
        sending: payload.phase === 'started',
        activeRunId: payload.phase === 'started' ? (payload.runId ?? null) : null,
        runPhase: payload.phase === 'started' ? 'submitted' : (
          payload.phase === 'final' ? 'done' : (
            payload.phase === 'error' ? 'error' : (
              payload.phase === 'aborted' ? 'aborted' : 'idle'
            )
          )
        ),
        activeTurnItemKey: null,
        pendingTurnKey: payload.phase === 'started' && payload.runId ? `main:${payload.runId}` : null,
        pendingTurnLaneKey: payload.phase === 'started' ? 'main' : null,
        pendingFinal: false,
        lastUserMessageAt: null,
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

function createSessionMessageUpdate(payload: {
  kind: 'agent_message' | 'agent_message_chunk';
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
        : `${payload.kind}-entry`
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
  const assistantItemKey = `session:${payload.sessionKey ?? ''}|assistant-turn:main:${turnIdentity}:main`;
  const item: SessionRenderItem = isAssistant
    ? {
        key: assistantItemKey,
        kind: 'assistant-turn',
        sessionKey: payload.sessionKey ?? '',
        role: 'assistant',
        laneKey: 'main',
        turnKey: `main:${turnIdentity}`,
        status: payload.kind === 'agent_message_chunk'
          ? 'streaming'
          : 'final',
        text: typeof payload.message.content === 'string' ? payload.message.content : '',
        thinking: null,
        toolCalls: assistantToolCalls,
        toolStatuses: Array.isArray(payload.message.toolStatuses) ? payload.message.toolStatuses as never[] : [],
        images: [],
        attachedFiles: [],
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
    sessionUpdate: payload.kind === 'agent_message_chunk' ? 'session_item_chunk' : 'session_item',
    runId: payload.runId ?? null,
    sessionKey: payload.sessionKey ?? null,
    item,
    snapshot: {
      sessionKey,
      catalog: {
        key: sessionKey,
        agentId: 'main',
        kind: 'main' as const,
        preferred: true,
        displayName: sessionKey,
      },
      items: [item],
      replayComplete: true,
      runtime: {
        sending: payload.kind === 'agent_message_chunk',
        activeRunId: payload.runId ?? null,
        runPhase: payload.kind === 'agent_message_chunk' ? 'streaming' : 'done',
        activeTurnItemKey: payload.kind === 'agent_message_chunk' ? assistantItemKey : null,
        pendingTurnKey: isAssistant ? `main:${turnIdentity}` : null,
        pendingTurnLaneKey: isAssistant ? 'main' : null,
        pendingFinal: false,
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

describe('gateway store event wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('subscribes to host events through subscribeHostEvent on init', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });

    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:connection', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:notification', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('session:update', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('gateway:channel-status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:status', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:error', expect.any(Function));
    expect(subscribeHostEventMock).toHaveBeenCalledWith('runtime-host:restart', expect.any(Function));

    handlers.get('gateway:status')?.({ state: 'stopped', port: 18789 });
    expect(useGatewayStore.getState().status.state).toBe('stopped');
  });

  it('gateway:connection 事件会更新 runtimeHost 连接态并驱动 degraded/running 切换', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('runtime-host:status')?.({
      status: 'running',
      updatedAt: 2001,
    });
    handlers.get('gateway:connection')?.({
      state: 'disconnected',
      lastError: 'socket closed',
      updatedAt: 2002,
    });

    let state = useGatewayStore.getState().runtimeHost;
    expect(state.lifecycle).toBe('degraded');
    expect(state.gatewayConnectionState).toBe('disconnected');
    expect(state.gatewayConnectionReason).toBe('socket closed');

    handlers.get('gateway:connection')?.({
      state: 'connected',
      updatedAt: 2003,
    });

    state = useGatewayStore.getState().runtimeHost;
    expect(state.lifecycle).toBe('running');
    expect(state.gatewayConnectionState).toBe('connected');
  });

  it('runtime-host 事件会更新 renderer 侧运行时状态', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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

  it('forwards exec.approval.requested/resolved notifications into chat approval state', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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

    handlers.get('gateway:notification')?.({
      method: 'exec.approval.requested',
      params: {
        id: 'approval-evt-1',
        runId: 'run-evt-1',
        toolName: 'shell.exec',
        request: {
          sessionKey: 'agent:main:main',
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    let chatState = useChatStore.getState();
    expect(chatState.loadedSessions['agent:main:main']?.runtime.runPhase).toBe('waiting_tool');
    expect(chatState.pendingApprovalsBySession['agent:main:main']?.map((item) => item.id)).toEqual([
      'approval-evt-1',
    ]);

    handlers.get('gateway:notification')?.({
      method: 'exec.approval.resolved',
      params: {
        id: 'approval-evt-1',
        sessionKey: 'agent:main:main',
        decision: 'deny',
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    chatState = useChatStore.getState();
    expect(chatState.loadedSessions['agent:main:main']?.runtime.runPhase).toBe('aborted');
    expect(chatState.pendingApprovalsBySession['agent:main:main'] ?? []).toEqual([]);
  });

  it('run.phase completed 事件应清理 chat.send 超时残留错误', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
            sending: true,
            activeRunId: 'run-cleanup',
            pendingFinal: true,
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
    expect(state.loadedSessions['agent:main:main']?.runtime.sending).toBe(false);
    expect(state.loadedSessions['agent:main:main']?.runtime.pendingFinal).toBe(false);
    expect(state.loadedSessions['agent:main:main']?.runtime.activeRunId).toBeNull();
    expect(state.error).toBeNull();
  });

  it('structured session:update delta 会直接驱动 chat store 写入 streaming assistant turn', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
            sending: true,
            activeRunId: 'run-delta-direct-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionMessageUpdate({
      kind: 'agent_message_chunk',
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
      turnKey: 'main:run-delta-direct-1',
    }]);
  });

  it('structured session:update 会按 event.sessionKey 写入对应 session，而不是 currentSessionKey', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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

    handlers.get('session:update')?.(createSessionMessageUpdate({
      kind: 'agent_message_chunk',
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
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
            sending: true,
            activeRunId: 'run-tool-direct-1',
          },
        }),
      },
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('session:update')?.(createSessionMessageUpdate({
      kind: 'agent_message_chunk',
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
        toolStatuses: [{
          toolCallId: 'tool-1',
          name: 'memory_store',
          status: 'running',
        }],
      },
    }));

    const state = useChatStore.getState();
    const [item] = getSessionItems(state, 'agent:main:main');
    expect(item).toMatchObject({
      kind: 'assistant-turn',
      turnKey: 'main:run:run-tool-direct-1:tool:tool-1',
      toolStatuses: [{
        toolCallId: 'tool-1',
        name: 'memory_store',
        status: 'running',
      }],
    });
  });

  it('run.phase completed 只应进入单一 session update 入口', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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

    const agentPayload = {
      method: 'agent',
      params: {
        runId: 'run-1',
        sessionKey: 'agent:main:main',
        data: {
          state: 'final',
          message: {
            role: 'assistant',
            id: 'assistant-final-1',
            content: 'hello',
          },
        },
      },
    };

    handlers.get('gateway:notification')?.(agentPayload);
    handlers.get('session:update')?.(createSessionMessageUpdate({
      kind: 'agent_message',
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
    expect(handleSessionUpdateEventMock).toHaveBeenCalledWith(createSessionMessageUpdate({
      kind: 'agent_message',
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
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
            sending: true,
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

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(1);
  });

  it('legacy chat 与结构化 final 同时到达时，应只消费结构化 final', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
            sending: true,
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
    handlers.get('session:update')?.(createSessionMessageUpdate({
      kind: 'agent_message',
      runId: 'run-legacy-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '你好呀！有什么想让我帮你做的吗?',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(2);
    expect(handleSessionUpdateEventMock).toHaveBeenLastCalledWith(createSessionMessageUpdate({
      kind: 'agent_message',
      runId: 'run-legacy-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '你好呀！有什么想让我帮你做的吗?',
      },
    }));
  });

  it('user legacy metadata 与结构化 final 同时到达时，应只消费结构化 final', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
            sending: true,
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
    handlers.get('session:update')?.(createSessionMessageUpdate({
      kind: 'agent_message',
      runId: 'run-user-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'user',
        content: '你好',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(2);
    expect(handleSessionUpdateEventMock).toHaveBeenLastCalledWith(createSessionMessageUpdate({
      kind: 'agent_message',
      runId: 'run-user-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'user',
        content: '你好',
      },
    }));
  });

  it('assistant legacy 与结构化 final 同时到达时，应只消费结构化 final', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
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
            sending: true,
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
    handlers.get('session:update')?.(createSessionMessageUpdate({
      kind: 'agent_message',
      runId: 'run-assistant-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '我能做的事情挺多，简单说： - 回答问题，陪你聊天',
      },
    }));

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(handleSessionUpdateEventMock).toHaveBeenCalledTimes(2);
    expect(handleSessionUpdateEventMock).toHaveBeenLastCalledWith(createSessionMessageUpdate({
      kind: 'agent_message',
      runId: 'run-assistant-1',
      sessionKey: 'agent:main:main',
      message: {
        role: 'assistant',
        content: '我能做的事情挺多，简单说： - 回答问题，陪你聊天',
      },
    }));
  });

  it('task_manager.* 通知会进入 task center，并按 taskId 合并批量更新', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ state: 'running', port: 18789 });
    const handlers = new Map<string, (payload: unknown) => void>();
    subscribeHostEventMock.mockImplementation((eventName: string, handler: (payload: unknown) => void) => {
      handlers.set(eventName, handler);
      return () => {};
    });

    const { useTaskCenterStore } = await import('@/stores/task-center-store');
    const handleGatewayNotificationMock = vi.fn();
    useTaskCenterStore.setState({
      handleGatewayNotification: handleGatewayNotificationMock,
    } as never);

    const { useGatewayStore } = await import('@/stores/gateway');
    await useGatewayStore.getState().init();

    handlers.get('gateway:notification')?.({
      method: 'task_manager.updated',
      params: { task: { id: 'task-1', status: 'pending' } },
    });
    handlers.get('gateway:notification')?.({
      method: 'task_manager.updated',
      params: { task: { id: 'task-1', status: 'in_progress' } },
    });

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(handleGatewayNotificationMock).toHaveBeenCalledTimes(1);
    expect(handleGatewayNotificationMock).toHaveBeenCalledWith({
      method: 'task_manager.updated',
      params: { task: { id: 'task-1', status: 'in_progress' } },
    });
  });
});

