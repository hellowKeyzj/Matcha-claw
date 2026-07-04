export interface TeamGraphWorkflowJoinPolicyInput {
  readonly requireCompleted: boolean;
  readonly allowFailed: boolean;
  readonly retryLimit: number;
}

export interface TeamGraphWorkflowTaskInput {
  readonly taskId: string;
  readonly roleId: string;
  readonly title: string;
  readonly prompt: string;
  readonly dependsOnTaskIds?: readonly string[];
  readonly outputArtifactKind?: string;
}

export interface TeamGraphWorkflowGroupInput {
  readonly groupId: string;
  readonly title: string;
  readonly taskIds: readonly string[];
  readonly join: TeamGraphWorkflowJoinPolicyInput;
}

export interface TeamGraphWorkflowPlanInput {
  readonly workflowPlanId: string;
  readonly runId: string;
  readonly title: string;
  readonly status: string;
  readonly groups: readonly TeamGraphWorkflowGroupInput[];
  readonly tasks: readonly TeamGraphWorkflowTaskInput[];
  readonly idempotencyKey: string;
  readonly createdAt: number;
}

export type TeamGraphNodeKind = 'start' | 'work' | 'review' | 'human_decision' | 'script_review' | 'join' | 'end';

export type TeamGraphStartTriggerMode = 'webhook' | 'cron';

export interface TeamGraphStartWebhookTrigger {
  readonly mode: 'webhook';
  readonly path: string;
}

export interface TeamGraphStartCronTrigger {
  readonly mode: 'cron';
  readonly cron: string;
}

export type TeamGraphStartTrigger = TeamGraphStartWebhookTrigger | TeamGraphStartCronTrigger;

export type TeamGraphEdgeAction = 'activate' | 'rework' | 'gate' | 'finish';

export interface TeamGraphEdgePayloadPolicy {
  readonly includeUpstreamResult: boolean;
}

/**
 * Read the external trigger off a StartNode definition. A StartNode without a
 * usable trigger is treated as un-armed: it seeds the run immediately like any
 * other root node. A StartNode WITH a webhook/cron trigger stays dormant until
 * the matching `trigger.fired` event arrives.
 */
export function readStartNodeTrigger(node: TeamGraphNodeDefinition): TeamGraphStartTrigger | null {
  if (node.kind !== 'start') return null;
  const trigger = node.config?.trigger;
  if (!trigger || typeof trigger !== 'object') return null;
  const record = trigger as Record<string, unknown>;
  const mode = record.mode;
  if (mode === 'webhook') {
    const path = typeof record.path === 'string' ? record.path.trim() : '';
    return path ? { mode: 'webhook', path } : null;
  }
  if (mode === 'cron') {
    const cron = typeof record.cron === 'string' ? record.cron.trim() : '';
    return cron ? { mode: 'cron', cron } : null;
  }
  return null;
}

export interface TeamGraphBaseNodeDefinition {
  readonly nodeId: string;
  readonly nodeKind: TeamGraphNodeKind;
  readonly kind: TeamGraphNodeKind;
  readonly title: string;
  readonly groupId?: string;
  readonly roleId?: string;
  readonly taskId?: string;
  readonly executor?: Record<string, unknown>;
  readonly config?: Record<string, unknown>;
  readonly metadata: Record<string, unknown> & {
    readonly workflowPlanId: string;
    readonly runId: string;
    readonly title: string;
    readonly groupId?: string;
    readonly groupTitle?: string;
    readonly groupJoin?: TeamGraphWorkflowJoinPolicyInput;
  };
}

export interface TeamGraphWorkNodeDefinition extends TeamGraphBaseNodeDefinition {
  readonly nodeKind: 'work';
  readonly kind: 'work';
  readonly taskId: string;
  readonly roleId: string;
  readonly executor: Record<string, unknown> & {
    readonly kind: 'team-role';
    readonly roleId: string;
  };
  readonly config: Record<string, unknown> & {
    readonly prompt: string;
    readonly outputArtifactKind?: string;
  };
  readonly metadata: Record<string, unknown> & {
    readonly workflowPlanId: string;
    readonly runId: string;
    readonly taskId: string;
    readonly roleId: string;
    readonly title: string;
    readonly groupId?: string;
    readonly groupTitle?: string;
    readonly groupJoin?: TeamGraphWorkflowJoinPolicyInput;
    readonly outputArtifactKind?: string;
  };
}

export type TeamGraphControlNodeDefinition = TeamGraphBaseNodeDefinition & {
  readonly nodeKind: Exclude<TeamGraphNodeKind, 'work'>;
  readonly kind: Exclude<TeamGraphNodeKind, 'work'>;
};

export type TeamGraphNodeDefinition = TeamGraphWorkNodeDefinition | TeamGraphControlNodeDefinition;

export interface TeamGraphEdgeDefinition {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly kind: string;
  readonly type: string;
  readonly sourcePort: string;
  readonly targetPort: string;
  readonly action: TeamGraphEdgeAction;
  readonly payload: TeamGraphEdgePayloadPolicy;
  readonly metadata: Record<string, unknown> & {
    readonly dependencyTaskId?: string;
    readonly taskId?: string;
  };
}

export interface TeamGraphDefinition {
  readonly graphId: string;
  readonly workflowPlanId: string;
  readonly runId: string;
  readonly title: string;
  readonly status: string;
  readonly idempotencyKey: string;
  readonly createdAt: number;
  readonly nodes: readonly TeamGraphNodeDefinition[];
  readonly edges: readonly TeamGraphEdgeDefinition[];
  readonly groups: readonly TeamGraphWorkflowGroupInput[];
  readonly metadata?: Record<string, unknown>;
}
