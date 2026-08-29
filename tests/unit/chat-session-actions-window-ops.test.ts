import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  executeDeleteSession,
  executeJumpViewportToLatest,
  executeLoadOlderViewportItems,
  executeLoadSessions,
  executeSetViewportAnchorItemKey,
  executeSwitchSession,
} from '@/stores/chat/session-actions';
import {
  createEmptySessionRecord,
  createEmptySessionViewportState,
  getSessionItems,
  projectSessionViewItems,
  resetSessionProjection,
  selectViewportItems,
} from '@/stores/chat/store-state-helpers';
import type { SessionWireItem } from '@/types/session/snapshot';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import type { StoreHistoryCache } from '@/stores/chat/history-cache';
import type { ChatStoreState } from '@/stores/chat/types';
import {
  assistantItem,
  completeFact,
  sessionView,
  userItem,
  windowView,
} from './helpers/session-fixtures';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

const hostSessionDeleteMock = vi.fn();
const hostSessionListMock = vi.fn();
const hostSessionLoadMock = vi.fn();
const hostSessionWindowFetchMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostSessionDelete: (...args: unknown[]) => hostSessionDeleteMock(...args),
  hostSessionList: (...args: unknown[]) => hostSessionListMock(...args),
  hostSessionLoad: (...args: unknown[]) => hostSessionLoadMock(...args),
  hostSessionWindowFetch: (...args: unknown[]) => hostSessionWindowFetchMock(...args),
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

function buildView(input: {
  sessionKey: string;
  items: SessionWireItem[];
  epoch?: number;
  seq?: number;
  cursor?: number;
  totalItemCount?: number;
  windowStartOffset?: number;
  windowEndOffset?: number;
  hasMore?: boolean;
  hasNewer?: boolean;
  isAtLatest?: boolean;
}) {
  return sessionView(input.sessionKey, {
    identity: createOpenClawTestSessionIdentity(input.sessionKey),
    epoch: input.epoch ?? 1,
    seq: input.seq ?? input.items.length,
    cursor: input.cursor ?? input.items.length,
    items: completeFact(input.items),
    window: completeFact(windowView(input.totalItemCount ?? input.items.length, {
      windowStartOffset: input.windowStartOffset ?? 0,
      windowEndOffset: input.windowEndOffset ?? input.items.length,
      hasMore: input.hasMore ?? false,
      hasNewer: input.hasNewer ?? false,
      isAtLatest: input.isAtLatest ?? true,
    })),
  });
}

function createStateHarness(input: {
  currentSessionKey: string;
  items: SessionWireItem[];
  window: ReturnType<typeof createViewportWindowState>;
  meta?: Partial<ChatStoreState['loadedSessions'][string]['meta']>;
  loadHistory?: ChatStoreState['loadHistory'];
  loadSessions?: ChatStoreState['loadSessions'];
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
          sessionIdentity: createOpenClawTestSessionIdentity(input.currentSessionKey),
          ...input.meta,
        },
        items: projectSessionViewItems(buildView({ sessionKey: input.currentSessionKey, items: input.items })),
        window: input.window,
      },
    },
    pendingApprovalsBySession: {},
    sessionRecordKeyByIdentityKey: {},
    sessionRuntimeCatalog: {
      status: 'ready' as const,
      error: null,
      endpoints: [{
        endpointId: 'openclaw-default',
        protocolId: 'openclaw',
        endpoint: createOpenClawTestSessionIdentity(input.currentSessionKey).endpoint,
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'default',
        displayName: 'OpenClaw',
        agentIds: ['test'],
        acceptsDynamicAgents: true,
        sessionPromptScopes: [{ kind: 'agent' as const, endpoint: createOpenClawTestSessionIdentity(input.currentSessionKey).endpoint, agentId: 'test' }],
        defaultSessionPromptScope: { kind: 'agent' as const, endpoint: createOpenClawTestSessionIdentity(input.currentSessionKey).endpoint, agentId: 'test' },
      }],
      defaultSessionPromptScope: { kind: 'agent' as const, endpoint: createOpenClawTestSessionIdentity(input.currentSessionKey).endpoint, agentId: 'test' },
    },
    sessionCatalogStatus: {
      status: 'ready' as const,
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: null,
    },
    loadHistory: input.loadHistory ?? vi.fn().mockResolvedValue(undefined),
    loadSessions: input.loadSessions ?? vi.fn().mockResolvedValue(undefined),
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
    loadSessions: () => executeLoadSessions(shared),
    loadOlderViewportItems: (sessionKey?: string) => executeLoadOlderViewportItems(shared, sessionKey),
    jumpViewportToLatest: (sessionKey?: string) => executeJumpViewportToLatest(shared, sessionKey),
    switchSession: (key: string) => executeSwitchSession(shared, key),
    setViewportAnchorItemKey: (itemKey: string | null, sessionKey?: string) => executeSetViewportAnchorItemKey(shared, itemKey, sessionKey),
  };
}

describe('chat session window ops', () => {
  beforeEach(() => {
    vi.useRealTimers();
    hostSessionDeleteMock.mockReset();
    hostSessionListMock.mockReset();
    hostSessionLoadMock.mockReset();
    hostSessionWindowFetchMock.mockReset();
    resetSessionProjection('agent:test:main');
    resetSessionProjection('agent:test:session-1');
  });

  it('loadSessions fails the catalog load instead of leaving first paint loading when every endpoint stalls', async () => {
    vi.useFakeTimers();
    const sessionKey = 'agent:test:main';
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      items: [],
      window: createViewportWindowState(createEmptySessionViewportState()),
    });
    set({
      loadedSessions: {},
      sessionCatalogStatus: {
        status: 'idle',
        error: null,
        hasLoadedOnce: false,
        lastLoadedAt: null,
      },
    } as never);
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });
    hostSessionListMock.mockReturnValueOnce(new Promise(() => {}));

    const loadTask = actions.loadSessions();
    await Promise.resolve();
    expect(get().sessionCatalogStatus.status).toBe('loading');

    await vi.advanceTimersByTimeAsync(30_000);
    await loadTask;

    expect(get().sessionCatalogStatus.status).toBe('error');
    expect(get().sessionCatalogStatus.error).toBe('Session catalog request timed out');
    expect(get().sessionCatalogStatus.hasLoadedOnce).toBe(false);
  });

  it('loadOlderViewportItems expands the current session window upward without dropping the visible range', async () => {
    const sessionKey = 'agent:test:main';
    const allItems = Array.from({ length: 220 }, (_, index) => {
      const itemId = `item-${index + 1}`;
      return (index + 1) % 2 === 0
        ? assistantItem(itemId, `message ${index + 1}`)
        : userItem(itemId, `message ${index + 1}`);
    });
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalItemCount: allItems.length,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      items: allItems.slice(120, 220),
      window: viewport,
    });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const olderWindowItems = allItems.slice(20, 220);
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildView({
      sessionKey,
      items: olderWindowItems,
      totalItemCount: allItems.length,
      windowStartOffset: 20,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.loadOlderViewportItems(sessionKey);

    expect(getSessionItems(get(), sessionKey).map((item) => item.key)).toEqual(
      olderWindowItems.map((item) => item.itemId),
    );
    expect(selectViewportItems(get().loadedSessions[sessionKey]!).map((item) => item.key)).toEqual(
      olderWindowItems.map((item) => item.itemId),
    );
    expect(get().loadedSessions[sessionKey]?.window.windowStartOffset).toBe(20);
    expect(get().loadedSessions[sessionKey]?.window.windowEndOffset).toBe(220);
  });

  it('jumpViewportToLatest refreshes the session window to the latest slice', async () => {
    const sessionKey = 'agent:test:main';
    const allItems = Array.from({ length: 220 }, (_, index) => {
      const itemId = `item-${index + 1}`;
      return (index + 1) % 2 === 0
        ? assistantItem(itemId, `message ${index + 1}`)
        : userItem(itemId, `message ${index + 1}`);
    });
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalItemCount: allItems.length,
      windowStartOffset: 0,
      windowEndOffset: 120,
      hasMore: false,
      hasNewer: true,
      isAtLatest: false,
    });
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      items: allItems.slice(0, 120),
      window: viewport,
    });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const latestWindowItems = allItems.slice(100);
    hostSessionWindowFetchMock.mockResolvedValueOnce(buildView({
      sessionKey,
      items: latestWindowItems,
      totalItemCount: allItems.length,
      windowStartOffset: 100,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.jumpViewportToLatest(sessionKey);

    expect(getSessionItems(get(), sessionKey).map((item) => item.key)).toEqual(
      latestWindowItems.map((item) => item.itemId),
    );
    expect(selectViewportItems(get().loadedSessions[sessionKey]!).map((item) => item.key)).toEqual(
      latestWindowItems.map((item) => item.itemId),
    );
    expect(get().loadedSessions[sessionKey]?.window.isAtLatest).toBe(true);
  });

  it('jumpViewportToLatest replaces a stale local streaming assistant with the authoritative final row', async () => {
    const sessionKey = 'agent:test:main';
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalItemCount: 1,
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
          meta: {
            ...createEmptySessionRecord().meta,
            sessionIdentity: createOpenClawTestSessionIdentity(sessionKey),
          },
          items: projectSessionViewItems(buildView({
            sessionKey,
            items: [assistantItem('assistant-local-stream', 'draft preview', {
              status: 'streaming',
              runId: 'run-1',
            })],
          })),

          runtime: {
            ...createEmptySessionRecord().runtime,
            activeRunId: 'run-1',
            runPhase: 'streaming' as const,
            activeTurnItemKey: 'session:agent:test:main|assistant-turn:main:assistant-local-stream:main',
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

    hostSessionWindowFetchMock.mockResolvedValueOnce(buildView({
      sessionKey,
      items: [assistantItem('assistant-final-1', 'server final')],
      totalItemCount: 1,
      windowStartOffset: 0,
      windowEndOffset: 1,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }));

    await actions.jumpViewportToLatest(sessionKey);

    expect(getSessionItems(state, sessionKey).map((item) => item.key)).toEqual(
      ['assistant-final-1'],
    );
    expect(selectViewportItems(state.loadedSessions[sessionKey]!).map((item) => item.key)).toEqual(
      ['assistant-final-1'],
    );
  });

  it('switchSession reselect loads the sealed timeline instead of starting a history reload', async () => {
    const sessionKey = 'agent:test:session-1';
    const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
    const resumedItems = [
      userItem('item-301', 'message 301'),
      assistantItem('item-302', 'message 302'),
    ];
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      totalItemCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      items: [],
      window: viewport,
      loadHistory: loadHistoryMock,
    });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    hostSessionLoadMock.mockResolvedValueOnce(buildView({
      sessionKey,
      items: resumedItems,
    }));
    actions.switchSession(sessionKey);
    await Promise.resolve();

    expect(hostSessionLoadMock).toHaveBeenCalledWith({
      sessionKey,
      sessionIdentity: createOpenClawTestSessionIdentity(sessionKey),
      limit: 200,
    });
    expect(loadHistoryMock).not.toHaveBeenCalled();
    for (let index = 0; index < 5; index += 1) {
      const currentItemKeys = getSessionItems(get(), sessionKey).map((item) => item.key);
      if (currentItemKeys.join('|') === resumedItems.map((item) => item.itemId).join('|')) {
        break;
      }
      await Promise.resolve();
    }
    expect(getSessionItems(get(), sessionKey).map((item) => item.key)).toEqual(
      resumedItems.map((item) => item.itemId),
    );
  });

  it.each([
    { projection: { outcome: 'incomplete' as const }, error: 'Session view is unavailable' },
    { projection: new Error('HTTP 503'), error: 'Session view is unavailable' },
  ])('switchSession reselect retains the presentation on a closed timeline failure', async ({ projection, error }) => {
    const sessionKey = 'agent:test:session-1';
    const displayedItems = [
      userItem('item-401', 'message 401'),
      assistantItem('item-402', 'message 402'),
    ];
    const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      items: displayedItems,
      window: createViewportWindowState({
        ...createEmptySessionViewportState(),
        totalItemCount: displayedItems.length,
        windowStartOffset: 0,
        windowEndOffset: displayedItems.length,
        isAtLatest: true,
      }),
      loadHistory: loadHistoryMock,
    });
    const actions = createSessionHarness({
      set,
      get,
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });
    if (projection instanceof Error) {
      hostSessionLoadMock.mockRejectedValueOnce(projection);
    } else {
      hostSessionLoadMock.mockResolvedValueOnce(projection);
    }

    actions.switchSession(sessionKey);
    for (let index = 0; index < 5; index += 1) {
      if (get().error === error) break;
      await Promise.resolve();
    }

    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(getSessionItems(get(), sessionKey).map((item) => item.key)).toEqual(
      displayedItems.map((item) => item.itemId),
    );
    expect(get().loadedSessions[sessionKey]?.meta.historyStatus).toBe('ready');
    expect(get().error).toBe(error);
  });

  it.each([
    { outcome: 'target_rejected' as const },
    { outcome: 'unknown' as const },
  ])('deleteSession keeps the local projection and selection after $outcome', async ({ outcome }) => {
    const sessionKey = 'agent:test:main';
    const loadSessionsMock = vi.fn().mockResolvedValue(undefined);
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      items: [],
      window: createViewportWindowState(createEmptySessionViewportState()),
      meta: { endpointSessionId: 'endpoint-session-1' },
      loadSessions: loadSessionsMock,
    });
    const historyRuntime = createHistoryRuntimeHarness();
    historyRuntime.historyFingerprintBySession.set(sessionKey, 'history');
    historyRuntime.historyRenderFingerprintBySession.set(sessionKey, 'render');
    hostSessionDeleteMock.mockResolvedValueOnce({ outcome });

    await executeDeleteSession({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultSessionKey: 'agent:test:default',
      historyRuntime,
    }, sessionKey);

    expect(hostSessionDeleteMock).toHaveBeenCalledWith({
      sessionKey,
      sessionIdentity: createOpenClawTestSessionIdentity(sessionKey),
    });
    expect(get().loadedSessions[sessionKey]).toBeDefined();
    expect(get().currentSessionKey).toBe(sessionKey);
    expect(historyRuntime.historyFingerprintBySession.get(sessionKey)).toBe('history');
    expect(historyRuntime.historyRenderFingerprintBySession.get(sessionKey)).toBe('render');
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it('deleteSession keeps the local projection and selection when the host request fails', async () => {
    const sessionKey = 'agent:test:main';
    const loadSessionsMock = vi.fn().mockResolvedValue(undefined);
    const { set, get } = createStateHarness({
      currentSessionKey: sessionKey,
      items: [],
      window: createViewportWindowState(createEmptySessionViewportState()),
      loadSessions: loadSessionsMock,
    });
    hostSessionDeleteMock.mockRejectedValueOnce(new Error('HTTP 503'));

    await expect(executeDeleteSession({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultSessionKey: 'agent:test:default',
      historyRuntime: createHistoryRuntimeHarness(),
    }, sessionKey)).rejects.toThrow('Session delete is unavailable');

    expect(get().loadedSessions[sessionKey]).toBeDefined();
    expect(get().currentSessionKey).toBe(sessionKey);
    expect(loadSessionsMock).not.toHaveBeenCalled();
  });

  it('deleteSession removes the confirmed projection, promotes selection, and refreshes the catalog', async () => {
    const deletedSessionKey = 'agent:test:main';
    const nextSessionKey = 'agent:test:session-2';
    const loadSessionsMock = vi.fn().mockResolvedValue(undefined);
    const loadHistoryMock = vi.fn().mockResolvedValue(undefined);
    const { set, get } = createStateHarness({
      currentSessionKey: deletedSessionKey,
      items: [],
      window: createViewportWindowState(createEmptySessionViewportState()),
      meta: { endpointSessionId: 'endpoint-session-1' },
      loadSessions: loadSessionsMock,
      loadHistory: loadHistoryMock,
    });
    set((state) => ({
      loadedSessions: {
        ...state.loadedSessions,
        [nextSessionKey]: {
          ...createEmptySessionRecord(),
          meta: {
            ...createEmptySessionRecord().meta,
            sessionIdentity: createOpenClawTestSessionIdentity(nextSessionKey),
          },
        },
      },
    }));
    const historyRuntime = createHistoryRuntimeHarness();
    historyRuntime.historyFingerprintBySession.set(deletedSessionKey, 'history');
    historyRuntime.historyRenderFingerprintBySession.set(deletedSessionKey, 'render');
    hostSessionDeleteMock.mockResolvedValueOnce({ outcome: 'succeeded' });

    await executeDeleteSession({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultSessionKey: 'agent:test:default',
      historyRuntime,
    }, deletedSessionKey);

    expect(get().loadedSessions[deletedSessionKey]).toBeUndefined();
    expect(get().currentSessionKey).toBe(nextSessionKey);
    expect(historyRuntime.historyFingerprintBySession.has(deletedSessionKey)).toBe(false);
    expect(historyRuntime.historyRenderFingerprintBySession.has(deletedSessionKey)).toBe(false);
    await Promise.resolve();
    expect(hostSessionDeleteMock).toHaveBeenCalledWith({
      sessionKey: deletedSessionKey,
      sessionIdentity: createOpenClawTestSessionIdentity(deletedSessionKey),
    });
    expect(hostSessionDeleteMock.mock.calls[0]?.[0]).not.toHaveProperty('endpointSessionId');
    expect(hostSessionLoadMock).toHaveBeenCalledWith({
      sessionKey: nextSessionKey,
      sessionIdentity: createOpenClawTestSessionIdentity(nextSessionKey),
      limit: 200,
    });
    expect(loadHistoryMock).not.toHaveBeenCalled();
    expect(loadSessionsMock).toHaveBeenCalledOnce();
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
            sessionIdentity: createOpenClawTestSessionIdentity(currentSessionKey),
          },
          window: createViewportWindowState({
            ...createEmptySessionViewportState(),
            totalItemCount: 2,
            windowStartOffset: 0,
            windowEndOffset: 2,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          }),
        },
        [targetSessionKey]: {
          ...createEmptySessionRecord(),
          meta: {
            ...createEmptySessionRecord().meta,
            sessionIdentity: createOpenClawTestSessionIdentity(targetSessionKey),
          },
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
      defaultSessionKey: currentSessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    actions.switchSession(targetSessionKey);

    expect(state.currentSessionKey).toBe(targetSessionKey);
    expect(state.loadedSessions[targetSessionKey]?.meta.historyStatus).toBe('loading');
  });
});
