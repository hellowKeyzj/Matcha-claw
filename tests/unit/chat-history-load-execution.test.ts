import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';
import {
  createEmptySessionRecord,
  getSessionTimelineEntries,
} from '@/stores/chat/store-state-helpers';
import { buildTimelineEntriesFromMessages, materializeTimelineMessages } from '@/stores/chat/timeline-message';

const fetchHistoryWindowMock = vi.fn();

vi.mock('@/stores/chat/history-fetch-helpers', () => ({
  fetchHistoryWindow: (...args: unknown[]) => fetchHistoryWindowMock(...args),
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
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createSnapshot(sessionKey: string, messages: RawMessage[]) {
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

function createWindowResult(sessionKey: string, messages: RawMessage[] = []) {
  return {
    snapshot: createSnapshot(sessionKey, messages),
    thinkingLevel: null,
    totalMessageCount: messages.length,
    windowStartOffset: 0,
    windowEndOffset: messages.length,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  };
}

function createStateHarness(overrides: Partial<ChatStoreState>) {
  let state = {
    currentSessionKey: 'agent:main:main',
    loadedSessions: {
      'agent:main:main': createEmptySessionRecord(),
    },
    foregroundHistorySessionKey: null,
    pendingApprovalsBySession: {},
    sessionCatalogStatus: {
      status: 'ready' as const,
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
    mutating: false,
    showThinking: true,
    error: 'stale',
  } as ChatStoreState;
  state = { ...state, ...overrides } as ChatStoreState;

  const set = (
    partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  ) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };

  return {
    set,
    get: () => state,
  };
}

describe('chat history load execution', () => {
  beforeEach(() => {
    fetchHistoryWindowMock.mockReset();
  });

  it('active foreground load applies authoritative snapshot and clears loading ui', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const resultMessages: RawMessage[] = [
      { role: 'assistant', content: 'loaded once', timestamp: 1, id: 'assistant-1' },
    ];
    const { set, get } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createEmptySessionRecord(),
      },
    });
    let sawLoadingState = false;
    fetchHistoryWindowMock.mockImplementationOnce(async () => {
      const current = get();
      sawLoadingState = (
        current.foregroundHistorySessionKey === requestedSessionKey
        && current.error === null
        && current.loadedSessions[requestedSessionKey]?.meta.historyStatus === 'loading'
      );
      return createWindowResult(requestedSessionKey, resultMessages);
    });

    await executeHistoryLoad({
      set,
      get,
      historyRuntime: createHistoryRuntimeHarness(),
      loadingTimeoutMs: 1000,
    }, {
      sessionKey: requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
    });

    expect(sawLoadingState).toBe(true);
    expect(get().foregroundHistorySessionKey).toBeNull();
    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(materializeTimelineMessages(getSessionTimelineEntries(get(), requestedSessionKey))).toMatchObject(resultMessages);
  });

  it('background load updates the target session without touching foreground loading ui', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:worker:main';
    const loadedMessages: RawMessage[] = [
      { role: 'assistant', content: 'background refresh', timestamp: 1, id: 'assistant-1' },
    ];
    const { set, get } = createStateHarness({
      currentSessionKey: 'agent:main:main',
      foregroundHistorySessionKey: null,
      loadedSessions: {
        'agent:main:main': createEmptySessionRecord(),
        [requestedSessionKey]: createEmptySessionRecord(),
      },
      error: 'keep',
    });
    fetchHistoryWindowMock.mockResolvedValueOnce(createWindowResult(requestedSessionKey, loadedMessages));

    await executeHistoryLoad({
      set,
      get,
      historyRuntime: createHistoryRuntimeHarness(),
      loadingTimeoutMs: 1000,
    }, {
      sessionKey: requestedSessionKey,
      mode: 'quiet',
      scope: 'background',
    });

    expect(get().foregroundHistorySessionKey).toBeNull();
    expect(get().error).toBe('keep');
    expect(materializeTimelineMessages(getSessionTimelineEntries(get(), requestedSessionKey))).toMatchObject(loadedMessages);
  });

  it('active foreground load marks error when authoritative snapshot fetch fails', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
    const historyRuntime = createHistoryRuntimeHarness();
    fetchHistoryWindowMock.mockRejectedValueOnce(new Error('window failed'));

    await executeHistoryLoad({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
    }, {
      sessionKey: requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
    });

    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('error');
    expect(get().error).toBe('window failed');
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
  });

  it('aborts before apply when foreground session already changed', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({ currentSessionKey: 'agent:main:other', error: null });
    const historyRuntime = createHistoryRuntimeHarness();

    await executeHistoryLoad({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
    }, {
      sessionKey: requestedSessionKey,
      mode: 'quiet',
      scope: 'foreground',
    });

    expect(fetchHistoryWindowMock).not.toHaveBeenCalled();
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(false);
  });
});
