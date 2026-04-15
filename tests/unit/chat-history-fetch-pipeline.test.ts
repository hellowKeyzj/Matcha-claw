import { describe, expect, it, vi } from 'vitest';
import { buildHistoryFingerprint } from '@/stores/chat/store-state-helpers';
import {
  CHAT_HISTORY_ACTIVE_PROBE_LIMIT,
  CHAT_HISTORY_QUIET_PROBE_LIMIT,
  runActiveHistoryPipeline,
  runQuietHistoryPipeline,
} from '@/stores/chat/history-fetch-helpers';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
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
    historyProbeFingerprintBySession: new Map<string, string>(),
    historyQuickFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

function createStateHarness(overrides: Partial<ChatStoreState>) {
  let state = {
    currentSessionKey: 'agent:main:main',
    messages: [] as RawMessage[],
    sessionReadyByKey: {} as Record<string, boolean>,
    ...overrides,
  } as ChatStoreState;

  const set = (
    partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  ) => {
    const patch = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...patch } as ChatStoreState;
  };

  return {
    set,
    getState: () => state,
  };
}

describe('chat history fetch pipeline helpers', () => {
  it('quiet pipeline short-circuits when probe fingerprint is unchanged', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const probe: { rawMessages: RawMessage[]; thinkingLevel: string | null } = {
      rawMessages: [{ role: 'assistant', content: 'ok', timestamp: 1 }],
      thinkingLevel: null,
    };
    const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
    historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);
    historyRuntime.historyFingerprintBySession.set(requestedSessionKey, probeFingerprint);

    const { set, getState } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      messages: [{ role: 'assistant', content: 'renderable', timestamp: 2 }],
      sessionReadyByKey: {},
    });

    const applyLoadedMessages = vi.fn(async () => {});
    const fetchHistoryWindow = vi.fn(async () => probe);

    await runQuietHistoryPipeline({
      set,
      getState,
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => false,
      fetchHistoryWindow,
      applyLoadedMessages,
    });

    expect(applyLoadedMessages).not.toHaveBeenCalled();
    expect(getState().sessionReadyByKey[requestedSessionKey]).toBe(true);
  });

  it('active pipeline applies probe then full window when probe is saturated', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const { set, getState } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      messages: [],
      sessionReadyByKey: {},
    });

    const probeMessages = Array.from({ length: CHAT_HISTORY_ACTIVE_PROBE_LIMIT }, (_, index) => ({
      role: 'assistant',
      content: `probe-${index}`,
      timestamp: index + 1,
    })) as RawMessage[];
    const fullMessages = Array.from({ length: CHAT_HISTORY_ACTIVE_PROBE_LIMIT + 3 }, (_, index) => ({
      role: 'assistant',
      content: `full-${index}`,
      timestamp: index + 1,
    })) as RawMessage[];

    const fetchHistoryWindow = vi.fn()
      .mockResolvedValueOnce({ rawMessages: probeMessages, thinkingLevel: 'medium' })
      .mockResolvedValueOnce({ rawMessages: fullMessages, thinkingLevel: 'medium' });
    const applyLoadedMessages = vi.fn(async () => {});

    await runActiveHistoryPipeline({
      set,
      getState,
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => false,
      fetchHistoryWindow,
      applyLoadedMessages,
    });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(2);
    expect(applyLoadedMessages).toHaveBeenCalledTimes(2);
    expect(applyLoadedMessages).toHaveBeenNthCalledWith(1, probeMessages, 'medium');
    expect(applyLoadedMessages).toHaveBeenNthCalledWith(2, fullMessages, 'medium');

    const expectedFullFingerprint = buildHistoryFingerprint(fullMessages, 'medium');
    expect(historyRuntime.historyFingerprintBySession.get(requestedSessionKey)).toBe(expectedFullFingerprint);
    expect(historyRuntime.historyProbeFingerprintBySession.get(requestedSessionKey)).toBe(expectedFullFingerprint);
  });

  it('active pipeline skips redundant full apply when full payload matches probe payload', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const { set, getState } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      messages: [],
      sessionReadyByKey: {},
    });

    const probeMessages = Array.from({ length: CHAT_HISTORY_ACTIVE_PROBE_LIMIT }, (_, index) => ({
      role: 'assistant',
      content: `probe-${index}`,
      timestamp: index + 1,
    })) as RawMessage[];
    const fullMessages = probeMessages.map((message) => ({ ...message }));
    const fetchHistoryWindow = vi.fn()
      .mockResolvedValueOnce({ rawMessages: probeMessages, thinkingLevel: 'medium' })
      .mockResolvedValueOnce({ rawMessages: fullMessages, thinkingLevel: 'medium' });
    const applyLoadedMessages = vi.fn(async () => {});

    await runActiveHistoryPipeline({
      set,
      getState,
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => false,
      fetchHistoryWindow,
      applyLoadedMessages,
    });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(2);
    expect(applyLoadedMessages).toHaveBeenCalledTimes(1);
    expect(applyLoadedMessages).toHaveBeenNthCalledWith(1, probeMessages, 'medium');

    const expectedFullFingerprint = buildHistoryFingerprint(fullMessages, 'medium');
    expect(historyRuntime.historyFingerprintBySession.get(requestedSessionKey)).toBe(expectedFullFingerprint);
    expect(historyRuntime.historyProbeFingerprintBySession.get(requestedSessionKey)).toBe(expectedFullFingerprint);
  });

  it('quiet pipeline skips redundant full apply when full payload matches probe payload', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const { set, getState } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      messages: [],
      sessionReadyByKey: {},
    });

    const probeMessages = Array.from({ length: CHAT_HISTORY_QUIET_PROBE_LIMIT }, (_, index) => ({
      role: 'assistant',
      content: `probe-${index}`,
      timestamp: index + 1,
    })) as RawMessage[];
    const fullMessages = probeMessages.map((message) => ({ ...message }));
    const fetchHistoryWindow = vi.fn()
      .mockResolvedValueOnce({ rawMessages: probeMessages, thinkingLevel: 'high' })
      .mockResolvedValueOnce({ rawMessages: fullMessages, thinkingLevel: 'high' });
    const applyLoadedMessages = vi.fn(async () => {});

    await runQuietHistoryPipeline({
      set,
      getState,
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => false,
      fetchHistoryWindow,
      applyLoadedMessages,
    });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(2);
    expect(applyLoadedMessages).not.toHaveBeenCalled();

    const expectedFullFingerprint = buildHistoryFingerprint(fullMessages, 'high');
    expect(historyRuntime.historyFingerprintBySession.get(requestedSessionKey)).toBe(expectedFullFingerprint);
    expect(historyRuntime.historyProbeFingerprintBySession.get(requestedSessionKey)).toBe(expectedFullFingerprint);
  });

  it('active pipeline short-circuits when probe fingerprint is unchanged', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const probe: { rawMessages: RawMessage[]; thinkingLevel: string | null } = {
      rawMessages: [{ role: 'assistant', content: 'stable', timestamp: 1 }],
      thinkingLevel: 'medium',
    };
    const probeFingerprint = buildHistoryFingerprint(probe.rawMessages, probe.thinkingLevel);
    historyRuntime.historyProbeFingerprintBySession.set(requestedSessionKey, probeFingerprint);
    historyRuntime.historyFingerprintBySession.set(requestedSessionKey, probeFingerprint);

    const { set, getState } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      messages: [{ role: 'assistant', content: 'renderable', timestamp: 2 }],
      sessionReadyByKey: {},
    });

    const applyLoadedMessages = vi.fn(async () => {});
    const fetchHistoryWindow = vi.fn(async () => probe);

    await runActiveHistoryPipeline({
      set,
      getState,
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => false,
      fetchHistoryWindow,
      applyLoadedMessages,
    });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(1);
    expect(applyLoadedMessages).not.toHaveBeenCalled();
    expect(getState().sessionReadyByKey[requestedSessionKey]).toBe(true);
  });

  it('quiet pipeline stops when abort is raised after probe fetch', async () => {
    const requestedSessionKey = 'agent:main:main';
    const historyRuntime = createHistoryRuntimeHarness();
    const { set, getState } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      messages: [],
      sessionReadyByKey: {},
    });

    let aborted = false;
    const probeMessages = Array.from({ length: CHAT_HISTORY_QUIET_PROBE_LIMIT }, (_, index) => ({
      role: 'assistant',
      content: `probe-${index}`,
      timestamp: index + 1,
    })) as RawMessage[];

    const fetchHistoryWindow = vi.fn(async () => {
      aborted = true;
      return { rawMessages: probeMessages, thinkingLevel: 'medium' };
    });
    const applyLoadedMessages = vi.fn(async () => {});

    await expect(runQuietHistoryPipeline({
      set,
      getState,
      requestedSessionKey,
      historyRuntime,
      abortSignal: new AbortController().signal,
      isAborted: () => aborted,
      fetchHistoryWindow,
      applyLoadedMessages,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(fetchHistoryWindow).toHaveBeenCalledTimes(1);
    expect(applyLoadedMessages).not.toHaveBeenCalled();
  });
});

