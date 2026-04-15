import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginHistoryLoadUiState,
  createHistoryLoadAbortGuard,
  finalizeHistoryLoadUiState,
} from '@/stores/chat/history-loading-helpers';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';

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
    messages: [],
    initialLoading: false,
    refreshing: false,
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

describe('chat history loading helpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('abort guard reacts to session switch and run mismatch', () => {
    const historyRuntime = createHistoryRuntimeHarness();
    historyRuntime.nextHistoryLoadRunId();
    const { get } = createStateHarness({ currentSessionKey: 'agent:main:main' });
    const abortController = new AbortController();

    const guard = createHistoryLoadAbortGuard({
      get,
      requestedSessionKey: 'agent:main:main',
      quiet: false,
      historyLoadRunId: 1,
      historyRuntime,
      abortSignal: abortController.signal,
    });

    expect(guard()).toBe(false);

    const changedSession = createStateHarness({ currentSessionKey: 'agent:foo:main' });
    const guardBySession = createHistoryLoadAbortGuard({
      get: changedSession.get,
      requestedSessionKey: 'agent:main:main',
      quiet: false,
      historyLoadRunId: 1,
      historyRuntime,
    });
    expect(guardBySession()).toBe(true);

    historyRuntime.nextHistoryLoadRunId();
    expect(guard()).toBe(true);

    abortController.abort('test_abort');
    expect(guard()).toBe(true);
  });

  it('begin/finalize keep loading flags consistent with timeout safety', () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const historyLoadRunId = historyRuntime.nextHistoryLoadRunId();
    const harness = createStateHarness({
      currentSessionKey: requestedSessionKey,
      messages: [],
      sessionReadyByKey: {},
      initialLoading: false,
      refreshing: false,
      error: 'stale',
    });

    const timer = beginHistoryLoadUiState({
      set: harness.set,
      get: harness.get,
      requestedSessionKey,
      quiet: false,
      historyLoadRunId,
      historyRuntime,
      timeoutMs: 20,
    });

    expect(harness.get().initialLoading).toBe(true);
    expect(harness.get().refreshing).toBe(false);
    expect(harness.get().error).toBeNull();

    vi.advanceTimersByTime(30);
    expect(harness.get().initialLoading).toBe(false);
    expect(harness.get().refreshing).toBe(false);

    harness.set({ initialLoading: true, refreshing: true });
    finalizeHistoryLoadUiState({
      set: harness.set,
      quiet: false,
      historyLoadRunId,
      historyRuntime,
      loadingSafetyTimer: timer,
    });
    expect(harness.get().initialLoading).toBe(false);
    expect(harness.get().refreshing).toBe(false);
  });
});

