import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';
import type { GatewayStatus } from '@/types/gateway';
import type { RawMessage } from './helpers/timeline-fixtures';
import {
  createEmptySessionRecord,
  getSessionItems,
} from '@/stores/chat/store-state-helpers';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';

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
  const items = buildRenderItemsFromMessages(sessionKey, messages);
  return {
    sessionKey,
    catalog: {
      key: sessionKey,
      agentId: 'main',
      kind: 'main' as const,
      preferred: true,
      ...(messages.length > 0 && typeof messages[messages.length - 1]?.content === 'string'
        ? { label: String(messages[messages.length - 1]?.content) }
        : {}),
      displayName: sessionKey,
      updatedAt: messages.length > 0 ? messages[messages.length - 1]?.timestamp : undefined,
    },
    items,
    replayComplete: true,
    runtime: {
      activeRunId: null,
      runPhase: 'done' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      lastUserMessageAt: null,
      updatedAt: 1,
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

function createWindowResult(sessionKey: string, messages: RawMessage[] = []) {
  return {
    snapshot: createSnapshot(sessionKey, messages),
    thinkingLevel: null,
    totalItemCount: messages.length,
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

function createGatewayStatus(overrides?: Partial<GatewayStatus>): GatewayStatus {
  return {
    processState: 'running',
    port: 18789,
    gatewayReady: true,
    healthSummary: 'healthy',
    transportState: 'connected',
    portReachable: true,
    diagnostics: {
      consecutiveHeartbeatMisses: 0,
      consecutiveRpcFailures: 0,
    },
    connectedAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
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
    expect(getSessionItems(get(), requestedSessionKey)).toMatchObject([
      expect.objectContaining({
        text: 'loaded once',
      }),
    ]);
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
    expect(getSessionItems(get(), requestedSessionKey)).toMatchObject([
      expect.objectContaining({
        text: 'background refresh',
      }),
    ]);
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

  it('chat_init_cold_start 首次前台加载遇到超时后会按启动期预算重试并恢复', async () => {
    vi.useFakeTimers();
    try {
      const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
      const requestedSessionKey = 'agent:main:main';
      const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
      fetchHistoryWindowMock
        .mockRejectedValueOnce(new Error('request timed out'))
        .mockResolvedValueOnce(createWindowResult(requestedSessionKey, [
          { role: 'assistant', content: 'recovered after retry', timestamp: 1, id: 'assistant-1' },
        ]));

      const loadPromise = executeHistoryLoad({
        set,
        get,
        historyRuntime: createHistoryRuntimeHarness(),
        loadingTimeoutMs: 15_000,
        getGatewayStatus: () => createGatewayStatus({
          connectedAt: Date.now() - 5_000,
        }),
      }, {
        sessionKey: requestedSessionKey,
        mode: 'active',
        scope: 'foreground',
        reason: 'chat_init_cold_start',
      });

      await vi.runAllTimersAsync();
      await loadPromise;

      expect(fetchHistoryWindowMock).toHaveBeenCalledTimes(2);
      expect(fetchHistoryWindowMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
        requestedSessionKey,
        timeoutMs: 35_000,
      }));
      expect(fetchHistoryWindowMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
        requestedSessionKey,
        timeoutMs: 35_000,
      }));
      expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
      expect(getSessionItems(get(), requestedSessionKey)).toMatchObject([
        expect.objectContaining({ text: 'recovered after retry' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('chat_init_cold_start 首次前台加载失败耗尽预算后才进入 error', async () => {
    vi.useFakeTimers();
    try {
      const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
      const requestedSessionKey = 'agent:main:main';
      const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
      fetchHistoryWindowMock.mockRejectedValue(new Error('request timed out'));

      const loadPromise = executeHistoryLoad({
        set,
        get,
        historyRuntime: createHistoryRuntimeHarness(),
        loadingTimeoutMs: 15_000,
        getGatewayStatus: () => createGatewayStatus({
          connectedAt: Date.now() - 2_000,
        }),
      }, {
        sessionKey: requestedSessionKey,
        mode: 'active',
        scope: 'foreground',
        reason: 'chat_init_cold_start',
      });

      await vi.runAllTimersAsync();
      await loadPromise;

      expect(fetchHistoryWindowMock).toHaveBeenCalledTimes(5);
      expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('error');
      expect(get().error).toBe('request timed out');
    } finally {
      vi.useRealTimers();
    }
  });

  it('chat_init_cold_start 遇到 gateway startup 特殊错误时会扩大重试预算并在耗尽后保持非失败态', async () => {
    vi.useFakeTimers();
    try {
      const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
      const requestedSessionKey = 'agent:main:main';
      const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
      fetchHistoryWindowMock.mockRejectedValue(new Error('Service not initialized: unavailable during gateway startup'));

      const loadPromise = executeHistoryLoad({
        set,
        get,
        historyRuntime: createHistoryRuntimeHarness(),
        loadingTimeoutMs: 15_000,
        getGatewayStatus: () => createGatewayStatus({
          processState: 'starting',
          gatewayReady: false,
          transportState: 'disconnected',
          connectedAt: undefined,
        }),
      }, {
        sessionKey: requestedSessionKey,
        mode: 'active',
        scope: 'foreground',
        reason: 'chat_init_cold_start',
      });

      await vi.runAllTimersAsync();
      await loadPromise;

      expect(fetchHistoryWindowMock).toHaveBeenCalledTimes(5);
      expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
      expect(get().foregroundHistorySessionKey).toBeNull();
      expect(get().error).toBeNull();
      expect(getSessionItems(get(), requestedSessionKey)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('非冷启动前台加载不会吃启动期重试预算', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = 'agent:main:main';
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
    fetchHistoryWindowMock.mockRejectedValueOnce(new Error('request timed out'));

    await executeHistoryLoad({
      set,
      get,
      historyRuntime: createHistoryRuntimeHarness(),
      loadingTimeoutMs: 15_000,
      getGatewayStatus: () => createGatewayStatus(),
    }, {
      sessionKey: requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      reason: 'manual_refresh',
    });

    expect(fetchHistoryWindowMock).toHaveBeenCalledTimes(1);
    const [firstCall] = fetchHistoryWindowMock.mock.calls[0] ?? [];
    expect(firstCall).toMatchObject({
      requestedSessionKey,
      limit: 200,
    });
    expect(firstCall).not.toHaveProperty('timeoutMs');
    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('error');
  });
});

