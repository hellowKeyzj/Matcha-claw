import { describe, expect, it, vi } from 'vitest';
import {
  selectAgentSessionsPaneState,
  selectChatInputSessionKey,
  selectChatPageActions,
  selectChatPageRuntimeState,
  selectChatPageSessionState,
  selectChatPageViewState,
  selectSessionRuntime,
  selectSidebarPendingBlockersState,
  selectSnapshotLayerState,
  selectViewLayerState,
} from '@/stores/chat/selectors';

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    sessionsByKey: {
      'agent:main:main': {
        transcript: [{ role: 'assistant', content: 'hello', id: 'm1' }],
        meta: {
          label: 'Main',
          lastActivityAt: 1_700_000_000_000,
          ready: true,
          thinkingLevel: null,
        },
        runtime: {
          sending: false,
          activeRunId: null,
          runPhase: 'idle',
          streamingMessage: null,
          streamRuntime: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          approvalStatus: 'idle',
        },
      },
    },
    sessions: [{ key: 'agent:main:main', displayName: 'main' }],
    currentSessionKey: 'agent:main:main',
    pendingApprovalsBySession: {},
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
    sessionsResource: {
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
      sessionsByKey: {
        'agent:main:main': {
          transcript: [{ role: 'assistant', content: 'hello', id: 'm1' }],
          meta: {
            label: 'Main',
            lastActivityAt: 1_700_000_000_000,
            ready: true,
            thinkingLevel: null,
          },
          runtime: {
            sending: true,
            activeRunId: null,
            runPhase: 'idle',
            streamingMessage: null,
            streamRuntime: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
        },
      },
      error: 'boom',
      refreshing: true,
    });

    const snapshot = selectSnapshotLayerState(state);
    const runtime = selectSessionRuntime(state, state.currentSessionKey);
    const view = selectViewLayerState(state);

    expect(snapshot.sessions).toHaveLength(1);
    expect(runtime.sending).toBe(true);
    expect(view.error).toBe('boom');
    expect(view.refreshing).toBe(true);
    expect(view.sessionsResource.status).toBe('ready');
  });

  it('chat page selectors split into session/runtime/view/actions surfaces', () => {
    const state = makeState({
      currentSessionKey: 'agent:a:main',
      sessionsByKey: {
        'agent:a:main': {
          transcript: [],
          meta: {
            label: null,
            lastActivityAt: null,
            ready: true,
            thinkingLevel: null,
          },
          runtime: {
            sending: false,
            activeRunId: null,
            runPhase: 'idle',
            streamingMessage: null,
            streamRuntime: null,
            streamingTools: [],
            pendingFinal: false,
            lastUserMessageAt: null,
            pendingToolImages: [],
            approvalStatus: 'idle',
          },
        },
      },
      pendingApprovalsBySession: {
        'agent:a:main': [{ id: 'ap-1', sessionKey: 'agent:a:main', createdAtMs: 1 }],
        'agent:b:main': [{ id: 'ap-2', sessionKey: 'agent:b:main', createdAtMs: 2 }],
      },
      sessions: [{ key: 'agent:a:main', displayName: 'a' }],
    });

    const session = selectChatPageSessionState(state);
    const runtime = selectChatPageRuntimeState(state);
    const view = selectChatPageViewState(state);
    const actions = selectChatPageActions(state);

    expect(session.currentSessionReady).toBe(true);
    expect(runtime.currentPendingApprovals).toHaveLength(1);
    expect(runtime.currentPendingApprovals[0]?.id).toBe('ap-1');
    expect(view.showThinking).toBe(true);
    expect(actions.sendMessage).toBe(state.sendMessage);
  });

  it('sidebar and session pane selectors read stable snapshot/runtime surfaces', () => {
    const state = makeState({
      pendingApprovalsBySession: {
        'agent:main:main': [{ id: 'ap-1', sessionKey: 'agent:main:main', createdAtMs: 1 }],
      },
      sessions: [
        { key: 'agent:main:main', displayName: 'main' },
        { key: 'agent:foo:main', displayName: 'foo' },
      ],
    });

    const sidebar = selectSidebarPendingBlockersState(state);
    const pane = selectAgentSessionsPaneState(state);

    expect(Object.keys(sidebar.pendingApprovalsBySession)).toEqual(['agent:main:main']);
    expect(sidebar.chatSessions).toHaveLength(2);
    expect(pane.sessions).toHaveLength(2);
    expect(pane.sessionsResource.status).toBe('ready');
    expect(pane.currentSessionKey).toBe('agent:main:main');
  });

  it('chat input selector only exposes current session key', () => {
    const state = makeState({
      currentSessionKey: 'agent:foo:session-123',
      sending: true,
    });
    expect(selectChatInputSessionKey(state)).toBe('agent:foo:session-123');
  });
});
