import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostSessionTimelineMessage } from '@/lib/host-api';
import type { HistoryWindowResult } from '@/stores/chat/history-fetch-helpers';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';
import type { SessionRenderItem } from '../../src/types/session/render-item';
import {
  createEmptySessionRecord,
  getSessionItems,
  projectSessionViewItems,
  resetSessionProjection,
} from '@/stores/chat/store-state-helpers';
import {
  assistantItem,
  completeFact,
  sessionView,
  userItem,
  windowView,
} from './helpers/session-fixtures';
import { buildSessionIdentityRecordIndex, buildSessionRecordKey } from '@/stores/chat/session-identity';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

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
    setHistoryLoadInFlight: () => {},
    clearHistoryLoadInFlight: () => {},
    historyFingerprintBySession: new Map<string, string>(),
    historyRenderFingerprintBySession: new Map<string, string>(),
  };
}

type HistoryMessage = HostSessionTimelineMessage;

function createWindowItems(
  sessionKey: string,
  messages: readonly HistoryMessage[],
): SessionRenderItem[] {
  return messages.map((message, index) => {
    const key = message.messageId ?? `${message.role}:${message.createdAt ?? index}:${index}`;
    if (message.role === 'user') {
      return {
        key,
        kind: 'user-message',
        role: 'user',
        sessionKey,
        text: message.text,
        images: [],
        attachedFiles: [],
        ...(message.messageId ? { messageId: message.messageId } : {}),
        ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
        ...(message.updatedAt !== undefined ? { updatedAt: message.updatedAt } : {}),
      };
    }
    return {
      key,
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey,
      identitySource: 'message',
      identityMode: 'message',
      identityConfidence: 'strong',
      status: 'final',
      segments: [{ kind: 'message', key: `${key}:text`, text: message.text }],
      thinking: null,
      tools: [],
      text: message.text,
      images: [],
      attachedFiles: [],
      ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
      ...(message.updatedAt !== undefined ? { updatedAt: message.updatedAt } : {}),
    };
  });
}

function createTestSessionRecord(sessionKey: string) {
  const record = createEmptySessionRecord();
  const sessionIdentity = createOpenClawTestSessionIdentity(sessionKey);
  return {
    ...record,
    meta: {
      ...record.meta,
      runtimeScopeKey: 'native-runtime:openclaw:local',
      agentId: sessionIdentity.agentId,
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'local',
      sessionIdentity,
    },
  };
}

function testRecordKey(sessionKey: string): string {
  return buildSessionRecordKey(createOpenClawTestSessionIdentity(sessionKey));
}

function createWindowResult(
  sessionKey: string,
  messages: HistoryMessage[] = [],
): HistoryWindowResult {
  const items = messages.map((message, index) => message.role === 'user'
    ? userItem(message.messageId ?? `user-${index}`, message.text, {
      ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
      ...(message.updatedAt !== undefined ? { updatedAt: message.updatedAt } : {}),
    })
    : assistantItem(message.messageId ?? `assistant-${index}`, message.text, {
      ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
      ...(message.updatedAt !== undefined ? { updatedAt: message.updatedAt } : {}),
    }));
  const view = sessionView(sessionKey, {
    identity: createOpenClawTestSessionIdentity(sessionKey),
    seq: items.length,
    cursor: items.length,
    items: completeFact(items),
    window: completeFact(windowView(items.length)),
  });
  return {
    view,
    items: projectSessionViewItems(view),
    sessionIdentity: createOpenClawTestSessionIdentity(sessionKey),
    thinkingLevel: null,
  };
}

function createStateHarness(overrides: Partial<ChatStoreState>) {
  const defaultRecordKey = testRecordKey('agent:main:main');
  let state = {
    currentSessionKey: defaultRecordKey,
    loadedSessions: {
      [defaultRecordKey]: createTestSessionRecord('agent:main:main'),
    },
    sessionRecordKeyByIdentityKey: {
      [defaultRecordKey]: defaultRecordKey,
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
  state = {
    ...state,
    sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(state.loadedSessions),
  } as ChatStoreState;

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
    resetSessionProjection('agent:main:main');
    resetSessionProjection('agent:worker:main');
  });

  it('active foreground load applies authoritative snapshot and clears loading ui', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const sessionKey = 'agent:main:main';
    const requestedSessionKey = testRecordKey(sessionKey);
    const resultMessages: HistoryMessage[] = [
      { role: 'assistant', text: 'loaded once', createdAt: 1, messageId: 'assistant-1' },
    ];
    const { set, get } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: createTestSessionRecord(sessionKey),
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
      return createWindowResult(sessionKey, resultMessages);
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

  it('foreground refresh clears items when the canonical SessionView is empty', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const sessionKey = 'agent:main:main';
    const requestedSessionKey = testRecordKey(sessionKey);
    const currentMessages: HistoryMessage[] = [
      { role: 'user', text: 'hello', createdAt: 1, messageId: 'user-1' },
      { role: 'assistant', text: 'streaming reply', createdAt: 2, messageId: 'assistant-1' },
    ];
    const { set, get } = createStateHarness({
      currentSessionKey: requestedSessionKey,
      loadedSessions: {
        [requestedSessionKey]: {
          ...createTestSessionRecord(sessionKey),
          items: createWindowItems(sessionKey, currentMessages),
        },
      },
    });
    fetchHistoryWindowMock.mockResolvedValueOnce(createWindowResult(sessionKey, []));

    await executeHistoryLoad({
      set,
      get,
      historyRuntime: createHistoryRuntimeHarness(),
      loadingTimeoutMs: 1000,
    }, {
      sessionKey: requestedSessionKey,
      mode: 'quiet',
      scope: 'foreground',
    });

    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('ready');
    expect(getSessionItems(get(), requestedSessionKey)).toEqual([]);
  });

  it('background load updates the target session without touching foreground loading ui', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const sessionKey = 'agent:worker:main';
    const requestedSessionKey = testRecordKey(sessionKey);
    const loadedMessages: HistoryMessage[] = [
      { role: 'assistant', text: 'background refresh', createdAt: 1, messageId: 'assistant-1' },
    ];
    const foregroundSessionKey = 'agent:main:main';
    const foregroundRecordKey = testRecordKey(foregroundSessionKey);
    const { set, get } = createStateHarness({
      currentSessionKey: foregroundRecordKey,
      foregroundHistorySessionKey: null,
      loadedSessions: {
        [foregroundRecordKey]: createTestSessionRecord(foregroundSessionKey),
        [requestedSessionKey]: createTestSessionRecord(sessionKey),
      },
      error: 'keep',
    });
    fetchHistoryWindowMock.mockResolvedValueOnce(createWindowResult(sessionKey, loadedMessages));

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
    const sessionKey = 'agent:main:main';
    const requestedSessionKey = testRecordKey(sessionKey);
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
    expect(get().error).toBe('Session timeline is unavailable');
    expect(historyRuntime.historyFingerprintBySession.has(requestedSessionKey)).toBe(true);
    expect(historyRuntime.historyRenderFingerprintBySession.has(requestedSessionKey)).toBe(true);
  });

  it('aborts before apply when foreground session already changed', async () => {
    const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
    const requestedSessionKey = testRecordKey('agent:main:main');
    const { set, get } = createStateHarness({ currentSessionKey: testRecordKey('agent:main:other'), error: null });
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
      const sessionKey = 'agent:main:main';
      const requestedSessionKey = testRecordKey(sessionKey);
      const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
      fetchHistoryWindowMock
        .mockRejectedValueOnce(new Error('request timed out'))
        .mockResolvedValueOnce(createWindowResult(sessionKey, [
          { role: 'assistant', text: 'recovered after retry', createdAt: 1, messageId: 'assistant-1' },
        ]));

      const loadPromise = executeHistoryLoad({
        set,
        get,
        historyRuntime: createHistoryRuntimeHarness(),
        loadingTimeoutMs: 15_000,
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
        recordKey: requestedSessionKey,
        sessionIdentity: expect.objectContaining({ sessionKey }),
        timeoutMs: 35_000,
      }));
      expect(fetchHistoryWindowMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
        recordKey: requestedSessionKey,
        sessionIdentity: expect.objectContaining({ sessionKey }),
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
      const sessionKey = 'agent:main:main';
      const requestedSessionKey = testRecordKey(sessionKey);
      const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
      fetchHistoryWindowMock.mockRejectedValue(new Error('request timed out'));

      const loadPromise = executeHistoryLoad({
        set,
        get,
        historyRuntime: createHistoryRuntimeHarness(),
        loadingTimeoutMs: 15_000,
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
      expect(get().error).toBe('Session timeline is unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('chat_init_cold_start 遇到 runtime startup 特殊错误时会扩大重试预算并在耗尽后保持非失败态', async () => {
    vi.useFakeTimers();
    try {
      const { executeHistoryLoad } = await import('@/stores/chat/history-load-execution');
      const sessionKey = 'agent:main:main';
      const requestedSessionKey = testRecordKey(sessionKey);
      const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
      fetchHistoryWindowMock.mockRejectedValue(new Error('Service not initialized: unavailable during runtime startup'));

      const loadPromise = executeHistoryLoad({
        set,
        get,
        historyRuntime: createHistoryRuntimeHarness(),
        loadingTimeoutMs: 15_000,
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
    const sessionKey = 'agent:main:main';
    const requestedSessionKey = testRecordKey(sessionKey);
    const { set, get } = createStateHarness({ currentSessionKey: requestedSessionKey });
    fetchHistoryWindowMock.mockRejectedValueOnce(new Error('request timed out'));

    await executeHistoryLoad({
      set,
      get,
      historyRuntime: createHistoryRuntimeHarness(),
      loadingTimeoutMs: 15_000,
    }, {
      sessionKey: requestedSessionKey,
      mode: 'active',
      scope: 'foreground',
      reason: 'manual_refresh',
    });

    expect(fetchHistoryWindowMock).toHaveBeenCalledTimes(1);
    const [firstCall] = fetchHistoryWindowMock.mock.calls[0] ?? [];
    expect(firstCall).toMatchObject({
      recordKey: requestedSessionKey,
      sessionIdentity: expect.objectContaining({ sessionKey }),
      limit: 200,
    });
    expect(firstCall).not.toHaveProperty('timeoutMs');
    expect(get().loadedSessions[requestedSessionKey]?.meta.historyStatus).toBe('error');
  });
});

