import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';

const fetchHistoryWindowMock = vi.fn();
const loadCronFallbackMessagesMock = vi.fn();
const normalizeHistoryMessagesMock = vi.fn();

vi.mock('@/stores/chat/history-fetch-helpers', () => ({
  CHAT_HISTORY_FULL_LIMIT: 200,
  CHAT_HISTORY_LOADING_TIMEOUT_MS: 1000,
  fetchHistoryWindow: (...args: unknown[]) => fetchHistoryWindowMock(...args),
  loadCronFallbackMessages: (...args: unknown[]) => loadCronFallbackMessagesMock(...args),
}));

vi.mock('@/stores/chat/history-normalizer-worker-client', () => ({
  normalizeHistoryMessages: (...args: unknown[]) => normalizeHistoryMessagesMock(...args),
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

function createWindowResult(messages: RawMessage[] = []) {
  return {
    rawMessages: messages,
    canonicalRawMessages: messages,
    thinkingLevel: null,
    totalMessageCount: messages.length,
    windowStartOffset: 0,
    windowEndOffset: messages.length,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
  };
}

describe('chat history load execution', () => {
  beforeEach(() => {
    fetchHistoryWindowMock.mockReset();
    loadCronFallbackMessagesMock.mockReset();
    normalizeHistoryMessagesMock.mockReset();
    fetchHistoryWindowMock.mockResolvedValue(createWindowResult());
    loadCronFallbackMessagesMock.mockResolvedValue([]);
    normalizeHistoryMessagesMock.mockImplementation(async (messages: RawMessage[]) => messages);
  });

  it('active foreground load toggles loading state around one direct fetch/apply pass', async () => {
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
      return createWindowResult(resultMessages);
    });
    const historyRuntime = createHistoryRuntimeHarness();

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

    expect(sawLoadingState).toBe(true);
    expect(fetchHistoryWindowMock).toHaveBeenCalledTimes(1);
    expect(normalizeHistoryMessagesMock).toHaveBeenCalledWith([{
      role: 'assistant',
      content: 'loaded once',
      timestamp: 1,
      id: 'assistant-1',
      messageId: 'assistant-1',
      uniqueId: 'assistant-1',
    }], expect.objectContaining({
      abortSignal: expect.any(AbortSignal),
    }));
    expect(get().foregroundHistorySessionKey).toBeNull();
    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(get().loadedSessions[requestedSessionKey]?.messages).toEqual([{
      role: 'assistant',
      content: 'loaded once',
      timestamp: 1,
      id: 'assistant-1',
      messageId: 'assistant-1',
      uniqueId: 'assistant-1',
    }]);
  });

  it('normalizes incoming history message identity before writing transcript state', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createEmptySessionRecord(),
      },
    });
    fetchHistoryWindowMock.mockResolvedValueOnce(createWindowResult([
      {
        role: 'user',
        id: 'transcript-user-1',
        content: '你好',
        timestamp: 1,
        idempotencyKey: 'optimistic-user-1',
      } as RawMessage,
    ]));
    const historyRuntime = createHistoryRuntimeHarness();

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

    expect(get().loadedSessions[requestedSessionKey]?.messages).toEqual([
      {
        role: 'user',
        id: 'transcript-user-1',
        messageId: 'transcript-user-1',
        clientId: 'optimistic-user-1',
        uniqueId: 'transcript-user-1',
        content: '你好',
        timestamp: 1,
        idempotencyKey: 'optimistic-user-1',
      },
    ]);
  });

  it('background load does not touch foreground loading ui', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const loadedMessages: RawMessage[] = [
      { role: 'assistant', content: 'background refresh', timestamp: 1, id: 'assistant-1' },
    ];
    const { set, get } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      foregroundHistorySessionKey: null,
      error: 'keep',
    });
    fetchHistoryWindowMock.mockImplementationOnce(async () => {
      expect(get().foregroundHistorySessionKey).toBeNull();
      expect(get().error).toBe('keep');
      return createWindowResult(loadedMessages);
    });
    const historyRuntime = createHistoryRuntimeHarness();

    await executeHistoryLoad({
      set,
      get,
      historyRuntime,
      loadingTimeoutMs: 1000,
    }, {
      sessionKey: requestedSessionKey,
      mode: 'quiet',
      scope: 'background',
    });

    expect(get().foregroundHistorySessionKey).toBeNull();
    expect(get().error).toBe('keep');
    expect(get().loadedSessions[requestedSessionKey]?.messages).toEqual([{
      role: 'assistant',
      content: 'background refresh',
      timestamp: 1,
      id: 'assistant-1',
      messageId: 'assistant-1',
      uniqueId: 'assistant-1',
    }]);
  });

  it('recovers through cron fallback when fetch fails and fallback data exists', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
    fetchHistoryWindowMock.mockRejectedValueOnce(new Error('window failed'));
    const fallbackMessages: RawMessage[] = [{ role: 'assistant', content: 'fallback', timestamp: 1, id: 'assistant-fallback' }];
    loadCronFallbackMessagesMock.mockResolvedValueOnce(fallbackMessages);
    const historyRuntime = createHistoryRuntimeHarness();

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

    expect(loadCronFallbackMessagesMock).toHaveBeenCalledWith(requestedSessionKey, 200);
    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(get().loadedSessions[requestedSessionKey]?.messages).toEqual([{
      role: 'assistant',
      content: 'fallback',
      timestamp: 1,
      id: 'assistant-fallback',
      messageId: 'assistant-fallback',
      uniqueId: 'assistant-fallback',
    }]);
  });

  it('marks active foreground load as error when fetch fails and no fallback exists', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
    fetchHistoryWindowMock.mockRejectedValueOnce(new Error('window failed'));
    loadCronFallbackMessagesMock.mockResolvedValueOnce([]);
    const historyRuntime = createHistoryRuntimeHarness();

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
    expect(historyRuntime.historyQuickFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
  });

  it('treats abort error as aborted outcome without failure recovery', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey, error: null });
    fetchHistoryWindowMock.mockImplementationOnce(async () => {
      const error = new Error('history aborted');
      error.name = 'AbortError';
      throw error;
    });
    const historyRuntime = createHistoryRuntimeHarness();

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

    expect(loadCronFallbackMessagesMock).not.toHaveBeenCalled();
    expect(get().error).toBeNull();
    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('loading');
  });

  it('aborts before fetch when foreground session already changed', async () => {
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
    expect(normalizeHistoryMessagesMock).not.toHaveBeenCalled();
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(false);
  });

  it('stops when abort is raised after window fetch', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey, error: null });
    const historyRuntime = createHistoryRuntimeHarness();
    fetchHistoryWindowMock.mockImplementationOnce(async () => {
      historyRuntime.nextHistoryLoadRunId();
      return createWindowResult([{ role: 'assistant', content: 'late', timestamp: 1, id: 'assistant-late' }]);
    });

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

    expect(normalizeHistoryMessagesMock).not.toHaveBeenCalled();
    expect(loadCronFallbackMessagesMock).not.toHaveBeenCalled();
    expect(get().loadedSessions[requestedSessionKey]?.messages).toEqual([]);
  });
});
