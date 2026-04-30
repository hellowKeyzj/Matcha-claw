import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStoreSessionActions } from '@/stores/chat/session-actions';
import {
  createEmptySessionRecord,
  createEmptySessionViewportState,
} from '@/stores/chat/store-state-helpers';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState, RawMessage } from '@/stores/chat/types';

const hostSessionWindowFetchMock = vi.fn();
const hostApiFetchMock = vi.fn();
const prewarmAssistantMarkdownBodiesMock = vi.fn();
const prewarmStaticRowsForMessagesMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionWindowFetch: (...args: unknown[]) => hostSessionWindowFetchMock(...args),
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/lib/chat-markdown-body', () => ({
  prewarmAssistantMarkdownBodies: (...args: unknown[]) => prewarmAssistantMarkdownBodiesMock(...args),
}));

vi.mock('@/pages/Chat/chat-rows-cache', () => ({
  prewarmStaticRowsForMessages: (...args: unknown[]) => prewarmStaticRowsForMessagesMock(...args),
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
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${start + index}`,
    role: (start + index) % 2 === 0 ? 'assistant' : 'user',
    content: `message ${start + index}`,
    timestamp: start + index,
  }));
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
        window: input.window,
      },
    },
    pendingApprovalsBySession: {},
    sessionMetasResource: {
      data: [],
      loading: false,
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

describe('chat session window ops', () => {
  beforeEach(() => {
    hostSessionWindowFetchMock.mockReset();
    hostApiFetchMock.mockReset();
    prewarmAssistantMarkdownBodiesMock.mockReset();
    prewarmStaticRowsForMessagesMock.mockReset();
  });

  it('loadOlderMessages replaces the session window with the older fetched slice', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      messages: allMessages.slice(120),
      totalMessageCount: allMessages.length,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: allMessages, window: viewport });
    const actions = createStoreSessionActions({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultCanonicalPrefix: 'agent:test',
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const olderWindowMessages = allMessages.slice(40, 180);
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: olderWindowMessages,
      totalMessageCount: allMessages.length,
      windowStartOffset: 40,
      windowEndOffset: 180,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    await actions.loadOlderMessages(sessionKey);

    expect(get().loadedSessions[sessionKey]?.window.messages).toEqual(olderWindowMessages);
    expect(get().loadedSessions[sessionKey]?.window.windowStartOffset).toBe(40);
  });

  it('loadOlderMessages prewarms settled rows and preserves overlapping message references', async () => {
    const sessionKey = 'agent:test:main';
    const currentMessages = buildMessages(100, 121);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      messages: currentMessages,
      totalMessageCount: 220,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: currentMessages, window: viewport });
    const actions = createStoreSessionActions({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultCanonicalPrefix: 'agent:test',
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const fetchedOlderMessages = [
      ...buildMessages(80, 41),
      ...buildMessages(60, 121).map((message) => ({ ...message })),
    ];
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: fetchedOlderMessages,
      totalMessageCount: 220,
      windowStartOffset: 40,
      windowEndOffset: 180,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    await actions.loadOlderMessages(sessionKey);

    const nextMessages = get().loadedSessions[sessionKey]?.window.messages ?? [];
    expect(nextMessages).toHaveLength(140);
    expect(nextMessages[80]).toBe(currentMessages[0]);
    expect(nextMessages[139]).toBe(currentMessages[59]);
    expect(prewarmAssistantMarkdownBodiesMock).toHaveBeenCalledWith(nextMessages, 'settled');
    expect(prewarmStaticRowsForMessagesMock).toHaveBeenCalledWith(sessionKey, nextMessages);
  });

  it('jumpToLatest refreshes the session window to the latest slice', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      messages: allMessages.slice(0, 120),
      totalMessageCount: allMessages.length,
      windowStartOffset: 0,
      windowEndOffset: 120,
      hasMore: false,
      hasNewer: true,
      isAtLatest: false,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: allMessages, window: viewport });
    const actions = createStoreSessionActions({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultCanonicalPrefix: 'agent:test',
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const latestWindowMessages = allMessages.slice(100);
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: latestWindowMessages,
      totalMessageCount: allMessages.length,
      windowStartOffset: 100,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });

    await actions.jumpToLatest(sessionKey);

    expect(get().loadedSessions[sessionKey]?.window.messages).toEqual(latestWindowMessages);
    expect(get().loadedSessions[sessionKey]?.window.isAtLatest).toBe(true);
    expect(prewarmAssistantMarkdownBodiesMock).toHaveBeenCalledWith(latestWindowMessages, 'settled');
    expect(prewarmStaticRowsForMessagesMock).toHaveBeenCalledWith(sessionKey, latestWindowMessages);
  });

  it('trimTopMessages trims the top of the active session window', () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(240);
    const viewportMessages = allMessages.slice(80);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      messages: viewportMessages,
      totalMessageCount: allMessages.length,
      windowStartOffset: 80,
      windowEndOffset: 240,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: allMessages, window: viewport });
    const actions = createStoreSessionActions({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultCanonicalPrefix: 'agent:test',
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    actions.trimTopMessages(sessionKey, 120);

    expect(get().loadedSessions[sessionKey]?.window.messages).toHaveLength(120);
    expect(get().loadedSessions[sessionKey]?.window.windowStartOffset).toBe(120);
  });

  it('switchSession reloads history when the current session is reselected', async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = 'agent:test:session-1';
      const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
      const viewport = createViewportWindowState({
        ...createEmptySessionViewportState(),
        messages: [],
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
      const actions = createStoreSessionActions({
        set,
        get,
        beginMutating: vi.fn(),
        finishMutating: vi.fn(),
        defaultCanonicalPrefix: 'agent:test',
        defaultSessionKey: sessionKey,
        historyRuntime: createHistoryRuntimeHarness(),
      });

      actions.switchSession(sessionKey);
      await vi.runAllTimersAsync();

      expect(loadHistoryMock).toHaveBeenCalledWith({
        sessionKey,
        mode: 'active',
        scope: 'foreground',
        reason: 'switch_session_reselect',
      });
    } finally {
      vi.useRealTimers();
    }
  });

});


