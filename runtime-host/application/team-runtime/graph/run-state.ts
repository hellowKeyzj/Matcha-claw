import type { TeamGraphDefinition, TeamGraphEdgeAction, TeamGraphEdgeDefinition, TeamGraphEdgePayloadPolicy, TeamGraphNodeDefinition } from './definition';

export type { TeamGraphDefinition, TeamGraphEdgeAction, TeamGraphEdgePayloadPolicy, TeamGraphNodeDefinition, TeamGraphWorkNodeDefinition, TeamGraphEdgeDefinition } from './definition';

export type TeamGraphNodeKind = TeamGraphNodeDefinition['kind'];

export type TeamGraphNodeExecutionStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TeamGraphNodeExecutionReason =
  | 'initial'
  | 'trigger'
  | 'edge-activated'
  | 'retry'
  | 'rework'
  | 'manual-resume';

export type TeamNodeResultKind =
  | 'trigger'
  | 'work'
  | 'review'
  | 'human_decision'
  | 'script_check'
  | 'joined'
  | 'final';

export type TeamRoleAssignmentResult = {
  readonly roleId: string;
  readonly text: string;
};

export type TeamNodeResult = {
  readonly kind: TeamNodeResultKind;
  readonly summary: string;
  readonly content?: string;
  readonly decision?: 'approved' | 'rejected' | 'aborted' | 'passed' | 'failed' | 'completed' | 'joined';
  readonly assignments?: readonly TeamRoleAssignmentResult[];
  readonly evidenceRefs?: readonly unknown[];
  readonly artifactIds?: readonly string[];
  readonly metadata?: Record<string, unknown>;
};

export type TeamGraphAttemptInputContext = {
  readonly edgeId: string;
  readonly action: TeamGraphEdgeAction;
  readonly sourceNodeId: string;
  readonly sourcePort: string;
  readonly targetPort: string;
  readonly sourceNodeExecutionId: string;
  readonly sourceAttemptId: string;
  readonly sourceResult?: TeamNodeResult;
  readonly artifactIds: string[];
  readonly arrivedAt: number;
};

export type TeamGraphNodeExecutionAttempt = {
  attemptId: string;
  nodeExecutionId?: string;
  attemptNumber: number;
  nodeId: string;
  nodeKind: TeamGraphNodeKind;
  status: TeamGraphNodeExecutionStatus;
  reason?: TeamGraphNodeExecutionReason;
  triggerEdgeId?: string;
  inputContexts?: TeamGraphAttemptInputContext[];
  outputArtifactIds?: string[];
  result?: TeamNodeResult;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  completedByTaskId?: string;
  outputPort?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
};

export type TeamGraphNodeExecutionHistory = {
  attempts: TeamGraphNodeExecutionAttempt[];
};

export type TeamGraphReadyQueueItem = {
  queueItemId: string;
  runId: string;
  nodeId: string;
  attemptId: string;
  nodeExecutionId: string;
  attemptNumber: number;
  reason: TeamGraphNodeExecutionReason;
  triggerEdgeId?: string;
  inputContexts: TeamGraphAttemptInputContext[];
  idempotencyKey: string;
  enqueuedAt: number;
};

export type TeamGraphInboundEdgeState = {
  edgeId: string;
  sourceNodeId: string;
  sourcePort: string;
  targetPort: string;
  action: TeamGraphEdgeAction;
  payload: TeamGraphEdgePayloadPolicy;
  status: 'available' | 'waiting';
  sourceNodeExecutionId?: string;
  artifactIds: string[];
  updatedAt?: number;
};

export type TeamGraphNodeInputState = {
  nodeId: string;
  status: 'waiting' | 'ready';
  inboundEdges: TeamGraphInboundEdgeState[];
  activationEdges: TeamGraphInboundEdgeState[];
  arrivedActivationEdges: TeamGraphInboundEdgeState[];
  waitingActivationEdges: TeamGraphInboundEdgeState[];
  updatedAt?: number;
};

export type TeamGraphRunState = {
  runId: string;
  workflowPlanId: string;
  definition: TeamGraphDefinition;
  nodeExecutionsByNodeId: Record<string, TeamGraphNodeExecutionHistory>;
  readyQueue: string[];
  readyQueueItems: TeamGraphReadyQueueItem[];
  readyQueueHead: number;
  queuedReadyNodeIds: readonly string[];
  completedNodeIds: readonly string[];
  completedNodeOutputPortsByNodeId?: Record<string, readonly string[]>;
  nodeInputStateByNodeId: Record<string, TeamGraphNodeInputState>;
};
