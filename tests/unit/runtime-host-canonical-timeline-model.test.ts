import { describe, expect, it } from 'vitest';
import { buildRenderItemsFromCanonicalState, buildTimelineEntriesFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { SessionSnapshotService } from '../../runtime-host/application/sessions/session-snapshot-service';
import { createEmptySessionRuntimeState } from '../../runtime-host/application/sessions/session-state-model';
import type { CanonicalSessionEvent } from '../../runtime-host/application/sessions/canonical/canonical-events';
import type {
  SessionRuntimeTimelineState,
} from '../../runtime-host/application/sessions/session-runtime-types';

function buildRuntimeState(): ReturnType<typeof createEmptySessionRuntimeState> {
  return createEmptySessionRuntimeState();
}

function base(eventId: string): Pick<CanonicalSessionEvent, 'eventId' | 'provider' | 'source' | 'sessionId' | 'runId' | 'seq' | 'timestamp' | 'laneKey' | 'origin'> {
  return {
    eventId,
    provider: 'openclaw-v4',
    source: 'live',
    sessionId: 'agent:main:main',
    runId: 'run-1',
    seq: 1,
    timestamp: 1_700_000_000_000,
    laneKey: 'main',
    origin: {
      providerEventType: 'test',
      providerIds: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
      },
    },
  };
}

describe('Runtime Host canonical ACP projection', () => {
  it('keeps tool lifecycle associated with the owning assistant turn and stable segment keys', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');
    reduceCanonicalSessionEvents(state, [{
      ...base('message-1'),
      type: 'message_snapshot',
      role: 'assistant',
      content: [{ type: 'text', text: 'I will inspect it' }],
      text: 'I will inspect it',
      status: 'streaming',
    }, {
      ...base('tool-start-1'),
      seq: 2,
      type: 'tool_call',
      toolCallId: 'tool-read-1',
      name: 'Read',
      input: { file_path: 'package.json' },
    }, {
      ...base('tool-result-1'),
      seq: 3,
      timestamp: 1_700_000_000_100,
      type: 'tool_result',
      toolCallId: 'tool-read-1',
      name: 'Read',
      output: 'package content',
      outputText: 'package content',
      isError: false,
    }]);

    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'assistant-turn',
      key: 'session:agent:main:main|assistant-turn:main:message:assistant:main:1',
      turnKey: 'message:assistant:main:1',
      runId: 'run-1',
      tools: [{ toolCallId: 'tool-read-1', status: 'completed' }],
    });
    if (items[0]?.kind !== 'assistant-turn') {
      throw new Error('Expected assistant turn');
    }
    expect(items[0].segments).toMatchObject([
      { kind: 'message', key: 'message:message:assistant:main:1:main:0', text: 'I will inspect it' },
      {
        kind: 'tool',
        key: 'tool:message:assistant:main:1:main:tool-read-1',
        tool: {
          toolCallId: 'tool-read-1',
          name: 'Read',
          status: 'completed',
          output: 'package content',
        },
      },
    ]);
  });

  it('projects state-only tool lifecycle as Runtime Host side state instead of visible tool cards', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');
    reduceCanonicalSessionEvents(state, [{
      ...base('plan-1'),
      type: 'plan',
      seq: 2,
      taskSnapshot: {
        type: 'tasks',
        sessionKey: 'agent:main:main',
        tasks: [],
        artifact: null,
      },
    }]);

    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });
    expect(items).toEqual([]);
    expect(state.taskSnapshot).toMatchObject({
      type: 'tasks',
      sessionKey: 'agent:main:main',
      tasks: [],
    });
  });

  it('keeps same-run assistant messages distinct and ordered around tool output', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');
    reduceCanonicalSessionEvents(state, [{
      ...base('message-before-tool'),
      seq: 1,
      timestamp: 1_700_000_000_000,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'assistant-tool-call-message',
      content: [{ type: 'tool_call', toolCallId: 'tool-read-1', name: 'Read', input: { file_path: 'package.json' } }],
      text: '',
      status: 'streaming',
    }, {
      ...base('tool-start-1'),
      seq: 2,
      timestamp: 1_700_000_000_010,
      type: 'tool_call',
      toolCallId: 'tool-read-1',
      name: 'Read',
      input: { file_path: 'package.json' },
    }, {
      ...base('tool-result-1'),
      seq: 3,
      timestamp: 1_700_000_000_020,
      type: 'tool_result',
      toolCallId: 'tool-read-1',
      output: 'package content',
      outputText: 'package content',
      isError: false,
    }, {
      ...base('message-after-tool'),
      seq: 4,
      timestamp: 1_700_000_000_030,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'assistant-final-message',
      content: [{ type: 'text', text: '再总结' }],
      text: '再总结',
      status: 'final',
    }]);

    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });

    expect(state.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'assistant-turn')).toMatchObject([
      {
        kind: 'assistant-turn',
        turnKey: 'assistant-tool-call-message',
        tools: [{ toolCallId: 'tool-read-1' }],
      },
      {
        kind: 'assistant-turn',
        turnKey: 'assistant-final-message',
        text: '再总结',
        tools: [],
      },
    ]);
  });

  it('uses seq as the local message identity fallback without conflating messages by runId', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');
    reduceCanonicalSessionEvents(state, [{
      ...base('assistant-1'),
      seq: 1,
      type: 'message_snapshot',
      role: 'assistant',
      content: [{ type: 'text', text: '第一条' }],
      text: '第一条',
      status: 'final',
    }, {
      ...base('assistant-2'),
      seq: 2,
      type: 'message_snapshot',
      role: 'assistant',
      content: [{ type: 'text', text: '第二条' }],
      text: '第二条',
      status: 'final',
    }]);

    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });

    expect(state.messages.filter((message) => message.role === 'assistant')).toHaveLength(2);
    expect(items.filter((item) => item.kind === 'assistant-turn')).toMatchObject([
      { kind: 'assistant-turn', text: '第一条' },
      { kind: 'assistant-turn', text: '第二条' },
    ]);
  });

  it('does not emit duplicate render items when duplicate assistant timeline keys exist', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');
    reduceCanonicalSessionEvents(state, [{
      ...base('message-1'),
      type: 'message_snapshot',
      role: 'assistant',
      content: [{ type: 'text', text: '主人，晚上好。抹茶在。🍵' }],
      text: '主人，晚上好。抹茶在。🍵',
      status: 'final',
    }]);
    const [entry] = buildTimelineEntriesFromCanonicalState(state);
    if (!entry) {
      throw new Error('Expected timeline entry');
    }

    const items = buildRenderItemsFromCanonicalState({
      state,
      executionGraphItems: [],
      timelineEntries: [entry, entry],
    });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'assistant-turn',
      key: 'session:agent:main:main|assistant-turn:main:message:assistant:main:1',
    });
  });

  it('ignores duplicate canonical events by eventId through the indexed event set', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');
    const event: CanonicalSessionEvent = {
      ...base('message-1'),
      type: 'message_snapshot',
      role: 'assistant',
      content: 'first',
      text: 'first',
      status: 'streaming',
    };

    const committed = reduceCanonicalSessionEvents(state, [event, { ...event, text: 'duplicate', content: 'duplicate' }]);

    expect(committed).toHaveLength(1);
    expect(state.eventIds).toEqual(['message-1']);
    expect(state.eventIdSet.has('message-1')).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messageIndexByKey.get(state.messages[0]!.key)).toBe(0);
    expect(state.messages[0]?.text).toBe('first');
  });

  it('projects canonical control transport events into runtime issue state', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main');
    reduceCanonicalSessionEvents(state, [{
      eventId: 'control-issue-1',
      type: 'control',
      provider: 'openclaw-v4',
      source: 'control',
      sessionId: 'agent:main:main',
      timestamp: 1,
      origin: {
        providerEventType: 'gateway.transport.issue',
        providerIds: { sessionKey: 'agent:main:main' },
      },
      controlType: 'transport_issue',
      issue: {
        source: 'runtime',
        message: 'Gateway unavailable',
        code: 'UNAVAILABLE',
        retryable: true,
        retryAfterMs: 500,
        at: 1,
      },
    }]);

    expect(state.runtime.lastError).toBe('Gateway unavailable');
    expect(state.runtime.lastIssue).toMatchObject({ code: 'UNAVAILABLE', retryable: true });
    expect(state.control).toMatchObject({ phase: null, ready: null });

    reduceCanonicalSessionEvents(state, [{
      eventId: 'control-connected-1',
      type: 'control',
      provider: 'openclaw-v4',
      source: 'control',
      sessionId: 'agent:main:main',
      timestamp: 2,
      origin: {
        providerEventType: 'gateway.transport.connected',
        providerIds: { sessionKey: 'agent:main:main' },
      },
      controlType: 'transport_connected',
      transportEpoch: 1,
      ready: true,
      phase: 'ready',
    }, {
      eventId: 'control-capabilities-1',
      type: 'control',
      provider: 'openclaw-v4',
      source: 'control',
      sessionId: 'agent:main:main',
      timestamp: 3,
      origin: {
        providerEventType: 'gateway.capabilities.updated',
        providerIds: { sessionKey: 'agent:main:main' },
      },
      controlType: 'capabilities_updated',
      capabilities: {
        methods: ['status'],
        updatedAt: 3,
      },
    }]);

    expect(state.runtime.lastError).toBeNull();
    expect(state.runtime.lastIssue).toBeNull();
    expect(state.control).toMatchObject({
      transportEpoch: 1,
      ready: true,
      phase: 'ready',
      capabilities: { methods: ['status'] },
      updatedAt: 3,
    });
  });

  it('exposes pending approvals through the Runtime Host session snapshot', () => {
    const runtime = buildRuntimeState();
    const state: SessionRuntimeTimelineState = {
      sessionKey: 'agent:main:main',
      runEpoch: 0,
      canonical: createEmptyCanonicalSessionState('agent:main:main'),
      timelineEntries: [],
      executionGraphItems: [],
      renderItems: [],
      renderItemIndexByKey: new Map(),
      renderItemKeyIndex: {
        messageItemKeyByCanonicalKey: new Map(),
        toolItemKeyByCanonicalKey: new Map(),
      },
      taskSnapshot: null,
      hydrated: true,
      runtime,
      window: {
        totalItemCount: 0,
        windowStartOffset: 0,
        windowEndOffset: 0,
        hasMore: false,
        hasNewer: false,
        isAtLatest: true,
      },
      activeTransportEpoch: null,
    };
    state.canonical.approvals = [{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      title: 'Run command',
      command: 'pnpm test',
      allowedDecisions: ['allow-once', 'deny'],
      createdAtMs: 1_700_000_000_000,
    }];
    const service = new SessionSnapshotService({
      stateStore: {
        getResolvedSessionModel: () => null,
      } as never,
      sessionMetadata: {} as never,
      sessionStorage: {} as never,
    });

    const snapshot = service.buildSnapshot('agent:main:main', state);

    expect(snapshot.approvals).toEqual([{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      runId: 'run-1',
      title: 'Run command',
      command: 'pnpm test',
      allowedDecisions: ['allow-once', 'deny'],
      createdAtMs: 1_700_000_000_000,
    }]);
  });
});
