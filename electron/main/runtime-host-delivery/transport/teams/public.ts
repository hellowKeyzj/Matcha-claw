import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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
  port: number,
  fetcher: typeof fetch = fetch,
): TeamPublicTransport {
  const url = `http://127.0.0.1:${port}/api/team/public`;
  return {
    async read(request): Promise<TeamPublicTransportResponse> {
      if (!isRequest(request)) return { status: 503, body: UNAVAILABLE };
      try {
        const response = await fetcher(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${issuer.signDecision({
              principal: 'electron-main-local',
              endpoint: '/api/team/public',
              scope: 'team:read',
              capability: 'team.public.read',
              subject: 'team-public-projection',
              expiresAt: Date.now() + DECISION_TTL_MS,
              revision: '1',
            })}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(request),
        });
        const body: unknown = await response.json();
        if (response.status === 200 && isProjection(body)) return { status: 200, body };
        if (response.status === 404 && isUnavailable(body)) return { status: 404, body };
      } catch {
        // Native transport details do not cross the Electron delivery boundary.
      }
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

function isRequest(value: unknown): value is Readonly<{ teamId: string; runId: string }> {
  return isRecord(value)
    && hasExactKeys(value, ['teamId', 'runId'])
    && isIdentifier(value.teamId)
    && isIdentifier(value.runId);
}

function isProjection(value: unknown): value is TeamPublicProjection {
  if (!isRecord(value) || !hasExactKeys(value, ['teamId', 'runId', 'teamRevision', 'runtime', 'graph'])) return false;
  return isIdentifier(value.teamId)
    && isIdentifier(value.runId)
    && isCounter(value.teamRevision)
    && (value.runtime === 'confirmed' || value.runtime === 'unknown')
    && isGraph(value.graph);
}

function isGraph(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['graphId', 'workflowPlanId', 'title', 'status', 'nodes', 'edges'])
    && isIdentifier(value.graphId)
    && isIdentifier(value.workflowPlanId)
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
    && isIdentifier(value.nodeId)
    && ['start', 'work', 'review', 'human_decision', 'script_review', 'join', 'end'].includes(value.kind as string)
    && typeof value.title === 'string'
    && (value.roleId === null || isIdentifier(value.roleId))
    && (value.taskId === null || isIdentifier(value.taskId))
    && isCounter(value.maxAttempts)
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
    && isCounter(value.number)
    && isGraphStatus(value.status)
    && isCounter(value.updatedAt);
}

function isEdge(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['edgeId', 'sourceNodeId', 'sourcePort', 'targetNodeId', 'targetPort', 'action', 'status'])
    && isIdentifier(value.edgeId)
    && isIdentifier(value.sourceNodeId)
    && typeof value.sourcePort === 'string'
    && isIdentifier(value.targetNodeId)
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

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
