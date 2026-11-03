import { sessionImageGenerationTask, type SessionAssistantTurnItem, type SessionRenderItem } from '@/types/session/render-item';
import type { SessionInputReceipt, SessionWireItem } from '@/types/session/snapshot';
import { bindSessionInputReceipts, isPendingUserItem, reconcileSessionItems } from '@/plugins/chat/store/session-item-reconciliation';
import { sanitizeAssistantDisplayText, sanitizeCanonicalUserText } from '@/plugins/chat/store/message-display';
import type { SessionMessageProjection, SessionMessageState, SessionTextModel } from '@/plugins/chat/store/session-presentation';
import {
  isRunActive,
  type ChatSessionAbortState,
  type ChatSessionPending,
  type ChatSessionRecord,
  type ChatSessionRuntimeState,
  type ChatSessionSendAdmission,
  type ChatSessionSendState,
} from '@/plugins/chat/store/types';

export const text: SessionTextModel = {
  user: sanitizeCanonicalUserText,
  assistant: sanitizeAssistantDisplayText,
};

export { pendingSessionInputIds as inputIds } from '@/plugins/chat/store/session-item-reconciliation';

export function reconcileItems(
  current: SessionRenderItem[],
  next: SessionRenderItem[],
  receipts: readonly SessionInputReceipt[] = [],
  sourceItems: readonly SessionWireItem[] = [],
): SessionRenderItem[] {
  const bound = bindSessionInputReceipts(current, next, receipts, sourceItems);
  if (bound === current && current === next) return current;
  const canonical = next.some(isPendingUserItem) ? next.filter((item) => !isPendingUserItem(item)) : next;
  return reconcileSessionItems(bound, canonical, null);
}

export function startSend(
  record: ChatSessionRecord,
  send: ChatSessionSendState,
  sessionKey: string,
): SessionMessageState {
  const assistantItem: SessionAssistantTurnItem = {
    key: `renderer-assistant:${send.clientId}`,
    kind: 'assistant-turn',
    role: 'assistant',
    sessionKey,
    identitySource: 'client',
    identityMode: 'client',
    identityConfidence: 'strong',
    status: 'streaming',
    segments: [],
    thinking: null,
    tools: [],
    text: '',
    images: [],
    attachedFiles: [],
    pendingState: 'typing',
    createdAt: send.startedAt,
    updatedAt: send.startedAt,
  };
  return {
    items: [...record.items, assistantItem],
    abort: null,
    runtime: {
      ...record.runtime,
      runPhase: 'submitted',
      pendingTurnKey: assistantItem.key,
      pendingTurnLaneKey: 'main',
      runProgress: null,
      imageGeneration: undefined,
      lastUserMessageAt: send.startedAt,
      lastError: null,
      lastIssue: null,
      updatedAt: send.startedAt,
    },
  };
}

export function confirmSend(
  record: ChatSessionRecord,
  send: ChatSessionSendState,
  runId: string,
  admission: ChatSessionSendAdmission,
  _retainReceipt: boolean,
  nextSend: ChatSessionSendState | null,
): SessionMessageState {
  const admitted = admission === 'queued' || admission === 'started';
  const terminalReceived = admitted && nextSend === null;
  const canBindRun = admitted && !terminalReceived;
  const clientAssistantKey = `renderer-assistant:${send.clientId}`;
  let changed = false;
  let lastUserMessageAt = record.runtime.lastUserMessageAt;
  const hasRunAssistant = record.items.some((item) => (
    item.kind === 'assistant-turn'
    && item.runId === runId
    && item.key !== clientAssistantKey
  ));
  const ownsPendingTurn = record.runtime.pendingTurnKey === clientAssistantKey
    && record.runtime.activeRunId === null && isRunActive(record.runtime);
  const items = record.items.filter((item) => {
    if ((!canBindRun || hasRunAssistant || !isRunActive(record.runtime)
      || (record.runtime.activeRunId !== null ? record.runtime.activeRunId !== runId : !ownsPendingTurn))
      && item.kind === 'assistant-turn' && item.key === clientAssistantKey) {
      changed = true;
      return false;
    }
    return true;
  }).map((item) => {
    if (item.kind === 'user-message' && item.clientId === send.clientId) {
      changed = true;
      lastUserMessageAt = item.createdAt ?? lastUserMessageAt;
      return {
        ...item,
        runId,
      };
    }
    if (item.kind === 'assistant-turn' && item.key === clientAssistantKey) {
      changed = true;
      return {
        ...item,
        runId,
        identitySource: 'run' as const,
        identityMode: 'run' as const,
      };
    }
    return item;
  });
  // Admission is not transcript consumption; only Started/Queued can bind this local turn.
  const runtime = !canBindRun
    ? ownsPendingTurn ? clearOptimisticRuntimeState(record.runtime, clientAssistantKey, terminalReceived) : record.runtime
    : ownsPendingTurn ? {
      ...record.runtime,
      activeRunId: runId,
      pendingTurnKey: hasRunAssistant ? null : clientAssistantKey,
      pendingTurnLaneKey: hasRunAssistant ? null : record.runtime.pendingTurnLaneKey,
      lastUserMessageAt,
      updatedAt: record.runtime.runPhase === 'stopping' || record.runtime.lastIssue ? record.runtime.updatedAt : Date.now(),
    } : record.runtime;
  const abort = terminalReceived && ownsPendingTurn && record.abort?.sendGeneration === send.generation
    ? null : record.abort ?? null;
  return { items: changed ? items : record.items, runtime, abort };
}

function clearOptimisticRuntimeState(
  runtime: ChatSessionRuntimeState,
  optimisticAssistantItemKey: string,
  terminalReceived = false,
): ChatSessionRuntimeState {
  // Send failure cannot settle a concurrent stop before its native terminal event.
  if (runtime.runPhase === 'stopping' && !terminalReceived) return runtime;
  const ownsPendingTurn = runtime.pendingTurnKey === optimisticAssistantItemKey;
  const ownsActiveTurn = runtime.activeTurnItemKey === optimisticAssistantItemKey;
  const ownsLocalPhase = ownsPendingTurn && runtime.activeRunId === null
    && (runtime.runPhase === 'submitted' || terminalReceived);
  if (!ownsPendingTurn && !ownsActiveTurn && !ownsLocalPhase) {
    return runtime;
  }
  return {
    ...runtime,
    ...(ownsLocalPhase ? { activeRunId: null, runPhase: 'idle' as const, lastError: null, lastIssue: null } : {}),
    activeTurnItemKey: ownsActiveTurn ? null : runtime.activeTurnItemKey,
    pendingTurnKey: ownsPendingTurn ? null : runtime.pendingTurnKey,
    pendingTurnLaneKey: ownsPendingTurn ? null : runtime.pendingTurnLaneKey,
    runProgress: null,
    imageGeneration: undefined,
    updatedAt: Date.now(),
  };
}

export function removeSend(record: ChatSessionRecord, clientId: string): SessionMessageState {
  const assistantItemKey = `renderer-assistant:${clientId}`;
  const items = record.items.filter((item) => !(
    (item.kind === 'user-message' && item.clientId === clientId)
    || (item.kind === 'assistant-turn' && item.key === assistantItemKey)
  ));
  return {
    items: items.length === record.items.length ? record.items : items,
    runtime: clearOptimisticRuntimeState(record.runtime, assistantItemKey),
    abort: record.abort ?? null,
  };
}

function pendingTurnTerminated(runtime: ChatSessionRuntimeState, terminatedRunIds: readonly string[]): boolean {
  return runtime.activeRunId !== null && terminatedRunIds.includes(runtime.activeRunId);
}

export function prepareProjectionItems(
  record: ChatSessionRecord,
  items: SessionRenderItem[],
  terminatedRunIds: readonly string[],
): SessionRenderItem[] {
  return pendingTurnTerminated(record.runtime, terminatedRunIds) ? items.filter((item) => (
    item.kind !== 'assistant-turn' || item.key !== record.runtime.pendingTurnKey
  )) : items;
}

function reconcileRuntimeProjection(
  current: ChatSessionRuntimeState,
  next: ChatSessionRuntimeState,
): ChatSessionRuntimeState {
  const sameRun = current.activeRunId === next.activeRunId
    || (current.activeRunId === null && current.pendingTurnKey !== null);
  if (!sameRun || !isRunActive(next)) return next;
  const stopping = current.runPhase === 'stopping';
  const abortIssue = current.lastIssue?.code?.startsWith('chat.abort.') === true;
  if (!stopping && !abortIssue) return next;
  return {
    ...next,
    ...(stopping ? { runPhase: 'stopping' as const, updatedAt: current.updatedAt }
      : abortIssue && next.runPhase === 'stopping' ? { runPhase: current.runPhase } : {}),
    ...(next.activeRunId === null && current.pendingTurnKey !== null ? {
      pendingTurnKey: current.pendingTurnKey,
      pendingTurnLaneKey: current.pendingTurnLaneKey,
    } : {}),
    ...(abortIssue ? { lastError: current.lastError, lastIssue: current.lastIssue, updatedAt: current.updatedAt } : {}),
  };
}

function imageTaskCancellationSettled(abort: ChatSessionAbortState, items: SessionRenderItem[]): boolean {
  const remaining = new Set(abort.imageTaskIds);
  for (const item of items) {
    if (item.kind !== 'assistant-turn') continue;
    for (const tool of item.tools) {
      const task = sessionImageGenerationTask(tool);
      if (task && task.status !== 'queued' && task.status !== 'running') remaining.delete(task.taskId);
    }
  }
  return remaining.size === 0;
}

export function projectMessages(
  record: ChatSessionRecord,
  items: SessionRenderItem[],
  projection: SessionMessageProjection,
): SessionMessageState {
  const current = record.runtime;
  const incoming = projection.runtime;
  // Admission owns this wait until native output or an associated terminal takes over.
  const yielded = incoming?.runPhase === 'idle' && incoming.activeRunId !== null
    && incoming.activeRunId === current.activeRunId;
  const preservePending = incoming !== null && !yielded && !isRunActive(incoming) && isRunActive(current)
    && current.pendingTurnKey !== null && !pendingTurnTerminated(current, projection.terminalRunIds);
  let runtime = incoming === null ? current : preservePending ? {
    ...current,
    runtimeNotice: incoming.runtimeNotice,
    imageGeneration: incoming.imageGeneration,
  } : reconcileRuntimeProjection(current, incoming);
  if (record.abort?.phase === 'stopping' && record.abort.imageTaskIds?.length
    && current.runPhase === 'stopping' && incoming !== null
    && (incoming.activeRunId === current.activeRunId || incoming.activeRunId === null)
    && !pendingTurnTerminated(current, projection.terminalRunIds)
    && !imageTaskCancellationSettled(record.abort, items)) {
    runtime = { ...incoming, runPhase: 'stopping', updatedAt: current.updatedAt };
  }
  const pendingAssistant = record.items.find((item): item is SessionAssistantTurnItem => (
    item.kind === 'assistant-turn' && item.key === current.pendingTurnKey
  ));
  let nextItems = yielded ? items.filter((item) => item.key !== current.pendingTurnKey) : items;
  if (!yielded && pendingAssistant && isRunActive(runtime)
    && (pendingAssistant.status === 'streaming' || pendingAssistant.status === 'waiting_tool')
    && !projection.retiredItemIds.has(pendingAssistant.key)
    && (!pendingAssistant.runId || pendingAssistant.runId === runtime.activeRunId)
    && !items.some((item) => item.key !== pendingAssistant.key
      && item.kind === 'assistant-turn' && item.runId && item.runId === runtime.activeRunId)) {
    const status = runtime.runPhase === 'waiting_tool' ? 'waiting_tool' : 'streaming';
    const pendingState = runtime.runtimeActivity === 'compacting' ? 'compacting'
      : status === 'waiting_tool' ? 'activity' : 'typing';
    const pending: SessionAssistantTurnItem = pendingAssistant.status === status && pendingAssistant.pendingState === pendingState
      ? pendingAssistant : { ...pendingAssistant, status, pendingState };
    nextItems = items.some((item) => item.key === pending.key)
      ? items.map((item) => item.key === pending.key ? pending : item) : [...items, pending];
    runtime = { ...runtime, pendingTurnKey: pending.key, pendingTurnLaneKey: current.pendingTurnLaneKey };
  }
  return {
    items: nextItems,
    runtime,
    abort: runtime.runPhase === 'stopping' || runtime.lastIssue?.code?.startsWith('chat.abort.') === true
      ? record.abort ?? null : null,
  };
}

export function startAbort(record: ChatSessionRecord, abort: ChatSessionAbortState): ChatSessionRuntimeState {
  return { ...record.runtime, runPhase: 'stopping', lastError: null, lastIssue: null, updatedAt: abort.startedAt };
}

export function failAbort(
  record: ChatSessionRecord,
  abort: ChatSessionAbortState,
  runtimeAtClick: ChatSessionRuntimeState,
): ChatSessionRuntimeState | null {
  const runtime = record.runtime;
  if (runtime.runPhase !== 'stopping' || runtime.updatedAt !== abort.startedAt
    || (abort.runId !== null && runtime.activeRunId !== abort.runId && !abort.imageTaskIds?.length) || abort.issue === null) return null;
  return {
    ...runtime,
    runPhase: runtimeAtClick.runPhase,
    lastError: abort.issue.message,
    lastIssue: abort.issue,
    updatedAt: abort.issue.at,
  };
}

export function hasPendingSend(_record: ChatSessionRecord): boolean {
  return false;
}

export function deriveRuntime(record: ChatSessionRecord): ChatSessionRuntimeState {
  return record.runtime;
}

export function terminalRunIds(
  exactRunIds: readonly string[],
  observedRunIds: readonly string[],
): readonly string[] {
  return observedRunIds.length ? [...exactRunIds, ...observedRunIds] : exactRunIds;
}

export function resolveAbortRunId(record: ChatSessionRecord): string | undefined {
  const activeRunId = record.runtime.activeRunId;
  if (activeRunId && isRunActive(record.runtime)) return activeRunId;
  const activeTasks = record.items.flatMap((item) => item.kind === 'assistant-turn'
    ? item.tools.flatMap((tool) => {
      const task = sessionImageGenerationTask(tool);
      return task && (task.status === 'queued' || task.status === 'running') ? [{ tool, task }] : [];
    }) : []);
  if (activeRunId && activeTasks.some(({ tool, task }) => tool.runId === activeRunId || task.runId === activeRunId)) return activeRunId;
  const taskRunIds = new Set(activeTasks.map(({ task }) => task.runId));
  if (taskRunIds.size === 1 && !taskRunIds.has(null)) return taskRunIds.values().next().value ?? undefined;
  const parentRunIds = new Set(activeTasks.map(({ tool }) => tool.runId));
  return parentRunIds.size === 1 && !parentRunIds.has(undefined) ? parentRunIds.values().next().value : undefined;
}

export function createPending(record: ChatSessionRecord, sessionKey: string): ChatSessionPending | null {
  const runtime = record.runtime;
  const placeholderRunId = runtime.activeRunId;
  if (!placeholderRunId || !isRunActive(runtime) || runtime.runPhase === 'stopping' && runtime.imageGeneration?.active) return null;
  if (record.items.some((item) => item.kind === 'assistant-turn'
    && (item.runId === placeholderRunId || item.key === runtime.pendingTurnKey))) return null;
  const isWaitingForTool = runtime.runPhase === 'waiting_tool';
  const isCompacting = runtime.runtimeActivity === 'compacting';
  return {
    kind: 'assistant',
    item: {
      key: `runtime-pending:${sessionKey}:${placeholderRunId}`,
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey,
      runId: placeholderRunId,
      identitySource: 'run',
      identityMode: 'run',
      identityConfidence: 'strong',
      status: isWaitingForTool ? 'waiting_tool' : 'streaming',
      segments: [],
      thinking: null,
      tools: [],
      text: '',
      images: [],
      attachedFiles: [],
      pendingState: isCompacting ? 'compacting' : (isWaitingForTool ? 'activity' : 'typing'),
      ...(runtime.lastUserMessageAt != null ? { createdAt: runtime.lastUserMessageAt } : {}),
      ...(runtime.updatedAt != null ? { updatedAt: runtime.updatedAt } : {}),
    },
  };
}

export function messageReplacementIndex(items: SessionWireItem[], incoming: SessionWireItem): number {
  const index = items.findIndex((item) => item.itemId === incoming.itemId);
  if (index >= 0 || incoming.kind !== 'assistantTurn' || incoming.runId === null) return index;
  return items.findIndex((item) => item.kind === 'assistantTurn' && item.runId === incoming.runId
    && item.messageId === null && item.text.length === 0 && item.segments.length > 0
    && item.segments.every((segment) => segment.kind === 'toolUse' || segment.kind === 'toolResult'));
}
