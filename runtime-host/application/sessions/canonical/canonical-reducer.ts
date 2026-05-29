import type { GatewayTransportIssue } from '../../../shared/gateway-error';
import type {
  SessionRuntimeStateSnapshot,
  SessionRunPhase,
} from '../../../shared/session-adapter-types';
import { createEmptySessionRuntimeState } from '../session-state-model';
import { createOpenClawRuntimeSessionContext } from '../runtime-providers/session-runtime-context';
import type { RuntimeSessionContext } from '../runtime-providers/runtime-provider-types';
import type {
  CanonicalApprovalEvent,
  CanonicalLifecycleEvent,
  CanonicalMessageSnapshotEvent,
  CanonicalSessionEvent,
  CanonicalToolCallEvent,
  CanonicalToolProgressEvent,
  CanonicalToolResultEvent,
} from './canonical-events';
import type {
  CanonicalControlState,
  CanonicalMessageState,
  CanonicalSessionState,
  CanonicalThoughtState,
  CanonicalToolState,
} from './canonical-state';

function eventTime(event: CanonicalSessionEvent): number | undefined {
  return typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? event.timestamp
    : undefined;
}

function laneKeyOf(event: Pick<CanonicalSessionEvent, 'laneKey'>): string {
  return event.laneKey || 'main';
}

export function buildCanonicalMessageStateKey(event: CanonicalMessageSnapshotEvent): string {
  const laneKey = laneKeyOf(event);
  const stableId = event.messageId || event.clientId || event.originMessageId || String(event.seq ?? event.eventId);
  return `message:${event.role}:${laneKey}:${stableId}`;
}

function thoughtKey(event: CanonicalSessionEvent & { thoughtId?: string }): string {
  return `thought:${laneKeyOf(event)}:${event.thoughtId || event.runId || event.seq || event.eventId}`;
}

export function buildCanonicalToolStateKey(event: Pick<CanonicalSessionEvent, 'laneKey'> & { toolCallId: string }): string {
  return `tool:${laneKeyOf(event)}:${event.toolCallId}`;
}

function upsertMessage(state: CanonicalSessionState, event: CanonicalMessageSnapshotEvent): void {
  const key = buildCanonicalMessageStateKey(event);
  const index = state.messageIndexByKey.get(key) ?? -1;
  const now = eventTime(event);
  const next: CanonicalMessageState = {
    key,
    role: event.role,
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.originMessageId ? { originMessageId: event.originMessageId } : {}),
    ...(event.clientId ? { clientId: event.clientId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    content: structuredClone(event.content),
    text: event.text,
    status: event.status,
    images: structuredClone(event.images ?? []),
    attachedFiles: structuredClone(event.attachedFiles ?? []),
    ...(event.seq != null ? { seq: event.seq } : {}),
    ...(index >= 0 && state.messages[index]?.createdAt != null ? { createdAt: state.messages[index]!.createdAt } : now != null ? { createdAt: now } : {}),
    ...(now != null ? { updatedAt: now } : {}),
  };
  if (index >= 0) {
    state.messages[index] = next;
  } else {
    state.messageIndexByKey.set(key, state.messages.length);
    state.messages.push(next);
  }
}

function upsertThought(state: CanonicalSessionState, event: CanonicalSessionEvent & { text: string; status: CanonicalMessageState['status']; thoughtId?: string }): void {
  const key = thoughtKey(event);
  const index = state.thoughtIndexByKey.get(key) ?? -1;
  const next: CanonicalThoughtState = {
    key,
    ...(event.runId ? { runId: event.runId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    text: event.text,
    status: event.status,
    ...(event.seq != null ? { seq: event.seq } : {}),
    ...(eventTime(event) != null ? { updatedAt: eventTime(event) } : {}),
  };
  if (index >= 0) {
    state.thoughts[index] = next;
  } else {
    state.thoughtIndexByKey.set(key, state.thoughts.length);
    state.thoughts.push(next);
  }
}

function upsertToolCall(state: CanonicalSessionState, event: CanonicalToolCallEvent): void {
  const key = buildCanonicalToolStateKey(event);
  const index = state.toolIndexByKey.get(key) ?? -1;
  const previous = index >= 0 ? state.tools[index] : null;
  const now = eventTime(event);
  const next: CanonicalToolState = {
    key,
    toolCallId: event.toolCallId,
    ...(event.runId ? { runId: event.runId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    name: event.name,
    ...(event.input !== undefined ? { input: structuredClone(event.input) } : previous?.input !== undefined ? { input: structuredClone(previous.input) } : {}),
    ...(previous?.partialResult !== undefined ? { partialResult: structuredClone(previous.partialResult) } : {}),
    ...(previous?.output !== undefined ? { output: structuredClone(previous.output) } : {}),
    ...(previous?.outputText !== undefined ? { outputText: previous.outputText } : {}),
    status: previous?.status === 'completed' || previous?.status === 'error' ? previous.status : 'running',
    ...(event.seq != null ? { seq: event.seq } : previous?.seq != null ? { seq: previous.seq } : {}),
    ...(previous?.createdAt != null ? { createdAt: previous.createdAt } : now != null ? { createdAt: now } : {}),
    ...(now != null ? { updatedAt: now } : previous?.updatedAt != null ? { updatedAt: previous.updatedAt } : {}),
  };
  if (index >= 0) {
    state.tools[index] = next;
  } else {
    state.toolIndexByKey.set(key, state.tools.length);
    state.tools.push(next);
  }
}

function upsertToolProgress(state: CanonicalSessionState, event: CanonicalToolProgressEvent): void {
  const key = buildCanonicalToolStateKey(event);
  const index = state.toolIndexByKey.get(key) ?? -1;
  if (index < 0) {
    return;
  }
  const previous = state.tools[index]!;
  state.tools[index] = {
    ...previous,
    ...(event.partialResult !== undefined ? { partialResult: structuredClone(event.partialResult) } : {}),
    ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
    status: 'running',
    ...(event.seq != null ? { seq: event.seq } : {}),
    ...(eventTime(event) != null ? { updatedAt: eventTime(event) } : {}),
  };
}

function upsertToolResult(state: CanonicalSessionState, event: CanonicalToolResultEvent): void {
  const key = buildCanonicalToolStateKey(event);
  const index = state.toolIndexByKey.get(key) ?? -1;
  const previous = index >= 0 ? state.tools[index] : null;
  const now = eventTime(event);
  const next: CanonicalToolState = {
    key,
    toolCallId: event.toolCallId,
    ...(event.runId ? { runId: event.runId } : previous?.runId ? { runId: previous.runId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : previous?.agentId ? { agentId: previous.agentId } : {}),
    name: event.name || previous?.name || '',
    ...(previous?.input !== undefined ? { input: structuredClone(previous.input) } : {}),
    ...(previous?.partialResult !== undefined ? { partialResult: structuredClone(previous.partialResult) } : {}),
    ...(event.output !== undefined ? { output: structuredClone(event.output) } : {}),
    ...(event.outputText !== undefined ? { outputText: event.outputText } : previous?.outputText !== undefined ? { outputText: previous.outputText } : {}),
    status: event.isError ? 'error' : 'completed',
    ...(event.seq != null ? { seq: event.seq } : previous?.seq != null ? { seq: previous.seq } : {}),
    ...(previous?.createdAt != null ? { createdAt: previous.createdAt } : now != null ? { createdAt: now } : {}),
    ...(now != null ? { updatedAt: now } : {}),
  };
  if (index >= 0) {
    state.tools[index] = next;
  } else {
    state.toolIndexByKey.set(key, state.tools.length);
    state.tools.push(next);
  }
}

function terminalRuntimePatch(runPhase: SessionRunPhase, lastError: string | null, lastIssue: GatewayTransportIssue | null): Partial<SessionRuntimeStateSnapshot> {
  return {
    activeRunId: null,
    runPhase,
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    runtimeActivity: null,
    lastError,
    lastIssue,
  };
}

function cloneIssue(issue: GatewayTransportIssue | null | undefined): GatewayTransportIssue | null {
  return issue ? structuredClone(issue) : null;
}

export function buildRuntimeWithControlOverlay(
  runtime: SessionRuntimeStateSnapshot,
  control: Pick<CanonicalControlState, 'issue'>,
): SessionRuntimeStateSnapshot {
  const issue = cloneIssue(control.issue);
  return {
    ...runtime,
    ...(issue ? {
      lastError: issue.message,
      lastIssue: issue,
    } : {}),
  };
}

function applyLifecycle(state: CanonicalSessionState, event: CanonicalLifecycleEvent): void {
  if (event.source === 'replay') {
    return;
  }
  if (event.phase === 'started') {
    state.runtime = {
      ...state.runtime,
      activeRunId: event.runId ?? null,
      runPhase: 'submitted',
      pendingTurnKey: event.runId ?? state.runtime.pendingTurnKey,
      pendingTurnLaneKey: laneKeyOf(event),
      lastError: null,
      lastIssue: null,
      runtimeActivity: null,
    };
    return;
  }
  state.runtime = {
    ...state.runtime,
    ...terminalRuntimePatch(event.runPhase, event.error, event.transportIssue ?? null),
  };
}

function applyMessageRuntime(state: CanonicalSessionState, event: CanonicalMessageSnapshotEvent): void {
  if (event.source === 'replay') {
    return;
  }
  if (event.role === 'user') {
    state.runtime = {
      ...state.runtime,
      lastUserMessageAt: eventTime(event) ?? state.runtime.lastUserMessageAt,
    };
    return;
  }
  if (event.role !== 'assistant') {
    return;
  }
  if (event.status === 'streaming') {
    state.runtime = {
      ...state.runtime,
      activeRunId: event.runId ?? state.runtime.activeRunId,
      runPhase: 'streaming',
      activeTurnItemKey: null,
      pendingTurnKey: event.runId ?? event.messageId ?? state.runtime.pendingTurnKey,
      pendingTurnLaneKey: laneKeyOf(event),
      lastError: null,
      lastIssue: null,
      runtimeActivity: null,
    };
    return;
  }
  if (event.status === 'final') {
    state.runtime = {
      ...state.runtime,
      ...terminalRuntimePatch('done', null, null),
    };
    return;
  }
  if (event.status === 'error') {
    state.runtime = {
      ...state.runtime,
      ...terminalRuntimePatch('error', event.text || state.runtime.lastError, state.runtime.lastIssue),
    };
    return;
  }
  state.runtime = {
    ...state.runtime,
    ...terminalRuntimePatch('aborted', state.runtime.lastError, state.runtime.lastIssue),
  };
}

function rebuildApprovalIndex(state: CanonicalSessionState): void {
  state.approvalIndexById = new Map(state.approvals.map((approval, index) => [approval.id, index]));
}

function applyApproval(state: CanonicalSessionState, event: CanonicalApprovalEvent): void {
  const index = state.approvalIndexById.get(event.approvalId) ?? -1;
  if (event.status === 'resolved') {
    if (index >= 0) {
      state.approvals.splice(index, 1);
      rebuildApprovalIndex(state);
    }
    return;
  }
  const approval = {
    id: event.approvalId,
    sessionKey: event.sessionId,
    ...(event.runId ? { runId: event.runId } : {}),
    title: event.title,
    ...(event.command ? { command: event.command } : {}),
    allowedDecisions: [...event.allowedDecisions],
    ...(event.request ? { request: structuredClone(event.request) } : {}),
    createdAtMs: event.createdAtMs,
    ...(event.expiresAtMs ? { expiresAtMs: event.expiresAtMs } : {}),
  };
  if (index >= 0) {
    state.approvals[index] = approval;
  } else {
    state.approvals.push(approval);
  }
  state.approvals.sort((left, right) => left.createdAtMs - right.createdAtMs);
  rebuildApprovalIndex(state);
}

function pruneExpiredApprovals(state: CanonicalSessionState, nowMs: number): void {
  const previousCount = state.approvals.length;
  state.approvals = state.approvals.filter((approval) => (
    typeof approval.expiresAtMs !== 'number' || approval.expiresAtMs > nowMs
  ));
  if (state.approvals.length !== previousCount) {
    rebuildApprovalIndex(state);
  }
}

function applyToolRuntime(state: CanonicalSessionState, event: CanonicalToolCallEvent | CanonicalToolProgressEvent | CanonicalToolResultEvent): void {
  if (event.source === 'replay') {
    return;
  }
  if (event.type === 'tool_call' || event.type === 'tool_progress') {
    state.runtime = {
      ...state.runtime,
      activeRunId: event.runId ?? state.runtime.activeRunId,
      pendingTurnKey: event.runId ?? state.runtime.pendingTurnKey,
      pendingTurnLaneKey: event.laneKey ?? state.runtime.pendingTurnLaneKey,
      runPhase: 'waiting_tool',
    };
    return;
  }
  if (state.runtime.runPhase !== 'waiting_tool') {
    return;
  }
  const hasRunningTools = state.tools.some((tool) => tool.status === 'running' && (!event.runId || tool.runId === event.runId));
  if (!hasRunningTools) {
    state.runtime = {
      ...state.runtime,
      runPhase: 'streaming',
    };
  }
}

export function createEmptyCanonicalSessionState(
  sessionId: string,
  context: RuntimeSessionContext = createOpenClawRuntimeSessionContext(sessionId),
): CanonicalSessionState {
  return {
    sessionId,
    protocolId: context.protocolId,
    runtimeProviderId: context.runtimeProviderId,
    eventIds: [],
    eventIdSet: new Set<string>(),
    messageIndexByKey: new Map<string, number>(),
    thoughtIndexByKey: new Map<string, number>(),
    toolIndexByKey: new Map<string, number>(),
    approvalIndexById: new Map<string, number>(),
    messages: [],
    thoughts: [],
    tools: [],
    approvals: [],
    teams: [],
    usage: [],
    artifacts: [],
    taskSnapshot: null,
    control: {
      transportEpoch: null,
      ready: null,
      phase: null,
      issue: null,
      issueTransportEpoch: null,
      capabilities: null,
      updatedAt: null,
    },
    runtime: createEmptySessionRuntimeState(),
    replayDepth: 0,
    hydrated: false,
    updatedAt: null,
  };
}

export function reduceCanonicalSessionEvent(state: CanonicalSessionState, event: CanonicalSessionEvent): boolean {
  if (state.protocolId !== event.protocolId || state.runtimeProviderId !== event.runtimeProviderId) {
    return false;
  }
  if (state.eventIdSet.has(event.eventId)) {
    return false;
  }
  state.eventIdSet.add(event.eventId);
  state.eventIds.push(event.eventId);
  state.updatedAt = eventTime(event) ?? state.updatedAt;
  switch (event.type) {
    case 'replay_boundary':
      state.replayDepth = event.phase === 'start'
        ? state.replayDepth + 1
        : Math.max(0, state.replayDepth - 1);
      if (event.phase === 'end') {
        state.hydrated = true;
      }
      break;
    case 'message_snapshot':
      upsertMessage(state, event);
      applyMessageRuntime(state, event);
      break;
    case 'thought_snapshot':
      upsertThought(state, event);
      break;
    case 'tool_call':
      upsertToolCall(state, event);
      applyToolRuntime(state, event);
      break;
    case 'tool_progress':
      upsertToolProgress(state, event);
      applyToolRuntime(state, event);
      break;
    case 'tool_result':
      upsertToolResult(state, event);
      applyToolRuntime(state, event);
      break;
    case 'lifecycle':
      applyLifecycle(state, event);
      break;
    case 'runtime_activity':
      if (event.source !== 'replay') {
        state.runtime = {
          ...state.runtime,
          activeRunId: event.runId ?? state.runtime.activeRunId,
          pendingTurnKey: event.runId ?? state.runtime.pendingTurnKey,
          pendingTurnLaneKey: event.laneKey ?? state.runtime.pendingTurnLaneKey,
          runtimeActivity: event.phase === 'started' ? event.activity : null,
        };
      }
      break;
    case 'approval':
      if (event.source !== 'replay') {
        applyApproval(state, event);
        pruneExpiredApprovals(state, eventTime(event) ?? Date.now());
      }
      break;
    case 'team':
      state.teams.push(structuredClone(event));
      break;
    case 'usage':
      state.usage.push(structuredClone(event));
      break;
    case 'artifact':
      state.artifacts.push(structuredClone(event));
      break;
    case 'control':
      if (event.source !== 'replay') {
        const nextTransportEpoch = event.transportEpoch ?? state.control.transportEpoch;
        const transportRecovered = event.controlType === 'transport_connected' || event.controlType === 'control_ready';
        const nextIssue = event.controlType === 'transport_issue'
          ? cloneIssue(event.issue)
          : transportRecovered
            ? null
            : state.control.issue;
        state.control = {
          ...state.control,
          transportEpoch: nextTransportEpoch,
          ...(event.ready != null ? { ready: event.ready } : {}),
          ...(event.phase != null ? { phase: event.phase } : {}),
          issue: nextIssue,
          issueTransportEpoch: nextIssue ? nextTransportEpoch : null,
          ...(event.capabilities !== undefined ? { capabilities: structuredClone(event.capabilities) } : {}),
          updatedAt: eventTime(event) ?? state.control.updatedAt,
        };
        if (event.controlType === 'transport_issue' || transportRecovered) {
          state.runtime = buildRuntimeWithControlOverlay(state.runtime, state.control);
          if (!state.control.issue && transportRecovered) {
            state.runtime = {
              ...state.runtime,
              lastError: null,
              lastIssue: null,
            };
          }
        }
      }
      break;
    case 'plan':
      state.taskSnapshot = structuredClone(event.taskSnapshot);
      break;
    default:
      break;
  }
  if (state.updatedAt == null) {
    state.updatedAt = Date.now();
  }
  state.runtime = {
    ...state.runtime,
    updatedAt: state.updatedAt,
  };
  return true;
}

export function reduceCanonicalSessionEvents(state: CanonicalSessionState, events: Iterable<CanonicalSessionEvent>): CanonicalSessionEvent[] {
  const committedEvents: CanonicalSessionEvent[] = [];
  for (const event of events) {
    if (reduceCanonicalSessionEvent(state, event)) {
      committedEvents.push(event);
    }
  }
  return committedEvents;
}
