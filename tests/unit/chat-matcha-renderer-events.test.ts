import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleStoreMatchaSessionActivity,
  handleStoreOpenClawSessionActivity,
  handleStoreOpenClawSessionUpdate,
} from '@/stores/chat/event-actions';
import type { ChatStoreState } from '@/stores/chat/types';
import { createViewportWindowState } from '@/stores/chat/viewport-state';

const openClawTestRuntimeEndpoint = {
  kind: 'native-runtime',
  runtimeAdapterId: 'openclaw',
  runtimeInstanceId: 'local',
} as const;

function createOpenClawTestSessionIdentity(sessionKey: string) {
  return {
    endpoint: openClawTestRuntimeEndpoint,
    agentId: sessionKey.split(':')[1] ?? 'main',
    sessionKey,
  };
}

function createSessionRecord(sessionKey: string) {
  return {
    meta: {
      runtimeScopeKey: 'native-runtime:openclaw:local',
      agentId: sessionKey.split(':')[1] ?? null,
      protocolId: 'openclaw-v4',
      runtimeEndpointId: 'local',
      sessionIdentity: createOpenClawTestSessionIdentity(sessionKey),
      kind: 'session' as const,
      preferred: false,
      label: null,
      titleSource: 'none' as const,
      lastActivityAt: null,
      historyStatus: 'ready' as const,
      thinkingLevel: null,
    },
    runtime: {
      activeRunId: null,
      runPhase: 'idle' as const,
      activeTurnItemKey: null,
      pendingTurnKey: null,
      pendingTurnLaneKey: null,
      lastUserMessageAt: null,
      lastError: null,
      lastIssue: null,
      updatedAt: null,
    },
    items: [],
    window: createViewportWindowState({
      totalItemCount: 0,
      windowStartOffset: 0,
      windowEndOffset: 0,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    }),
  };
}

function createState(sessionKey: string, routeKey: string, runId = 'run:test') {
  return {
    currentSessionKey: sessionKey,
    loadedSessions: { [sessionKey]: createSessionRecord(sessionKey) },
    rendererRouteRecordKeys: {
      [routeKey]: { recordKey: sessionKey, sessionKey, runId },
    },
  } as ChatStoreState;
}

function createInput(initialState: ChatStoreState) {
  let state = initialState;
  const set = (partial: Partial<ChatStoreState> | ((current: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState)) => {
    state = { ...state, ...(typeof partial === 'function' ? partial(state) : partial) } as ChatStoreState;
  };
  return { input: { set, get: () => state }, getState: () => state };
}

describe('Matcha renderer event routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes opaque keys to bound records rather than the current session', () => {
    const foreground = 'agent:main:foreground';
    const background = 'agent:main:background';
    const foregroundRoute = 'renderer-route:foreground';
    const backgroundRoute = 'renderer-route:background';
    const { input, getState } = createInput({
      currentSessionKey: foreground,
      loadedSessions: { [foreground]: createSessionRecord(foreground), [background]: createSessionRecord(background) },
      rendererRouteRecordKeys: {
        [foregroundRoute]: { recordKey: foreground, sessionKey: foreground, runId: 'run:foreground' },
        [backgroundRoute]: { recordKey: background, sessionKey: background, runId: 'run:background' },
      },
    } as ChatStoreState);

    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey: foregroundRoute, sequence: 1,
      activity: { kind: 'run', phase: 'started' },
    });
    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey: backgroundRoute, sequence: 1,
      activity: { kind: 'run', phase: 'waiting_for_approval' },
    });

    expect(getState().loadedSessions[foreground]!.runtime).toMatchObject({ runPhase: 'streaming', activeRunId: 'run:foreground' });
    expect(getState().loadedSessions[background]!.runtime).toMatchObject({ runPhase: 'waiting_tool', activeRunId: 'run:background' });
  });

  it('orders message and tool segments by first activity and merges duplicate sequences once', () => {
    const sessionKey = 'agent:main:activity-order';
    const routeKey = 'renderer-route:activity-order';
    const { input, getState } = createInput(createState(sessionKey, routeKey));

    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 1,
      activity: { kind: 'message', messageId: 'message-1', lifecycle: 'started' },
    });
    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 2,
      activity: { kind: 'message', messageId: 'message-1', lifecycle: 'delta', textDelta: 'before ' },
    });
    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 3,
      activity: { kind: 'tool', toolCallId: 'tool-1', phase: 'started' },
    });
    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 4,
      activity: { kind: 'message', messageId: 'message-2', lifecycle: 'delta', textDelta: 'after' },
    });
    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 4,
      activity: { kind: 'message', messageId: 'message-2', lifecycle: 'delta', textDelta: ' ignored' },
    });
    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 5,
      activity: { kind: 'tool', toolCallId: 'tool-1', phase: 'completed' },
    });

    const assistant = getState().loadedSessions[sessionKey]!.items[0];
    expect(assistant).toMatchObject({ kind: 'assistant-turn', text: 'before after' });
    if (assistant?.kind !== 'assistant-turn') throw new Error('expected assistant turn');
    expect(assistant.segments.map((segment) => segment.key)).toEqual(['message:message-1', 'tool:tool-1', 'message:message-2']);
    expect(assistant.tools).toMatchObject([{ id: 'tool-1', status: 'completed' }]);
    expect(getState().loadedSessions[sessionKey]!.runtime.lastMatchaActivitySequence).toBe(5);
  });

  it('keeps a tool-only assistant turn visible', () => {
    const sessionKey = 'agent:main:tool-only';
    const routeKey = 'renderer-route:tool-only';
    const { input, getState } = createInput(createState(sessionKey, routeKey));

    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 1,
      activity: { kind: 'tool', toolCallId: 'tool-only', phase: 'started' },
    });

    const assistant = getState().loadedSessions[sessionKey]!.items[0];
    expect(assistant).toMatchObject({ kind: 'assistant-turn', text: '', tools: [{ id: 'tool-only', status: 'running' }] });
    if (assistant?.kind !== 'assistant-turn') throw new Error('expected assistant turn');
    expect(assistant.segments).toHaveLength(1);
  });

  it('keeps approvals outside transcript while refreshing native approval projection', async () => {
    const sessionKey = 'agent:main:approval';
    const routeKey = 'renderer-route:approval';
    const { input, getState } = createInput(createState(sessionKey, routeKey));
    const syncPendingApprovals = vi.fn(async () => undefined);

    handleStoreMatchaSessionActivity({ ...input, syncPendingApprovals }, {
      type: 'matcha.session.activity', routeKey, sequence: 1,
      activity: { kind: 'approval', approvalId: 'approval-1', phase: 'requested', optionIds: ['allow-once', 'deny'] },
    });
    await Promise.resolve();

    expect(getState().loadedSessions[sessionKey]!.items).toEqual([]);
    expect(getState().pendingApprovalsBySession[sessionKey]).toEqual([{
      approvalId: 'approval-1',
      optionIds: ['allow-once', 'deny'],
      sessionKey,
    }]);
    expect(getState().loadedSessions[sessionKey]!.runtime).toMatchObject({ runPhase: 'waiting_tool', activeRunId: 'run:test' });
    expect(syncPendingApprovals).toHaveBeenCalledWith(sessionKey);

    handleStoreMatchaSessionActivity({ ...input, syncPendingApprovals }, {
      type: 'matcha.session.activity', routeKey, sequence: 2,
      activity: { kind: 'approval', approvalId: 'approval-1', phase: 'resolved' },
    });
    expect(getState().loadedSessions[sessionKey]!.items).toEqual([]);
    expect(getState().pendingApprovalsBySession[sessionKey]).toEqual([]);
  });

  it('ignores unknown routes and releases only terminal routes', () => {
    const sessionKey = 'agent:main:terminal';
    const routeKey = 'renderer-route:terminal';
    const { input, getState } = createInput(createState(sessionKey, routeKey));

    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey: 'renderer-route:foreign', sequence: 1,
      activity: { kind: 'run', phase: 'started' },
    });
    expect(getState().loadedSessions[sessionKey]!.runtime.runPhase).toBe('idle');

    const loadHistory = vi.fn(async () => undefined);
    handleStoreMatchaSessionActivity({ ...input, loadHistory }, {
      type: 'matcha.session.activity', routeKey, sequence: 1,
      activity: { kind: 'run', phase: 'completed' },
    });
    expect(getState().loadedSessions[sessionKey]!.runtime).toMatchObject({ runPhase: 'done', activeRunId: null });
    expect(getState().rendererRouteRecordKeys).toEqual({});
  });

  it('releases terminal route bindings without creating a missing renderer projection', () => {
    const routeKey = 'renderer-route:orphaned';
    const { input, getState } = createInput({
      currentSessionKey: 'agent:main:current',
      loadedSessions: {},
      rendererRouteRecordKeys: { [routeKey]: { recordKey: 'agent:main:missing', sessionKey: 'agent:main:missing', runId: 'run:missing' } },
    } as ChatStoreState);

    handleStoreMatchaSessionActivity(input, {
      type: 'matcha.session.activity', routeKey, sequence: 1,
      activity: { kind: 'run', phase: 'failed' },
    });

    expect(getState().loadedSessions).toEqual({});
    expect(getState().rendererRouteRecordKeys).toEqual({});
  });

  it('preserves an existing OpenClaw tool result when activity updates the same tool', () => {
    const sessionKey = 'agent:main:openclaw-tool';
    const routeKey = 'renderer-route:openclaw-tool';
    const { input, getState } = createInput(createState(sessionKey, routeKey));

    handleStoreOpenClawSessionActivity(input, {
      type: 'openclaw.session.activity', routeKey, sequence: 1,
      activity: { kind: 'tool', toolId: 'tool-1', phase: 'completed', summary: 'done' },
    });
    const first = getState().loadedSessions[sessionKey]!.items[0];
    if (first?.kind !== 'assistant-turn' || first.segments[0]?.kind !== 'tool') throw new Error('expected tool segment');
    const result = { kind: 'text' as const, surface: 'tool-card' as const, collapsedPreview: 'done', bodyText: 'done' };
    getState().loadedSessions[sessionKey]!.items[0] = {
      ...first,
      segments: [{ ...first.segments[0], tool: { ...first.segments[0].tool, result } }],
      tools: [{ ...first.segments[0].tool, result }],
    };

    handleStoreOpenClawSessionActivity(input, {
      type: 'openclaw.session.activity', routeKey, sequence: 2,
      activity: { kind: 'tool', toolId: 'tool-1', phase: 'updated', summary: 'still done' },
    });

    const updated = getState().loadedSessions[sessionKey]!.items[0];
    if (updated?.kind !== 'assistant-turn' || updated.segments[0]?.kind !== 'tool') throw new Error('expected updated tool segment');
    expect(updated.segments[0].tool.result).toEqual(result);
  });

  it('keeps OpenClaw delta, snapshot, and terminal updates on their separate path', async () => {
    const sessionKey = 'agent:main:openclaw';
    const routeKey = 'renderer-route:openclaw';
    const { input, getState } = createInput(createState(sessionKey, routeKey));
    const loadHistory = vi.fn(async () => undefined);

    handleStoreOpenClawSessionUpdate({ ...input, loadHistory }, {
      type: 'openclaw.session.update', routeKey, kind: 'delta', sequence: 1, text: 'Hello ', replace: false,
    });
    handleStoreOpenClawSessionUpdate({ ...input, loadHistory }, {
      type: 'openclaw.session.update', routeKey, kind: 'delta', sequence: 2, text: 'world', replace: false,
    });
    handleStoreOpenClawSessionUpdate({ ...input, loadHistory }, {
      type: 'openclaw.session.update', routeKey, kind: 'delta', sequence: 2, text: 'ignored', replace: false,
    });
    handleStoreOpenClawSessionUpdate({ ...input, loadHistory }, {
      type: 'openclaw.session.update', routeKey, kind: 'terminal', sequence: 3, text: 'authoritative', replace: false, terminal: 'completed',
    });
    await Promise.resolve();

    expect(getState().loadedSessions[sessionKey]!.items[0]).toMatchObject({ text: 'authoritative', status: 'final' });
    expect(getState().loadedSessions[sessionKey]!.runtime).toMatchObject({ activeRunId: null, runPhase: 'done', lastSessionUpdateSequence: 3 });
    expect(getState().rendererRouteRecordKeys).toEqual({});
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });
});
