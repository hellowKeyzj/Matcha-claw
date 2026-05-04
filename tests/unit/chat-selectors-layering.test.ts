import { describe, expect, it, vi } from 'vitest';
import {
  selectAgentSessionsPaneState,
  selectSessionRuntime,
  selectSidebarPendingBlockersState,
  selectSnapshotLayerState,
  selectViewLayerState,
} from '@/stores/chat/selectors';
import { buildTimelineEntriesFromMessages } from './helpers/timeline-fixtures';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

function makeState(overrides: Record<string, unknown> = {}) {
  const baseMessages = [{ role: 'assistant', content: 'hello', id: 'm1' }];
  return {
    loadedSessions: {
      'agent:main:main': {
        timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', baseMessages),
        meta: {
          label: 'Main',
          lastActivityAt: 1_700_000_000_000,
          historyStatus: 'ready',
          thinkingLevel: null,
        },
        runtime: {
          sending: false,
          activeRunId: null,
          runPhase: 'idle',
          streamingAnchorKey: null,
          pendingFinal: false,
          lastUserMessageAt: null,
        },
        window: createViewportWindowState({
          totalMessageCount: 1,
          windowStartOffset: 0,
          windowEndOffset: 1,
          hasMore: false,
          hasNewer: false,
          isAtLatest: true,
        }),
      },
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
        'agent:main:main': {
          meta: {
            label: 'Main',
            lastActivityAt: 1_700_000_000_000,
            historyStatus: 'ready',
            thinkingLevel: null,
          },
          messages: [{ role: 'assistant', content: 'hello', id: 'm1' }],
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{ role: 'assistant', content: 'hello', id: 'm1' }]),
          runtime: {
            sending: true,
            activeRunId: null,
            runPhase: 'idle',
            streamingAnchorKey: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
          window: createViewportWindowState({
            totalMessageCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          }),
        },
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
        'agent:main:main': {
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{ role: 'assistant', content: 'hello', id: 'm1' }]),
          meta: {
            label: 'Main',
            lastActivityAt: 1_700_000_000_000,
            historyStatus: 'ready',
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            streamingAnchorKey: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
          window: createViewportWindowState({
            totalMessageCount: 1,
            windowStartOffset: 0,
            windowEndOffset: 1,
            hasMore: false,
            hasNewer: false,
            isAtLatest: true,
          }),
        },
        'agent:foo:main': {
          timelineEntries: [],
          meta: {
            label: 'Foo',
            lastActivityAt: 1_699_000_000_000,
            historyStatus: 'idle',
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            streamingAnchorKey: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
          window: createViewportWindowState(),
        },
      },
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
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

  it('session pane selector should keep stable session entry references when only transcript changes', () => {
    const baseState = makeState({
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': {
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{ role: 'tool_result', content: 'hello', id: 'm1' }]),
          meta: {
            label: 'Main',
            lastActivityAt: 1_700_000_000_000,
            historyStatus: 'ready',
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            streamingAnchorKey: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
          window: createViewportWindowState({ totalMessageCount: 1, windowStartOffset: 0, windowEndOffset: 1, hasMore: false, hasNewer: false, isAtLatest: true }),
        },
      },
    });
    const nextState = makeState({
      ...baseState,
      sessionCatalogStatus: baseState.sessionCatalogStatus,
      loadedSessions: {
        'agent:main:main': {
          ...baseState.loadedSessions['agent:main:main'],
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{ role: 'tool_result', content: 'hello again', id: 'm2' }]),
        },
      },
    });

    const firstPane = selectAgentSessionsPaneState(baseState);
    const secondPane = selectAgentSessionsPaneState(nextState);

    expect(secondPane.sessionEntries).toBe(firstPane.sessionEntries);
    expect(secondPane).toBe(firstPane);
  });

  it('session pane selector should refresh session entries when the latest local user turn changes', () => {
    const baseState = makeState({
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': {
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{ role: 'user', content: 'old title', id: 'u1' }]),
          meta: {
            label: 'Main',
            lastActivityAt: 1_700_000_000_000,
            historyStatus: 'ready',
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            streamingAnchorKey: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
          window: createViewportWindowState({ totalMessageCount: 1, windowStartOffset: 0, windowEndOffset: 1, hasMore: false, hasNewer: false, isAtLatest: true }),
        },
      },
    });
    const nextState = makeState({
      ...baseState,
      sessionCatalogStatus: baseState.sessionCatalogStatus,
      loadedSessions: {
        'agent:main:main': {
          ...baseState.loadedSessions['agent:main:main'],
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{
            role: 'user',
            content: 'new title',
            id: 'optimistic-user-1',
            timestamp: 1_700_000_001,
          }]),
        },
      },
    });

    const firstPane = selectAgentSessionsPaneState(baseState);
    const secondPane = selectAgentSessionsPaneState(nextState);

    expect(secondPane.sessionEntries).not.toBe(firstPane.sessionEntries);
    expect(secondPane.sessionEntries[0]?.title).toBe('new title');
  });

  it('session pane selector should refresh session title when loaded viewport title changes', () => {
    const baseState = makeState({
      sessionCatalogStatus: {
        status: 'ready',
        error: null,
        hasLoadedOnce: true,
        lastLoadedAt: 1,
      },
      loadedSessions: {
        'agent:main:main': {
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{ role: 'user', content: '旧正文标题', id: 'u1' }]),
          meta: {
            label: '旧标题',
            lastActivityAt: 1_700_000_000_000,
            historyStatus: 'ready',
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            streamingAnchorKey: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
          window: createViewportWindowState({ totalMessageCount: 1, windowStartOffset: 0, windowEndOffset: 1, hasMore: false, hasNewer: false, isAtLatest: true }),
        },
      },
    });
    const nextState = makeState({
      ...baseState,
      sessionCatalogStatus: baseState.sessionCatalogStatus,
      loadedSessions: {
        'agent:main:main': {
          ...baseState.loadedSessions['agent:main:main'],
          timelineEntries: buildTimelineEntriesFromMessages('agent:main:main', [{ role: 'user', content: '新正文标题', id: 'u2' }]),
        },
      },
    });

    const firstPane = selectAgentSessionsPaneState(baseState);
    const secondPane = selectAgentSessionsPaneState(nextState);

    expect(firstPane.sessionEntries[0]?.title).toBe('旧正文标题');
    expect(secondPane.sessionEntries[0]?.title).toBe('新正文标题');
    expect(secondPane.sessionEntries).not.toBe(firstPane.sessionEntries);
  });
});

