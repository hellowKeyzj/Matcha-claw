import { describe, expect, it } from 'vitest';
import { createApplyLoadedMessagesPipeline } from '@/stores/chat/history-load-execution';
import {
  createEmptySessionRecord,
  getSessionItems,
  patchSessionSnapshot,
} from '@/stores/chat/store-state-helpers';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { HistoryWindowResult } from '@/stores/chat/history-fetch-helpers';
import type { ChatStoreState } from '@/stores/chat/types';
import type { RawMessage } from './helpers/timeline-fixtures';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

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
  const items = buildRenderItemsFromMessages(sessionKey, messages);
  const agentId = sessionKey.split(':')[1] ?? 'main';
  const suffix = sessionKey.split(':').slice(2).join(':');
  const kind = suffix === 'main'
    ? 'main'
    : (suffix.startsWith('subagent:') ? 'subsession' : 'session');
  return {
    sessionKey,
    revision: runtimeOverrides.revision ?? 1,
    runEpoch: runtimeOverrides.runEpoch ?? 1,
    catalog: {
      key: sessionKey,
      agentId,
      kind,
      preferred: kind === 'main',
      displayName: sessionKey,
      updatedAt: items[items.length - 1]?.createdAt,
    },
    items,
    replayComplete: true,
    runtime: {
      revision: runtimeOverrides.revision ?? 1,
      runEpoch: runtimeOverrides.runEpoch ?? 1,
      sending: false,
      activeRunId: null,
      runPhase: 'done' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: false,
      lastUserMessageAt: null,
      updatedAt: 1,
      ...runtimeOverrides,
    },
    window: {
      totalItemCount: items.length,
      windowStartOffset: 0,
      windowEndOffset: items.length,
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
  const snapshot = overrides.snapshot ?? createSnapshot(sessionKey, messages);
  return {
    snapshot,
    thinkingLevel: overrides.thinkingLevel ?? null,
    totalItemCount: snapshot.window.totalItemCount,
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
  it('drops stale snapshots atomically so pending items cannot revive after abort', () => {
    const sessionKey = 'agent:main:main';
    const currentMessages: RawMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1, id: 'user-1' },
    ];
    const staleMessages: RawMessage[] = [
      { role: 'user', content: 'hello', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: '', timestamp: 2, id: 'assistant-pending', status: 'sending' },
    ];
    const current = createEmptySessionRecord();
    const abortedSnapshot = createSnapshot(sessionKey, currentMessages, {
      revision: 3,
      runEpoch: 2,
      runPhase: 'aborted',
      updatedAt: 3,
    });
    const staleSnapshot = createSnapshot(sessionKey, staleMessages, {
      revision: 2,
      runEpoch: 1,
      sending: true,
      activeRunId: 'run-old',
      runPhase: 'streaming',
      updatedAt: 2,
    });
    const firstState = {
      loadedSessions: {
        [sessionKey]: current,
      },
    } as Pick<ChatStoreState, 'loadedSessions'>;
    const loadedSessions = patchSessionSnapshot(
      firstState,
      sessionKey,
      abortedSnapshot,
    );
    const staleResult = patchSessionSnapshot(
      { loadedSessions },
      sessionKey,
      staleSnapshot,
    );

    expect(staleResult).toBe(loadedSessions);
    expect(getSessionItems({ loadedSessions: staleResult }, sessionKey)).toHaveLength(1);
    expect(staleResult[sessionKey]?.runtime).toMatchObject({
      revision: 3,
      runEpoch: 2,
      sending: false,
      runPhase: 'aborted',
    });
  });

  it('stale canonical final text can repair existing final items without rolling runtime back', () => {
    const sessionKey = 'agent:main:main';
    const currentShortMessages: RawMessage[] = [
      { role: 'user', content: 'write file', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: '已', timestamp: 2, id: 'assistant-1' },
    ];
    const canonicalMessages: RawMessage[] = [
      { role: 'user', content: 'write file', timestamp: 1, id: 'user-1' },
      { role: 'assistant', content: '已写入。', timestamp: 2, id: 'assistant-1' },
    ];
    const current = {
      ...createEmptySessionRecord(),
      items: createSnapshot(sessionKey, currentShortMessages, {
        revision: 3,
        runEpoch: 2,
        runPhase: 'done',
        updatedAt: 3,
      }).items,
      runtime: {
        ...createEmptySessionRecord().runtime,
        revision: 3,
        runEpoch: 2,
        runPhase: 'done',
        updatedAt: 3,
      },
    };
    const staleCanonicalSnapshot = createSnapshot(sessionKey, canonicalMessages, {
      revision: 2,
      runEpoch: 1,
      sending: true,
      activeRunId: 'run-old',
      runPhase: 'streaming',
      updatedAt: 2,
    });

    const loadedSessions = patchSessionSnapshot(
      {
        loadedSessions: {
          [sessionKey]: current,
        },
      } as Pick<ChatStoreState, 'loadedSessions'>,
      sessionKey,
      staleCanonicalSnapshot,
    );

    expect(getSessionItems({ loadedSessions }, sessionKey)).toMatchObject([
      expect.objectContaining({ kind: 'user-message', text: 'write file' }),
      expect.objectContaining({ kind: 'assistant-turn', text: '已写入。' }),
    ]);
    expect(loadedSessions[sessionKey]?.runtime).toMatchObject({
      revision: 3,
      runEpoch: 2,
      sending: false,
      activeRunId: null,
      runPhase: 'done',
    });
  });

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
    expect(getSessionItems(harness.get(), sessionKey)).toMatchObject([
      expect.objectContaining({ text: 'hello' }),
      expect.objectContaining({ text: 'done' }),
    ]);
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
          items: createSnapshot(currentSessionKey, currentMessages).items,
        },
        [requestedSessionKey]: createEmptySessionRecord(),
      },
      pendingApprovalsBySession: {},
      foregroundHistorySessionKey: null,
    } as ChatStoreState);
    const currentItemsRef = getSessionItems(harness.get(), currentSessionKey);

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

    expect(getSessionItems(harness.get(), currentSessionKey)).toBe(currentItemsRef);
    expect(getSessionItems(harness.get(), requestedSessionKey)).toMatchObject([
      expect.objectContaining({ text: 'worker update' }),
    ]);
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
          items: createSnapshot(sessionKey, localOptimistic).items,
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

    expect(getSessionItems(harness.get(), sessionKey)).toMatchObject([
      expect.objectContaining({ kind: 'user-message', key: 'session:agent:main:main|entry:user-server-1', text: 'hello' }),
      expect.objectContaining({ kind: 'assistant-turn', text: 'done' }),
    ]);
    expect(getSessionItems(harness.get(), sessionKey)).toHaveLength(2);
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

  it('active run期间的history snapshot不能冲掉当前pending assistant turn', async () => {
    const sessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const harness = createStateHarness({
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createEmptySessionRecord(),
          items: [{
            key: `session:${sessionKey}|assistant-turn:main:run-1:main`,
            kind: 'assistant-turn',
            sessionKey,
            role: 'assistant',
            turnKey: 'main:run-1',
            laneKey: 'main',
            identitySource: 'run',
            identityMode: 'run',
            identityConfidence: 'strong',
            status: 'streaming',
            segments: [],
            thinking: null,
            tools: [],
            embeddedToolResults: [],
            text: '',
            images: [],
            attachedFiles: [],
            pendingState: 'typing',
            updatedAt: 1,
          }],
          runtime: {
            ...createEmptySessionRecord().runtime,
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'submitted',
            pendingTurnKey: 'main:run-1',
            pendingTurnLaneKey: 'main',
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
      ...createHistoryWindow(sessionKey, []),
      snapshot: createSnapshot(sessionKey, [], {
        sending: true,
        activeRunId: 'run-1',
        runPhase: 'submitted',
        pendingTurnKey: 'main:run-1',
        pendingTurnLaneKey: 'main',
      }),
    });

    expect(getSessionItems(harness.get(), sessionKey)).toEqual([
      expect.objectContaining({
        kind: 'assistant-turn',
        turnKey: 'main:run-1',
        laneKey: 'main',
        status: 'streaming',
      }),
    ]);
    expect(harness.get().loadedSessions[sessionKey]?.runtime).toMatchObject({
      sending: true,
      activeRunId: 'run-1',
      pendingTurnKey: 'main:run-1',
      runPhase: 'submitted',
    });
  });
});

