import { describe, expect, it, vi } from 'vitest';
import { buildQuickRawHistoryFingerprint } from '@/stores/chat/store-state-helpers';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-apply-pipeline';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';

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
  transcript?: RawMessage[];
  ready?: boolean;
  thinkingLevel?: string | null;
  label?: string | null;
  lastActivityAt?: number | null;
  runtime?: Partial<ChatStoreState['sessionsByKey'][string]['runtime']>;
}) {
  return {
    transcript: input?.transcript ?? [],
    meta: {
      label: input?.label ?? null,
      lastActivityAt: input?.lastActivityAt ?? null,
      ready: input?.ready ?? false,
      thinkingLevel: input?.thinkingLevel ?? null,
    },
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'idle' as const,
      pendingUserMessage: null,
      streamingMessage: null,
      streamRuntime: null,
      streamingTools: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      pendingToolImages: [],
      approvalStatus: 'idle' as const,
      ...input?.runtime,
    },
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
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          transcript: rawMessages,
          thinkingLevel: null,
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: true,
      refreshing: false,
      snapshotReady: false,
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

    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.snapshotReady).toBe(true);
    expect(state.sessionsByKey[requestedSessionKey]?.meta.ready).toBe(true);
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
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          transcript: [],
          ready: true,
          thinkingLevel: null,
        }),
      },
      pendingApprovalsBySession: {},
      initialLoading: true,
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

    await applyLoadedMessages(rawMessages, null);

    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.snapshotReady).toBe(true);
    expect(state.sessionsByKey[requestedSessionKey]?.meta.ready).toBe(true);
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
      sessionsByKey: {
        'agent:main:main': createSessionRecord({
          transcript: currentMessages,
        }),
        [requestedSessionKey]: createSessionRecord(),
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
      mode: 'quiet',
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(rawMessages, null);

    expect(state.currentSessionKey).toBe('agent:main:main');
    expect(state.sessionsByKey['agent:main:main']?.transcript).toBe(currentMessages);
    expect(state.sessionsByKey[requestedSessionKey]?.meta.ready).toBe(true);
    expect(state.sessionsByKey[requestedSessionKey]?.transcript).toHaveLength(1);
    expect(state.sessionsByKey[requestedSessionKey]?.transcript[0]?.content).toBe('another session content');
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
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord(),
      },
      pendingApprovalsBySession: {},
      initialLoading: true,
      refreshing: false,
      snapshotReady: false,
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

    expect(state.initialLoading).toBe(false);
    expect(state.snapshotReady).toBe(true);
    expect(state.sessionsByKey[requestedSessionKey]?.meta.ready).toBe(true);
    expect(state.sessionsByKey[requestedSessionKey]?.transcript).toHaveLength(32);
    expect(state.sessionsByKey[requestedSessionKey]?.transcript.at(0)?.id).toBe('message-1');
    expect(state.sessionsByKey[requestedSessionKey]?.transcript.at(-1)?.id).toBe('message-32');
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
      sessionsByKey: {
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

    await applyLoadedMessages(rawMessages, null);

    expect(state.sessionsByKey[requestedSessionKey]?.runtime.pendingUserMessage).toBeNull();
    expect(state.sessionsByKey[requestedSessionKey]?.transcript[0]?.id).toBe(pendingUserId);
  });

  it('reuses the current transcript reference when history payload is semantically unchanged', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const transcript: RawMessage[] = [
      { role: 'assistant', content: 'same content', timestamp: 1, id: 'assistant-1' },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          transcript,
          ready: true,
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

    await applyLoadedMessages([{ role: 'assistant', content: 'same content', timestamp: 1, id: 'assistant-1' }], null);

    expect(state.sessionsByKey[requestedSessionKey]?.transcript).toBe(transcript);
  });

  it('reuses unchanged message references when history only patches part of the transcript', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const transcript: RawMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'draft', timestamp: 2, id: 'assistant-1' },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          transcript,
          ready: true,
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

    await applyLoadedMessages([
      { role: 'user', content: 'hello', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'final', timestamp: 2, id: 'assistant-1' },
    ], null);

    const nextTranscript = state.sessionsByKey[requestedSessionKey]?.transcript ?? [];
    expect(nextTranscript).not.toBe(transcript);
    expect(nextTranscript[0]).toBe(transcript[0]);
    expect(nextTranscript[1]).not.toBe(transcript[1]);
  });

  it('clears the settled assistant overlay after background history apply confirms the final transcript', async () => {
    trackUiTimingMock.mockReset();
    const requestedSessionKey = 'agent:main:main';
    const transcript: RawMessage[] = [
      { role: 'assistant', content: 'final answer', timestamp: 1, id: 'assistant-1' },
    ];

    const historyRuntime = createHistoryRuntimeHarness();
    let state = {
      currentSessionKey: requestedSessionKey,
      sessionsByKey: {
        [requestedSessionKey]: createSessionRecord({
          transcript,
          ready: true,
          runtime: {
            sending: false,
            activeRunId: null,
            pendingFinal: false,
            runPhase: 'done',
            assistantOverlay: {
              runId: 'run-1',
              messageId: 'assistant-1',
              sourceMessage: {
                role: 'assistant',
                content: 'final answer',
                timestamp: 1,
                id: 'assistant-1',
              },
              committedText: 'final answer',
              targetText: 'final answer',
              status: 'finalizing',
              rafId: null,
            },
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
      mode: 'quiet',
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages([
      { role: 'assistant', content: 'final answer', timestamp: 1, id: 'assistant-1' },
    ], null);

    expect(state.sessionsByKey[requestedSessionKey]?.runtime.assistantOverlay).toBeNull();
    expect(state.sessionsByKey[requestedSessionKey]?.transcript).toBe(transcript);
  });
});
