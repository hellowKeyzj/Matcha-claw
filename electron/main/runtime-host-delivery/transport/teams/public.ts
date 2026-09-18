import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import {
  hasExactKeys,
  isNonEmptyBoundedText,
  isRecord,
  isSafeNonNegativeInteger,
  sendLoopbackJson,
} from '../client';

const ENDPOINT = '/api/team/public';
const UNAVAILABLE = {
  success: false,
  error: 'Team public projection is unavailable',
} as const;

type TeamRuntimeState = 'confirmed' | 'unknown';
type TeamGraphStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
type TeamNodeKind = 'start' | 'work' | 'review' | 'human_decision' | 'script_review' | 'join' | 'end';
type TeamAttemptStatus = TeamGraphStatus;
type TeamEdgeAction = 'activate' | 'rework' | 'gate' | 'finish';
type TeamEdgeStatus = 'waiting' | 'satisfied';
type TeamWebhookTrigger = Readonly<{ kind: 'webhook' }>;
type TeamCronTrigger = Readonly<{ kind: 'cron'; expression: string }>;

export type TeamPublicProjection = Readonly<{
  teamId: string;
  runId: string;
  teamRevision: number;
  runtime: TeamRuntimeState;
  graph: Readonly<{
    graphId: string;
    workflowPlanId: string;
    title: string;
    status: TeamGraphStatus;
    nodes: readonly Readonly<{
      nodeId: string;
      kind: TeamNodeKind;
      title: string;
      roleId: string | null;
      taskId: string | null;
      maxAttempts: number;
      trigger: TeamWebhookTrigger | TeamCronTrigger | null;
      attempt: Readonly<{ number: number; status: TeamAttemptStatus; updatedAt: number }>;
    }>[];
    edges: readonly Readonly<{
      edgeId: string;
      sourceNodeId: string;
      sourcePort: string;
      targetNodeId: string;
      targetPort: string;
      action: TeamEdgeAction;
      status: TeamEdgeStatus;
    }>[];
  }>;
}>;

export type TeamPublicTransportResponse = Readonly<{
  status: 200 | 404 | 503;
  body: TeamPublicProjection | typeof UNAVAILABLE;
}>;

export interface TeamPublicTransport {
  read(request: Readonly<{ teamId: string; runId: string }>): Promise<TeamPublicTransportResponse>;
}

export function createTeamPublicTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamPublicTransport {
  return {
    async read(request): Promise<TeamPublicTransportResponse> {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: ENDPOINT,
        issuer,
        decision: {
          endpoint: ENDPOINT,
          scope: 'team:read',
          capability: 'team.public.read',
          subject: 'team-public-projection',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response === null) return { status: 503, body: UNAVAILABLE };
      if (response.status === 200 && isProjection(response.body)) return { status: 200, body: response.body };
      if (response.status === 404 && isUnavailable(response.body)) return { status: 404, body: response.body };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is Readonly<{ teamId: string; runId: string }> {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId'])
    && isNonEmptyBoundedText(value.teamId)
    && isNonEmptyBoundedText(value.runId);
}

function isProjection(value: unknown): value is TeamPublicProjection {
  if (!isRecord(value) || !hasExactKeys(value, ['teamId', 'runId', 'teamRevision', 'runtime', 'graph'])) return false;
  return isNonEmptyBoundedText(value.teamId)
    && isNonEmptyBoundedText(value.runId)
    && isSafeNonNegativeInteger(value.teamRevision)
    && (value.runtime === 'confirmed' || value.runtime === 'unknown')
    && isGraph(value.graph);
}

function isGraph(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['graphId', 'workflowPlanId', 'title', 'status', 'nodes', 'edges'])
    && isNonEmptyBoundedText(value.graphId)
    && isNonEmptyBoundedText(value.workflowPlanId)
    && typeof value.title === 'string'
    && isGraphStatus(value.status)
    && Array.isArray(value.nodes)
    && value.nodes.every(isNode)
    && Array.isArray(value.edges)
    && value.edges.every(isEdge);
}

function isNode(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['nodeId', 'kind', 'title', 'roleId', 'taskId', 'maxAttempts', 'trigger', 'attempt'])
    && isNonEmptyBoundedText(value.nodeId)
    && ['start', 'work', 'review', 'human_decision', 'script_review', 'join', 'end'].includes(value.kind as string)
    && typeof value.title === 'string'
    && (value.roleId === null || isNonEmptyBoundedText(value.roleId))
    && (value.taskId === null || isNonEmptyBoundedText(value.taskId))
    && isSafeNonNegativeInteger(value.maxAttempts)
    && isStartTrigger(value.trigger)
    && isAttempt(value.attempt);
}

function isStartTrigger(value: unknown): value is TeamWebhookTrigger | TeamCronTrigger | null {
  return value === null || (isRecord(value) && (
    (hasExactKeys(value, ['kind']) && value.kind === 'webhook')
    || (hasExactKeys(value, ['kind', 'expression']) && value.kind === 'cron' && typeof value.expression === 'string')
  ));
}

function isAttempt(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['number', 'status', 'updatedAt'])
    && isSafeNonNegativeInteger(value.number)
    && isGraphStatus(value.status)
    && isSafeNonNegativeInteger(value.updatedAt);
}

function isEdge(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['edgeId', 'sourceNodeId', 'sourcePort', 'targetNodeId', 'targetPort', 'action', 'status'])
    && isNonEmptyBoundedText(value.edgeId)
    && isNonEmptyBoundedText(value.sourceNodeId)
    && typeof value.sourcePort === 'string'
    && isNonEmptyBoundedText(value.targetNodeId)
    && typeof value.targetPort === 'string'
    && ['activate', 'rework', 'gate', 'finish'].includes(value.action as string)
    && (value.status === 'waiting' || value.status === 'satisfied');
}

function isUnavailable(value: unknown): value is typeof UNAVAILABLE {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === UNAVAILABLE.error;
}

function isGraphStatus(value: unknown): value is TeamGraphStatus {
  return ['pending', 'ready', 'running', 'waiting', 'completed', 'failed', 'cancelled'].includes(value as string);
}
