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
    historyProbeFingerprintBySession: new Map<string, string>(),
    historyQuickFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
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
      messages: rawMessages,
      thinkingLevel: null,
      initialLoading: true,
      refreshing: false,
      snapshotReady: false,
      sessionReadyByKey: {},
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
      quiet: false,
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
      optimisticUserReconcileWindowMs: 15_000,
    });

    await applyLoadedMessages(rawMessages, null);

    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.snapshotReady).toBe(true);
    expect(state.sessionReadyByKey[requestedSessionKey]).toBe(true);
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
      messages: [],
      thinkingLevel: null,
      initialLoading: true,
      refreshing: false,
      snapshotReady: true,
      sessionReadyByKey: { [requestedSessionKey]: true },
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
      quiet: false,
      abortSignal: new AbortController().signal,
      shouldAbortHistoryProcessing: () => false,
      optimisticUserReconcileWindowMs: 15_000,
    });

    await applyLoadedMessages(rawMessages, null);

    expect(state.initialLoading).toBe(false);
    expect(state.refreshing).toBe(false);
    expect(state.snapshotReady).toBe(true);
    expect(state.sessionReadyByKey[requestedSessionKey]).toBe(true);
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
    const metricEvents = trackUiTimingMock.mock.calls.map((call) => call[0]);
    expect(metricEvents).not.toContain('chat.history_apply_normalize');
  });
});

