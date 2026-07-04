import type {
  TeamGraphAttemptInputContext,
  TeamGraphDefinition,
  TeamGraphEdgeAction,
  TeamGraphEdgeDefinition,
  TeamGraphNodeDefinition,
  TeamGraphNodeExecutionAttempt,
  TeamGraphNodeExecutionHistory,
  TeamGraphNodeExecutionReason,
  TeamGraphReadyQueueItem,
  TeamGraphRunState,
  TeamGraphNodeInputState,
  TeamNodeResult,
  TeamNodeResultKind,
} from './run-state';
import { readStartNodeTrigger } from './definition';

const DEFAULT_MAX_NODE_ATTEMPTS = 3;

export type TeamGraphAttemptIdFactory = (nodeId: string, attemptNumber: number) => string;

export type TeamGraphEvent =
  | { type: 'workflow.plan_submitted'; definition: TeamGraphDefinition; nowMs?: number }
  | { type: 'task.completed'; taskId: string; completedAt: number; summary?: string; result?: TeamNodeResult; metadata?: Record<string, unknown> }
  | { type: 'node.completed'; nodeId: string; completedAt: number; outputPort?: string; summary?: string; result?: TeamNodeResult; metadata?: Record<string, unknown> }
  | { type: 'node.failed'; nodeId: string; failedAt: number; outputPort?: string; reason?: string; result?: TeamNodeResult; metadata?: Record<string, unknown> }
  | { type: 'node.waiting'; nodeId: string; waitingAt: number; reason?: string; metadata?: Record<string, unknown> }
  | { type: 'node.rework_requested'; nodeId: string; requestedAt: number; reason?: string; inputContexts?: TeamGraphAttemptInputContext[] }
  | { type: 'trigger.fired'; nodeId: string; firedAt: number; metadata?: Record<string, unknown> };

export type CreateInitialTeamGraphRunStateInput = {
  definition: TeamGraphDefinition;
  nowMs?: number;
  attemptIdForNode?: TeamGraphAttemptIdFactory;
};

export function createInitialTeamGraphRunState(input: CreateInitialTeamGraphRunStateInput): TeamGraphRunState {
  const nowMs = input.nowMs ?? 0;
  assertValidDefinition(input.definition);

  const rootNodeIds = new Set(
    input.definition.nodes
      .filter((node) => hasNoExecutionTriggerInputs(input.definition, node.nodeId) && !isArmedTriggerStartNode(node))
      .map((node) => node.nodeId),
  );

  const nodeExecutionsByNodeId: Record<string, TeamGraphNodeExecutionHistory> = {};
  const readyQueueItems: TeamGraphReadyQueueItem[] = [];

  for (const node of input.definition.nodes) {
    const status = rootNodeIds.has(node.nodeId) ? 'ready' : 'pending';
    const attempt = createExecutionAttempt({
      node,
      attemptNumber: 1,
      status,
      reason: 'initial',
      nowMs,
      attemptIdForNode: input.attemptIdForNode,
    });
    nodeExecutionsByNodeId[node.nodeId] = { attempts: [attempt] };
    if (status === 'ready') readyQueueItems.push(createReadyQueueItem(input.definition.runId, attempt, nowMs));
  }

  return {
    runId: input.definition.runId,
    workflowPlanId: input.definition.workflowPlanId,
    definition: input.definition,
    nodeExecutionsByNodeId,
    readyQueue: readyQueueItems.map((item) => item.nodeId),
    readyQueueItems,
    readyQueueHead: 0,
    queuedReadyNodeIds: readyQueueItems.map((item) => item.nodeId),
    completedNodeIds: [],
    completedNodeOutputPortsByNodeId: {},
    nodeInputStateByNodeId: buildNodeInputStateByNodeId(input.definition, {}, [], nodeExecutionsByNodeId, nowMs),
  };
}

export function reduceTeamGraphRunState(state: TeamGraphRunState, event: TeamGraphEvent): TeamGraphRunState {
  switch (event.type) {
    case 'workflow.plan_submitted':
      return createInitialTeamGraphRunState({ definition: event.definition, nowMs: event.nowMs });
    case 'task.completed':
      return reduceTaskCompleted(state, event);
    case 'node.completed':
      return reduceNodeCompleted(state, event);
    case 'node.failed':
      return reduceNodeFailed(state, event);
    case 'node.waiting':
      return reduceNodeWaiting(state, event);
    case 'node.rework_requested':
      return reduceNodeReworkRequested(state, event);
    case 'trigger.fired':
      return reduceTriggerFired(state, event);
  }
}

function reduceTriggerFired(state: TeamGraphRunState, event: Extract<TeamGraphEvent, { type: 'trigger.fired' }>): TeamGraphRunState {
  const node = requireNodeByNodeId(state.definition, event.nodeId);
  if (node.kind !== 'start' || !readStartNodeTrigger(node)) {
    throw new Error(`Cannot fire trigger for node "${event.nodeId}" because it is not an armed StartNode. Configure a webhook or cron trigger on the StartNode first.`);
  }

  const currentAttempt = requireCurrentAttempt(state, node.nodeId);
  const nextAttemptNumber = currentAttempt.status === 'pending' ? currentAttempt.attemptNumber : currentAttempt.attemptNumber + 1;
  assertAttemptLimit(node, nextAttemptNumber);

  const resetNodeIds = currentAttempt.status === 'pending'
    ? new Set([node.nodeId])
    : new Set([node.nodeId, ...reachableNodeIdsFrom(state.definition, node.nodeId)]);

  const nodeExecutionsByNodeId: Record<string, TeamGraphNodeExecutionHistory> = { ...state.nodeExecutionsByNodeId };
  const startAttempt = createExecutionAttempt({
    node,
    attemptNumber: nextAttemptNumber,
    status: 'ready',
    reason: 'trigger',
    nowMs: event.firedAt,
    metadata: event.metadata,
  });
  nodeExecutionsByNodeId[node.nodeId] = currentAttempt.status === 'pending'
    ? { attempts: [startAttempt] }
    : { attempts: [...state.nodeExecutionsByNodeId[node.nodeId]!.attempts, startAttempt] };

  if (currentAttempt.status !== 'pending') {
    for (const downstreamNodeId of resetNodeIds) {
      if (downstreamNodeId === node.nodeId) continue;
      const downstreamNode = requireNodeByNodeId(state.definition, downstreamNodeId);
      const downstreamAttempt = requireCurrentAttempt(state, downstreamNodeId);
      if (downstreamAttempt.status === 'pending') continue;
      nodeExecutionsByNodeId[downstreamNodeId] = {
        attempts: [...state.nodeExecutionsByNodeId[downstreamNodeId]!.attempts, createExecutionAttempt({
          node: downstreamNode,
          attemptNumber: downstreamAttempt.attemptNumber + 1,
          status: 'pending',
          reason: 'trigger',
          nowMs: event.firedAt,
        })],
      };
    }
  }

  return rebuildQueueAndInputState({
    ...state,
    nodeExecutionsByNodeId,
    completedNodeIds: state.completedNodeIds.filter((nodeId) => !resetNodeIds.has(nodeId)),
    completedNodeOutputPortsByNodeId: omitKeys(state.completedNodeOutputPortsByNodeId ?? {}, resetNodeIds),
  }, [startAttempt], event.firedAt);
}

function reduceTaskCompleted(state: TeamGraphRunState, event: Extract<TeamGraphEvent, { type: 'task.completed' }>): TeamGraphRunState {
  const node = findWorkNodeByTaskId(state.definition, event.taskId);
  if (!node) {
    throw new Error(`Cannot complete task "${event.taskId}" because no TeamRun graph WorkNode references that taskId. Submit a workflow plan containing this task before recording completion.`);
  }

  return reduceNodeCompleted(state, {
    type: 'node.completed',
    nodeId: node.nodeId,
    completedAt: event.completedAt,
    outputPort: 'completed',
    summary: event.summary,
    result: event.result,
    metadata: { ...(event.metadata ?? {}), completedByTaskId: event.taskId },
  });
}

function reduceNodeCompleted(state: TeamGraphRunState, event: Extract<TeamGraphEvent, { type: 'node.completed' }>): TeamGraphRunState {
  const node = requireNodeByNodeId(state.definition, event.nodeId);
  const currentAttempt = requireCurrentAttempt(state, node.nodeId);
  if (currentAttempt.status === 'completed') {
    throw new Error(`Cannot complete node "${node.nodeId}" because attempt ${currentAttempt.attemptNumber} is already completed. Request rework before recording another completion.`);
  }
  if (currentAttempt.status === 'failed' || currentAttempt.status === 'cancelled') {
    throw new Error(`Cannot complete node "${node.nodeId}" because attempt ${currentAttempt.attemptNumber} is ${currentAttempt.status}. Request rework to create a new attempt first.`);
  }

  const outputPort = event.outputPort ?? defaultOutputPortForNode(node);
  const outputArtifactIds = readStringArrayFromRecord(event.metadata, 'artifactId');
  const result = event.result ?? buildDefaultNodeResult(node, event.summary ?? 'Node completed.', outputPort, event.metadata);
  const completedAttempt: TeamGraphNodeExecutionAttempt = {
    ...currentAttempt,
    status: 'completed',
    updatedAt: event.completedAt,
    completedAt: event.completedAt,
    outputPort,
    outputArtifactIds,
    result: { ...result, artifactIds: outputArtifactIds.length > 0 ? outputArtifactIds : result.artifactIds },
    ...(node.kind === 'work' && node.taskId ? { completedByTaskId: node.taskId } : {}),
    summary: result.summary,
    ...(event.metadata ? { metadata: { ...(currentAttempt.metadata ?? {}), ...event.metadata } } : {}),
  };
  const completedNodeIds = appendUnique(state.completedNodeIds, node.nodeId);
  const completedNodeOutputPortsByNodeId = {
    ...(state.completedNodeOutputPortsByNodeId ?? {}),
    [node.nodeId]: appendUnique(state.completedNodeOutputPortsByNodeId?.[node.nodeId] ?? [], outputPort),
  };

  return applyOutputEdges({
    ...state,
    nodeExecutionsByNodeId: replaceCurrentAttempt(state, node.nodeId, completedAttempt),
    readyQueueItems: activeQueuedItems(state).filter((item) => item.nodeId !== node.nodeId),
    readyQueue: activeQueuedItems(state).filter((item) => item.nodeId !== node.nodeId).map((item) => item.nodeId),
    readyQueueHead: 0,
    queuedReadyNodeIds: activeQueuedItems(state).filter((item) => item.nodeId !== node.nodeId).map((item) => item.nodeId),
    completedNodeIds,
    completedNodeOutputPortsByNodeId,
  }, node, completedAttempt, outputPort, event.completedAt);
}

function reduceNodeFailed(state: TeamGraphRunState, event: Extract<TeamGraphEvent, { type: 'node.failed' }>): TeamGraphRunState {
  const node = requireNodeByNodeId(state.definition, event.nodeId);
  const currentAttempt = requireCurrentAttempt(state, node.nodeId);
  const outputPort = event.outputPort ?? 'failed';
  const result = event.result ?? buildDefaultNodeResult(node, event.reason ?? 'Node failed.', outputPort, event.metadata);
  const failedAttempt: TeamGraphNodeExecutionAttempt = {
    ...currentAttempt,
    status: 'failed',
    updatedAt: event.failedAt,
    completedAt: event.failedAt,
    outputPort,
    summary: result.summary,
    result,
    metadata: {
      ...(currentAttempt.metadata ?? {}),
      ...(event.metadata ?? {}),
      ...(event.reason ? { failureReason: event.reason } : {}),
    },
  };

  const completedNodeOutputPortsByNodeId = {
    ...(state.completedNodeOutputPortsByNodeId ?? {}),
    [node.nodeId]: appendUnique(state.completedNodeOutputPortsByNodeId?.[node.nodeId] ?? [], outputPort),
  };

  return applyOutputEdges({
    ...state,
    nodeExecutionsByNodeId: replaceCurrentAttempt(state, node.nodeId, failedAttempt),
    readyQueueItems: activeQueuedItems(state).filter((item) => item.nodeId !== node.nodeId),
    readyQueue: activeQueuedItems(state).filter((item) => item.nodeId !== node.nodeId).map((item) => item.nodeId),
    readyQueueHead: 0,
    queuedReadyNodeIds: activeQueuedItems(state).filter((item) => item.nodeId !== node.nodeId).map((item) => item.nodeId),
    completedNodeOutputPortsByNodeId,
  }, node, failedAttempt, outputPort, event.failedAt);
}

function reduceNodeWaiting(state: TeamGraphRunState, event: Extract<TeamGraphEvent, { type: 'node.waiting' }>): TeamGraphRunState {
  requireNodeByNodeId(state.definition, event.nodeId);
  const currentAttempt = requireCurrentAttempt(state, event.nodeId);
  if (currentAttempt.status !== 'ready' && currentAttempt.status !== 'running' && currentAttempt.status !== 'waiting') {
    throw new Error(`Cannot mark node "${event.nodeId}" waiting because current attempt "${currentAttempt.attemptId}" is ${currentAttempt.status}.`);
  }
  const waitingAttempt: TeamGraphNodeExecutionAttempt = {
    ...currentAttempt,
    status: 'waiting',
    updatedAt: event.waitingAt,
    ...(event.reason ? { summary: event.reason } : {}),
    metadata: {
      ...(currentAttempt.metadata ?? {}),
      ...(event.metadata ?? {}),
      ...(event.reason ? { waitingReason: event.reason } : {}),
    },
  };
  const nextQueueItems = activeQueuedItems(state).filter((item) => item.nodeId !== event.nodeId);
  return {
    ...state,
    nodeExecutionsByNodeId: replaceCurrentAttempt(state, event.nodeId, waitingAttempt),
    readyQueueItems: nextQueueItems,
    readyQueue: nextQueueItems.map((item) => item.nodeId),
    readyQueueHead: 0,
    queuedReadyNodeIds: nextQueueItems.map((item) => item.nodeId),
  };
}

function reduceNodeReworkRequested(state: TeamGraphRunState, event: Extract<TeamGraphEvent, { type: 'node.rework_requested' }>): TeamGraphRunState {
  const node = requireNodeByNodeId(state.definition, event.nodeId);
  const currentAttempt = requireCurrentAttempt(state, event.nodeId);
  const nextAttemptNumber = currentAttempt.attemptNumber + 1;
  assertAttemptLimit(node, nextAttemptNumber);

  const completedNodeIds = state.completedNodeIds.filter((nodeId) => nodeId !== event.nodeId);
  const completedNodeOutputPortsByNodeId = { ...(state.completedNodeOutputPortsByNodeId ?? {}) };
  delete completedNodeOutputPortsByNodeId[event.nodeId];

  const nextAttempt = createExecutionAttempt({
    node,
    attemptNumber: nextAttemptNumber,
    status: 'ready',
    reason: 'rework',
    nowMs: event.requestedAt,
    inputContexts: event.inputContexts ?? [],
    metadata: event.reason ? { reworkReason: event.reason } : undefined,
  });

  const activeReadyQueue = activeQueuedItems(state).filter((item) => item.nodeId !== event.nodeId);
  const readyQueueItems = [...activeReadyQueue, createReadyQueueItem(state.runId, nextAttempt, event.requestedAt)];
  const nodeExecutionsByNodeId = {
    ...state.nodeExecutionsByNodeId,
    [event.nodeId]: { attempts: [...state.nodeExecutionsByNodeId[event.nodeId]!.attempts, nextAttempt] },
  };
  return {
    ...state,
    nodeExecutionsByNodeId,
    readyQueueItems,
    readyQueue: readyQueueItems.map((item) => item.nodeId),
    readyQueueHead: 0,
    queuedReadyNodeIds: readyQueueItems.map((item) => item.nodeId),
    completedNodeIds,
    completedNodeOutputPortsByNodeId,
    nodeInputStateByNodeId: buildNodeInputStateByNodeId(state.definition, completedNodeOutputPortsByNodeId, completedNodeIds, nodeExecutionsByNodeId, event.requestedAt),
  };
}

function applyOutputEdges(state: TeamGraphRunState, sourceNode: TeamGraphNodeDefinition, sourceAttempt: TeamGraphNodeExecutionAttempt, outputPort: string, nowMs: number): TeamGraphRunState {
  let nextState: TeamGraphRunState = {
    ...state,
    nodeInputStateByNodeId: buildNodeInputStateByNodeId(state.definition, state.completedNodeOutputPortsByNodeId ?? {}, state.completedNodeIds, state.nodeExecutionsByNodeId, nowMs),
  };
  for (const edge of matchingEdgesForOutput(state.definition, sourceNode.nodeId, outputPort)) {
    const targetNode = requireNodeByNodeId(state.definition, edge.targetNodeId);
    const inputContext = buildAttemptInputContext(edge, sourceAttempt, targetNode, nowMs);
    switch (edge.action) {
      case 'activate':
      case 'finish':
        nextState = activateTargetAttempt(nextState, edge, inputContext, nowMs);
        break;
      case 'rework':
        nextState = reduceNodeReworkRequested(nextState, { type: 'node.rework_requested', nodeId: edge.targetNodeId, requestedAt: nowMs, reason: sourceAttempt.summary, inputContexts: [inputContext] });
        break;
      case 'gate':
        nextState = activateGateTargetWhenSatisfied(nextState, edge.targetNodeId, nowMs);
        break;
    }
  }
  return {
    ...nextState,
    nodeInputStateByNodeId: buildNodeInputStateByNodeId(nextState.definition, nextState.completedNodeOutputPortsByNodeId ?? {}, nextState.completedNodeIds, nextState.nodeExecutionsByNodeId, nowMs),
  };
}

function activateTargetAttempt(state: TeamGraphRunState, edge: TeamGraphEdgeDefinition, inputContext: TeamGraphAttemptInputContext, nowMs: number): TeamGraphRunState {
  const targetAttempt = requireCurrentAttempt(state, edge.targetNodeId);
  if (targetAttempt.status !== 'pending') return state;
  return markNodeReadyAndEnqueue(state, edge.targetNodeId, nowMs, 'edge-activated', edge.edgeId, [inputContext]);
}

function activateGateTargetWhenSatisfied(state: TeamGraphRunState, nodeId: string, nowMs: number): TeamGraphRunState {
  const targetAttempt = requireCurrentAttempt(state, nodeId);
  if (targetAttempt.status !== 'pending') return state;
  const gateEdges = incomingEdgesForAction(state.definition, nodeId, 'gate');
  if (gateEdges.length === 0) return state;
  const targetNode = requireNodeByNodeId(state.definition, nodeId);
  const inputContexts = gateEdges.flatMap((edge) => {
    const sourceAttempt = currentAttemptFromHistory(state.nodeExecutionsByNodeId, edge.sourceNodeId);
    if (!sourceAttempt || !edgeSatisfied(state, edge)) return [];
    return [buildAttemptInputContext(edge, sourceAttempt, targetNode, nowMs)];
  });
  if (inputContexts.length !== gateEdges.length) return state;
  return markNodeReadyAndEnqueue(state, nodeId, nowMs, 'edge-activated', gateEdges.map((edge) => edge.edgeId).join(','), inputContexts);
}

function createExecutionAttempt(input: {
  node: TeamGraphNodeDefinition;
  attemptNumber: number;
  status: TeamGraphNodeExecutionAttempt['status'];
  reason: TeamGraphNodeExecutionReason;
  nowMs: number;
  attemptIdForNode?: TeamGraphAttemptIdFactory;
  triggerEdgeId?: string;
  inputContexts?: TeamGraphAttemptInputContext[];
  metadata?: Record<string, unknown>;
}): TeamGraphNodeExecutionAttempt {
  const attemptId = input.attemptIdForNode?.(input.node.nodeId, input.attemptNumber) ?? `${input.node.nodeId}:attempt:${input.attemptNumber}`;
  return {
    attemptId,
    nodeExecutionId: attemptId,
    attemptNumber: input.attemptNumber,
    nodeId: input.node.nodeId,
    nodeKind: input.node.kind,
    status: input.status,
    reason: input.reason,
    ...(input.triggerEdgeId ? { triggerEdgeId: input.triggerEdgeId } : {}),
    inputContexts: input.inputContexts ?? [],
    outputArtifactIds: [],
    createdAt: input.nowMs,
    updatedAt: input.nowMs,
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
}

function createReadyQueueItem(runId: string, attempt: TeamGraphNodeExecutionAttempt, enqueuedAt: number): TeamGraphReadyQueueItem {
  return {
    queueItemId: `${runId}:queue:${attempt.nodeId}:${attempt.attemptId}`,
    runId,
    nodeId: attempt.nodeId,
    attemptId: attempt.attemptId,
    nodeExecutionId: attempt.nodeExecutionId ?? attempt.attemptId,
    attemptNumber: attempt.attemptNumber,
    reason: attempt.reason ?? 'edge-activated',
    ...(attempt.triggerEdgeId ? { triggerEdgeId: attempt.triggerEdgeId } : {}),
    inputContexts: [...(attempt.inputContexts ?? [])],
    idempotencyKey: `${runId}:queue:${attempt.nodeId}:${attempt.attemptId}`,
    enqueuedAt,
  };
}

function markNodeReadyAndEnqueue(state: TeamGraphRunState, nodeId: string, nowMs: number, reason: TeamGraphNodeExecutionAttempt['reason'], triggerEdgeId?: string, inputContexts: TeamGraphAttemptInputContext[] = []): TeamGraphRunState {
  const currentAttempt = requireCurrentAttempt(state, nodeId);
  const readyAttempt: TeamGraphNodeExecutionAttempt = {
    ...currentAttempt,
    status: 'ready',
    reason,
    ...(triggerEdgeId ? { triggerEdgeId } : {}),
    inputContexts,
    updatedAt: nowMs,
  };
  const nodeExecutionsByNodeId = replaceCurrentAttempt(state, nodeId, readyAttempt);
  if (state.queuedReadyNodeIds.includes(nodeId)) return { ...state, nodeExecutionsByNodeId };
  const readyQueueItems = [...activeQueuedItems(state), createReadyQueueItem(state.runId, readyAttempt, nowMs)];
  return {
    ...state,
    nodeExecutionsByNodeId,
    readyQueueItems,
    readyQueue: readyQueueItems.map((item) => item.nodeId),
    queuedReadyNodeIds: readyQueueItems.map((item) => item.nodeId),
    readyQueueHead: 0,
  };
}

function buildAttemptInputContext(edge: TeamGraphEdgeDefinition, sourceAttempt: TeamGraphNodeExecutionAttempt, targetNode: TeamGraphNodeDefinition, arrivedAt: number): TeamGraphAttemptInputContext {
  const sourceNodeExecutionId = sourceAttempt.nodeExecutionId ?? sourceAttempt.attemptId;
  return {
    edgeId: edge.edgeId,
    action: edge.action,
    sourceNodeId: edge.sourceNodeId,
    sourcePort: edge.sourcePort,
    targetPort: edge.targetPort,
    sourceNodeExecutionId,
    sourceAttemptId: sourceAttempt.attemptId,
    sourceResult: edge.payload.includeUpstreamResult ? selectSourceResultForTargetNode(sourceAttempt.result, targetNode) : undefined,
    artifactIds: edge.payload.includeUpstreamResult ? [...(sourceAttempt.outputArtifactIds ?? [])] : [],
    arrivedAt,
  };
}

function selectSourceResultForTargetNode(sourceResult: TeamNodeResult | undefined, targetNode: TeamGraphNodeDefinition): TeamNodeResult | undefined {
  if (!sourceResult?.assignments?.length || !targetNode.roleId) return sourceResult;
  const assignments = sourceResult.assignments.filter((assignment) => assignment.roleId === targetNode.roleId);
  return { ...sourceResult, assignments };
}

function replaceCurrentAttempt(state: TeamGraphRunState, nodeId: string, attempt: TeamGraphNodeExecutionAttempt): Record<string, TeamGraphNodeExecutionHistory> {
  const history = state.nodeExecutionsByNodeId[nodeId];
  if (!history || history.attempts.length === 0) {
    throw new Error(`Cannot update node "${nodeId}" because it has no execution attempts. Recreate the run state from the submitted workflow plan.`);
  }
  return { ...state.nodeExecutionsByNodeId, [nodeId]: { attempts: [...history.attempts.slice(0, -1), attempt] } };
}

function requireCurrentAttempt(state: TeamGraphRunState, nodeId: string): TeamGraphNodeExecutionAttempt {
  const currentAttempt = state.nodeExecutionsByNodeId[nodeId]?.attempts.at(-1);
  if (!currentAttempt) {
    throw new Error(`Node "${nodeId}" has no current execution attempt. Recreate the run state from the submitted workflow plan before reducing node events.`);
  }
  return currentAttempt;
}

function currentAttemptFromHistory(nodeExecutionsByNodeId: Readonly<Record<string, TeamGraphNodeExecutionHistory>>, nodeId: string): TeamGraphNodeExecutionAttempt | undefined {
  return nodeExecutionsByNodeId[nodeId]?.attempts.at(-1);
}

function findWorkNodeByTaskId(definition: TeamGraphDefinition, taskId: string): TeamGraphNodeDefinition | undefined {
  return definition.nodes.find((node) => node.kind === 'work' && node.taskId === taskId);
}

function requireNodeByNodeId(definition: TeamGraphDefinition, nodeId: string): TeamGraphNodeDefinition {
  const node = definition.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new Error(`Cannot update node "${nodeId}" because it does not exist in the TeamRun graph definition.`);
  return node;
}

function matchingEdgesForOutput(definition: TeamGraphDefinition, nodeId: string, outputPort: string): TeamGraphEdgeDefinition[] {
  return definition.edges.filter((edge) => edge.sourceNodeId === nodeId && edge.sourcePort === outputPort);
}

function incomingEdgesForAction(definition: TeamGraphDefinition, nodeId: string, action: TeamGraphEdgeAction): TeamGraphEdgeDefinition[] {
  return definition.edges.filter((edge) => edge.targetNodeId === nodeId && edge.action === action);
}

function reachableNodeIdsFrom(definition: TeamGraphDefinition, nodeId: string): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const queue = definition.edges.filter((edge) => edge.sourceNodeId === nodeId).map((edge) => edge.targetNodeId);
  for (let index = 0; index < queue.length; index += 1) {
    const nextNodeId = queue[index]!;
    if (visited.has(nextNodeId)) continue;
    visited.add(nextNodeId);
    result.push(nextNodeId);
    for (const edge of definition.edges) {
      if (edge.sourceNodeId === nextNodeId && !visited.has(edge.targetNodeId)) queue.push(edge.targetNodeId);
    }
  }
  return result;
}

function hasNoExecutionTriggerInputs(definition: TeamGraphDefinition, nodeId: string): boolean {
  return !definition.edges.some((edge) => edge.targetNodeId === nodeId && (edge.action === 'activate' || edge.action === 'gate' || edge.action === 'finish'));
}

function buildNodeInputStateByNodeId(
  definition: TeamGraphDefinition,
  completedNodeOutputPortsByNodeId: Readonly<Record<string, readonly string[]>>,
  completedNodeIds: readonly string[],
  nodeExecutionsByNodeId: Readonly<Record<string, TeamGraphNodeExecutionHistory>>,
  updatedAt: number,
): Record<string, TeamGraphNodeInputState> {
  const result: Record<string, TeamGraphNodeInputState> = {};
  for (const node of definition.nodes) {
    const inboundEdges = definition.edges
      .filter((edge) => edge.targetNodeId === node.nodeId)
      .map((edge) => {
        const sourceAttempt = currentAttemptFromHistory(nodeExecutionsByNodeId, edge.sourceNodeId);
        const available = edgeSatisfied({ completedNodeOutputPortsByNodeId, completedNodeIds }, edge);
        return {
          edgeId: edge.edgeId,
          sourceNodeId: edge.sourceNodeId,
          sourcePort: edge.sourcePort,
          targetPort: edge.targetPort,
          action: edge.action,
          payload: edge.payload,
          status: available ? 'available' as const : 'waiting' as const,
          ...(available && sourceAttempt ? { sourceNodeExecutionId: sourceAttempt.nodeExecutionId ?? sourceAttempt.attemptId } : {}),
          artifactIds: available && edge.payload.includeUpstreamResult ? [...(sourceAttempt?.outputArtifactIds ?? [])] : [],
          updatedAt,
        };
      });
    const activationEdges = inboundEdges.filter((edge) => edge.action === 'activate' || edge.action === 'gate' || edge.action === 'finish');
    const arrivedActivationEdges = activationEdges.filter((edge) => edge.status === 'available');
    const waitingActivationEdges = activationEdges.filter((edge) => edge.status === 'waiting');
    if (activationEdges.length === 0) continue;
    result[node.nodeId] = {
      nodeId: node.nodeId,
      status: waitingActivationEdges.length === 0 ? 'ready' : 'waiting',
      inboundEdges,
      activationEdges,
      arrivedActivationEdges,
      waitingActivationEdges,
      updatedAt,
    };
  }
  return result;
}

function edgeSatisfied(state: Pick<TeamGraphRunState, 'completedNodeOutputPortsByNodeId' | 'completedNodeIds'>, edge: TeamGraphEdgeDefinition): boolean {
  const ports = state.completedNodeOutputPortsByNodeId?.[edge.sourceNodeId];
  return ports ? ports.includes(edge.sourcePort) : state.completedNodeIds.includes(edge.sourceNodeId) && edge.sourcePort === 'completed';
}

function defaultOutputPortForNode(node: TeamGraphNodeDefinition): string {
  switch (node.kind) {
    case 'review':
    case 'script_review':
      return 'passed';
    case 'human_decision':
      return 'approved';
    case 'join':
      return 'joined';
    default:
      return 'completed';
  }
}

function defaultResultKindForNode(node: TeamGraphNodeDefinition): TeamNodeResultKind {
  switch (node.kind) {
    case 'start':
      return 'trigger';
    case 'review':
      return 'review';
    case 'human_decision':
      return 'human_decision';
    case 'script_review':
      return 'script_check';
    case 'join':
      return 'joined';
    case 'end':
      return 'final';
    default:
      return 'work';
  }
}

function buildDefaultNodeResult(node: TeamGraphNodeDefinition, summary: string, outputPort: string, metadata: Record<string, unknown> | undefined): TeamNodeResult {
  return {
    kind: defaultResultKindForNode(node),
    summary,
    decision: decisionFromOutputPort(outputPort),
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

function decisionFromOutputPort(outputPort: string): TeamNodeResult['decision'] | undefined {
  switch (outputPort) {
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'aborted':
      return 'aborted';
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'joined':
      return 'joined';
    case 'completed':
      return 'completed';
    default:
      return undefined;
  }
}

function activeQueuedItems(state: TeamGraphRunState): TeamGraphReadyQueueItem[] {
  return state.readyQueueItems.slice(state.readyQueueHead);
}

function rebuildQueueAndInputState(state: TeamGraphRunState, readyAttempts: TeamGraphNodeExecutionAttempt[], nowMs: number): TeamGraphRunState {
  const readyQueueItems = [...activeQueuedItems(state).filter((item) => !readyAttempts.some((attempt) => attempt.nodeId === item.nodeId)), ...readyAttempts.map((attempt) => createReadyQueueItem(state.runId, attempt, nowMs))];
  return {
    ...state,
    readyQueueItems,
    readyQueue: readyQueueItems.map((item) => item.nodeId),
    readyQueueHead: 0,
    queuedReadyNodeIds: readyQueueItems.map((item) => item.nodeId),
    nodeInputStateByNodeId: buildNodeInputStateByNodeId(state.definition, state.completedNodeOutputPortsByNodeId ?? {}, state.completedNodeIds, state.nodeExecutionsByNodeId, nowMs),
  };
}

function assertAttemptLimit(node: TeamGraphNodeDefinition, attemptNumber: number): void {
  const configured = typeof node.config?.maxAttempts === 'number' && Number.isFinite(node.config.maxAttempts)
    ? Math.max(1, Math.floor(node.config.maxAttempts))
    : DEFAULT_MAX_NODE_ATTEMPTS;
  if (attemptNumber > configured) {
    throw new Error(`Node "${node.nodeId}" exceeded maxAttempts ${configured}. Stop the loop or increase maxAttempts in the node config.`);
  }
}

function isArmedTriggerStartNode(node: TeamGraphNodeDefinition): boolean {
  return node.kind === 'start' && readStartNodeTrigger(node) !== null;
}

function omitKeys(record: Readonly<Record<string, readonly string[]>>, keys: ReadonlySet<string>): Record<string, readonly string[]> {
  const next = { ...record };
  for (const key of keys) delete next[key];
  return next;
}

function appendUnique(values: readonly string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function readStringArrayFromRecord(record: Record<string, unknown> | undefined, field: string): string[] {
  const value = record?.[field];
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []);
  return [];
}

function assertValidDefinition(definition: TeamGraphDefinition): void {
  const nodeIds = new Set<string>();
  for (const node of definition.nodes) {
    if (nodeIds.has(node.nodeId)) throw new Error(`Invalid TeamRun graph definition: duplicate nodeId "${node.nodeId}". Node ids must be unique before execution can start.`);
    nodeIds.add(node.nodeId);
  }
  const edgeIds = new Set<string>();
  for (const edge of definition.edges) {
    if (edgeIds.has(edge.edgeId)) throw new Error(`Invalid TeamRun graph definition: duplicate edgeId "${edge.edgeId}". Edge ids must be unique before execution can start.`);
    edgeIds.add(edge.edgeId);
    if (!nodeIds.has(edge.sourceNodeId)) throw new Error(`Invalid TeamRun graph definition: edge "${edge.edgeId}" sourceNodeId "${edge.sourceNodeId}" does not reference a graph node.`);
    if (!nodeIds.has(edge.targetNodeId)) throw new Error(`Invalid TeamRun graph definition: edge "${edge.edgeId}" targetNodeId "${edge.targetNodeId}" does not reference a graph node.`);
  }
}
