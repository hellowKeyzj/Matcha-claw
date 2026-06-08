import { describe, expect, it } from 'vitest';
import { buildProjectedCanonicalSessionState, buildRenderItemsFromCanonicalState, buildTimelineEntriesFromCanonicalState } from '../../runtime-host/application/sessions/canonical/canonical-projection';
import { createEmptyCanonicalSessionState, reduceCanonicalSessionEvents } from '../../runtime-host/application/sessions/canonical/canonical-reducer';
import { SessionSnapshotService } from '../../runtime-host/application/sessions/session-snapshot-service';
import { SessionSnapshotWorkflow } from '../../runtime-host/application/workflows/session-snapshot/session-snapshot-workflow';
import { createEmptySessionRuntimeState, createEmptyTimelineState } from '../../runtime-host/application/sessions/session-state-model';
import { SessionTimelineRuntime } from '../../runtime-host/application/sessions/session-timeline-runtime';
import { SessionExecutionGraphRuntime } from '../../runtime-host/application/sessions/session-execution-graph-runtime';
import type { CanonicalSessionEvent } from '../../runtime-host/application/sessions/canonical/canonical-events';
import type {
  SessionRuntimeTimelineState,
} from '../../runtime-host/application/sessions/session-runtime-types';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID } from '../../runtime-host/application/adapters/openclaw/runtime/openclaw-runtime-identity';
import { createOpenClawTestSessionIdentity, createOpenClawTestRuntimeContext } from './helpers/runtime-address-fixtures';

function buildRuntimeState(): ReturnType<typeof createEmptySessionRuntimeState> {
  return createEmptySessionRuntimeState();
}

function createTimelineRuntime(state: SessionRuntimeTimelineState) {
  const stateStore = {
    ready: async () => undefined,
    getSessionState: () => state,
    persistStore: () => undefined,
    updateExecutionGraphDependencyIndex: () => undefined,
    syncTransportIssueIndex: () => undefined,
    syncApprovalIdentityIndex: () => undefined,
    listParentSessionStates: () => [],
  };
  const executionGraphRuntime = new SessionExecutionGraphRuntime({
    stateStore: stateStore as never,
  });
  return new SessionTimelineRuntime({
    stateStore: stateStore as never,
    sessionStorage: {} as never,
    transcriptLoader: {} as never,
    executionGraphRuntime,
    clock: { nowMs: () => 1_700_000_000_500 },
  });
}

function base(eventId: string): Pick<CanonicalSessionEvent, 'eventId' | 'protocolId' | 'runtimeEndpointId' | 'source' | 'sessionId' | 'runId' | 'seq' | 'timestamp' | 'laneKey' | 'origin'> {
  return {
    eventId,
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    source: 'live',
    sessionId: 'agent:main:main',
    runId: 'run-1',
    seq: 1,
    timestamp: 1_700_000_000_000,
    laneKey: 'main',
    origin: {
      runtimeEventType: 'test',
      runtimeIds: {
        sessionKey: 'agent:main:main',
        runId: 'run-1',
      },
    },
  };
}

describe('Runtime Host canonical ACP projection', () => {
  it('does not treat timestamp-less replay boundaries as session activity', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('replay-start'),
      source: 'replay',
      type: 'replay_boundary',
      timestamp: undefined,
      phase: 'start',
    }, {
      ...base('replay-end'),
      source: 'replay',
      type: 'replay_boundary',
      timestamp: undefined,
      phase: 'end',
    }]);

    expect(state.updatedAt).toBeNull();
    expect(state.runtime.updatedAt).toBeNull();
  });

  it('keeps tool lifecycle associated with the owning assistant turn and stable segment keys', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
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
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
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

  it('projects thought snapshots into an assistant turn even before assistant message text arrives', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('thought-1'),
      seq: 1,
      type: 'thought_snapshot',
      text: '先检查入口',
      status: 'streaming',
    }]);

    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });
    expect(items).toMatchObject([{
      kind: 'assistant-turn',
      runId: 'run-1',
      status: 'final',
      thinking: '先检查入口',
      segments: [{ kind: 'thinking', text: '先检查入口' }],
      text: '',
    }]);
  });

  it('settles thought-only assistant turns when the run is no longer active', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('thought-1'),
      seq: 1,
      type: 'thought_snapshot',
      text: '先检查入口',
      status: 'streaming',
    }, {
      ...base('lifecycle-final-1'),
      seq: 2,
      type: 'lifecycle',
      phase: 'final',
      runPhase: 'done',
      error: null,
    }]);

    const items = buildRenderItemsFromCanonicalState({ state, executionGraphItems: [] });
    expect(items).toMatchObject([{
      kind: 'assistant-turn',
      runId: 'run-1',
      status: 'final',
      thinking: '先检查入口',
    }]);
  });

  it('keeps final assistant tool-use turns active until tool results arrive', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('message-with-tool-call'),
      seq: 1,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'assistant-tool-turn',
      content: [
        { type: 'thinking', thinking: '先检查入口' },
        { type: 'text', text: '我先读文件。' },
        { type: 'tool_call', toolCallId: 'tool-read-1', name: 'Read', input: { file_path: 'package.json' } },
      ],
      text: '我先读文件。',
      status: 'final',
    }]);

    expect(state.runtime).toMatchObject({
      activeRunId: 'run-1',
      runPhase: 'waiting_tool',
      pendingTurnKey: 'run-1',
      pendingTurnLaneKey: 'main',
      lastError: null,
    });
  });

  it('does not let an old run final clear a newer active run', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('run-1-started'),
      type: 'lifecycle',
      phase: 'started',
      runPhase: 'submitted',
      error: null,
    }, {
      ...base('run-2-started'),
      eventId: 'run-2-started',
      runId: 'run-2',
      seq: 2,
      type: 'lifecycle',
      phase: 'started',
      runPhase: 'submitted',
      error: null,
    }, {
      ...base('run-1-final-message'),
      seq: 3,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'old-run-final',
      content: [{ type: 'text', text: '旧 run 完成' }],
      text: '旧 run 完成',
      status: 'final',
    }, {
      ...base('run-1-final-lifecycle'),
      seq: 4,
      type: 'lifecycle',
      phase: 'final',
      runPhase: 'done',
      error: null,
    }]);

    expect(state.messages).toContainEqual(expect.objectContaining({
      runId: 'run-1',
      text: '旧 run 完成',
      status: 'final',
    }));
    expect(state.runtime).toMatchObject({
      activeRunId: 'run-2',
      runPhase: 'submitted',
      pendingTurnKey: 'run-2',
    });
  });

  it('does not let same-run progress leave stopping before terminal event', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('run-1-started'),
      type: 'lifecycle',
      phase: 'started',
      runPhase: 'submitted',
      error: null,
    }, {
      ...base('run-1-stopping'),
      seq: 2,
      type: 'lifecycle',
      phase: 'aborted',
      runPhase: 'stopping',
      error: null,
    }, {
      ...base('run-1-late-streaming'),
      seq: 3,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'late-streaming',
      content: [{ type: 'text', text: '停止后的迟到 delta' }],
      text: '停止后的迟到 delta',
      status: 'streaming',
    }, {
      ...base('run-1-late-tool'),
      seq: 4,
      type: 'tool_call',
      toolCallId: 'late-tool',
      name: 'Read',
      input: { file_path: 'package.json' },
    }]);

    expect(state.messages).toContainEqual(expect.objectContaining({
      runId: 'run-1',
      text: '停止后的迟到 delta',
      status: 'streaming',
    }));
    expect(state.tools).toContainEqual(expect.objectContaining({
      runId: 'run-1',
      toolCallId: 'late-tool',
      status: 'running',
    }));
    expect(state.runtime).toMatchObject({
      activeRunId: 'run-1',
      runPhase: 'stopping',
      pendingTurnKey: 'run-1',
    });
  });

  it('allows same-run terminal event to settle stopping', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      ...base('run-1-started'),
      type: 'lifecycle',
      phase: 'started',
      runPhase: 'submitted',
      error: null,
    }, {
      ...base('run-1-stopping'),
      seq: 2,
      type: 'lifecycle',
      phase: 'aborted',
      runPhase: 'stopping',
      error: null,
    }, {
      ...base('run-1-aborted'),
      seq: 3,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'aborted-message',
      content: [],
      text: '',
      status: 'aborted',
    }]);

    expect(state.runtime).toMatchObject({
      activeRunId: null,
      runPhase: 'aborted',
      pendingTurnKey: null,
    });
  });

  it('keeps same-run assistant messages distinct and ordered around tool output', () => {
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
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
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
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
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
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
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
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
    const state = createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main'));
    reduceCanonicalSessionEvents(state, [{
      eventId: 'control-issue-1',
      type: 'control',
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      source: 'control',
      sessionId: 'agent:main:main',
      timestamp: 1,
      origin: {
        runtimeEventType: 'gateway.transport.issue',
        runtimeIds: { sessionKey: 'agent:main:main' },
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
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      source: 'control',
      sessionId: 'agent:main:main',
      timestamp: 2,
      origin: {
        runtimeEventType: 'gateway.transport.connected',
        runtimeIds: { sessionKey: 'agent:main:main' },
      },
      controlType: 'transport_connected',
      transportEpoch: 1,
      ready: true,
      phase: 'ready',
    }, {
      eventId: 'control-capabilities-1',
      type: 'control',
      protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
      runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
      source: 'control',
      sessionId: 'agent:main:main',
      timestamp: 3,
      origin: {
        runtimeEventType: 'gateway.capabilities.updated',
        runtimeIds: { sessionKey: 'agent:main:main' },
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

  it('updates only affected timeline entries when appending render events', () => {
    const sessionKey = 'agent:main:main';
    const state = createEmptyTimelineState({ sessionKey }, createOpenClawTestRuntimeContext(sessionKey));
    const timelineRuntime = createTimelineRuntime(state);

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('user-1'),
      runId: 'run-user',
      type: 'message_snapshot',
      role: 'user',
      content: 'hello',
      text: 'hello',
      status: 'final',
    }, {
      ...base('assistant-1'),
      seq: 2,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'assistant-1',
      content: 'working',
      text: 'working',
      status: 'streaming',
    }]);
    const userEntry = state.timelineEntries[0];
    const assistantEntry = state.timelineEntries[1];

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('assistant-1-final'),
      seq: 3,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'assistant-1',
      content: 'done',
      text: 'done',
      status: 'final',
    }]);

    expect(state.timelineEntries).toHaveLength(2);
    expect(state.timelineEntries[0]).toBe(userEntry);
    expect(state.timelineEntries[1]).not.toBe(assistantEntry);
    expect(state.timelineEntries[1]).toMatchObject({ text: 'done', status: 'final' });
  });

  it('reprojects lifecycle events through the canonical render path', () => {
    const sessionKey = 'agent:main:main';
    const state = createEmptyTimelineState({ sessionKey }, createOpenClawTestRuntimeContext(sessionKey));
    const timelineRuntime = createTimelineRuntime(state);

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('message-1'),
      type: 'message_snapshot',
      role: 'assistant',
      content: 'ready',
      text: 'ready',
      status: 'final',
    }]);
    const renderItems = state.renderItems;
    const timelineEntries = state.timelineEntries;
    const renderItemIndexByKey = state.renderItemIndexByKey;

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('lifecycle-1'),
      eventId: 'lifecycle-1',
      type: 'lifecycle',
      phase: 'completed',
      runPhase: 'idle',
    }]);

    expect(state.renderItems).not.toBe(renderItems);
    expect(state.timelineEntries).not.toBe(timelineEntries);
    expect(state.renderItemIndexByKey).not.toBe(renderItemIndexByKey);
    expect(state.runtime.runPhase).toBe('idle');
    expect(state.runEpoch).toBe(1);
  });

  it('reprojects control and runtime activity events through the canonical render path', () => {
    const sessionKey = 'agent:main:main';
    const state = createEmptyTimelineState({ sessionKey }, createOpenClawTestRuntimeContext(sessionKey));
    const timelineRuntime = createTimelineRuntime(state);

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('message-1'),
      type: 'message_snapshot',
      role: 'assistant',
      content: 'ready',
      text: 'ready',
      status: 'final',
    }]);
    const renderItems = state.renderItems;
    const timelineEntries = state.timelineEntries;
    const renderItemIndexByKey = state.renderItemIndexByKey;

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('runtime-activity-1'),
      type: 'runtime_activity',
      activity: 'compacting',
      phase: 'started',
    }, {
      ...base('control-issue-1'),
      eventId: 'control-issue-1',
      type: 'control',
      source: 'control',
      controlType: 'transport_issue',
      issue: {
        source: 'runtime',
        message: 'Gateway unavailable',
        code: 'UNAVAILABLE',
        retryable: true,
        at: 1_700_000_000_000,
      },
    }]);

    expect(state.renderItems).not.toBe(renderItems);
    expect(state.timelineEntries).not.toBe(timelineEntries);
    expect(state.renderItemIndexByKey).not.toBe(renderItemIndexByKey);
    expect(state.runtime.runtimeActivity).toBe('compacting');
    expect(state.runtime.lastIssue).toMatchObject({ code: 'UNAVAILABLE' });
    expect(state.runEpoch).toBe(0);
  });

  it('keeps incremental projection aligned with full projection when a message snapshot absorbs a prior tool-only entry', () => {
    const sessionKey = 'agent:main:main';
    const state = createEmptyTimelineState({ sessionKey }, createOpenClawTestRuntimeContext(sessionKey));
    const timelineRuntime = createTimelineRuntime(state);

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('tool-call-1'),
      type: 'tool_call',
      toolCallId: 'tool-read-1',
      name: 'Read',
      input: { file_path: 'package.json' },
    }, {
      ...base('tool-result-1'),
      seq: 2,
      type: 'tool_result',
      toolCallId: 'tool-read-1',
      name: 'Read',
      output: 'package content',
      outputText: 'package content',
      isError: false,
    }]);

    timelineRuntime.appendCanonicalEvents(sessionKey, [{
      ...base('message-1'),
      seq: 3,
      type: 'message_snapshot',
      role: 'assistant',
      messageId: 'assistant-tool-message',
      content: [
        { type: 'tool_call', toolCallId: 'tool-read-1', name: 'Read', input: { file_path: 'package.json' } },
        { type: 'text', text: '已读取。' },
      ],
      text: '已读取。',
      status: 'final',
    }]);

    const fullProjection = buildProjectedCanonicalSessionState(state.canonical);

    expect(state.timelineEntries).toEqual(fullProjection.timelineEntries);
    expect(state.renderItems).toEqual(fullProjection.renderItems);
    expect(state.renderItems.filter((item) => item.kind === 'assistant-turn')).toHaveLength(1);
    expect(state.renderItems[0]).toMatchObject({
      kind: 'assistant-turn',
      text: '已读取。',
      tools: [{ toolCallId: 'tool-read-1', status: 'completed' }],
    });
  });

  it('exposes pending approvals through the Runtime Host session snapshot', () => {
    const runtime = buildRuntimeState();
    const state: SessionRuntimeTimelineState = {
      sessionKey: 'agent:main:main',
      runEpoch: 0,
      canonical: createEmptyCanonicalSessionState('agent:main:main', createOpenClawTestRuntimeContext('agent:main:main')),
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
    const sessionIdentity = createOpenClawTestSessionIdentity('agent:main:main');
    state.canonical.approvals = [{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      sessionIdentity,
      runId: 'run-1',
      title: 'Run command',
      command: 'pnpm test',
      allowedDecisions: ['allow-once', 'deny'],
      createdAtMs: 1_700_000_000_000,
    }];
    const service = new SessionSnapshotService({
      snapshotWorkflow: new SessionSnapshotWorkflow({
        stateStore: {
          getResolvedSessionModel: () => null,
        } as never,
        sessionMetadata: {} as never,
        sessionStorage: {} as never,
      }),
    });

    const snapshot = service.buildSnapshot('agent:main:main', state);

    expect(snapshot.approvals).toEqual([{
      id: 'approval-1',
      sessionKey: 'agent:main:main',
      sessionIdentity,
      runId: 'run-1',
      title: 'Run command',
      command: 'pnpm test',
      allowedDecisions: ['allow-once', 'deny'],
      createdAtMs: 1_700_000_000_000,
    }]);
  });
});
