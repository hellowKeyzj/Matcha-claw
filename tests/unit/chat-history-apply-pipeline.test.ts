import { describe, expect, it } from 'vitest';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-load-execution';
import {
  createEmptySessionRecord,
  getSessionTimelineEntries,
} from '@/stores/chat/store-state-helpers';
import { buildTimelineEntriesFromMessages, materializeTimelineMessages } from '@/stores/chat/timeline-message';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { HistoryWindowResult } from '@/stores/chat/history-fetch-helpers';
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
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createSnapshot(sessionKey: string, messages: RawMessage[], runtimeOverrides: Partial<HistoryWindowResult['snapshot']['runtime']> = {}) {
  const entries = buildTimelineEntriesFromMessages(sessionKey, messages);
  return {
    sessionKey,
    entries,
    replayComplete: true,
    runtime: {
      sending: false,
      activeRunId: null,
      runPhase: 'done' as const,
      streamingMessageId: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      updatedAt: 1,
      ...runtimeOverrides,
    },
    window: {
      totalEntryCount: entries.length,
      windowStartOffset: 0,
      windowEndOffset: entries.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    },
  };
}

function createHistoryWindow(
  sessionKey: string,
  messages: RawMessage[],
  overrides: Partial<HistoryWindowResult> = {},
): HistoryWindowResult {
  return {
    snapshot: createSnapshot(sessionKey, messages),
    thinkingLevel: overrides.thinkingLevel ?? null,
    totalMessageCount: messages.length,
    windowStartOffset: 0,
    windowEndOffset: messages.length,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
    ...overrides,
  };
}

function createStateHarness(state: ChatStoreState) {
  let currentState = state;
  const set = (
    partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  ) => {
    const patch = typeof partial === 'function' ? partial(currentState) : partial;
    currentState = { ...currentState, ...patch } as ChatStoreState;
  };
  return {
    set,
    get: () => currentState,
  };
}

describe('chat history apply pipeline', () => {
  it('foreground apply writes authoritative snapshot into the requested session', async () => {
    const sessionKey = 'agent:main:main';
    const rawMessages: RawMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: 'done', timestamp: 2, id: 'assistant-1' },
    ];
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: createEmptySessionRecord(),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(sessionKey, rawMessages));

    expect(harness.get().loadedSessions[sessionKey]?.meta.historyStatus).toBe('ready');
    expect(materializeTimelineMessages(getSessionTimelineEntries(harness.get(), sessionKey))).toMatchObject(rawMessages);
    expect(harness.get().loadedSessions[sessionKey]?.runtime.runPhase).toBe('done');
  });

  it('background apply only updates the target session snapshot', async () => {
    const currentSessionKey = 'agent:main:main';
    const requestedSessionKey = 'agent:worker:main';
    const currentMessages: RawMessage[] = [
      { role: 'assistant', content: 'keep me', timestamp: 1, id: 'assistant-current' },
    ];
    const targetMessages: RawMessage[] = [
      { role: 'assistant', content: 'worker update', timestamp: 2, id: 'assistant-worker' },
    ];
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey,
      loadedSessions: {
        [currentSessionKey]: {
          ...createEmptySessionRecord(),
          timelineEntries: buildTimelineEntriesFromMessages(currentSessionKey, currentMessages),
        },
        [requestedSessionKey]: createEmptySessionRecord(),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
    } as ChatStoreState);
    const currentEntriesRef = getSessionTimelineEntries(harness.get(), currentSessionKey);

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey,
      scope: 'background',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(requestedSessionKey, targetMessages));

    expect(getSessionTimelineEntries(harness.get(), currentSessionKey)).toBe(currentEntriesRef);
    expect(materializeTimelineMessages(getSessionTimelineEntries(harness.get(), requestedSessionKey))).toMatchObject(targetMessages);
  });

  it('authoritative snapshot replaces stale local optimistic messages instead of front-end canonical reconcile', async () => {
    const sessionKey = 'agent:main:main';
    const localOptimistic: RawMessage[] = [
      {
        role: 'user',
        content: 'hello',
        timestamp: 1,
        id: 'user-local-1',
        messageId: 'user-local-1',
        status: 'sending',
      },
    ];
    const authoritative: RawMessage[] = [
      {
        role: 'user',
        content: 'hello',
        timestamp: 1,
        id: 'user-server-1',
      },
      {
        role: 'assistant',
        content: 'done',
        timestamp: 2,
        id: 'assistant-1',
      },
    ];
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createEmptySessionRecord(),
          timelineEntries: buildTimelineEntriesFromMessages(sessionKey, localOptimistic),
        },
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages(createHistoryWindow(sessionKey, authoritative));

    expect(materializeTimelineMessages(getSessionTimelineEntries(harness.get(), sessionKey))).toMatchObject(authoritative);
    expect(getSessionTimelineEntries(harness.get(), sessionKey)).toHaveLength(2);
  });

  it('completed snapshot clears pending run state through authoritative runtime', async () => {
    const sessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createEmptySessionRecord(),
          runtime: {
            ...createEmptySessionRecord().runtime,
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming',
          },
        },
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: sessionKey,
    } as ChatStoreState);

    const applyLoadedMessages = createApplyLoadedMessagesPipeline({
      set: harness.set,
      get: harness.get,
      historyRuntime,
      requestedSessionKey: sessionKey,
      scope: 'foreground',
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
    });

    await applyLoadedMessages({
      ...createHistoryWindow(sessionKey, [
        { role: 'assistant', content: 'done', timestamp: 2, id: 'assistant-1' },
      ]),
      snapshot: createSnapshot(sessionKey, [
        { role: 'assistant', content: 'done', timestamp: 2, id: 'assistant-1' },
      ], {
        sending: false,
        activeRunId: null,
        runPhase: 'done',
      }),
    });

    expect(harness.get().loadedSessions[sessionKey]?.runtime.sending).toBe(false);
    expect(harness.get().loadedSessions[sessionKey]?.runtime.activeRunId).toBeNull();
    expect(harness.get().loadedSessions[sessionKey]?.runtime.runPhase).toBe('done');
  });
});
