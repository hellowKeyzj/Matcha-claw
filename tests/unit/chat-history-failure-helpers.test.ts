import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';
import { createEmptySessionRecord } from '@/stores/chat/store-state-helpers';

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
    foregroundHistorySessionKey: 'agent:main:main',
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
      mode: 'active',
      scope: 'foreground',
      historyRuntime,
      error: new Error('boom'),
      applyLoadedMessages,
    });

    expect(applyLoadedMessages).toHaveBeenCalledWith({
      rawMessages: fallbackMessages,
      canonicalRawMessages: fallbackMessages,
      thinkingLevel: null,
      totalMessageCount: fallbackMessages.length,
      windowStartOffset: 0,
      windowEndOffset: fallbackMessages.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    });
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(true);
  });

  it('marks the session history as error and exposes the error when non-quiet and no fallback data', async () => {
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
      mode: 'active',
      scope: 'foreground',
      historyRuntime,
      error: new Error('load failed'),
      applyLoadedMessages,
    });

    const state = get();
    expect(applyLoadedMessages).not.toHaveBeenCalled();
    expect(state.loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('error');
    expect(state.error).toBe('load failed');
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyQuickFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
  });
});

