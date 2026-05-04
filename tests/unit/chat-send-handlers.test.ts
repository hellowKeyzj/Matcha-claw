import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyStoreSendStart, executeStoreSend } from '@/stores/chat/send-handlers';
import type { ChatStoreState } from '@/stores/chat/types';
import type { RawMessage } from './helpers/timeline-fixtures';
import { getSessionRows } from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { SessionRenderRow } from '../../runtime-host/shared/session-adapter-types';

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
  const rows: SessionRenderRow[] = messages.map((message, index) => {
    const rowId = String(message.id ?? `row-${index + 1}`);
    return {
      key: `session:${sessionKey}|row:${rowId}`,
      kind: 'message',
      sessionKey,
      role: message.role === 'user' || message.role === 'system' ? message.role : 'assistant',
      text: typeof message.content === 'string' ? message.content : '',
      createdAt: message.timestamp,
      status: message.status === 'sending' ? 'pending' : 'final',
      rowId,
      laneKey: 'main',
      turnKey: `main:${rowId}`,
      thinking: null,
      images: [],
      toolUses: [],
      attachedFiles: [],
      toolStatuses: [],
      isStreaming: false,
      messageId: String(message.messageId ?? message.id ?? rowId),
      ...(message.clientId ? { clientId: message.clientId } : {}),
      ...(message.uniqueId ? { uniqueId: message.uniqueId } : {}),
      ...(message.requestId ? { requestId: message.requestId } : {}),
    };
  });
  return {
    meta: {
      agentId: sessionKey.split(':')[1] ?? null,
      kind: sessionKey.endsWith(':main') ? 'main' : 'session',
      preferred: sessionKey.endsWith(':main'),
      label: null,
      titleSource: 'none' as const,
      lastActivityAt: null,
      historyStatus: 'ready' as const,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      streamingMessageId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
    },
    rows,
    window: createViewportWindowState({
      totalRowCount: messages.length,
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

  it('send start 只进入 sending runtime，不再本地写 optimistic user transcript', () => {
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
    expect(record.runtime.lastUserMessageAt).toBe(nowMs);
    expect(record.runtime.sending).toBe(true);
    expect(record.runtime.runPhase).toBe('submitted');
    expect(record.rows).toEqual([]);
  });

  it('send success 会把 runtime-host 返回的 authoritative user row 写入 row timeline', async () => {
    const sessionKey = 'agent:main:session-1';
    sendChatTransportMock.mockResolvedValueOnce({
      ok: true,
      runId: 'run-1',
      snapshot: {
        sessionKey,
        catalog: {
          key: sessionKey,
          agentId: 'main',
          kind: 'session' as const,
          preferred: false,
          label: 'latest reply',
          titleSource: 'user' as const,
          displayName: sessionKey,
          updatedAt: 1,
        },
        rows: [{
          key: `session:${sessionKey}|row:user-local-1`,
          kind: 'message',
          sessionKey,
          role: 'user',
          status: 'final',
          text: 'latest reply',
          rowId: 'user-local-1',
          laneKey: 'main',
          turnKey: 'main:user-local-1',
          thinking: null,
          images: [],
          toolUses: [],
          attachedFiles: [],
          toolStatuses: [],
          isStreaming: false,
          messageId: 'user-local-1',
          clientId: 'user-local-1',
          uniqueId: 'user-local-1',
          requestId: 'user-local-1',
        }],
        replayComplete: true,
        runtime: {
          sending: true,
          activeRunId: null,
          runPhase: 'submitted',
          streamingMessageId: null,
          pendingFinal: false,
          lastUserMessageAt: 1,
          updatedAt: 1,
        },
        window: {
          totalRowCount: 1,
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
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      text: 'latest reply',
    });

    const record = state.loadedSessions[sessionKey]!;
    expect(record.runtime.activeRunId).toBe('run-1');
    expect(getSessionRows(state, sessionKey).map((row) => row.rowId)).toEqual(['user-local-1']);
    expect(getSessionRows(state, sessionKey)[0]).toMatchObject({
      messageId: 'user-local-1',
      requestId: 'user-local-1',
    });
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
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'submitted' as const,
            streamingMessageId: null,
            pendingFinal: false,
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
      beginMutating,
      finishMutating,
      text: '你好',
    });

    expect(sendChatTransportMock).not.toHaveBeenCalled();
    expect(beginMutating).not.toHaveBeenCalled();
    expect(finishMutating).not.toHaveBeenCalled();
    expect(getSessionRows(state, sessionKey).map((row) => row.rowId)).toEqual(['user-local-1']);
  });
});
