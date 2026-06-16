import type { GatewayTransportIssue } from '../../../shared/gateway-error';
import type {
  SessionRuntimeStateSnapshot,
  SessionRunPhase,
} from '../../../shared/session-adapter-types';
import { createEmptySessionRuntimeState } from '../session-state-model';
import type { RuntimeSessionContext } from '../../agent-runtime/contracts/runtime-endpoint-types';
import type {
  CanonicalApprovalEvent,
  CanonicalBindingConfidence,
  CanonicalBindingSource,
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
import { isStateOnlyToolContentBlock, isToolCallContentType } from '../state-only-tools';

function eventTime(event: CanonicalSessionEvent): number | undefined {
  return typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? event.timestamp
    : undefined;
}

function laneKeyOf(event: Pick<CanonicalSessionEvent, 'laneKey'>): string {
  return event.laneKey || 'main';
}

export function resolveCanonicalMessageIdentity(event: CanonicalMessageSnapshotEvent): {
  key: string;
  ownerMessageKey: string;
  messageBindingSource: CanonicalBindingSource;
  messageBindingConfidence: CanonicalBindingConfidence;
} {
  const laneKey = laneKeyOf(event);
  const stableId = event.messageId || event.clientId || event.originMessageId || String(event.seq ?? event.eventId);
  const key = `message:${event.role}:${laneKey}:${stableId}`;
  if (event.ownerMessageKey) {
    return {
      key,
      ownerMessageKey: event.ownerMessageKey,
      messageBindingSource: event.messageBindingSource ?? 'runtime',
      messageBindingConfidence: event.messageBindingConfidence ?? 'high',
    };
  }
  if (event.messageId || event.clientId || event.originMessageId) {
    return {
      key,
      ownerMessageKey: key,
      messageBindingSource: event.messageBindingSource ?? 'adapter',
      messageBindingConfidence: event.messageBindingConfidence ?? 'high',
    };
  }
  return {
    key,
    ownerMessageKey: key,
    messageBindingSource: event.messageBindingSource ?? 'synthetic',
    messageBindingConfidence: event.messageBindingConfidence ?? 'medium',
  };
}

export function resolveCanonicalTurnBinding(event: Pick<CanonicalSessionEvent, 'turnId' | 'ownerTurnKey' | 'turnBindingSource' | 'turnBindingConfidence' | 'runId' | 'laneKey'>): {
  ownerTurnKey: string | undefined;
  turnBindingSource: CanonicalBindingSource | undefined;
  turnBindingConfidence: CanonicalBindingConfidence | undefined;
} {
  if (event.ownerTurnKey) {
    return {
      ownerTurnKey: event.ownerTurnKey,
      turnBindingSource: event.turnBindingSource ?? 'runtime',
      turnBindingConfidence: event.turnBindingConfidence ?? 'high',
    };
  }
  if (event.turnId) {
    return {
      ownerTurnKey: `turn:${laneKeyOf(event)}:${event.turnId}`,
      turnBindingSource: event.turnBindingSource ?? 'adapter',
      turnBindingConfidence: event.turnBindingConfidence ?? 'high',
    };
  }
  if (event.runId) {
    return {
      ownerTurnKey: `run:${laneKeyOf(event)}:${event.runId}`,
      turnBindingSource: event.turnBindingSource ?? 'synthetic',
      turnBindingConfidence: event.turnBindingConfidence ?? 'low',
    };
  }
  return {
    ownerTurnKey: undefined,
    turnBindingSource: event.turnBindingSource,
    turnBindingConfidence: event.turnBindingConfidence,
  };
}

export function resolveCanonicalOwnerBindings(event: CanonicalSessionEvent): {
  ownerTurnKey: string | undefined;
  ownerMessageKey: string | undefined;
  turnBindingSource: CanonicalBindingSource | undefined;
  turnBindingConfidence: CanonicalBindingConfidence | undefined;
  messageBindingSource: CanonicalBindingSource | undefined;
  messageBindingConfidence: CanonicalBindingConfidence | undefined;
} {
  const turnBinding = resolveCanonicalTurnBinding(event);
  if (event.type === 'message_snapshot') {
    const messageIdentity = resolveCanonicalMessageIdentity(event);
    return {
      ...turnBinding,
      ownerMessageKey: messageIdentity.ownerMessageKey,
      messageBindingSource: messageIdentity.messageBindingSource,
      messageBindingConfidence: messageIdentity.messageBindingConfidence,
    };
  }
  return {
    ...turnBinding,
    ownerMessageKey: event.ownerMessageKey,
    messageBindingSource: event.messageBindingSource,
    messageBindingConfidence: event.messageBindingConfidence,
  };
}

function hasExplicitTurnBinding(binding: {
  ownerTurnKey?: string;
  turnBindingConfidence?: CanonicalBindingConfidence;
}): boolean {
  return Boolean(binding.ownerTurnKey) && binding.turnBindingConfidence !== 'low';
}

function resolveRuntimePendingTurnKeyForMessage(
  event: CanonicalMessageSnapshotEvent,
  currentPendingTurnKey: string | null,
): string | null {
  const ownerBindings = resolveCanonicalOwnerBindings(event);
  if (hasExplicitTurnBinding(ownerBindings)) {
    return ownerBindings.ownerTurnKey ?? currentPendingTurnKey;
  }
  return ownerBindings.ownerMessageKey
    ?? ownerBindings.ownerTurnKey
    ?? event.runId
    ?? event.messageId
    ?? currentPendingTurnKey;
}

function resolveRuntimePendingTurnKeyForTool(
  event: CanonicalToolCallEvent | CanonicalToolProgressEvent | CanonicalToolResultEvent,
  currentPendingTurnKey: string | null,
): string | null {
  const ownerBindings = resolveCanonicalOwnerBindings(event);
  if (hasExplicitTurnBinding(ownerBindings)) {
    return ownerBindings.ownerTurnKey ?? currentPendingTurnKey;
  }
  return ownerBindings.ownerMessageKey
    ?? ownerBindings.ownerTurnKey
    ?? event.runId
    ?? currentPendingTurnKey;
}

export function buildCanonicalMessageStateKey(event: CanonicalMessageSnapshotEvent): string {
  return resolveCanonicalMessageIdentity(event).key;
}

function thoughtKey(event: CanonicalSessionEvent & { thoughtId?: string }): string {
  return `thought:${laneKeyOf(event)}:${event.thoughtId || event.runId || event.seq || event.eventId}`;
}

export function buildCanonicalToolStateKey(event: Pick<CanonicalSessionEvent, 'laneKey'> & { toolCallId: string }): string {
  return `tool:${laneKeyOf(event)}:${event.toolCallId}`;
}

function setOwnerKeys(map: Map<string, string[]>, previousOwnerKey: string | undefined, nextOwnerKey: string | undefined, valueKey: string): void {
  if (previousOwnerKey && previousOwnerKey !== nextOwnerKey) {
    const current = map.get(previousOwnerKey);
    if (current) {
      const filtered = current.filter((candidate) => candidate !== valueKey);
      if (filtered.length > 0) {
        map.set(previousOwnerKey, filtered);
      } else {
        map.delete(previousOwnerKey);
      }
    }
  }
  if (!nextOwnerKey) {
    return;
  }
  const current = map.get(nextOwnerKey);
  if (!current) {
    map.set(nextOwnerKey, [valueKey]);
    return;
  }
  if (!current.includes(valueKey)) {
    current.push(valueKey);
  }
}

function upsertMessage(state: CanonicalSessionState, event: CanonicalMessageSnapshotEvent): void {
  const messageIdentity = resolveCanonicalMessageIdentity(event);
  const turnBinding = resolveCanonicalTurnBinding(event);
  const key = messageIdentity.key;
  const index = state.messageIndexByKey.get(key) ?? -1;
  const previous = index >= 0 ? state.messages[index] : null;
  const now = eventTime(event);
  const next: CanonicalMessageState = {
    key,
    role: event.role,
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.originMessageId ? { originMessageId: event.originMessageId } : {}),
    ...(event.clientId ? { clientId: event.clientId } : {}),
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : previous?.turnId ? { turnId: previous.turnId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(turnBinding.ownerTurnKey ? { ownerTurnKey: turnBinding.ownerTurnKey } : {}),
    ownerMessageKey: messageIdentity.ownerMessageKey,
    ...(turnBinding.turnBindingSource ? { turnBindingSource: turnBinding.turnBindingSource } : {}),
    ...(turnBinding.turnBindingConfidence ? { turnBindingConfidence: turnBinding.turnBindingConfidence } : {}),
    ...(messageIdentity.messageBindingSource ? { messageBindingSource: messageIdentity.messageBindingSource } : {}),
    ...(messageIdentity.messageBindingConfidence ? { messageBindingConfidence: messageIdentity.messageBindingConfidence } : {}),
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
    const previousOwnerMessageKey = previous?.ownerMessageKey ?? previous?.key;
    state.messages[index] = next;
    if (previousOwnerMessageKey !== next.ownerMessageKey) {
      state.messageIndexByMessageKey.delete(previousOwnerMessageKey);
    }
  } else {
    state.messageIndexByKey.set(key, state.messages.length);
    state.messages.push(next);
  }
  state.messageIndexByKey.set(key, index >= 0 ? index : state.messages.length - 1);
  state.messageIndexByMessageKey.set(next.ownerMessageKey ?? key, index >= 0 ? index : state.messages.length - 1);
}

function upsertThought(state: CanonicalSessionState, event: CanonicalSessionEvent & { text: string; status: CanonicalMessageState['status']; thoughtId?: string }): void {
  const ownerBindings = resolveCanonicalOwnerBindings(event);
  const key = thoughtKey(event);
  const index = state.thoughtIndexByKey.get(key) ?? -1;
  const previous = index >= 0 ? state.thoughts[index] : null;
  const next: CanonicalThoughtState = {
    key,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : previous?.turnId ? { turnId: previous.turnId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(ownerBindings.ownerTurnKey ? { ownerTurnKey: ownerBindings.ownerTurnKey } : {}),
    ...(ownerBindings.ownerMessageKey ? { ownerMessageKey: ownerBindings.ownerMessageKey } : {}),
    ...(ownerBindings.turnBindingSource ? { turnBindingSource: ownerBindings.turnBindingSource } : {}),
    ...(ownerBindings.turnBindingConfidence ? { turnBindingConfidence: ownerBindings.turnBindingConfidence } : {}),
    ...(ownerBindings.messageBindingSource ? { messageBindingSource: ownerBindings.messageBindingSource } : {}),
    ...(ownerBindings.messageBindingConfidence ? { messageBindingConfidence: ownerBindings.messageBindingConfidence } : {}),
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
  setOwnerKeys(state.thoughtKeysByOwnerMessageKey, previous?.ownerMessageKey, next.ownerMessageKey, key);
  setOwnerKeys(state.thoughtKeysByOwnerTurnKey, previous?.ownerTurnKey, next.ownerTurnKey, key);
}

function upsertToolCall(state: CanonicalSessionState, event: CanonicalToolCallEvent): void {
  const ownerBindings = resolveCanonicalOwnerBindings(event);
  const key = buildCanonicalToolStateKey(event);
  const index = state.toolIndexByKey.get(key) ?? -1;
  const previous = index >= 0 ? state.tools[index] : null;
  const now = eventTime(event);
  const next: CanonicalToolState = {
    key,
    toolCallId: event.toolCallId,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : previous?.turnId ? { turnId: previous.turnId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(ownerBindings.ownerTurnKey ? { ownerTurnKey: ownerBindings.ownerTurnKey } : previous?.ownerTurnKey ? { ownerTurnKey: previous.ownerTurnKey } : {}),
    ...(ownerBindings.ownerMessageKey ? { ownerMessageKey: ownerBindings.ownerMessageKey } : previous?.ownerMessageKey ? { ownerMessageKey: previous.ownerMessageKey } : {}),
    ...(ownerBindings.turnBindingSource ? { turnBindingSource: ownerBindings.turnBindingSource } : previous?.turnBindingSource ? { turnBindingSource: previous.turnBindingSource } : {}),
    ...(ownerBindings.turnBindingConfidence ? { turnBindingConfidence: ownerBindings.turnBindingConfidence } : previous?.turnBindingConfidence ? { turnBindingConfidence: previous.turnBindingConfidence } : {}),
    ...(ownerBindings.messageBindingSource ? { messageBindingSource: ownerBindings.messageBindingSource } : previous?.messageBindingSource ? { messageBindingSource: previous.messageBindingSource } : {}),
    ...(ownerBindings.messageBindingConfidence ? { messageBindingConfidence: ownerBindings.messageBindingConfidence } : previous?.messageBindingConfidence ? { messageBindingConfidence: previous.messageBindingConfidence } : {}),
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
  setOwnerKeys(state.toolKeysByOwnerMessageKey, previous?.ownerMessageKey, next.ownerMessageKey, key);
  setOwnerKeys(state.toolKeysByOwnerTurnKey, previous?.ownerTurnKey, next.ownerTurnKey, key);
}

function upsertToolProgress(state: CanonicalSessionState, event: CanonicalToolProgressEvent): void {
  const ownerBindings = resolveCanonicalOwnerBindings(event);
  const key = buildCanonicalToolStateKey(event);
  const index = state.toolIndexByKey.get(key) ?? -1;
  if (index < 0) {
    return;
  }
  const previous = state.tools[index]!;
  const next: CanonicalToolState = {
    ...previous,
    ...(event.partialResult !== undefined ? { partialResult: structuredClone(event.partialResult) } : {}),
    ...(event.outputText !== undefined ? { outputText: event.outputText } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(ownerBindings.ownerTurnKey ? { ownerTurnKey: ownerBindings.ownerTurnKey } : {}),
    ...(ownerBindings.ownerMessageKey ? { ownerMessageKey: ownerBindings.ownerMessageKey } : {}),
    ...(ownerBindings.turnBindingSource ? { turnBindingSource: ownerBindings.turnBindingSource } : {}),
    ...(ownerBindings.turnBindingConfidence ? { turnBindingConfidence: ownerBindings.turnBindingConfidence } : {}),
    ...(ownerBindings.messageBindingSource ? { messageBindingSource: ownerBindings.messageBindingSource } : {}),
    ...(ownerBindings.messageBindingConfidence ? { messageBindingConfidence: ownerBindings.messageBindingConfidence } : {}),
    status: 'running',
    ...(event.seq != null ? { seq: event.seq } : {}),
    ...(eventTime(event) != null ? { updatedAt: eventTime(event) } : {}),
  };
  state.tools[index] = next;
  setOwnerKeys(state.toolKeysByOwnerMessageKey, previous.ownerMessageKey, next.ownerMessageKey, key);
  setOwnerKeys(state.toolKeysByOwnerTurnKey, previous.ownerTurnKey, next.ownerTurnKey, key);
}

function upsertToolResult(state: CanonicalSessionState, event: CanonicalToolResultEvent): void {
  const ownerBindings = resolveCanonicalOwnerBindings(event);
  const key = buildCanonicalToolStateKey(event);
  const index = state.toolIndexByKey.get(key) ?? -1;
  const previous = index >= 0 ? state.tools[index] : null;
  const now = eventTime(event);
  const next: CanonicalToolState = {
    key,
    toolCallId: event.toolCallId,
    ...(event.runId ? { runId: event.runId } : previous?.runId ? { runId: previous.runId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : previous?.turnId ? { turnId: previous.turnId } : {}),
    laneKey: laneKeyOf(event),
    ...(event.agentId ? { agentId: event.agentId } : previous?.agentId ? { agentId: previous.agentId } : {}),
    ...(ownerBindings.ownerTurnKey ? { ownerTurnKey: ownerBindings.ownerTurnKey } : previous?.ownerTurnKey ? { ownerTurnKey: previous.ownerTurnKey } : {}),
    ...(ownerBindings.ownerMessageKey ? { ownerMessageKey: ownerBindings.ownerMessageKey } : previous?.ownerMessageKey ? { ownerMessageKey: previous.ownerMessageKey } : {}),
    ...(ownerBindings.turnBindingSource ? { turnBindingSource: ownerBindings.turnBindingSource } : previous?.turnBindingSource ? { turnBindingSource: previous.turnBindingSource } : {}),
    ...(ownerBindings.turnBindingConfidence ? { turnBindingConfidence: ownerBindings.turnBindingConfidence } : previous?.turnBindingConfidence ? { turnBindingConfidence: previous.turnBindingConfidence } : {}),
    ...(ownerBindings.messageBindingSource ? { messageBindingSource: ownerBindings.messageBindingSource } : previous?.messageBindingSource ? { messageBindingSource: previous.messageBindingSource } : {}),
    ...(ownerBindings.messageBindingConfidence ? { messageBindingConfidence: ownerBindings.messageBindingConfidence } : previous?.messageBindingConfidence ? { messageBindingConfidence: previous.messageBindingConfidence } : {}),
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
  setOwnerKeys(state.toolKeysByOwnerMessageKey, previous?.ownerMessageKey, next.ownerMessageKey, key);
  setOwnerKeys(state.toolKeysByOwnerTurnKey, previous?.ownerTurnKey, next.ownerTurnKey, key);
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

function eventMatchesActiveRun(state: CanonicalSessionState, event: { runId?: string }): boolean {
  return !!event.runId && event.runId === state.runtime.activeRunId;
}

function canClaimIdleRuntime(state: CanonicalSessionState, event: { runId?: string }): boolean {
  return state.runtime.activeRunId == null && !!event.runId;
}

function canMutateRuntimeForRun(state: CanonicalSessionState, event: { runId?: string }): boolean {
  return eventMatchesActiveRun(state, event) || canClaimIdleRuntime(state, event);
}

function isStoppingActiveRunEvent(state: CanonicalSessionState, event: { runId?: string }): boolean {
  return state.runtime.runPhase === 'stopping' && eventMatchesActiveRun(state, event);
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
  if (event.runPhase === 'stopping') {
    if (event.runId && state.runtime.activeRunId != null && !eventMatchesActiveRun(state, event)) {
      return;
    }
    state.runtime = {
      ...state.runtime,
      activeRunId: event.runId ?? state.runtime.activeRunId,
      runPhase: 'stopping',
      pendingTurnKey: event.runId ?? state.runtime.pendingTurnKey,
      pendingTurnLaneKey: laneKeyOf(event),
      lastError: null,
      lastIssue: null,
      runtimeActivity: null,
    };
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
  if (!canMutateRuntimeForRun(state, event)) {
    return;
  }
  state.runtime = {
    ...state.runtime,
    ...terminalRuntimePatch(event.runPhase, event.error, event.transportIssue ?? null),
  };
}

function messageHasToolCall(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) {
      return false;
    }
    const record = block as Record<string, unknown>;
    return isToolCallContentType(record.type) && !isStateOnlyToolContentBlock(record);
  });
}

function applyMessageRuntime(state: CanonicalSessionState, event: CanonicalMessageSnapshotEvent): void {
  if (event.source === 'replay' || !canMutateRuntimeForRun(state, event)) {
    return;
  }
  if (event.role === 'user') {
    state.runtime = {
      ...state.runtime,
      lastUserMessageAt: eventTime(event) ?? state.runtime.lastUserMessageAt,
    };
    return;
  }
  if (event.role !== 'assistant' || !canMutateRuntimeForRun(state, event)) {
    return;
  }
  if (event.status === 'streaming') {
    if (isStoppingActiveRunEvent(state, event)) {
      return;
    }
    state.runtime = {
      ...state.runtime,
      activeRunId: event.runId ?? state.runtime.activeRunId,
      runPhase: 'streaming',
      activeTurnItemKey: null,
      pendingTurnKey: resolveRuntimePendingTurnKeyForMessage(event, state.runtime.pendingTurnKey),
      pendingTurnLaneKey: laneKeyOf(event),
      lastError: null,
      lastIssue: null,
      runtimeActivity: null,
    };
    return;
  }
  if (event.status === 'final') {
    if (messageHasToolCall(event.content)) {
      if (isStoppingActiveRunEvent(state, event)) {
        return;
      }
      state.runtime = {
        ...state.runtime,
        activeRunId: event.runId ?? state.runtime.activeRunId,
        runPhase: 'waiting_tool',
        pendingTurnKey: resolveRuntimePendingTurnKeyForMessage(event, state.runtime.pendingTurnKey),
        pendingTurnLaneKey: laneKeyOf(event),
        lastError: null,
        lastIssue: null,
        runtimeActivity: null,
      };
      return;
    }
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
    sessionIdentity: state.context.identity,
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
  if (event.source === 'replay' || !canMutateRuntimeForRun(state, event)) {
    return;
  }
  if (event.type === 'tool_call' || event.type === 'tool_progress') {
    if (isStoppingActiveRunEvent(state, event)) {
      return;
    }
    state.runtime = {
      ...state.runtime,
      activeRunId: event.runId ?? state.runtime.activeRunId,
      pendingTurnKey: resolveRuntimePendingTurnKeyForTool(event, state.runtime.pendingTurnKey),
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
  context: RuntimeSessionContext,
): CanonicalSessionState {
  return {
    sessionId,
    protocolId: context.protocolId,
    runtimeEndpointId: context.runtimeEndpointId,
    context,
    eventIds: [],
    eventIdSet: new Set<string>(),
    messageIndexByKey: new Map<string, number>(),
    messageIndexByMessageKey: new Map<string, number>(),
    thoughtIndexByKey: new Map<string, number>(),
    toolIndexByKey: new Map<string, number>(),
    toolKeysByOwnerMessageKey: new Map<string, string[]>(),
    thoughtKeysByOwnerMessageKey: new Map<string, string[]>(),
    toolKeysByOwnerTurnKey: new Map<string, string[]>(),
    thoughtKeysByOwnerTurnKey: new Map<string, string[]>(),
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
  if (state.protocolId !== event.protocolId || state.runtimeEndpointId !== event.runtimeEndpointId) {
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
  if (state.updatedAt == null && event.source !== 'replay') {
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
