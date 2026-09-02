import { describe, expect, it, vi } from 'vitest';
import {
  selectAgentSessionsPaneState,
  selectCurrentChatSendGate,
  selectSidebarPendingBlockersState,
  selectSnapshotLayerState,
  selectViewLayerState,
} from '@/stores/chat/selectors';
import { resolveChatSendGateForPayload, type ChatSessionRuntimeState } from '@/stores/chat';
import { buildRenderItemsFromMessages } from './helpers/timeline-fixtures';
import { buildRuntimeScopeKey } from '@/stores/chat/session-identity';
import { createViewportWindowState } from '@/stores/chat/viewport-state';
import { createOpenClawTestSessionIdentity } from './helpers/runtime-address-fixtures';

function createSessionRecord(input?: {
  sessionKey?: string;
  label?: string | null;
  historyStatus?: 'idle' | 'loading' | 'ready' | 'error';
  lastActivityAt?: number | null;
  sessionIdentity?: ReturnType<typeof createOpenClawTestSessionIdentity> | null;
  runtime?: Partial<ChatSessionRuntimeState>;
  items?: ReturnType<typeof buildRenderItemsFromMessages>;
}) {
  const sessionKey = input?.sessionKey ?? 'agent:main:main';
  const sessionIdentity = input && Object.prototype.hasOwnProperty.call(input, 'sessionIdentity')
    ? input.sessionIdentity
    : createOpenClawTestSessionIdentity(sessionKey, sessionKey.split(':')[1] ?? 'default');
  const items = input?.items ?? buildRenderItemsFromMessages(sessionKey, [
    { role: 'assistant', content: 'hello', id: 'm1' },
  ]);
  const label = input && Object.prototype.hasOwnProperty.call(input, 'label')
    ? (input.label ?? null)
    : 'Main';
  return {
    meta: {
      endpointSessionId: null,
      runtimeScopeKey: sessionIdentity ? buildRuntimeScopeKey(sessionIdentity.endpoint) : null,
      agentId: sessionIdentity?.agentId ?? null,
      protocolId: null,
      runtimeEndpointId: 'local',
      sessionIdentity,
      kind: sessionKey.endsWith(':main') ? 'main' : 'session',
      preferred: sessionKey.endsWith(':main'),
      label,
      titleSource: label ? 'user' as const : 'none' as const,
      displayName: null,
      model: null,
      lastActivityAt: input && Object.prototype.hasOwnProperty.call(input, 'lastActivityAt')
        ? (input.lastActivityAt ?? null)
        : 1_700_000_000_000,
      historyStatus: input?.historyStatus ?? 'ready',
      thinkingLevel: null,
    },
    runtime: {
      activeRunId: null,
      runPhase: 'idle' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      runtimeActivity: null,
      lastUserMessageAt: null,
      lastError: null,
      lastIssue: null,
      updatedAt: null,
      ...input?.runtime,
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

function buildCurrentConversation(sessionKey: string, record: ReturnType<typeof createSessionRecord> | undefined) {
  const sessionIdentity = record?.meta.sessionIdentity;
  if (!record || !sessionIdentity) {
    return null;
  }
  return {
    kind: 'session' as const,
    runtimeScopeKey: buildRuntimeScopeKey(sessionIdentity.endpoint),
    endpoint: sessionIdentity.endpoint,
    agentId: sessionIdentity.agentId,
    sessionRecordKey: sessionKey,
    endpointSessionId: record.meta.endpointSessionId,
    sessionIdentity,
  };
}

function makeState(overrides: Record<string, unknown> = {}) {
  const loadedSessions = (overrides.loadedSessions as Record<string, ReturnType<typeof createSessionRecord>> | undefined) ?? {
    'agent:main:main': createSessionRecord(),
  };
  const currentSessionKey = (overrides.currentSessionKey as string | undefined) ?? 'agent:main:main';
  return {
    loadedSessions,
    currentSessionKey,
    currentConversation: Object.prototype.hasOwnProperty.call(overrides, 'currentConversation')
      ? overrides.currentConversation
      : buildCurrentConversation(currentSessionKey, loadedSessions[currentSessionKey]),
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
    const view = selectViewLayerState(state);

    expect(snapshot.sessions).toHaveLength(1);
    expect(view.error).toBe('boom');
    expect(view.foregroundHistorySessionKey).toBe('agent:main:main');
    expect(view.sessionsLoading).toBe(false);
    expect(view.sessionsLoadedOnce).toBe(true);
    expect(view.sessionsError).toBeNull();
  });

  it('sidebar and session pane selectors read stable snapshot/runtime surfaces', () => {
    const state = makeState({
      currentSessionKey: 'agent:foo:main',
      pendingApprovalsBySession: {
        'agent:main:main': [{
          approvalId: 'ap-1',
          sessionKey: 'agent:main:main',
          optionIds: ['option-1'],
        }],
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
    expect(pane.currentSessionKey).toBe('agent:foo:main');
    expect(pane.currentAgentId).toBe('foo');
  });

  it('current send gate follows only the current session history and identity', () => {
    const currentSessionKey = 'agent:main:main';
    const otherSessionKey = 'agent:other:main';
    const readyState = makeState({
      currentSessionKey,
      loadedSessions: {
        [currentSessionKey]: createSessionRecord({ sessionKey: currentSessionKey }),
        [otherSessionKey]: createSessionRecord({ sessionKey: otherSessionKey, historyStatus: 'loading' }),
      },
      mutating: true,
    });

    expect(resolveChatSendGateForPayload(selectCurrentChatSendGate(readyState), {
      text: 'hello',
      attachmentCount: 0,
    })).toEqual(expect.objectContaining({
      canSend: true,
      sessionKey: currentSessionKey,
    }));

    const loadingState = makeState({
      currentSessionKey,
      loadedSessions: {
        [currentSessionKey]: createSessionRecord({ sessionKey: currentSessionKey, historyStatus: 'loading' }),
        [otherSessionKey]: createSessionRecord({ sessionKey: otherSessionKey }),
      },
    });
    expect(selectCurrentChatSendGate(loadingState)).toEqual({
      canSend: false,
      reason: 'loading-history',
      sessionKey: currentSessionKey,
    });

    const missingIdentityState = makeState({
      currentSessionKey,
      loadedSessions: {
        [currentSessionKey]: createSessionRecord({ sessionKey: currentSessionKey, sessionIdentity: null }),
      },
      currentConversation: null,
    });
    expect(selectCurrentChatSendGate(missingIdentityState)).toEqual({
      canSend: false,
      reason: 'missing-session-identity',
      sessionKey: currentSessionKey,
    });
  });

  it('current send gate is stable for the same store snapshot', () => {
    const state = makeState();

    expect(selectCurrentChatSendGate(state)).toBe(selectCurrentChatSendGate(state));
  });

  it('session pane selector hides empty runtime placeholder sessions', () => {
    const state = makeState({
      loadedSessions: {
        'agent:main:main': createSessionRecord({
          label: null,
          lastActivityAt: null,
          items: [],
        }),
      },
    });

    expect(selectAgentSessionsPaneState(state).sessionEntries).toHaveLength(0);
  });

  it('session pane selector does not infer TeamRun role sessions from local session id shape', () => {
    const state = makeState({
      loadedSessions: {
        'agent:leader-agent:main': createSessionRecord({
          sessionKey: 'agent:leader-agent:main',
          label: 'Leader normal chat',
        }),
        'team-role-session-run-1-leader': createSessionRecord({
          sessionKey: 'team-role-session-run-1-leader',
          label: 'TeamRun leader role',
          lastActivityAt: 1_900_000_000_000,
        }),
      },
    });

    const entries = selectAgentSessionsPaneState(state).sessionEntries;

    expect(entries.map((entry) => entry.session.key)).toEqual(['team-role-session-run-1-leader', 'agent:leader-agent:main']);
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
