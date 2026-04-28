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
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${start + index}`,
    role: (start + index) % 2 === 0 ? 'assistant' : 'user',
    content: `message ${start + index}`,
    timestamp: start + index,
  }));
}

function createStateHarness(input: {
  currentSessionKey: string;
  transcript: RawMessage[];
  viewport: ReturnType<typeof createViewportWindowState>;
  meta?: Partial<ChatStoreState['sessionsByKey'][string]['meta']>;
  loadHistory?: ChatStoreState['loadHistory'];
}) {
  let state = {
    currentSessionKey: input.currentSessionKey,
    sessionsByKey: {
      [input.currentSessionKey]: {
        ...createEmptySessionRecord(),
        transcript: input.transcript,
        meta: {
          ...createEmptySessionRecord().meta,
          ...input.meta,
        },
      },
    },
    viewportBySession: {
      [input.currentSessionKey]: input.viewport,
    },
    pendingApprovalsBySession: {},
    sessionsResource: {
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
  });

  it('loadOlderMessages updates viewport only and preserves canonical transcript', async () => {
    const sessionKey = 'agent:test:main';
    const transcript = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      messages: transcript.slice(120),
      totalMessageCount: transcript.length,
      windowStartOffset: 120,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, transcript, viewport });
    const actions = createStoreSessionActions({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultCanonicalPrefix: 'agent:test',
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const olderWindowMessages = transcript.slice(40, 180);
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: olderWindowMessages,
      totalMessageCount: transcript.length,
      windowStartOffset: 40,
      windowEndOffset: 180,
      hasMore: true,
      hasNewer: true,
      isAtLatest: false,
    });

    await actions.loadOlderMessages(sessionKey);

    expect(get().sessionsByKey[sessionKey]?.transcript).toBe(transcript);
    expect(get().viewportBySession[sessionKey]?.messages).toEqual(olderWindowMessages);
    expect(get().viewportBySession[sessionKey]?.windowStartOffset).toBe(40);
  });

  it('jumpToLatest refreshes viewport only and preserves canonical transcript', async () => {
    const sessionKey = 'agent:test:main';
    const transcript = buildMessages(220);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      messages: transcript.slice(0, 120),
      totalMessageCount: transcript.length,
      windowStartOffset: 0,
      windowEndOffset: 120,
      hasMore: false,
      hasNewer: true,
      isAtLatest: false,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, transcript, viewport });
    const actions = createStoreSessionActions({
      set,
      get,
      beginMutating: vi.fn(),
      finishMutating: vi.fn(),
      defaultCanonicalPrefix: 'agent:test',
      defaultSessionKey: sessionKey,
      historyRuntime: createHistoryRuntimeHarness(),
    });

    const latestWindowMessages = transcript.slice(100);
    hostSessionWindowFetchMock.mockResolvedValueOnce({
      messages: latestWindowMessages,
      totalMessageCount: transcript.length,
      windowStartOffset: 100,
      windowEndOffset: 220,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });

    await actions.jumpToLatest(sessionKey);

    expect(get().sessionsByKey[sessionKey]?.transcript).toBe(transcript);
    expect(get().viewportBySession[sessionKey]?.messages).toEqual(latestWindowMessages);
    expect(get().viewportBySession[sessionKey]?.isAtLatest).toBe(true);
  });

  it('trimTopMessages only trims viewport window and does not overwrite canonical transcript', () => {
    const sessionKey = 'agent:test:main';
    const transcript = buildMessages(240);
    const viewportMessages = transcript.slice(80);
    const viewport = createViewportWindowState({
      ...createEmptySessionViewportState(),
      messages: viewportMessages,
      totalMessageCount: transcript.length,
      windowStartOffset: 80,
      windowEndOffset: 240,
      hasMore: true,
      hasNewer: false,
      isAtLatest: true,
    });
    const { set, get } = createStateHarness({ currentSessionKey: sessionKey, transcript, viewport });
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

    expect(get().sessionsByKey[sessionKey]?.transcript).toBe(transcript);
    expect(get().viewportBySession[sessionKey]?.messages).toHaveLength(120);
    expect(get().viewportBySession[sessionKey]?.windowStartOffset).toBe(120);
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
        transcript: [],
        viewport,
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
