import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStoreSendStart, executeStoreSend, NO_RESPONSE_RECEIVED_ERROR, startStoreSendWatchers } from '@/stores/chat/send-handlers';
import { createStoreSessionRunCache } from '@/stores/chat/session-run-cache';
import { buildSessionIdentityRecordIndex } from '@/stores/chat/session-identity';
import type { ChatStoreState } from '@/stores/chat/types';
import { getSessionItems, applySessionView } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { SessionRenderItem } from '../../src/types/session/render-item';
import { assistantItem, completeFact, sessionView, userItem } from './helpers/session-fixtures';

interface RawMessage {
  role: 'user';
  content: string;
  timestamp?: number;
  id?: string;
  messageId?: string;
  [key: string]: unknown;
}

const openClawTestRuntimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

function createOpenClawTestSessionIdentity(sessionKey: string) {
  return {
    endpoint: openClawTestRuntimeEndpoint,
    agentId: sessionKey.split(':')[1] ?? 'main',
    sessionKey,
  };
}

function buildRenderItemsFromMessages(sessionKey: string, messages: readonly RawMessage[]): SessionRenderItem[] {
  return messages.map((message, index) => ({
    key: message.messageId ?? message.id ?? `message-${index}`,
    kind: 'user-message',
    sessionKey,
    role: 'user',
    text: message.content,
    images: [],
    attachedFiles: [],
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.timestamp != null ? { createdAt: message.timestamp, updatedAt: message.timestamp } : {}),
  }));
}

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

  it('binds the immediate assistant placeholder to the ack run and authoritative projection', async () => {
    const sessionKey = 'agent:main:session-1';
    let resolveSend: ((value: unknown) => void) | null = null;
    sendChatTransportMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    const loadedSessions = { [sessionKey]: createSessionRecord({ sessionKey }) };
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      pendingApprovalsBySession: {},
      error: null,
      mutating: false,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
      loadHistory: vi.fn().mockResolvedValue(undefined),
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
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'hello',
    });

    await Promise.resolve();

    const beforeAck = getSessionItems(state, sessionKey);
    expect(beforeAck).toEqual([
      expect.objectContaining({
        kind: 'user-message',
        text: 'hello',
        status: 'pending',
        clientId: expect.any(String),
      }),
      expect.objectContaining({
        key: expect.stringMatching(/^renderer-assistant:/),
        kind: 'assistant-turn',
        identitySource: 'client',
        identityMode: 'client',
        status: 'streaming',
        pendingState: 'typing',
        text: '',
      }),
    ]);

    resolveSend?.({ ok: true, runId: 'native-run-1', projection: null });
    await sendPromise;

    const afterAck = getSessionItems(state, sessionKey);
    expect(afterAck).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'assistant-turn',
        key: 'renderer-assistant:native-run-1',
        runId: 'native-run-1',
        identitySource: 'run',
        identityMode: 'run',
        pendingState: 'typing',
      }),
    ]));
    expect(state.loadedSessions[sessionKey]!.runtime).toMatchObject({
      activeRunId: 'native-run-1',
      runPhase: 'submitted',
      activeTurnItemKey: null,
      pendingTurnKey: 'renderer-assistant:native-run-1',
    });

    applySessionView({ set, get }, sessionView(sessionKey, {
      seq: 1,
      cursor: 1,
      identity: createOpenClawTestSessionIdentity(sessionKey),
      items: completeFact([
        userItem('user-1', 'hello'),
        assistantItem('assistant-1', 'real assistant text', { runId: 'native-run-1' }),
      ]),
    }));

    const assistantItems = getSessionItems(state, sessionKey).filter((item) => item.kind === 'assistant-turn');
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toMatchObject({
      key: 'assistant-1',
      runId: 'native-run-1',
      identitySource: 'run',
      identityMode: 'run',
      text: 'real assistant text',
    });
    expect(getSessionItems(state, sessionKey)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'assistant-turn',
        identitySource: 'client',
        pendingState: 'typing',
      }),
    ]));
  });

  it('clears the immediate assistant placeholder when chat send fails', async () => {
    const sessionKey = 'agent:main:session-1';
    let resolveSend: ((value: unknown) => void) | null = null;
    sendChatTransportMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveSend = resolve;
    }));

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: { [sessionKey]: createSessionRecord({ sessionKey }) },
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

    const sendPromise = executeStoreSend({
      set,
      get: () => state,
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'hello',
    });

    await Promise.resolve();

    expect(getSessionItems(state, sessionKey)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'assistant-turn',
        identitySource: 'client',
        pendingState: 'typing',
      }),
    ]));

    resolveSend?.({ ok: false, error: 'Target rejected the prompt' });
    await expect(sendPromise).resolves.toEqual({
      accepted: false,
      reason: 'error',
      error: 'Target rejected the prompt',
    });

    expect(state.error).toBe('Target rejected the prompt');
    expect(getSessionItems(state, sessionKey)).toEqual([]);
  });

  it('applies a canonical view returned by send transport without keeping the local assistant placeholder', async () => {
    const sessionKey = 'agent:main:session-1';
    const view = sessionView(sessionKey, {
      identity: createOpenClawTestSessionIdentity(sessionKey),
      items: completeFact([
        userItem('user-1', 'hello'),
        assistantItem('assistant-1', 'real assistant text', { runId: 'run-1' }),
      ]),
    });
    sendChatTransportMock.mockResolvedValueOnce({
      ok: true,
      runId: 'run-1',
      projection: { kind: 'view', view },
    });
    const loadedSessions = { [sessionKey]: createSessionRecord({ sessionKey }) };
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      rendererRouteRecordKeys: {},
      pendingApprovalsBySession: {},
      error: null,
      mutating: false,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatStoreState;
    const set = (partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState>)) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };

    await executeStoreSend({
      set,
      get: () => state,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      sessionRunCache: createStoreSessionRunCache(),
      text: 'hello',
    });

    const items = getSessionItems(state, sessionKey);
    expect(items).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'assistant-turn',
        role: 'assistant',
        identitySource: 'client',
        identityMode: 'client',
        pendingState: 'typing',
      }),
    ]));
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message',
        text: 'hello',
        messageId: 'user-1',
      }),
    ]));
    const assistantItems = items.filter((item) => item.kind === 'assistant-turn');
    expect(assistantItems).toHaveLength(1);
    expect(assistantItems[0]).toMatchObject({
      key: 'assistant-1',
      runId: 'run-1',
      identitySource: 'run',
      identityMode: 'run',
      text: 'real assistant text',
    });
  });

  it('accepted attachment send writes a metadata-only renderer receipt keyed by its run', async () => {
    const sessionKey = 'agent:main:session-1';
    sendChatTransportMock.mockResolvedValueOnce({
      ok: true,
      runId: 'run-attachment-1',
      projection: null,
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
      attachments: [{
        fileName: 'attachment.txt',
        mimeType: 'text/plain',
        fileSize: 16,
        stagedAttachmentId: 'attachment-text',
        preview: 'data:text/plain;base64,c2VjcmV0',
      }, {
        fileName: 'attachment.png',
        mimeType: 'image/png',
        fileSize: 32,
        stagedAttachmentId: 'attachment-image',
        preview: 'blob:renderer-attachment-preview',
      }, {
        fileName: 'staged-image.png',
        mimeType: 'image/png',
        fileSize: 24,
        stagedAttachmentId: 'attachment-staged-image',
        preview: 'data:image/png;base64,aW1hZ2U=',
      }],
    });

    expect(sendChatTransportMock).toHaveBeenCalledWith(expect.objectContaining({
      attachments: expect.arrayContaining([expect.objectContaining({ fileName: 'attachment.txt' })]),
    }));
    const record = state.loadedSessions[sessionKey]!;
    expect(record.runtime.activeRunId).toBe('run-attachment-1');
    expect(record.runtime.pendingTurnKey).toBe('renderer-assistant:run-attachment-1');
    const items = getSessionItems(state, sessionKey);
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'assistant-turn',
        role: 'assistant',
        key: 'renderer-assistant:run-attachment-1',
        runId: 'run-attachment-1',
        identitySource: 'run',
        identityMode: 'run',
        pendingState: 'typing',
      }),
    ]));
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'user-message',
        text: 'latest reply',
        runId: expect.any(String),
        rendererReceiptRunId: expect.any(String),
        images: [{
          url: 'blob:renderer-attachment-preview',
          mimeType: 'image/png',
        }],
        attachedFiles: [{
          fileName: 'attachment.txt',
          mimeType: 'text/plain',
          fileSize: 16,
          preview: null,
        }],
      }),
    ]));
    const receipt = getSessionItems(state, sessionKey)[0]!;
    expect(receipt.key).toBe(`renderer-receipt:${receipt.runId}`);
    expect(receipt.rendererReceiptRunId).toBe(receipt.runId);
    expect(JSON.stringify(receipt)).not.toContain('attachment-text');
    expect(JSON.stringify(receipt)).not.toContain('attachment-image');
    expect(JSON.stringify(receipt)).not.toContain('attachment-staged-image');
    expect(JSON.stringify(receipt)).not.toContain('c2VjcmV0');
    expect(JSON.stringify(receipt)).not.toContain('aW1hZ2U=');
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

  it('keeps the composer draft when runtime-host rejects an attachment send', async () => {
    const sessionKey = 'agent:main:session-1';
    sendChatTransportMock.mockResolvedValueOnce({
      ok: false,
      error: 'Attachment staging expired',
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

    const result = await executeStoreSend({
      set,
      get: () => state,
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'retry this attachment',
      attachments: [{
        fileName: 'report.txt',
        mimeType: 'text/plain',
        fileSize: 42,
        stagedAttachmentId: 'attachment-report',
        preview: null,
      }],
    });

    expect(result).toEqual({
      accepted: false,
      reason: 'error',
      error: 'Attachment staging expired',
      attachmentReselectionRequired: true,
    });
    expect(state.error).toBe('Attachment staging expired');
  });

  it('unknown attachment send requires reselection instead of preserving a reusable token', async () => {
    const sessionKey = 'agent:main:session-1';
    sendChatTransportMock.mockResolvedValueOnce({
      ok: false,
      error: 'Gateway RPC timeout: chat.send',
    });

    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: { [sessionKey]: createSessionRecord({ sessionKey }) },
      pendingApprovalsBySession: {},
      error: null,
      mutating: false,
      syncPendingApprovals: vi.fn().mockResolvedValue(undefined),
    } as unknown as ChatStoreState;
    const set = (partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState>)) => {
      state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) };
    };

    await expect(executeStoreSend({
      set,
      get: () => state,
      sessionRunCache: createStoreSessionRunCache(),
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'keep the text',
      attachments: [{
        fileName: 'report.txt',
        mimeType: 'text/plain',
        fileSize: 42,
        stagedAttachmentId: 'attachment-report',
        preview: null,
      }],
    })).resolves.toEqual({
      accepted: false,
      reason: 'error',
      error: 'Gateway RPC timeout: chat.send',
      attachmentReselectionRequired: true,
    });
    expect(state.error).toBe('Gateway RPC timeout: chat.send');
    expect(state.syncPendingApprovals).not.toHaveBeenCalled();
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
      projection: null,
    });

    await sendPromise;

    const record = state.loadedSessions[sessionKey]!;
    expect(record.runtime.runPhase).toBe('aborted');
    expect(record.runtime.activeRunId).toBeNull();
    expect(getSessionItems(state, sessionKey)).toEqual([]);
  });
});
