import { describe, expect, it, vi } from 'vitest';
import {
  selectAgentSessionsPaneState,
  selectChatInputSessionKey,
  selectChatPageActions,
  selectChatPageRuntimeState,
  selectChatPageSessionState,
  selectChatPageViewState,
  selectRuntimeLayerState,
  selectSidebarPendingBlockersState,
  selectSnapshotLayerState,
  selectViewLayerState,
} from '@/stores/chat/selectors';

function makeState(overrides: Record<string, unknown> = {}) {
  return {
    messages: [{ role: 'assistant', content: 'hello', id: 'm1' }],
    sessions: [{ key: 'agent:main:main', displayName: 'main' }],
    currentSessionKey: 'agent:main:main',
    sessionLabels: { 'agent:main:main': 'Main' },
    sessionLastActivity: { 'agent:main:main': 1_700_000_000_000 },
    sessionReadyByKey: { 'agent:main:main': true },
    sending: false,
    activeRunId: null,
    streamingText: '',
    streamingMessage: null,
    streamingTools: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: [],
    approvalStatus: 'idle',
    pendingApprovalsBySession: {},
    sessionRuntimeByKey: {},
    snapshotReady: true,
    initialLoading: false,
    refreshing: false,
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
      sending: true,
      error: 'boom',
      refreshing: true,
    });

    const snapshot = selectSnapshotLayerState(state);
    const runtime = selectRuntimeLayerState(state);
    const view = selectViewLayerState(state);

    expect(snapshot.messages).toHaveLength(1);
    expect(runtime.sending).toBe(true);
    expect(view.error).toBe('boom');
    expect(view.refreshing).toBe(true);
  });

  it('chat page selectors split into session/runtime/view/actions surfaces', () => {
    const state = makeState({
      currentSessionKey: 'agent:a:main',
      pendingApprovalsBySession: {
        'agent:a:main': [{ id: 'ap-1', sessionKey: 'agent:a:main', createdAtMs: 1 }],
        'agent:b:main': [{ id: 'ap-2', sessionKey: 'agent:b:main', createdAtMs: 2 }],
      },
      sessionReadyByKey: { 'agent:a:main': true },
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
