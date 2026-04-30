import { describe, expect, it, vi } from 'vitest';
import { buildQuickRawHistoryFingerprint } from '@/stores/chat/store-state-helpers';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-apply-pipeline';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

const trackUiTimingMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/telemetry', () => ({
  trackUiTiming: (...args: unknown[]) => trackUiTimingMock(...args),
}));

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
  historyStatus?: ChatStoreState['loadedSessions'][string]['meta']['historyStatus'];
  thinkingLevel?: string | null;
  label?: string | null;
  lastActivityAt?: number | null;
  runtime?: Partial<ChatStoreState['loadedSessions'][string]['runtime']>;
}) {
  return {
    meta: {
      label: input?.label ?? null,
      lastActivityAt: input?.lastActivityAt ?? null,
      historyStatus: input?.historyStatus ?? 'idle',
      thinkingLevel: input?.thinkingLevel ?? null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      pendingUserMessage: null,
      streamingMessageId: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
      ...input?.runtime,
    },
    window: createViewportWindowState({
      messages: input?.messages ?? [],
      totalMessageCount: input?.messages?.length ?? 0,
      windowStartOffset: 0,
      windowEndOffset: input?.messages?.length ?? 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }),
  };
}

describe('chat history apply pipeline', () => {
  it('quick-fingerprint path skips heavy pipeline and only resolves readiness/loading state', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const rawMessages: RawMessage[] = [
      { role: 'assistant', content: 'hello', timestamp: 1 },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    historyRuntime.historyQuickFingerprintBySession.set(
      requestedSessionKey,
      buildQuickRawHistoryFingerprint(rawMessages, null),
    );

    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: rawMessages,
          thinkingLevel: null,
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: requestedSessionKey,
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

    await applyLoadedMessages(rawMessages, null);

    expect(state.loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
    const metricEvents = trackUiTimingMock.mock.calls.map((call) => call[0]);
    expect(metricEvents).not.toContain('chat.history_apply_normalize');
  });

  it('quick-fingerprint path also short-circuits for ready empty snapshot', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const rawMessages: RawMessage[] = [];

    const historyRuntime = createHistoryRuntimeHarness();
    historyRuntime.historyQuickFingerprintBySession.set(
      requestedSessionKey,
      buildQuickRawHistoryFingerprint(rawMessages, null),
    );

    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: [],
          historyStatus: 'ready',
          thinkingLevel: null,
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: requestedSessionKey,
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

    await applyLoadedMessages(rawMessages, null);

    expect(state.loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
    const metricEvents = trackUiTimingMock.mock.calls.map((call) => call[0]);
    expect(metricEvents).not.toContain('chat.history_apply_normalize');
  });

  it('background apply updates target session runtime without overwriting current foreground messages', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:another:main';
    const rawMessages: RawMessage[] = [
      { role: 'assistant', content: 'another session content', timestamp: 2 },
    ];
    const currentMessages: RawMessage[] = [
      { role: 'assistant', content: 'current session content', timestamp: 1 },
    ];
    const historyRuntime = createHistoryRuntimeHarness();

    let state = {
      currentSessionKey: 'agent:main:main',
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          messages: currentMessages,
        }),
        [requestedSessionKey]: createSessionRecord(),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
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
      mode: 'quiet',
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(rawMessages, null);

    expect(state.currentSessionKey).toBe('agent:main:main');
    expect(state.loadedSessions['agent:main:main']?.window.messages).toBe(currentMessages);
    expect(state.loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(state.loadedSessions[requestedSessionKey]?.window.messages).toHaveLength(1);
    expect(state.loadedSessions[requestedSessionKey]?.window.messages[0]?.content).toBe('another session content');
  });

  it('foreground apply writes the full canonical transcript into the requested session record', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const rawMessages: RawMessage[] = Array.from({ length: 32 }, (_, index) => ({
      role: index % 2 === 0 ? 'assistant' : 'user',
      content: index % 2 === 0
        ? Array.from(
          { length: 320 },
          (_, line) => `message-${index + 1}-line-${line}: [OpenAI](https://openai.com) with **bold** text and \`code\``,
        ).join('\n\n')
        : `user message ${index + 1}`,
      timestamp: index + 1,
      id: `message-${index + 1}`,
    }));

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord(),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: requestedSessionKey,
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

    await applyLoadedMessages(rawMessages, null);

    expect(state.loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(state.loadedSessions[requestedSessionKey]?.window.messages).toHaveLength(32);
    expect(state.loadedSessions[requestedSessionKey]?.window.messages.at(0)?.id).toBe('message-1');
    expect(state.loadedSessions[requestedSessionKey]?.window.messages.at(-1)?.id).toBe('message-32');
  });

  it('foreground apply commits pending user overlay into canonical transcript and clears the overlay', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const pendingUserId = 'user-local-1';
    const rawMessages: RawMessage[] = [
      { role: 'user', content: 'hello world [message_id: user-local-1]', timestamp: 1, id: 'gateway-user-1' },
      { role: 'assistant', content: 'done', timestamp: 2, id: 'assistant-1' },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          runtime: {
            sending: true,
            pendingUserMessage: {
              clientMessageId: pendingUserId,
              createdAtMs: 1_700_000_000_000,
              message: {
                role: 'user',
                content: 'hello world',
                timestamp: 1,
                id: pendingUserId,
              },
            },
          },
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
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

    await applyLoadedMessages(rawMessages, null);

    expect(state.loadedSessions[requestedSessionKey]?.runtime.pendingUserMessage).toBeNull();
    expect(state.loadedSessions[requestedSessionKey]?.window.messages[0]?.id).toBe(pendingUserId);
  });

  it('reuses the current message window reference when history payload is semantically unchanged', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const existingMessages: RawMessage[] = [
      { role: 'assistant', content: 'same content', timestamp: 1, id: 'assistant-1' },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: existingMessages,
          historyStatus: 'ready',
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
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

    await applyLoadedMessages([{ role: 'assistant', content: 'same content', timestamp: 1, id: 'assistant-1' }], null);

    expect(state.loadedSessions[requestedSessionKey]?.window.messages).toBe(existingMessages);
  });

  it('reuses unchanged message references when history only patches part of the message window', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const existingMessages: RawMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'draft', timestamp: 2, id: 'assistant-1' },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: existingMessages,
          historyStatus: 'ready',
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
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

    await applyLoadedMessages([
      { role: 'user', content: 'hello', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'final', timestamp: 2, id: 'assistant-1' },
    ], null);

    const nextMessages = state.loadedSessions[requestedSessionKey]?.window.messages ?? [];
    expect(nextMessages).not.toBe(existingMessages);
    expect(nextMessages[0]).toBe(existingMessages[0]);
    expect(nextMessages[1]).not.toBe(existingMessages[1]);
  });

  it('keeps the settled transcript stable after background history apply confirms the final message window', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const existingMessages: RawMessage[] = [
      { role: 'assistant', content: 'final answer', timestamp: 1, id: 'assistant-1' },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createSessionRecord({
          messages: existingMessages,
          historyStatus: 'ready',
          runtime: {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            runPhase: 'done',
            streamingMessageId: null,
          },
        }),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
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
      mode: 'quiet',
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages([
      { role: 'assistant', content: 'final answer', timestamp: 1, id: 'assistant-1' },
    ], null);

    expect(state.loadedSessions[requestedSessionKey]?.window.messages).toBe(existingMessages);
  });
});

