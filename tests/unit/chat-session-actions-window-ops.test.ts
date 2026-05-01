import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeJumpToLatest,
  executeLoadOlderMessages,
  executeSetViewportLastVisibleMessageId,
  executeSwitchSession,
} from '@/stores/chat/session-actions';
import {
  createEmptySessionRecord,
  createEmptySessionViewportState,
  selectViewportMessages,
} from '@/stores/chat/store-state-helpers';
import { normalizeIncomingMessages } from '@/stores/chat/message-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';

const hostSessionWindowFetchMock = vi.fn();
const hostApiFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionWindowFetch: (...args: unknown[]) => hostSessionWindowFetchMock(...args),
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
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

function buildMessages(count: number, start = 1): RawMessage[] {
  return normalizeIncomingMessages(Array.from({ length: count }, (_, index) => ({
    id: `message-${start + index}`,
    role: (start + index) % 2 === 0 ? 'assistant' : 'user',
    content: `message ${start + index}`,
    timestamp: start + index,
  })));
}

function createStateHarness(input: {
  currentSessionKey: string;
  messages: RawMessage[];
  window: ReturnType<typeof createViewportWindowState>;
  meta?: Partial<ChatStoreState['loadedSessions'][string]['meta']>;
  loadHistory?: ChatStoreState['loadHistory'];
}) {
  let state = {
    currentSessionKey: input.currentSessionKey,
    loadedSessions: {
      [input.currentSessionKey]: {
        ...createEmptySessionRecord(),
        meta: {
          ...createEmptySessionRecord().meta,
          ...input.meta,
        },
        messages: input.messages,
        window: input.window,
      },
    },
    pendingApprovalsBySession: {},
    sessionCatalogStatus: {
      status: 'ready' as const,
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: null,
    },
    loadHistory: input.loadHistory ?? vi.fn().mockResolvedValue(undefined),
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

function createSessionHarness(input: {
  set: (partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState)) => void;
  get: () => ChatStoreState;
  defaultSessionKey: string;
  historyRuntime: StoreHistoryCache;
}) {
  const shared = {
    set: input.set,
    get: input.get,
    beginMutating: vi.fn(),
    finishMutating: vi.fn(),
    defaultCanonicalPrefix: 'agent:test',
    defaultSessionKey: input.defaultSessionKey,
    historyRuntime: input.historyRuntime,
  };
  return {
    loadOlderMessages: (sessionKey?: string) => executeLoadOlderMessages(shared, sessionKey),
    jumpToLatest: (sessionKey?: string) => executeJumpToLatest(shared, sessionKey),
    switchSession: (key: string) => executeSwitchSession(shared, key),
    setViewportLastVisibleMessageId: (messageId: string | null, sessionKey?: string) => executeSetViewportLastVisibleMessageId(shared, messageId, sessionKey),
  };
}

describe('chat session window ops', () => {
  beforeEach(() => {
    hostSessionWindowFetchMock.mockReset();
    hostApiFetchMock.mockReset();
  });

  it('loadOlderMessages expands the current session window upward without dropping the visible range', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: allMessages.length,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: allMessages, window: viewport });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const olderWindowMessages = allMessages.slice(40, 180);
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: olderWindowMessages,
      canonicalMessages: allMessages,
      totalMessageCount: allMessages.length,
      windowStartOffset: 40,
      windowEndOffset: 180,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    await actions.loadOlderMessages(sessionKey);

    expect(get().loadedSessions[sessionKey]?.messages).toEqual(allMessages);
    expect(selectViewportMessages(get().loadedSessions[sessionKey]!).map((message) => message.id)).toEqual(
      allMessages.slice(40, 220).map((message) => message.id),
    );
    expect(get().loadedSessions[sessionKey]?.window.windowStartOffset).toBe(40);
    expect(get().loadedSessions[sessionKey]?.window.windowEndOffset).toBe(220);
  });

  it('loadOlderMessages preserves overlapping message references', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: 220,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: allMessages, window: viewport });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const fetchedOlderMessages = [
      ...buildMessages(80, 41),
      ...buildMessages(60, 121).map((message) => ({ ...message })),
    ];
    const canonicalMessages = allMessages.map((message) => ({ ...message }));
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: fetchedOlderMessages,
      canonicalMessages,
      totalMessageCount: 220,
      windowStartOffset: 40,
      windowEndOffset: 180,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    await actions.loadOlderMessages(sessionKey);

    const nextRecord = get().loadedSessions[sessionKey]!;
    const nextMessages = selectViewportMessages(nextRecord);
    expect(nextMessages).toHaveLength(180);
    expect(nextMessages[40]).toBe(allMessages[80]);
    expect(nextMessages[139]).toBe(allMessages[179]);
  });

  it('jumpToLatest refreshes the session window to the latest slice', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: allMessages.length,
      windowStartOffset: 0,
      windowEndOffset: 120,
      hasMore: false,
      hasNewer: true,
      isAtLatest: false,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: allMessages, window: viewport });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const latestWindowMessages = allMessages.slice(100);
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: latestWindowMessages,
      canonicalMessages: allMessages,
      totalMessageCount: allMessages.length,
      windowStartOffset: 100,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });

    await actions.jumpToLatest(sessionKey);

    expect(get().loadedSessions[sessionKey]?.messages).toEqual(allMessages);
    expect(selectViewportMessages(get().loadedSessions[sessionKey]!).map((message) => message.id)).toEqual(
      latestWindowMessages.map((message) => message.id),
    );
    expect(get().loadedSessions[sessionKey]?.window.isAtLatest).toBe(true);
  });

  it('jumpToLatest does not re-append a stale local assistant when canonical latest already has the server final', async () => {
    const sessionKey = 'agent:test:main';
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: true,
      isAtLatest: false,
    });
    let state = {
      currentSessionKey: sessionKey,
      loadedSessions: {
        [sessionKey]: {
          ...createEmptySessionRecord(),
          messages: [{
            id: 'assistant-local-stream',
            role: 'assistant',
            content: 'draft preview',
            timestamp: 2,
            streaming: true,
          }],
          runtime: {
            ...createEmptySessionRecord().runtime,
            sending: true,
            activeRunId: 'run-1',
            runPhase: 'streaming' as const,
            streamingMessageId: 'assistant-local-stream',
          },
          window: viewport,
        },
      },
      pendingApprovalsBySession: {},
      sessionCatalogStatus: {
        status: 'ready' as const,
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: null,
      },
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: [{
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'server final',
        timestamp: 2,
      }],
      canonicalMessages: [{
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'server final',
        timestamp: 2,
      }],
      totalMessageCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    });

    await actions.jumpToLatest(sessionKey);

    expect(state.loadedSessions[sessionKey]?.messages.map((message) => message.id)).toEqual(['assistant-final-1']);
    expect(selectViewportMessages(state.loadedSessions[sessionKey]!).map((message) => message.id)).toEqual(['assistant-final-1']);
  });

  it('switchSession reloads history immediately when the current session is reselected', () => {
    const sessionKey = 'agent:test:session-1';
    const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      messages: [],
      window: viewport,
      loadHistory: loadHistoryMock,
    });
      const actions = createSessionHarness({
        set,
        get,
        defaultSessionKey: sessionKey,
        historyRuntime: createHistoryRuntimeHarness(),
      });

    actions.switchSession(sessionKey);

    expect(loadHistoryMock).toHaveBeenCalledWith({
      sessionKey,
      mode: 'active',
      scope: 'foreground',
      reason: 'switch_session_reselect',
    });
  });

  it('switchSession marks a cold target session as loading before foreground history reconcile', () => {
    const currentSessionKey = 'agent:test:session-1';
    const targetSessionKey = 'agent:test:session-2';
    let state = {
      currentSessionKey,
      loadedSessions: {
        [currentSessionKey]: {
          ...createEmptySessionRecord(),
          meta: {
            ...createEmptySessionRecord().meta,
            historyStatus: 'ready' as const,
          },
          window: createViewportWindowState({
            ...createEmptySessionViewportState(),
            totalMessageCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          }),
        },
        [targetSessionKey]: createEmptySessionRecord(),
      },
      pendingApprovalsBySession: {},
      sessionCatalogStatus: {
        status: 'ready' as const,
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: null,
      },
      loadHistory: vi.fn().mockResolvedValue(undefined),
    } as ChatStoreState;

    const set = (
      partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
    ) => {
      const patch = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...patch } as ChatStoreState;
    };
    const get = () => state;

    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: currentSessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    actions.switchSession(targetSessionKey);

    expect(state.currentSessionKey).toBe(targetSessionKey);
    expect(state.loadedSessions[targetSessionKey]?.meta.historyStatus).toBe('loading');
  });

});
