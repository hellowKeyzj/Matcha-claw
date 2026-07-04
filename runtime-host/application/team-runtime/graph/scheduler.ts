import type { TeamGraphAttemptInputContext, TeamGraphNodeDefinition, TeamGraphNodeExecutionAttempt, TeamGraphNodeExecutionHistory, TeamGraphReadyQueueItem, TeamGraphRunState } from './run-state';

export type { TeamGraphRunState } from './run-state';

export type TeamWorkNodeDelivery = {
  readonly deliveryId: string;
  readonly nodeId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly attemptId: string;
  readonly nodeExecutionId: string;
  readonly attemptNumber: number;
  readonly inputContexts: readonly TeamGraphAttemptInputContext[];
  readonly attemptUserMessage?: string;
  readonly idempotencyKey: string;
  readonly status: 'queued';
  readonly createdAt: number;
};

export type TeamGraphControlNodeEffect = {
  readonly nodeId: string;
  readonly nodeKind: 'start' | 'review' | 'human_decision' | 'script_review' | 'join' | 'end';
  readonly effectType: 'auto_complete' | 'agent_review' | 'request_review' | 'request_human_decision' | 'script_review';
  readonly attemptId: string;
  readonly nodeExecutionId: string;
  readonly attemptNumber: number;
  readonly inputContexts: readonly TeamGraphAttemptInputContext[];
  readonly idempotencyKey: string;
  readonly createdAt: number;
};

export type ScheduleReadyWorkNodeDeliveriesOptions = {
  readonly maxDeliveries?: number;
  readonly maxActiveRoleSessions?: number;
  readonly activeRoleSessionCount?: number;
  readonly activeRoleSessionKeys?: readonly string[];
  readonly roleSessionKeyByRoleId?: Readonly<Record<string, string>>;
  readonly nowMs?: number;
};

export type ScheduleReadyWorkNodeDeliveriesResult = {
  readonly state: TeamGraphRunState;
  readonly deliveries: TeamWorkNodeDelivery[];
  readonly controlEffects: TeamGraphControlNodeEffect[];
};

type ReadyWorkNodeDispatch = {
  readonly nodeId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly roleSessionKey: string;
  readonly attempt: TeamGraphNodeExecutionAttempt;
  readonly queueItem: TeamGraphReadyQueueItem;
};

type ReadyControlNodeDispatch = {
  readonly nodeId: string;
  readonly nodeKind: TeamGraphControlNodeEffect['nodeKind'];
  readonly effectType: TeamGraphControlNodeEffect['effectType'];
  readonly roleSessionKey?: string;
  readonly attempt: TeamGraphNodeExecutionAttempt;
  readonly queueItem: TeamGraphReadyQueueItem;
};

export function scheduleReadyWorkNodeDeliveries(
  state: TeamGraphRunState,
  options: ScheduleReadyWorkNodeDeliveriesOptions = {},
): ScheduleReadyWorkNodeDeliveriesResult {
  if (options.maxDeliveries !== undefined && (!Number.isInteger(options.maxDeliveries) || options.maxDeliveries < 0)) {
    throw new Error(`maxDeliveries must be a non-negative integer when provided. Received: ${String(options.maxDeliveries)}`);
  }
  if (options.maxActiveRoleSessions !== undefined && (!Number.isInteger(options.maxActiveRoleSessions) || options.maxActiveRoleSessions < 0)) {
    throw new Error(`maxActiveRoleSessions must be a non-negative integer when provided. Received: ${String(options.maxActiveRoleSessions)}`);
  }
  const activeQueueItems = activeReadyQueueItems(state);
  if (state.readyQueueHead < 0 || state.readyQueueHead > activeQueueItems.length) {
    throw new Error(`readyQueueHead ${state.readyQueueHead} is outside readyQueue bounds 0..${activeQueueItems.length}. Rebuild the TeamRun graph state before scheduling.`);
  }

  const maxDeliveries = options.maxDeliveries ?? Number.POSITIVE_INFINITY;
  const sessionSlots = Math.max(0, (options.maxActiveRoleSessions ?? Number.POSITIVE_INFINITY) - (options.activeRoleSessionCount ?? 0));
  if (maxDeliveries === 0 || sessionSlots === 0 || state.readyQueueHead >= activeQueueItems.length) return { state, deliveries: [], controlEffects: [] };

  const nodesById = new Map(state.definition.nodes.map((node) => [node.nodeId, node]));
  const dispatches: ReadyWorkNodeDispatch[] = [];
  const controlDispatches: ReadyControlNodeDispatch[] = [];
  const scheduledNodeIds = new Set<string>();
  const reservedRoleSessionKeys = new Set(options.activeRoleSessionKeys ?? []);
  const retainedQueueItems: TeamGraphReadyQueueItem[] = [];
  let scheduledRoleSessionCount = 0;

  const activeWindowItems = activeQueueItems.slice(state.readyQueueHead);
  for (let index = 0; index < activeWindowItems.length; index += 1) {
    const queueItem = activeWindowItems[index]!;
    const nodeId = queueItem.nodeId;
    if (scheduledNodeIds.has(nodeId)) {
      throw new Error(`Ready queue contains duplicate node "${nodeId}" in the active scheduling window. Rebuild the TeamRun graph state before scheduling.`);
    }
    const node = nodesById.get(nodeId);
    if (!node) throw new Error(`Ready queue references missing node "${nodeId}".`);
    const attempt = requireCurrentReadyAttempt(state, nodeId, queueItem);
    if (node.kind === 'work') {
      const roleSessionKey = options.roleSessionKeyByRoleId?.[node.roleId] ?? node.roleId;
      if (dispatches.length >= maxDeliveries || scheduledRoleSessionCount >= sessionSlots) {
        retainedQueueItems.push(...activeWindowItems.slice(index));
        break;
      }
      if (reservedRoleSessionKeys.has(roleSessionKey)) {
        retainedQueueItems.push(queueItem);
        continue;
      }
      dispatches.push({ nodeId, taskId: node.taskId, roleId: node.roleId, roleSessionKey, attempt, queueItem });
      reservedRoleSessionKeys.add(roleSessionKey);
      scheduledRoleSessionCount += 1;
    } else {
      const roleSessionKey = readRoleSessionKeyForControlNode(node, options.roleSessionKeyByRoleId);
      if (roleSessionKey && scheduledRoleSessionCount >= sessionSlots) {
        retainedQueueItems.push(...activeWindowItems.slice(index));
        break;
      }
      if (roleSessionKey && reservedRoleSessionKeys.has(roleSessionKey)) {
        retainedQueueItems.push(queueItem);
        continue;
      }
      controlDispatches.push({ nodeId, nodeKind: node.kind, effectType: effectTypeForControlNode(node.kind, node.executor), ...(roleSessionKey ? { roleSessionKey } : {}), attempt, queueItem });
      if (roleSessionKey) {
        reservedRoleSessionKeys.add(roleSessionKey);
        scheduledRoleSessionCount += 1;
      }
    }
    scheduledNodeIds.add(nodeId);
  }

  if (dispatches.length === 0 && controlDispatches.length === 0) return { state, deliveries: [], controlEffects: [] };

  const nowMs = options.nowMs ?? 0;
  const nodeExecutionsByNodeId = replaceScheduledAttempts(state, [...dispatches, ...controlDispatches], nowMs);
  const nextQueueItems = retainedQueueItems;
  return {
    state: {
      ...state,
      nodeExecutionsByNodeId,
      readyQueue: nextQueueItems.map((item) => item.nodeId),
      readyQueueItems: nextQueueItems,
      readyQueueHead: 0,
      queuedReadyNodeIds: nextQueueItems.map((item) => item.nodeId),
    },
    deliveries: dispatches.map((dispatch) => ({
      deliveryId: `team-graph-delivery:${dispatch.attempt.attemptId}`,
      nodeId: dispatch.nodeId,
      taskId: dispatch.taskId,
      roleId: dispatch.roleId,
      attemptId: dispatch.attempt.attemptId,
      nodeExecutionId: dispatch.queueItem.nodeExecutionId,
      attemptNumber: dispatch.attempt.attemptNumber,
      inputContexts: [...dispatch.queueItem.inputContexts],
      idempotencyKey: dispatch.queueItem.idempotencyKey,
      status: 'queued',
      createdAt: nowMs,
    })),
    controlEffects: controlDispatches.map((dispatch) => ({
      nodeId: dispatch.nodeId,
      nodeKind: dispatch.nodeKind,
      effectType: dispatch.effectType,
      attemptId: dispatch.attempt.attemptId,
      nodeExecutionId: dispatch.queueItem.nodeExecutionId,
      attemptNumber: dispatch.attempt.attemptNumber,
      inputContexts: [...dispatch.queueItem.inputContexts],
      idempotencyKey: dispatch.queueItem.idempotencyKey,
      createdAt: nowMs,
    })),
  };
}

function requireCurrentReadyAttempt(state: TeamGraphRunState, nodeId: string, queueItem: TeamGraphReadyQueueItem): TeamGraphNodeExecutionAttempt {
  const currentAttempt = state.nodeExecutionsByNodeId[nodeId]?.attempts.at(-1);
  if (!currentAttempt) throw new Error(`Ready node "${nodeId}" cannot be scheduled because it has no execution attempt. Recreate the run state from the submitted workflow plan.`);
  if (currentAttempt.status !== 'ready') throw new Error(`Ready node "${nodeId}" current attempt "${currentAttempt.attemptId}" has status "${currentAttempt.status}", expected "ready".`);
  if (currentAttempt.attemptId !== queueItem.attemptId) throw new Error(`Ready queue item for node "${nodeId}" points to attempt "${queueItem.attemptId}", but current attempt is "${currentAttempt.attemptId}".`);
  return currentAttempt;
}

function replaceScheduledAttempts(state: TeamGraphRunState, dispatches: readonly Array<{ readonly nodeId: string; readonly attempt: TeamGraphNodeExecutionAttempt }>, nowMs: number): Record<string, TeamGraphNodeExecutionHistory> {
  const nodeExecutionsByNodeId: Record<string, TeamGraphNodeExecutionHistory> = { ...state.nodeExecutionsByNodeId };
  for (const dispatch of dispatches) {
    const history = state.nodeExecutionsByNodeId[dispatch.nodeId];
    if (!history || history.attempts.length === 0) {
      throw new Error(`Cannot mark node "${dispatch.nodeId}" running because it has no attempt history. Recreate the run state from the submitted workflow plan.`);
    }
    nodeExecutionsByNodeId[dispatch.nodeId] = {
      attempts: [...history.attempts.slice(0, -1), { ...dispatch.attempt, status: 'running', startedAt: nowMs, updatedAt: nowMs }],
    };
  }
  return nodeExecutionsByNodeId;
}

function effectTypeForControlNode(kind: TeamGraphControlNodeEffect['nodeKind'], executor: Record<string, unknown> | undefined): TeamGraphControlNodeEffect['effectType'] {
  switch (kind) {
    case 'review':
      return executor?.kind === 'team-role' ? 'agent_review' : 'request_review';
    case 'human_decision':
      return 'request_human_decision';
    case 'script_review':
      return 'script_review';
    case 'start':
    case 'join':
    case 'end':
      return 'auto_complete';
  }
}

function readRoleSessionKeyForControlNode(node: TeamGraphNodeDefinition, roleSessionKeyByRoleId: Readonly<Record<string, string>> | undefined): string | undefined {
  if (node.kind !== 'review' || node.executor?.kind !== 'team-role') return undefined;
  const roleId = typeof node.executor.roleId === 'string' && node.executor.roleId.trim() ? node.executor.roleId : node.roleId;
  if (!roleId) return undefined;
  return roleSessionKeyByRoleId?.[roleId] ?? roleId;
}

function activeReadyQueueItems(state: TeamGraphRunState): TeamGraphReadyQueueItem[] {
  return state.readyQueueItems;
}
