import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStoreSendStart, executeStoreSend, NO_RESPONSE_RECEIVED_ERROR, startStoreSendWatchers } from '@/stores/chat/send-handlers';
import { createStoreSessionRunCache } from '@/stores/chat/session-run-cache';
import type { ChatStoreState } from '@/stores/chat/types';
import type { RawMessage } from './helpers/timeline-fixtures';
import { getSessionItems } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { SessionRenderItem } from '../../runtime-host/shared/session-adapter-types';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const sendChatTransportMock = vi.fn();

vi.mock('@/stores/chat/send-transport', () => ({
  CHAT_SEND_RPC_TIMEOUT_MS: 120000,
  sendChatTransport: (...args: unknown[]) => sendChatTransportMock(...args),
}));

function createSessionRecord(input?: {
  sessionKey?: string;
  messages?: RawMessage[];
}) {
  const sessionKey = input?.sessionKey ?? 'agent:main:session-1';
  const messages = input?.messages ?? [];
  const items: SessionRenderItem[] = buildRenderItemsFromMessages(sessionKey, messages);
  const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey);
  return {
    meta: {
      backendSessionKey: sessionKey,
      runtimeScopeKey: 'native-runtime:openclaw:local',
      agentId: sessionKey.split(':')[1] ?? null,
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'local',
      sessionIdentity,
      kind: sessionKey.endsWith(':main') ? 'main' : 'session',
      preferred: sessionKey.endsWith(':main'),
      label: null,
      titleSource: 'none' as const,
      lastActivityAt: null,
      historyStatus: 'ready' as const,
      thinkingLevel: null,
    },
    runtime: {
      activeRunId: null,
      runPhase: 'idle' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      lastUserMessageAt: null,
      lastError: null,
      lastIssue: null,
      updatedAt: null,
    },
    items,
    window: createViewportWindowState({
      totalItemCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }),
  };
}

describe('chat send handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('send start only updates local session label before runtime-host snapshot returns', () => {
    const sessionKey = 'agent:main:session-1';
    const nowMs = 1_700_000_000_000;

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({ sessionKey }),
      },
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };

    applyStoreSendStart({
      set,
      sessionKey,
      text: 'hello world',
      nowMs,
    });

    const record = state.loadedSessions[sessionKey]!;
    expect(record.meta.label).toBe('hello world');
    expect(record.meta.lastActivityAt).toBe(nowMs);
    expect(record.runtime.lastUserMessageAt).toBeNull();
    expect(record.runtime.runPhase).toBe('idle');
    expect(record.items).toEqual([]);
  });

  it('send success applies the runtime-host submitted snapshot without binding runId locally', async () => {
    const sessionKey = 'agent:main:session-1';
    sendChatTransportMock.mockResolvedValueOnce({
      ok: true,
      runId: 'run-1',
      snapshot: {
        sessionKey,
        catalog: {
          key: sessionKey,
          agentId: 'main',
          protocolId: 'openclaw-v4',
          runtimeEndpointId: 'local',
          sessionIdentity: createOpenClawTestSessionIdentity(sessionKey),
          kind: 'session' as const,
          preferred: false,
          label: 'latest reply',
          titleSource: 'user' as const,
          displayName: sessionKey,
          updatedAt: 1,
        },
        items: [{
          key: `session:${sessionKey}|entry:user-local-1`,
          kind: 'user-message',
          sessionKey,
          role: 'user',
          text: 'latest reply',
          images: [],
          attachedFiles: [],
          createdAt: 1,
          updatedAt: 1,
          messageId: 'user-local-1',
        }],
        replayComplete: true,
        runtime: {
          activeRunId: null,
          runPhase: 'submitted',
          activeTurnItemKey: null,
          pendingTurnKey: 'main:run-1',
          pendingTurnLaneKey: 'main',
          lastUserMessageAt: 1,
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

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({ sessionKey }),
      },
      pendingApprovalsBySession: {},
      error: null,
      mutating: false,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    await executeStoreSend({
      set,
      get,
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'latest reply',
    });

    const record = state.loadedSessions[sessionKey]!;
    expect(record.runtime.activeRunId).toBeNull();
    expect(record.runtime.pendingTurnKey).toBe('main:run-1');
    expect(getSessionItems(state, sessionKey).map((item) => item.messageId)).toEqual(['user-local-1']);
    expect(getSessionItems(state, sessionKey)[0]).toMatchObject({
      messageId: 'user-local-1',
    });
  });

  it('does not send while a previous send mutation is still in flight', async () => {
    const sessionKey = 'agent:main:session-1';
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({ sessionKey }),
      },
      pendingApprovalsBySession: {},
      error: null,
      mutating: true,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const beginMutating = vi.fn();

    await executeStoreSend({
      set,
      get: () => state,
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating,
      finishMutating: vi.fn(),
      text: '你好',
    });

    expect(sendChatTransportMock).not.toHaveBeenCalled();
    expect(beginMutating).not.toHaveBeenCalled();
  });

  it('does not poll history while a run is active', async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = 'agent:main:session-1';
      let state = {
        currentSessionKey: sessionKey,
        loadedSessions: {
          [sessionKey]: {
            ...createSessionRecord({ sessionKey }),
            runtime: {
              activeRunId: 'run-1',
              runPhase: 'waiting_tool' as const,
              activeTurnItemKey: null,
              pendingTurnKey: 'run-1',
              pendingTurnLaneKey: 'main',
              runtimeActivity: null,
              lastUserMessageAt: 1,
              lastError: null,
              lastIssue: null,
              updatedAt: 1,
            },
          },
        },
        loadHistory: vi.fn().mockResolvedValue(undefined),
        syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChatStoreState;
      const set = (
        partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
      ) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...patch } as ChatStoreState;
      };
      const get = () => state;

      startStoreSendWatchers({
        set,
        get,
        sessionKey,
        onSafetyTimeout: vi.fn(),
      });

      await vi.advanceTimersByTimeAsync(60_000);

      expect(state.loadHistory).not.toHaveBeenCalled();
      expect(state.syncPendingApprovals).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not show the safety timeout error when history has assistant tool progress', async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = 'agent:main:session-1';
      const onSafetyTimeout = vi.fn();
      let state = {
        currentSessionKey: sessionKey,
        loadedSessions: {
          [sessionKey]: {
            ...createSessionRecord({ sessionKey }),
            items: [{
              key: 'assistant-tool-1',
              kind: 'assistant-turn' as const,
              sessionKey,
              role: 'assistant' as const,
              identitySource: 'runtime' as const,
              identityMode: 'turn' as const,
              identityConfidence: 'high' as const,
              status: 'waiting_tool' as const,
              segments: [{ kind: 'tool' as const, toolCallId: 'tool-1' }],
              thinking: 'Searching...',
              tools: [{ name: 'web_search', status: 'running' as const, updatedAt: 1 }],
              text: '',
              images: [],
              attachedFiles: [],
            }],
            runtime: {
              activeRunId: 'run-1',
              runPhase: 'submitted' as const,
              activeTurnItemKey: null,
              pendingTurnKey: 'turn-1',
              pendingTurnLaneKey: 'main',
              runtimeActivity: null,
              lastUserMessageAt: 1,
              lastError: null,
              lastIssue: null,
              updatedAt: 1,
            },
          },
        },
        error: NO_RESPONSE_RECEIVED_ERROR,
        loadHistory: vi.fn().mockResolvedValue(undefined),
        syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChatStoreState;
      const set = (
        partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
      ) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...patch } as ChatStoreState;
      };

      startStoreSendWatchers({
        set,
        get: () => state,
        sessionKey,
        onSafetyTimeout,
      });

      await vi.advanceTimersByTimeAsync(130_000);

      expect(onSafetyTimeout).not.toHaveBeenCalled();
      expect(state.error).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the safety timeout error for stuck active runs without runtime reconciliation', async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = 'agent:main:session-1';
      const onSafetyTimeout = vi.fn();
      let state = {
        currentSessionKey: sessionKey,
        loadedSessions: {
          [sessionKey]: {
            ...createSessionRecord({ sessionKey }),
            runtime: {
              activeRunId: 'run-1',
              runPhase: 'streaming' as const,
              activeTurnItemKey: null,
              pendingTurnKey: 'turn-1',
              pendingTurnLaneKey: 'main',
              runtimeActivity: null,
              lastUserMessageAt: 1,
              lastError: null,
              lastIssue: null,
              updatedAt: 1,
            },
          },
        },
        error: null,
        loadHistory: vi.fn().mockResolvedValue(undefined),
        syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
      } as unknown as ChatStoreState;
      const set = (
        partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
      ) => {
        const patch = typeof partial === 'function' ? partial(state) : partial;
        state = { ...state, ...patch } as ChatStoreState;
      };
      const get = () => state;

      startStoreSendWatchers({
        set,
        get,
        sessionKey,
        onSafetyTimeout,
      });

      await vi.advanceTimersByTimeAsync(130_000);

      expect(state.loadHistory).not.toHaveBeenCalled();
      expect(onSafetyTimeout).toHaveBeenCalledTimes(1);
      expect(state.error).toBe(NO_RESPONSE_RECEIVED_ERROR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second send while the current session is already sending', async () => {
    const sessionKey = 'agent:main:session-1';
    const finishMutating = vi.fn();
    const beginMutating = vi.fn();
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createSessionRecord({
            sessionKey,
            messages: [{
              id: 'user-local-1',
              clientId: 'user-local-1',
              messageId: 'user-local-1',
              uniqueId: 'user-local-1',
              requestId: 'user-local-1',
              role: 'user',
              status: 'sent' as const,
              content: '你好',
              timestamp: 1,
            }],
          }),
          runtime: {
            activeRunId: 'run-1',
            runPhase: 'submitted' as const,
            activeTurnItemKey: null,
            pendingTurnKey: 'main:run-1',
            pendingTurnLaneKey: 'main',
            lastUserMessageAt: 1,
          },
        },
      },
      pendingApprovalsBySession: {},
      error: null,
      mutating: false,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    await executeStoreSend({
      set,
      get,
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating,
      finishMutating,
      text: '你好',
    });

    expect(sendChatTransportMock).not.toHaveBeenCalled();
    expect(beginMutating).not.toHaveBeenCalled();
    expect(finishMutating).not.toHaveBeenCalled();
    expect(getSessionItems(state, sessionKey).map((item) => item.messageId)).toEqual(['user-local-1']);
  });

  it('recoverable chat.send timeout leaves runtime unchanged while runtime-host remains authoritative', async () => {
    const sessionKey = 'agent:main:session-1';
    sendChatTransportMock.mockResolvedValueOnce({
      ok: false,
      error: 'Gateway RPC timeout: chat.send',
    });

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({ sessionKey }),
      },
      pendingApprovalsBySession: {},
      error: null,
      mutating: false,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    await executeStoreSend({
      set,
      get,
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'latest reply',
    });

    const runtime = state.loadedSessions[sessionKey]!.runtime;
    expect(runtime.runPhase).toBe('idle');
    expect(runtime.lastError).toBeNull();
  });

  it('ignores a late send result after the user already aborted the session', async () => {
    const sessionKey = 'agent:main:session-1';
    const sessionRunCache = createStoreSessionRunCache();
    let resolveSend: ((value: unknown) => void) | null = null;
    sendChatTransportMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({ sessionKey }),
      },
      pendingApprovalsBySession: {},
      error: null,
      mutating: false,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
      handleSessionUpdateEvent: vi.fn(),
    } as unknown as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const sendPromise = executeStoreSend({
      set,
      get,
      sessionRunCache,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'late reply',
    });

    await Promise.resolve();

    sessionRunCache.nextSendGeneration(sessionKey);
    set((current) => ({
      loadedSessions: {
        ...current.loadedSessions,
        [sessionKey]: {
          ...current.loadedSessions[sessionKey]!,
          runtime: {
            ...current.loadedSessions[sessionKey]!.runtime,
            activeRunId: null,
            runPhase: 'aborted',
          },
        },
      },
    }));

    resolveSend?.({
      ok: true,
      runId: 'run-late-1',
      snapshot: {
        sessionKey,
        catalog: {
          key: sessionKey,
          agentId: 'main',
          protocolId: 'openclaw-v4',
          runtimeEndpointId: 'local',
          sessionIdentity: createOpenClawTestSessionIdentity(sessionKey),
          kind: 'session' as const,
          preferred: false,
          label: 'late reply',
          titleSource: 'user' as const,
          displayName: sessionKey,
          updatedAt: 1,
        },
        items: [{
          key: `session:${sessionKey}|entry:user-late-1`,
          kind: 'user-message',
          sessionKey,
          role: 'user',
          text: 'late reply',
          images: [],
          attachedFiles: [],
          createdAt: 1,
          updatedAt: 1,
          messageId: 'user-late-1',
        }],
        replayComplete: true,
        runtime: {
          activeRunId: 'run-late-1',
          runPhase: 'submitted' as const,
          activeTurnItemKey: null,
          pendingTurnKey: 'main:run-late-1',
          pendingTurnLaneKey: 'main',
          lastUserMessageAt: 1,
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

    await sendPromise;

    const record = state.loadedSessions[sessionKey]!;
    expect(record.runtime.runPhase).toBe('aborted');
    expect(record.runtime.activeRunId).toBeNull();
    expect(getSessionItems(state, sessionKey)).toEqual([]);
  });
});
