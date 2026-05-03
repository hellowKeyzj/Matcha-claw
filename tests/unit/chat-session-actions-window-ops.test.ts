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
  getSessionTimelineEntries,
  selectViewportTimelineEntries,
} from '@/stores/chat/store-state-helpers';
import { materializeTimelineMessages } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';
import type { RawMessage } from './helpers/timeline-fixtures';
import { normalizeCanonicalChatMessage } from '@/../runtime-host/shared/chat-message-normalization';

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
  return Array.from({ length: count }, (_, index) => (
    normalizeCanonicalChatMessage({
      id: `message-${start + index}`,
      role: (start + index) % 2 === 0 ? 'assistant' : 'user',
      content: `message ${start + index}`,
      timestamp: start + index,
    }) as RawMessage
  ));
}

function buildTimelineEntries(sessionKey: string, messages: RawMessage[]) {
  return messages.map((message, index) => ({
    entryId: `${message.id ?? `entry-${index + 1}`}`,
    sessionKey,
    laneKey: message.agentId ? `member:${message.agentId}` : 'main',
    turnKey: message.agentId ? `member:${message.agentId}:${message.id ?? index + 1}` : `main:${message.id ?? index + 1}`,
    role: message.role,
    status: 'final' as const,
    text: typeof message.content === 'string' ? message.content : '',
    message,
  }));
}

function materializeSessionMessages(sessionKey: string, messages: RawMessage[]): RawMessage[] {
  return materializeTimelineMessages(buildTimelineEntries(sessionKey, messages));
}

function buildWindowSnapshotResult(input: {
  sessionKey: string;
  messages: RawMessage[];
  totalMessageCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}) {
  return {
    snapshot: {
      sessionKey: input.sessionKey,
      entries: buildTimelineEntries(input.sessionKey, input.messages),
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
        totalEntryCount: input.totalMessageCount,
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
      entries: buildTimelineEntries(input.sessionKey, input.messages),
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
        totalEntryCount: input.messages.length,
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
          ...input.meta,
        },
        timelineEntries: buildTimelineEntries(input.currentSessionKey, input.messages),
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
    const currentWindowMessages = materializeSessionMessages(sessionKey, allMessages.slice(120, 220));
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: allMessages.length,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: currentWindowMessages, window: viewport });
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
      totalMessageCount: allMessages.length,
      windowStartOffset: 20,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.loadOlderMessages(sessionKey);

    expect(materializeTimelineMessages(getSessionTimelineEntries(get(), sessionKey)).map((message) => message.id)).toEqual(
      olderWindowMessages.map((message) => message.id),
    );
    expect(materializeTimelineMessages(selectViewportTimelineEntries(get().loadedSessions[sessionKey]!)).map((message) => message.id)).toEqual(
      olderWindowMessages.map((message) => message.id),
    );
    expect(get().loadedSessions[sessionKey]?.window.windowStartOffset).toBe(20);
    expect(get().loadedSessions[sessionKey]?.window.windowEndOffset).toBe(220);
  });

  it('loadOlderMessages preserves overlapping message references', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const currentWindowMessages = materializeSessionMessages(sessionKey, allMessages.slice(120, 220));
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: 220,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: currentWindowMessages, window: viewport });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });
    const currentWindowMessagesRef = materializeTimelineMessages(
      getSessionTimelineEntries(get(), sessionKey),
    );

    const fetchedOlderMessages = [
      ...buildMessages(100, 21),
      ...currentWindowMessagesRef.map((message) => ({ ...message })),
    ];
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildWindowSnapshotResult({
      sessionKey,
      messages: fetchedOlderMessages,
      totalMessageCount: 220,
      windowStartOffset: 20,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.loadOlderMessages(sessionKey);

    const nextRecord = get().loadedSessions[sessionKey]!;
    const nextMessages = materializeTimelineMessages(selectViewportTimelineEntries(nextRecord));
    expect(nextMessages).toHaveLength(200);
    expect(nextMessages[100]).toMatchObject(currentWindowMessagesRef[0]!);
    expect(nextMessages[199]).toMatchObject(currentWindowMessagesRef[99]!);
  });

  it('jumpToLatest refreshes the session window to the latest slice', async () => {
    const sessionKey = 'agent:test:main';
    const allMessages = buildMessages(220);
    const currentWindowMessages = allMessages.slice(0, 120);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalMessageCount: allMessages.length,
      windowStartOffset: 0,
      windowEndOffset: 120,
      hasMore: false,
      hasNewer: true,
      isAtLatest: false,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, messages: currentWindowMessages, window: viewport });
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
      totalMessageCount: allMessages.length,
      windowStartOffset: 100,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.jumpToLatest(sessionKey);

    expect(materializeTimelineMessages(getSessionTimelineEntries(get(), sessionKey)).map((message) => message.id)).toEqual(
      latestWindowMessages.map((message) => message.id),
    );
    expect(materializeTimelineMessages(selectViewportTimelineEntries(get().loadedSessions[sessionKey]!)).map((message) => message.id)).toEqual(
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
          timelineEntries: buildTimelineEntries(sessionKey, [{
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
      totalMessageCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.jumpToLatest(sessionKey);

    expect(materializeTimelineMessages(getSessionTimelineEntries(state, sessionKey)).map((message) => message.id)).toEqual(['assistant-final-1']);
    expect(materializeTimelineMessages(selectViewportTimelineEntries(state.loadedSessions[sessionKey]!)).map((message) => message.id)).toEqual(['assistant-final-1']);
  });

  it('switchSession reselect 优先走后端 session resume snapshot，而不是直接触发 history reload', async () => {
    const sessionKey = 'agent:test:session-1';
    const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
    const resumedMessages = buildMessages(2, 301);
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
      const currentMessageIds = materializeTimelineMessages(getSessionTimelineEntries(get(), sessionKey)).map((message) => message.id);
      if (currentMessageIds.join('|') === resumedMessages.map((message) => message.id).join('|')) {
        break;
      }
      await Promise.resolve();
    }
    expect(materializeTimelineMessages(getSessionTimelineEntries(get(), sessionKey)).map((message) => message.id)).toEqual(
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

