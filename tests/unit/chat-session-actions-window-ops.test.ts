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
  getSessionRows,
  selectViewportRows,
} from '@/stores/chat/store-state-helpers';
import { buildRenderRowsFromMessages, type RawMessage } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';

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

function buildWindowSnapshotResult(input: {
  sessionKey: string;
  messages: RawMessage[];
  totalRowCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}) {
  return {
    snapshot: {
      sessionKey: input.sessionKey,
      catalog: {
        key: input.sessionKey,
        agentId: input.sessionKey.split(':')[1] ?? 'main',
        kind: input.sessionKey.endsWith(':main') ? 'main' as const : 'session' as const,
        preferred: input.sessionKey.endsWith(':main'),
        displayName: input.sessionKey,
        updatedAt: input.messages[input.messages.length - 1]?.timestamp,
      },
      rows: buildRenderRowsFromMessages(input.sessionKey, input.messages),
      replayComplete: true,
      runtime: {
        sending: false,
        activeRunId: null,
        runPhase: 'done' as const,
        streamingMessageId: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        updatedAt: 1,
      },
      window: {
        totalRowCount: input.totalRowCount,
        windowStartOffset: input.windowStartOffset,
        windowEndOffset: input.windowEndOffset,
        hasMore: input.hasMore,
        hasNewer: input.hasNewer,
        isAtLatest: input.isAtLatest,
      },
    },
  };
}

function buildSessionSnapshotResult(input: {
  sessionKey: string;
  messages: RawMessage[];
}) {
  return {
    snapshot: {
      sessionKey: input.sessionKey,
      catalog: {
        key: input.sessionKey,
        agentId: input.sessionKey.split(':')[1] ?? 'main',
        kind: input.sessionKey.endsWith(':main') ? 'main' as const : 'session' as const,
        preferred: input.sessionKey.endsWith(':main'),
        displayName: input.sessionKey,
        updatedAt: input.messages[input.messages.length - 1]?.timestamp,
      },
      rows: buildRenderRowsFromMessages(input.sessionKey, input.messages),
      replayComplete: true,
      runtime: {
        sending: false,
        activeRunId: null,
        runPhase: 'done' as const,
        streamingMessageId: null,
        pendingFinal: false,
        lastUserMessageAt: null,
        updatedAt: 1,
      },
      window: {
        totalRowCount: input.messages.length,
        windowStartOffset: 0,
        windowEndOffset: input.messages.length,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
    },
  };
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
          agentId: input.currentSessionKey.split(':')[1] ?? null,
          kind: input.currentSessionKey.endsWith(':main') ? 'main' : 'session',
          preferred: input.currentSessionKey.endsWith(':main'),
          titleSource: 'none',
          ...input.meta,
        },
        rows: buildRenderRowsFromMessages(input.currentSessionKey, input.messages),
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
      totalRowCount: allMessages.length,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      messages: allMessages.slice(120, 220),
      window: viewport,
    });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const olderWindowMessages = allMessages.slice(20, 220);
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildWindowSnapshotResult({
      sessionKey,
      messages: olderWindowMessages,
      totalRowCount: allMessages.length,
      windowStartOffset: 20,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.loadOlderMessages(sessionKey);

    expect(getSessionRows(get(), sessionKey).map((row) => row.rowId)).toEqual(
      olderWindowMessages.map((message) => message.id),
    );
    expect(selectViewportRows(get().loadedSessions[sessionKey]!).map((row) => row.rowId)).toEqual(
      olderWindowMessages.map((message) => message.id),
    );
    expect(get().loadedSessions[sessionKey]?.window.windowStartOffset).toBe(20);
    expect(get().loadedSessions[sessionKey]?.window.windowEndOffset).toBe(220);
  });

  it('jumpToLatest refreshes the session window to the latest slice', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalRowCount: allMessages.length,
      windowStartOffset: 0,
      windowEndOffset: 120,
      hasMore: false,
      hasNewer: true,
      isAtLatest: false,
    });
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      messages: allMessages.slice(0, 120),
      window: viewport,
    });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const latestWindowMessages = allMessages.slice(100);
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildWindowSnapshotResult({
      sessionKey,
      messages: latestWindowMessages,
      totalRowCount: allMessages.length,
      windowStartOffset: 100,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.jumpToLatest(sessionKey);

    expect(getSessionRows(get(), sessionKey).map((row) => row.rowId)).toEqual(
      latestWindowMessages.map((message) => message.id),
    );
    expect(selectViewportRows(get().loadedSessions[sessionKey]!).map((row) => row.rowId)).toEqual(
      latestWindowMessages.map((message) => message.id),
    );
    expect(get().loadedSessions[sessionKey]?.window.isAtLatest).toBe(true);
  });

  it('jumpToLatest replaces a stale local streaming assistant with the authoritative final row', async () => {
    const sessionKey = 'agent:test:main';
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalRowCount: 1,
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
          rows: buildRenderRowsFromMessages(sessionKey, [{
            id: 'assistant-local-stream',
            role: 'assistant',
            content: 'draft preview',
            timestamp: 2,
            streaming: true,
          }]),
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

    hostSessionWindowFetchMock.mockResolvedValueOnce(buildWindowSnapshotResult({
      sessionKey,
      messages: [{
        id: 'assistant-final-1',
        role: 'assistant',
        content: 'server final',
        timestamp: 2,
      }],
      totalRowCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.jumpToLatest(sessionKey);

    expect(getSessionRows(state, sessionKey).map((row) => row.rowId)).toEqual(['assistant-final-1']);
    expect(selectViewportRows(state.loadedSessions[sessionKey]!).map((row) => row.rowId)).toEqual(['assistant-final-1']);
  });

  it('switchSession reselect 优先走后端 session resume snapshot，而不是直接触发 history reload', async () => {
    const sessionKey = 'agent:test:session-1';
    const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
    const resumedMessages = buildMessages(2, 301);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalRowCount: 0,
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

    hostApiFetchMock.mockResolvedValueOnce(buildSessionSnapshotResult({
      sessionKey,
      messages: resumedMessages,
    }));
    actions.switchSession(sessionKey);
    await Promise.resolve();

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/session/resume', expect.objectContaining({
      method: 'POST',
    }));
    expect(loadHistoryMock).not.toHaveBeenCalled();
    for (let index = 0; index < 5; index += 1) {
      const currentRowIds = getSessionRows(get(), sessionKey).map((row) => row.rowId);
      if (currentRowIds.join('|') === resumedMessages.map((message) => message.id).join('|')) {
        break;
      }
      await Promise.resolve();
    }
    expect(getSessionRows(get(), sessionKey).map((row) => row.rowId)).toEqual(
      resumedMessages.map((message) => message.id),
    );
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
            totalRowCount: 2,
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
