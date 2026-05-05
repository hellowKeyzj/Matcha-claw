import { describe, expect, it, vi } from 'vitest';
import {
  selectAgentSessionsPaneState,
  selectSessionRuntime,
  selectSidebarPendingBlockersState,
  selectSnapshotLayerState,
  selectViewLayerState,
} from '@/stores/chat/selectors';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function createSessionRecord(input?: {
  sessionKey?: string;
  label?: string | null;
  historyStatus?: 'idle' | 'loading' | 'ready' | 'error';
  lastActivityAt?: number | null;
  items?: ReturnType<typeof buildRenderItemsFromMessages>;
  sending?: boolean;
}) {
  const sessionKey = input?.sessionKey ?? 'agent:main:main';
  const items = input?.items ?? buildRenderItemsFromMessages(sessionKey, [
    { role: 'assistant', content: 'hello', id: 'm1' },
  ]);
  const label = input && Object.prototype.hasOwnProperty.call(input, 'label')
    ? (input.label ?? null)
    : 'Main';
  return {
    meta: {
      label,
      lastActivityAt: input?.lastActivityAt ?? 1_700_000_000_000,
      historyStatus: input?.historyStatus ?? 'ready',
      thinkingLevel: null,
    },
    runtime: {
      sending: input?.sending ?? false,
      activeRunId: null,
      runPhase: 'idle' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      pendingFinal: false,
      lastUserMessageAt: null,
    },
    items,
    window: createViewportWindowState({
      totalItemCount: items.length,
      windowStartOffset: 0,
      windowEndOffset: items.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }),
  };
}

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    loadedSessions: {
      'agent:main:main': createSessionRecord(),
    },
    currentSessionKey: 'agent:main:main',
    pendingApprovalsBySession: {},
    foregroundHistorySessionKey: null,
    sessionCatalogStatus: {
      status: 'ready',
      error: null,
      hasLoadedOnce: true,
      lastLoadedAt: 1,
    },
    mutating: false,
    error: null,
    showThinking: true,
    thinkingLevel: null,
    resolveApproval: vi.fn(),
    loadHistory: vi.fn(),
    loadSessions: vi.fn(),
    switchSession: vi.fn(),
    openAgentConversation: vi.fn(),
    sendMessage: vi.fn(),
    abortRun: vi.fn(),
    clearError: vi.fn(),
    cleanupEmptySession: vi.fn(),
    refresh: vi.fn(),
    toggleThinking: vi.fn(),
    newSession: vi.fn(),
    deleteSession: vi.fn(),
    ...overrides,
  } as never;
}

describe('chat selectors layering', () => {
  it('splits state into snapshot/runtime/view selectors', () => {
    const state = makeState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({ sending: true }),
      },
      error: 'boom',
      foregroundHistorySessionKey: 'agent:main:main',
    });

    const snapshot = selectSnapshotLayerState(state);
    const runtime = selectSessionRuntime(state, state.currentSessionKey);
    const view = selectViewLayerState(state);

    expect(snapshot.sessions).toHaveLength(1);
    expect(runtime.sending).toBe(true);
    expect(view.error).toBe('boom');
    expect(view.foregroundHistorySessionKey).toBe('agent:main:main');
    expect(view.sessionsLoading).toBe(false);
    expect(view.sessionsLoadedOnce).toBe(true);
    expect(view.sessionsError).toBeNull();
  });

  it('sidebar and session pane selectors read stable snapshot/runtime surfaces', () => {
    const state = makeState({
      pendingApprovalsBySession: {
        'agent:main:main': [{ id: 'ap-1', sessionKey: 'agent:main:main', createdAtMs: 1 }],
      },
      loadedSessions: {
        'agent:main:main': createSessionRecord({ label: 'Main' }),
        'agent:foo:main': createSessionRecord({
          sessionKey: 'agent:foo:main',
          label: 'Foo',
          historyStatus: 'idle',
          lastActivityAt: 1_699_000_000_000,
          items: [],
        }),
      },
    });

    const sidebar = selectSidebarPendingBlockersState(state);
    const pane = selectAgentSessionsPaneState(state);

    expect(Object.keys(sidebar.pendingApprovalsBySession)).toEqual(['agent:main:main']);
    expect(sidebar.chatSessions).toHaveLength(2);
    expect(pane.sessionEntries).toHaveLength(2);
    expect(pane.sessionsLoading).toBe(false);
    expect(pane.sessionsLoadedOnce).toBe(true);
    expect(pane.sessionsError).toBeNull();
    expect(pane.currentSessionKey).toBe('agent:main:main');
  });

  it('session pane selector keeps stable session entry references when only assistant transcript changes', () => {
    const baseState = makeState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          items: buildRenderItemsFromMessages('agent:main:main', [{ role: 'tool_result', content: 'hello', id: 'm1' }]),
        }),
      },
    });
    const nextState = makeState({
      ...baseState,
      sessionCatalogStatus: baseState.sessionCatalogStatus,
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          items: buildRenderItemsFromMessages('agent:main:main', [{ role: 'tool_result', content: 'hello again', id: 'm2' }]),
        }),
      },
    });

    const firstPane = selectAgentSessionsPaneState(baseState);
    const secondPane = selectAgentSessionsPaneState(nextState);

    expect(secondPane.sessionEntries).toBe(firstPane.sessionEntries);
    expect(secondPane).toBe(firstPane);
  });

  it('session pane selector refreshes session entries when the latest local user turn changes', () => {
    const baseState = makeState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          label: null,
          items: buildRenderItemsFromMessages('agent:main:main', [{ role: 'user', content: 'old title', id: 'u1' }]),
        }),
      },
    });
    const nextState = makeState({
      ...baseState,
      sessionCatalogStatus: baseState.sessionCatalogStatus,
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          label: null,
          items: buildRenderItemsFromMessages('agent:main:main', [{
            role: 'user',
            content: 'new title',
            id: 'optimistic-user-1',
            timestamp: 1_700_000_001,
          }]),
        }),
      },
    });

    const firstPane = selectAgentSessionsPaneState(baseState);
    const secondPane = selectAgentSessionsPaneState(nextState);

    expect(secondPane.sessionEntries).not.toBe(firstPane.sessionEntries);
    expect(secondPane.sessionEntries[0]?.title).toBe('new title');
  });

  it('session pane selector refreshes session title when loaded viewport title changes', () => {
    const baseState = makeState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          label: null,
          items: buildRenderItemsFromMessages('agent:main:main', [{ role: 'user', content: '旧正文标题', id: 'u1' }]),
        }),
      },
    });
    const nextState = makeState({
      ...baseState,
      sessionCatalogStatus: baseState.sessionCatalogStatus,
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          label: null,
          items: buildRenderItemsFromMessages('agent:main:main', [{ role: 'user', content: '新正文标题', id: 'u2' }]),
        }),
      },
    });

    const firstPane = selectAgentSessionsPaneState(baseState);
    const secondPane = selectAgentSessionsPaneState(nextState);

    expect(firstPane.sessionEntries[0]?.title).toBe('旧正文标题');
    expect(secondPane.sessionEntries[0]?.title).toBe('新正文标题');
    expect(secondPane.sessionEntries).not.toBe(firstPane.sessionEntries);
  });
});
