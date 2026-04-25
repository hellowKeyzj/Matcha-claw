import { describe, expect, it, vi } from 'vitest';
import { createStoreEventActions } from '@/stores/chat/event-actions';
import { handleStoreFinalEvent } from '@/stores/chat/event-handlers';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-apply-pipeline';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import { selectStreamingRenderMessage, createAssistantOverlay } from '@/stores/chat/stream-overlay-message';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';

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
    historyProbeFingerprintBySession: new Map<string, string>(),
    historyQuickFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createSessionRecord(input?: {
  transcript?: RawMessage[];
  runtime?: Partial<ChatStoreState['sessionsByKey'][string]['runtime']>;
}) {
  return {
    transcript: input?.transcript ?? [],
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
      assistantOverlay: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
      ...input?.runtime,
    },
  };
}

describe('chat stream finalization identity', () => {
  it('commits assistant final immediately with the existing overlay message id', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      sessionsByKey: {
        [sessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            assistantOverlay: createAssistantOverlay({
              runId: 'run-1',
              messageId: 'assistant-local-1',
              sourceMessage: {
                id: 'assistant-local-1',
                role: 'assistant',
                content: 'hello',
                timestamp: sentAtMs / 1000,
              },
              committedText: 'hello',
              targetText: 'hello',
              status: 'streaming',
            }),
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
      onBeginFinalToHistory: () => {},
    });

    const transcript = state.sessionsByKey[sessionKey]!.transcript;
    const runtime = state.sessionsByKey[sessionKey]!.runtime;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: 'assistant-local-1',
      role: 'assistant',
      content: 'hello world',
    });
    expect(runtime.assistantOverlay).toBeNull();
    expect(selectStreamingRenderMessage(runtime)).toBeNull();
    expect(runtime.sending).toBe(false);
    expect(runtime.pendingFinal).toBe(false);
  });

  it('commits the final assistant message into transcript with the existing overlay message id', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      sessionsByKey: {
        [sessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            assistantOverlay: createAssistantOverlay({
              runId: 'run-1',
              messageId: 'assistant-local-1',
              sourceMessage: {
                id: 'assistant-local-1',
                role: 'assistant',
                content: 'hello world',
                timestamp: sentAtMs / 1000,
              },
              committedText: 'hello world',
              targetText: 'hello world',
              status: 'streaming',
            }),
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
      onBeginFinalToHistory: () => {},
    });

    const transcript = state.sessionsByKey[sessionKey]!.transcript;
    const runtime = state.sessionsByKey[sessionKey]!.runtime;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]?.id).toBe('assistant-local-1');
    expect(transcript[0]?.content).toBe('hello world');
    expect(runtime.assistantOverlay).toBeNull();
    expect(state.loadHistory).toHaveBeenCalledWith({
      sessionKey,
      mode: 'quiet',
      scope: 'background',
      reason: 'final_event_reconcile',
    });
  });

  it('preserves the local assistant id when final history refresh writes back the canonical transcript', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const currentMessages: RawMessage[] = [{
      id: 'assistant-local-1',
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
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          transcript: currentMessages,
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
      optimisticUserReconcileWindowMs: 15_000,
    });

    await applyLoadedMessages(rawMessages, null);

    expect(state.sessionsByKey[requestedSessionKey]?.transcript).toHaveLength(1);
    expect(state.sessionsByKey[requestedSessionKey]?.transcript[0]?.id).toBe('assistant-local-1');
  });

  it('treats reply_to colon prefix as assistant metadata during history reconcile', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const currentMessages: RawMessage[] = [{
      id: 'assistant-local-1',
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
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          transcript: currentMessages,
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
      optimisticUserReconcileWindowMs: 15_000,
    });

    await applyLoadedMessages(rawMessages, null);

    expect(state.sessionsByKey[requestedSessionKey]?.transcript).toHaveLength(1);
    expect(state.sessionsByKey[requestedSessionKey]?.transcript[0]?.id).toBe('assistant-local-1');
    expect(state.sessionsByKey[requestedSessionKey]?.transcript[0]?.content).toBe('[[reply_to:f4a00548-42a8-4826-8e45-0a655d7c6414]]好，我继续。');
  });

  it('keeps the raw streaming source message for tool turns while render projection strips tool blocks', () => {
    const runtime = createSessionRecord({
      runtime: {
        sending: true,
        activeRunId: 'run-1',
        runPhase: 'streaming',
        lastUserMessageAt: 1_700_000_000_000,
        assistantOverlay: createAssistantOverlay({
          runId: 'run-1',
          messageId: 'assistant-local-1',
          sourceMessage: {
            id: 'assistant-local-1',
            role: 'assistant',
            content: [
              { type: 'text', text: 'hello world' },
              { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/tmp/a.ts' } },
            ],
            timestamp: 1_700_000_000,
          },
          committedText: 'hello',
          targetText: 'hello world',
          status: 'streaming',
        }),
      },
    }).runtime;

    expect(Array.isArray(runtime.assistantOverlay?.sourceMessage?.content)).toBe(true);
    expect((runtime.assistantOverlay?.sourceMessage?.content as Array<{ type: string }>).some((block) => block.type === 'tool_use')).toBe(true);

    const renderMessage = selectStreamingRenderMessage(runtime);
    expect(renderMessage?.id).toBe('assistant-local-1');
    expect(renderMessage?.content).toEqual([
      { type: 'text', text: 'hello' },
    ]);
  });

  it('returns a stable render message reference while overlay state is unchanged', () => {
    const runtime = createSessionRecord({
      runtime: {
        sending: true,
        activeRunId: 'run-1',
        runPhase: 'streaming',
        lastUserMessageAt: 1_700_000_000_000,
        assistantOverlay: createAssistantOverlay({
          runId: 'run-1',
          messageId: 'assistant-local-1',
          sourceMessage: {
            id: 'assistant-local-1',
            role: 'assistant',
            content: 'hello world',
            timestamp: 1_700_000_000,
          },
          committedText: 'hello',
          targetText: 'hello world',
          status: 'streaming',
        }),
      },
    }).runtime;

    const first = selectStreamingRenderMessage(runtime);
    const second = selectStreamingRenderMessage(runtime);

    expect(second).toBe(first);
  });

  it('commits authoritative user final by client message id and clears pending user overlay', () => {
    const sessionKey = 'agent:main:main';
    let state = {
      currentSessionKey: sessionKey,
      sessionsByKey: {
        [sessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'submitted',
            lastUserMessageAt: 1_700_000_000_000,
            pendingUserMessage: {
              clientMessageId: 'user-local-1',
              createdAtMs: 1_700_000_000_000,
              message: {
                id: 'user-local-1',
                role: 'user',
                content: 'hello world',
                timestamp: 1_700_000_000,
              },
            },
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
      onBeginFinalToHistory: () => {},
    });

    expect(state.sessionsByKey[sessionKey]?.runtime.pendingUserMessage).toBeNull();
    expect(state.sessionsByKey[sessionKey]?.runtime.runPhase).toBe('submitted');
    expect(state.sessionsByKey[sessionKey]?.transcript).toHaveLength(1);
    expect(state.sessionsByKey[sessionKey]?.transcript[0]?.id).toBe('user-local-1');
  });

  it('clears pending user overlay when assistant final is committed', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      sessionsByKey: {
        [sessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            pendingUserMessage: {
              clientMessageId: 'user-local-1',
              createdAtMs: sentAtMs,
              message: {
                id: 'user-local-1',
                role: 'user',
                content: 'hello world',
                timestamp: sentAtMs / 1000,
              },
            },
            assistantOverlay: createAssistantOverlay({
              runId: 'run-1',
              messageId: 'assistant-local-1',
              sourceMessage: {
                id: 'assistant-local-1',
                role: 'assistant',
                content: 'hello',
                timestamp: sentAtMs / 1000,
              },
              committedText: 'hello',
              targetText: 'hello',
              status: 'streaming',
            }),
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
      onBeginFinalToHistory: () => {},
    });

    expect(state.sessionsByKey[sessionKey]?.runtime.pendingUserMessage).toBeNull();
  });

  it('does not let an unbound final event terminate the active run', () => {
    const sessionKey = 'agent:main:main';
    const sentAtMs = Date.now();
    let state = {
      currentSessionKey: sessionKey,
      sessionsByKey: {
        [sessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-active',
            runPhase: 'submitted',
            lastUserMessageAt: sentAtMs,
            pendingUserMessage: {
              clientMessageId: 'user-local-1',
              createdAtMs: sentAtMs,
              message: {
                id: 'user-local-1',
                role: 'user',
                content: 'hello world',
                timestamp: sentAtMs / 1000,
              },
            },
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
    const actions = createStoreEventActions({ set, get });

    actions.handleChatEvent({
      sessionKey,
      state: 'completed',
      message: {
        id: 'stale-final-1',
        role: 'assistant',
        content: 'stale final payload',
      },
    });

    expect(state.sessionsByKey[sessionKey]?.transcript).toHaveLength(0);
    expect(state.sessionsByKey[sessionKey]?.runtime.sending).toBe(true);
    expect(state.sessionsByKey[sessionKey]?.runtime.activeRunId).toBe('run-active');
    expect(state.sessionsByKey[sessionKey]?.runtime.pendingUserMessage?.clientMessageId).toBe('user-local-1');
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
      sessionsByKey: {
        [sessionKey]: createSessionRecord({
          transcript: [{
            id: 'gateway-final-1',
            role: 'assistant',
            content: 'hello world',
            timestamp: sentAtMs / 1000,
          }],
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
            lastUserMessageAt: sentAtMs,
            pendingToolImages: [pendingImage],
            assistantOverlay: createAssistantOverlay({
              runId: 'run-1',
              messageId: 'assistant-local-1',
              sourceMessage: {
                id: 'assistant-local-1',
                role: 'assistant',
                content: 'hello world',
                timestamp: sentAtMs / 1000,
              },
              committedText: 'hello world',
              targetText: 'hello world',
              status: 'streaming',
            }),
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
      onBeginFinalToHistory: () => {},
    });

    const transcript = state.sessionsByKey[sessionKey]!.transcript;
    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toMatchObject({
      id: 'assistant-local-1',
      role: 'assistant',
      content: 'hello world',
    });
    expect(transcript[0]?._attachedFiles).toEqual([pendingImage]);
  });

  it('clears pending user after final_without_message is reconciled by final assistant history', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            activeRunId: 'run-1',
            pendingFinal: false,
            runPhase: 'streaming',
            lastUserMessageAt: 1_700_000_000_000,
            pendingUserMessage: {
              clientMessageId: 'user-local-1',
              createdAtMs: 1_700_000_000_000,
              message: {
                id: 'user-local-1',
                role: 'user',
                content: 'hello world',
                timestamp: 1_700_000_000,
              },
            },
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
      onBeginFinalToHistory: () => {},
    });

    expect(state.sessionsByKey[requestedSessionKey]?.runtime.pendingUserMessage?.clientMessageId).toBe('user-local-1');

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set,
      get,
      historyRuntime,
      requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
      optimisticUserReconcileWindowMs: 15_000,
    });

    await applyLoadedMessages([
      {
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'done',
        timestamp: 1_700_000_001,
      },
    ], null);

    expect(state.sessionsByKey[requestedSessionKey]?.runtime.pendingUserMessage).toBeNull();
    expect(state.sessionsByKey[requestedSessionKey]?.runtime.runPhase).toBe('done');
    expect(state.sessionsByKey[requestedSessionKey]?.transcript).toHaveLength(1);
    expect(state.sessionsByKey[requestedSessionKey]?.transcript[0]?.id).toBe('assistant-final-1');
  });
});
