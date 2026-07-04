import type { TeamGraphNodeExecutionAttempt, TeamGraphNodeInputState, TeamGraphRunState, TeamNodeResult } from './run-state';
import type { TeamWorkNodeDelivery } from './scheduler';

export type TeamGraphNodeProjection = {
  readonly nodeId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly roleId?: string;
  readonly groupId?: string;
  readonly taskId?: string;
  readonly stageId?: string;
  readonly status?: string;
  readonly statusReason?: string;
  readonly createdAt?: number;
  readonly completedAt?: number;
  readonly artifactId?: string;
  readonly executor?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
};

export type TeamGraphEdgeProjection = {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly fromNodeId?: string;
  readonly toNodeId?: string;
  readonly sourcePort?: string;
  readonly targetPort?: string;
  readonly edgeType?: string;
  readonly kind?: string;
  readonly action?: string;
  readonly payload?: Record<string, unknown>;
  readonly status?: string;
  readonly label?: string;
  readonly metadata?: Record<string, unknown>;
};

export type TeamGraphSnapshotProjection = {
  readonly runId?: string;
  readonly workflowPlanId?: string;
  readonly nodes: TeamGraphNodeProjection[];
  readonly edges: TeamGraphEdgeProjection[];
  readonly status: string;
  readonly updatedAt?: number;
  readonly metadata?: Record<string, unknown>;
};

export type TeamGraphNodeInputStateProjection = TeamGraphNodeInputState;

export type TeamNodeExecutionProjection = {
  readonly runId: string;
  readonly nodeId: string;
  readonly nodeExecutionId?: string;
  readonly attemptId?: string;
  readonly attemptNumber?: number;
  readonly reason?: string;
  readonly executionRecordId?: string;
  readonly executionId?: string;
  readonly stageId?: string;
  readonly roleId?: string;
  readonly status: string;
  readonly statusReason?: string;
  readonly summary?: string;
  readonly startedAt?: number;
  readonly completedAt?: number;
  readonly createdAt?: number;
  readonly updatedAt?: number;
  readonly inputSummary?: Record<string, unknown>;
  readonly outputSummary?: Record<string, unknown>;
  readonly input?: Record<string, unknown>;
  readonly output?: Record<string, unknown>;
  readonly result?: TeamNodeResult;
  readonly metadata?: Record<string, unknown>;
};

export type TeamNodeDeliveryProjection = {
  readonly runId?: string;
  readonly nodeId: string;
  readonly deliveryId: string;
  readonly taskId: string;
  readonly roleId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly inputContexts: TeamWorkNodeDelivery['inputContexts'];
  readonly status: 'queued';
  readonly createdAt: number;
};

export function buildTeamGraphSnapshotProjection(state: TeamGraphRunState): TeamGraphSnapshotProjection {
  return {
    runId: state.runId,
    workflowPlanId: state.workflowPlanId,
    nodes: state.definition.nodes.map((node) => {
      const currentAttempt = currentAttemptForNode(state, node.nodeId);
      return {
        nodeId: node.nodeId,
        kind: node.kind,
        title: node.title,
        roleId: node.roleId,
        groupId: node.groupId,
        taskId: node.taskId,
        stageId: node.taskId,
        status: currentAttempt?.status,
        createdAt: currentAttempt?.createdAt,
        completedAt: currentAttempt?.completedAt,
        artifactId: currentAttempt?.outputArtifactIds?.[0],
        executor: cloneRecord(node.executor),
        config: cloneRecord(node.config),
        metadata: cloneRecord(node.metadata),
      };
    }),
    edges: state.definition.edges.map((edge) => ({
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      fromNodeId: edge.sourceNodeId,
      toNodeId: edge.targetNodeId,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
      edgeType: edge.type,
      kind: edge.kind,
      action: edge.action,
      payload: { ...edge.payload },
      status: edgeSatisfied(state, edge.sourceNodeId, edge.sourcePort) ? 'satisfied' : 'waiting',
      label: `${edge.sourcePort} → ${edge.action}`,
      metadata: cloneRecord(edge.metadata),
    })),
    status: buildTeamGraphStatus(state),
    updatedAt: buildGraphUpdatedAt(state),
    metadata: cloneRecord(state.definition.metadata),
  };
}

export function buildTeamNodeExecutionProjection(state: TeamGraphRunState): TeamNodeExecutionProjection[] {
  return state.definition.nodes.flatMap((node) => {
    return (state.nodeExecutionsByNodeId[node.nodeId]?.attempts ?? []).map((attempt) => {
      const nodeExecutionId = attempt.nodeExecutionId ?? attempt.attemptId;
      const input = {
        contexts: cloneInputContexts(attempt.inputContexts ?? []),
      };
      const output = {
        port: attempt.outputPort,
        artifactIds: [...(attempt.outputArtifactIds ?? [])],
        result: attempt.result,
      };
      return {
        runId: state.runId,
        nodeId: attempt.nodeId,
        nodeExecutionId,
        attemptId: attempt.attemptId,
        attemptNumber: attempt.attemptNumber,
        reason: attempt.reason,
        executionRecordId: nodeExecutionId,
        executionId: nodeExecutionId,
        roleId: node.roleId,
        status: attempt.status,
        statusReason: typeof attempt.metadata?.failureReason === 'string' ? attempt.metadata.failureReason : undefined,
        summary: attempt.summary,
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        createdAt: attempt.createdAt,
        updatedAt: attempt.updatedAt,
        inputSummary: { contextCount: (attempt.inputContexts ?? []).length },
        outputSummary: output,
        input,
        output,
        result: attempt.result,
        metadata: cloneRecord(attempt.metadata),
      };
    });
  });
}

export function buildTeamNodeInputStateProjection(state: TeamGraphRunState): TeamGraphNodeInputStateProjection[] {
  return Object.values(state.nodeInputStateByNodeId).map((inputState) => ({
    ...inputState,
    inboundEdges: inputState.inboundEdges.map((edge) => ({ ...edge, payload: { ...edge.payload }, artifactIds: [...edge.artifactIds] })),
    activationEdges: inputState.activationEdges.map((edge) => ({ ...edge, payload: { ...edge.payload }, artifactIds: [...edge.artifactIds] })),
    arrivedActivationEdges: inputState.arrivedActivationEdges.map((edge) => ({ ...edge, payload: { ...edge.payload }, artifactIds: [...edge.artifactIds] })),
    waitingActivationEdges: inputState.waitingActivationEdges.map((edge) => ({ ...edge, payload: { ...edge.payload }, artifactIds: [...edge.artifactIds] })),
  }));
}

export function buildTeamNodeDeliveryProjection(deliveries: ReadonlyArray<TeamWorkNodeDelivery>): TeamNodeDeliveryProjection[] {
  return deliveries.map((delivery) => ({ ...delivery, inputContexts: cloneInputContexts(delivery.inputContexts) }));
}

function buildTeamGraphStatus(state: TeamGraphRunState): string {
  const currentAttempts = state.definition.nodes
    .map((node) => currentAttemptForNode(state, node.nodeId))
    .filter((attempt): attempt is TeamGraphNodeExecutionAttempt => attempt !== undefined);
  if (currentAttempts.some((attempt) => attempt.status === 'cancelled')) return 'cancelled';
  const endNodes = state.definition.nodes.filter((node) => node.kind === 'end');
  if (endNodes.length > 0 && endNodes.every((node) => currentAttemptForNode(state, node.nodeId)?.status === 'completed')) return 'completed';
  if (currentAttempts.some((attempt) => attempt.status === 'failed')) return 'failed';
  if (currentAttempts.some((attempt) => attempt.status === 'running')) return 'running';
  if (currentAttempts.some((attempt) => attempt.status === 'waiting')) return 'waiting';
  if (currentAttempts.length > 0 && currentAttempts.every((attempt) => attempt.status === 'completed')) return 'completed';
  if (state.readyQueueHead < state.readyQueueItems.length) return 'ready';
  return 'pending';
}

function buildGraphUpdatedAt(state: TeamGraphRunState): number | undefined {
  return state.definition.nodes.reduce<number | undefined>((latestUpdatedAt, node) => {
    const currentAttempt = currentAttemptForNode(state, node.nodeId);
    if (currentAttempt?.updatedAt === undefined) return latestUpdatedAt;
    return latestUpdatedAt === undefined ? currentAttempt.updatedAt : Math.max(latestUpdatedAt, currentAttempt.updatedAt);
  }, undefined);
}

function edgeSatisfied(state: TeamGraphRunState, sourceNodeId: string, sourcePort: string): boolean {
  return Boolean(state.completedNodeOutputPortsByNodeId?.[sourceNodeId]?.includes(sourcePort));
}

function currentAttemptForNode(state: TeamGraphRunState, nodeId: string): TeamGraphNodeExecutionAttempt | undefined {
  return state.nodeExecutionsByNodeId[nodeId]?.attempts.at(-1);
}

function cloneRecord(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return value ? { ...value } : undefined;
}

function cloneInputContexts<T extends ReadonlyArray<{ readonly artifactIds: readonly string[]; readonly sourceResult?: TeamNodeResult }>>(contexts: T): T {
  return contexts.map((context) => ({
    ...context,
    artifactIds: [...context.artifactIds],
    ...(context.sourceResult ? { sourceResult: { ...context.sourceResult } } : {}),
  })) as unknown as T;
}
