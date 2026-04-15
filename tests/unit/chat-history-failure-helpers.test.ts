import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';

const loadCronFallbackMessagesMock = vi.fn();

vi.mock('@/stores/chat/history-fetch-helpers', async () => {
  const actual = await vi.importActual<typeof import('@/stores/chat/history-fetch-helpers')>(
    '@/stores/chat/history-fetch-helpers',
  );
  return {
    ...actual,
    loadCronFallbackMessages: (...args: Parameters<typeof actual.loadCronFallbackMessages>) => (
      loadCronFallbackMessagesMock(...args)
    ),
  };
});

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

function createStateHarness(overrides: Partial<ChatStoreState>) {
  let state = {
    currentSessionKey: 'agent:main:main',
    sessionReadyByKey: {},
    initialLoading: true,
    refreshing: true,
    snapshotReady: false,
    error: null,
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

describe('chat history failure helpers', () => {
  beforeEach(() => {
    loadCronFallbackMessagesMock.mockReset();
  });

  it('applies fallback messages when cron fallback returns data', async () => {
    const { handleHistoryLoadFailure } = await import('@/stores/chat/history-failure-helpers');
    const historyRuntime = createHistoryRuntimeHarness();
    const requestedSessionKey = 'agent:main:main';
    const fallbackMessages: RawMessage[] = [{ role: 'assistant', content: 'fallback', timestamp: 1 }];
    loadCronFallbackMessagesMock.mockResolvedValueOnce(fallbackMessages);
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
    const applyLoadedMessages = vi.fn(async () => {});

    await handleHistoryLoadFailure({
      set,
      get,
      requestedSessionKey,
      quiet: false,
      historyRuntime,
      error: new Error('boom'),
      applyLoadedMessages,
    });

    expect(applyLoadedMessages).toHaveBeenCalledWith(fallbackMessages, null);
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyProbeFingerprintBySession.has(requestedSessionKey)).toBe(true);
  });

  it('writes empty fallback snapshot and error when non-quiet and no fallback data', async () => {
    const { handleHistoryLoadFailure } = await import('@/stores/chat/history-failure-helpers');
    const historyRuntime = createHistoryRuntimeHarness();
    const requestedSessionKey = 'agent:main:main';
    loadCronFallbackMessagesMock.mockResolvedValueOnce([]);
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
    const applyLoadedMessages = vi.fn(async () => {});

    await handleHistoryLoadFailure({
      set,
      get,
      requestedSessionKey,
      quiet: false,
      historyRuntime,
      error: new Error('load failed'),
      applyLoadedMessages,
    });

    const state = get();
    expect(applyLoadedMessages).not.toHaveBeenCalled();
    expect(state.snapshotReady).toBe(true);
    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.sessionReadyByKey[requestedSessionKey]).toBe(true);
    expect(state.error).toBe('load failed');
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyProbeFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyQuickFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
  });
});

