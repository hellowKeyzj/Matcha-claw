import { describe, expect, it, vi } from 'vitest';
import { handleStoreConversationEvent } from '@/stores/chat/event-actions';
import { handleStoreFinalEvent } from '@/stores/chat/event-handlers';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-load-execution';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { HistoryWindowResult } from '@/stores/chat/history-fetch-helpers';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';
import { findCurrentStreamingMessage } from '@/stores/chat/streaming-message';

function createHistoryRuntimeHarness(): StoreHistoryCache {
  let runId = 0;
  return {
    getHistoryLoadRunId: () => runId,
    nextHistoryLoadRunId: () => {
      runId += 1;
      return runId;
    },
    replaceHistoryLoadAbortController: () => null,
    clearHistoryLoadAbortController: () => {},
    historyFingerprintBySession: new Map<string, string>(),
    historyQuickFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createSessionRecord(input?: {
  messages?: RawMessage[];
  runtime?: Partial<ChatStoreState['loadedSessions'][string]['runtime']>;
  tooling?: Partial<ChatStoreState['loadedSessions'][string]['tooling']>;
}) {
  return {
    meta: {
      label: null,
      lastActivityAt: Date.now(),
      ready: true,
      thinkingLevel: null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      streamingMessageId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      ...input?.runtime,
    },
    tooling: {
      streamingTools: [],
      pendingToolImages: [],
      ...input?.tooling,
    },
    messages: input?.messages ?? [],
    window: createViewportWindowState({
      totalMessageCount: input?.messages?.length ?? 0,
      windowStartOffset: 0,
      windowEndOffset: input?.messages?.length ?? 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }),
  };
}

function createStreamingAssistantMessage(id: string, content: RawMessage['content'], timestamp: number): RawMessage {
  return {
    id,
    role: 'assistant',
    content,
    timestamp,
    streaming: true,
  };
}

function createHistoryWindow(
  rawMessages: RawMessage[],
  overrides: Partial<HistoryWindowResult> = {},
): HistoryWindowResult {
  return {
    rawMessages,
    canonicalRawMessages: overrides.canonicalRawMessages ?? rawMessages,
    thinkingLevel: overrides.thinkingLevel ?? null,
    totalMessageCount: overrides.totalMessageCount ?? rawMessages.length,
    windowStartOffset: overrides.windowStartOffset ?? 0,
    windowEndOffset: overrides.windowEndOffset ?? rawMessages.length,
    hasMore: overrides.hasMore ?? false,
    hasNewer: overrides.hasNewer ?? false,
    isAtLatest: overrides.isAtLatest ?? true,
  };
}

describe('chat stream finalization identity', () => {
  it('commits assistant final immediately with the existing streaming message id', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            streamingMessageId: 'assistant-local-1',
          },
        }),
      },
      pendingApprovalsBySession: {},
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    handleStoreFinalEvent({
      set,
      get,
      event: {
        message: {
          id: 'gateway-final-1',
          role: 'assistant',
          content: 'hello world',
        },
      },
      resolvedState: 'final',
      currentSessionKey: sessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    const transcript = state.loadedSessions[sessionKey]!.messages;
    const runtime = state.loadedSessions[sessionKey]!.runtime;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: 'assistant-local-1',
      messageId: 'gateway-final-1',
      role: 'assistant',
      content: 'hello world',
      streaming: false,
    });
    expect(runtime.streamingMessageId).toBeNull();
    expect(runtime.sending).toBe(false);
    expect(runtime.pendingFinal).toBe(false);
  });

  it('commits the final assistant message once and updates local session meta without forcing a background history reconcile', () => {
    const sessionKey = 'agent:main:session-2';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({
          messages: [
            createStreamingAssistantMessage('assistant-local-1', 'hello world', sentAtMs / 1000),
          ],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            streamingMessageId: 'assistant-local-1',
          },
        }),
      },
      pendingApprovalsBySession: {},
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    handleStoreFinalEvent({
      set,
      get,
      event: {
        message: {
          id: 'gateway-final-1',
          role: 'assistant',
          content: 'hello world',
          timestamp: 123,
        },
      },
      resolvedState: 'final',
      currentSessionKey: sessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    const transcript = state.loadedSessions[sessionKey]!.messages;
    const meta = state.loadedSessions[sessionKey]!.meta;
    const runtime = state.loadedSessions[sessionKey]!.runtime;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.id).toBe('assistant-local-1');
    expect(transcript[0]?.messageId).toBe('gateway-final-1');
    expect(transcript[0]?.content).toBe('hello world');
    expect(meta.label).toBe('hello world');
    expect(meta.lastActivityAt).toBe(123000);
    expect(runtime.streamingMessageId).toBeNull();
    expect(state.loadHistory).not.toHaveBeenCalled();
  });

  it('preserves the local assistant id when final history refresh writes back the canonical transcript', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const currentMessages: RawMessage[] = [{
      id: 'assistant-local-1',
      messageId: 'gateway-final-1',
      role: 'assistant',
      content: 'hello world',
      timestamp: 2,
    }];
    const rawMessages: RawMessage[] = [{
      id: 'gateway-final-1',
      role: 'assistant',
      content: 'hello world',
      timestamp: 2,
    }];

    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: currentMessages,
          runtime: {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            runPhase: 'done',
          },
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: false,
      refreshing: false,
      snapshotReady: true,
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(rawMessages));

    expect(state.loadedSessions[requestedSessionKey]?.messages).toHaveLength(1);
    expect(state.loadedSessions[requestedSessionKey]?.messages[0]?.id).toBe('assistant-local-1');
  });

  it('drops an unmatched settled local assistant tail when canonical history already has the final assistant', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: [
            {
              id: 'user-local-1',
              clientId: 'user-local-1',
              messageId: 'user-local-1',
              role: 'user',
              content: 'hello world',
              timestamp: 1,
            },
            {
              id: 'assistant-local-preview',
              role: 'assistant',
              content: 'draft preview text',
              timestamp: 2,
            },
          ],
          runtime: {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            runPhase: 'done',
          },
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: false,
      refreshing: false,
      snapshotReady: true,
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow([
      {
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'canonical final text',
        timestamp: 2,
      },
    ]));

    expect(state.loadedSessions[requestedSessionKey]?.messages.map((message) => message.id)).toEqual([
      'user-local-1',
      'assistant-final-1',
    ]);
  });

  it('treats reply_to colon prefix as assistant metadata during history reconcile', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const currentMessages: RawMessage[] = [{
      id: 'assistant-local-1',
      messageId: 'gateway-final-1',
      role: 'assistant',
      content: '好，我继续。',
      timestamp: 2,
    }];
    const rawMessages: RawMessage[] = [{
      id: 'gateway-final-1',
      role: 'assistant',
      content: '[[reply_to:f4a00548-42a8-4826-8e45-0a655d7c6414]]好，我继续。',
      timestamp: 2,
    }];

    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: currentMessages,
          runtime: {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            runPhase: 'done',
          },
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: false,
      refreshing: false,
      snapshotReady: true,
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(rawMessages));

    expect(state.loadedSessions[requestedSessionKey]?.messages).toHaveLength(1);
    expect(state.loadedSessions[requestedSessionKey]?.messages[0]?.id).toBe('assistant-local-1');
    expect(state.loadedSessions[requestedSessionKey]?.messages[0]?.content).toBe('[[reply_to:f4a00548-42a8-4826-8e45-0a655d7c6414]]好，我继续。');
  });

  it('keeps the raw streaming message blocks for tool turns inside the transcript message', () => {
    const record = createSessionRecord({
      messages: [
        createStreamingAssistantMessage(
          'assistant-local-1',
          [
            { type: 'text', text: 'hello world' },
            { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/tmp/a.ts' } },
          ],
          1_700_000_000,
        ),
      ],
      runtime: {
        sending: true,
        activeRunId: 'run-1',
        runPhase: 'streaming',
        lastUserMessageAt: 1_700_000_000_000,
        streamingMessageId: 'assistant-local-1',
      },
    });

    const streamingMessage = findCurrentStreamingMessage(record.messages, record.runtime.streamingMessageId);
    expect(Array.isArray(streamingMessage?.content)).toBe(true);
    expect((streamingMessage?.content as Array<{ type: string }>).some((block) => block.type === 'tool_use')).toBe(true);
  });

  it('returns the same streaming transcript message reference while runtime state is unchanged', () => {
    const record = createSessionRecord({
      messages: [
        createStreamingAssistantMessage('assistant-local-1', 'hello world', 1_700_000_000),
      ],
      runtime: {
        sending: true,
        activeRunId: 'run-1',
        runPhase: 'streaming',
        lastUserMessageAt: 1_700_000_000_000,
        streamingMessageId: 'assistant-local-1',
      },
    });

    const first = findCurrentStreamingMessage(record.messages, record.runtime.streamingMessageId);
    const second = findCurrentStreamingMessage(record.messages, record.runtime.streamingMessageId);

    expect(second).toBe(first);
  });

  it('commits authoritative user final by client message id onto the existing local user message', () => {
    const sessionKey = 'agent:main:main';
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({
          messages: [{
            id: 'user-local-1',
            clientId: 'user-local-1',
            messageId: 'user-local-1',
            role: 'user',
            status: 'sending',
            content: 'hello world',
            timestamp: 1_700_000_000,
          }],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'submitted',
            lastUserMessageAt: 1_700_000_000_000,
          },
        }),
      },
      pendingApprovalsBySession: {},
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    handleStoreFinalEvent({
      set,
      get,
      event: {
        message: {
          id: 'gateway-user-1',
          role: 'user',
          content: 'hello world [message_id: user-local-1]',
        },
      },
      resolvedState: 'final',
      currentSessionKey: sessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    expect(state.loadedSessions[sessionKey]?.runtime.runPhase).toBe('submitted');
    expect(state.loadedSessions[sessionKey]?.messages).toHaveLength(1);
    expect(state.loadedSessions[sessionKey]?.messages[0]?.id).toBe('user-local-1');
    expect(state.loadedSessions[sessionKey]?.messages[0]?.status).toBe('sent');
  });

  it('retains the existing local user message when assistant final is committed', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({
          messages: [{
            id: 'user-local-1',
            clientId: 'user-local-1',
            messageId: 'user-local-1',
            role: 'user',
            status: 'sending',
            content: 'hello world',
            timestamp: sentAtMs / 1000,
          }],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            streamingMessageId: 'assistant-local-1',
          },
        }),
      },
      pendingApprovalsBySession: {},
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    handleStoreFinalEvent({
      set,
      get,
      event: {
        message: {
          id: 'gateway-final-1',
          role: 'assistant',
          content: 'hello world',
        },
      },
      resolvedState: 'final',
      currentSessionKey: sessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    expect(state.loadedSessions[sessionKey]?.messages.some((message) => message.id === 'user-local-1')).toBe(true);
  });

  it('keeps the local user message and assistant final together so the current turn never disappears', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({
          messages: [{
            id: 'user-local-1',
            clientId: 'user-local-1',
            messageId: 'user-local-1',
            role: 'user',
            status: 'sending',
            content: 'hello world',
            timestamp: sentAtMs / 1000,
          }, {
            id: 'assistant-prev-1',
            role: 'assistant',
            content: 'previous',
            timestamp: (sentAtMs - 1000) / 1000,
          }, {
            ...createStreamingAssistantMessage('assistant-local-1', 'hello', sentAtMs / 1000),
          }],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            streamingMessageId: 'assistant-local-1',
          },
        }),
      },
      pendingApprovalsBySession: {},
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    handleStoreFinalEvent({
      set,
      get,
      event: {
        message: {
          id: 'gateway-final-1',
          role: 'assistant',
          content: 'hello world',
        },
      },
      resolvedState: 'final',
      currentSessionKey: sessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    expect(state.loadedSessions[sessionKey]?.messages.map((message) => message.id)).toEqual([
      'user-local-1',
      'assistant-prev-1',
      'assistant-local-1',
    ]);
  });

  it('does not let an unbound final event terminate the active run', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({
          messages: [{
            id: 'user-local-1',
            clientId: 'user-local-1',
            messageId: 'user-local-1',
            role: 'user',
            status: 'sending',
            content: 'hello world',
            timestamp: sentAtMs / 1000,
          }],
          runtime: {
            sending: true,
            activeRunId: 'run-active',
            runPhase: 'submitted',
            lastUserMessageAt: sentAtMs,
          },
        }),
      },
      pendingApprovalsBySession: {},
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;
    handleStoreConversationEvent({ set, get }, {
      kind: 'chat.message',
      source: 'chat.message',
      phase: 'final',
      runId: null,
      sessionKey,
      event: {
        sessionKey,
        state: 'completed',
        message: {
          id: 'stale-final-1',
          role: 'assistant',
          content: 'stale final payload',
        },
      },
    });

    expect(state.loadedSessions[sessionKey]?.messages).toHaveLength(1);
    expect(state.loadedSessions[sessionKey]?.runtime.sending).toBe(true);
    expect(state.loadedSessions[sessionKey]?.runtime.activeRunId).toBe('run-active');
    expect(state.loadHistory).toHaveBeenCalledWith({
      sessionKey,
      mode: 'quiet',
      scope: 'foreground',
      reason: 'unbound_final_event_reconcile',
    });
  });

  it('merges duplicate assistant final into the existing transcript entry instead of dropping final metadata', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    const pendingImage = {
      fileName: 'result.png',
      mimeType: 'image/png',
      fileSize: 42,
      preview: 'data:image/png;base64,abc',
    };
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createSessionRecord({
          messages: [{
            ...createStreamingAssistantMessage('assistant-local-1', 'hello world', sentAtMs / 1000),
          }],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            streamingMessageId: 'assistant-local-1',
          },
          tooling: {
            pendingToolImages: [pendingImage],
          },
        }),
      },
      pendingApprovalsBySession: {},
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    handleStoreFinalEvent({
      set,
      get,
      event: {
        message: {
          id: 'gateway-final-1',
          role: 'assistant',
          content: 'hello world',
        },
      },
      resolvedState: 'final',
      currentSessionKey: sessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    const transcript = state.loadedSessions[sessionKey]!.messages;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: 'assistant-local-1',
      messageId: 'gateway-final-1',
      role: 'assistant',
      content: 'hello world',
    });
    expect(transcript[0]?._attachedFiles).toEqual([pendingImage]);
  });

  it('settles the local user message after final_without_message is reconciled by final assistant history', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: [{
            id: 'user-local-1',
            clientId: 'user-local-1',
            messageId: 'user-local-1',
            role: 'user',
            status: 'sending',
            content: 'hello world',
            timestamp: 1_700_000_000,
          }],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            pendingFinal: false,
            runPhase: 'streaming',
            lastUserMessageAt: 1_700_000_000_000,
          },
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: false,
      refreshing: false,
      snapshotReady: true,
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    handleStoreFinalEvent({
      set,
      get,
      event: {
        state: 'final',
        runId: 'run-1',
      },
      resolvedState: 'final',
      currentSessionKey: requestedSessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow([
      {
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'done',
        timestamp: 1_700_000_001,
      },
    ]));

    expect(state.loadedSessions[requestedSessionKey]?.runtime.runPhase).toBe('done');
    expect(state.loadedSessions[requestedSessionKey]?.messages).toHaveLength(2);
    expect(state.loadedSessions[requestedSessionKey]?.messages.map((message) => message.id)).toEqual([
      'user-local-1',
      'assistant-final-1',
    ]);
  });

  it('preserves the committed local user turn when history final arrives before canonical user writeback', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: [
            {
              id: 'user-local-1',
              role: 'user',
              content: 'hello world',
              timestamp: 1,
              _attachedFiles: [{
                fileName: 'a.png',
                mimeType: 'image/png',
                fileSize: 1,
                preview: 'data:image/png;base64,abc',
              }],
            },
            {
              id: 'assistant-local-1',
              messageId: 'assistant-final-1',
              role: 'assistant',
              content: 'done',
              timestamp: 2,
            },
          ],
          runtime: {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            runPhase: 'done',
          },
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: false,
      refreshing: false,
      snapshotReady: true,
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow([
      {
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'done',
        timestamp: 2,
      },
    ]));

    expect(state.loadedSessions[requestedSessionKey]?.messages.map((message) => message.id)).toEqual([
      'user-local-1',
      'assistant-local-1',
    ]);
    expect(state.loadedSessions[requestedSessionKey]?.messages[0]?._attachedFiles).toEqual([{
      fileName: 'a.png',
      mimeType: 'image/png',
      fileSize: 1,
      preview: 'data:image/png;base64,abc',
    }]);
  });

  it('preserves the committed local user id when canonical history user arrives later', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: [
            {
              id: 'user-local-1',
              role: 'user',
              content: 'hello world',
              timestamp: 1,
            },
            {
              id: 'assistant-local-1',
              messageId: 'assistant-final-1',
              role: 'assistant',
              content: 'done',
              timestamp: 2,
            },
          ],
          runtime: {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            runPhase: 'done',
          },
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: false,
      refreshing: false,
      snapshotReady: true,
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow([
      {
        id: 'gateway-user-1',
        role: 'user',
        content: 'hello world [message_id: user-local-1]',
        timestamp: 1,
      },
      {
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'done',
        timestamp: 2,
      },
    ]));

    expect(state.loadedSessions[requestedSessionKey]?.messages.map((message) => message.id)).toEqual([
      'user-local-1',
      'assistant-local-1',
    ]);
  });

  it('does not duplicate the assistant message when canonical final lands before a late live final without ids', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: [
            {
              id: 'user-local-1',
              clientId: 'user-local-1',
              messageId: 'user-local-1',
              role: 'user',
              status: 'sending',
              content: 'hello world',
              timestamp: sentAtMs / 1000,
            },
            {
              ...createStreamingAssistantMessage('assistant-local-1', 'done', (sentAtMs + 1000) / 1000),
            },
          ],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            pendingFinal: false,
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            streamingMessageId: 'assistant-local-1',
          },
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: false,
      refreshing: false,
      snapshotReady: true,
      error: null,
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow([
      {
        id: 'gateway-final-1',
        role: 'assistant',
        content: 'done',
        timestamp: (sentAtMs + 1000) / 1000,
      },
    ]));

    handleStoreFinalEvent({
      set,
      get,
      event: {
        message: {
          role: 'assistant',
          content: 'done',
          timestamp: (sentAtMs + 1000) / 1000,
        },
      },
      resolvedState: 'final',
      currentSessionKey: requestedSessionKey,
      eventRunId: 'run-1',
      snapshot: {
        reset: () => {},
        armIfIdle: () => {},
        consume: () => null,
      },
      onMaybeTrackFirstTokenFinal: () => {},
    });

    expect(state.loadedSessions[requestedSessionKey]?.messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(state.loadedSessions[requestedSessionKey]?.messages.map((message) => ({
      id: message.id,
      messageId: message.messageId ?? null,
      role: message.role,
      content: message.content,
    }))).toEqual([
      {
        id: 'user-local-1',
        messageId: 'user-local-1',
        role: 'user',
        content: 'hello world',
      },
      {
        id: 'assistant-local-1',
        messageId: 'gateway-final-1',
        role: 'assistant',
        content: 'done',
      },
    ]);
  });
});
import { createViewportWindowState } from '@/stores/chat/viewport-state';
