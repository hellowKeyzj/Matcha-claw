import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

export type WorkflowPlan = Readonly<{
  workflowPlanId: string;
  runId: string;
  title: string;
  status: string;
  groups: readonly Readonly<{
    groupId: string;
    title: string;
    taskIds: readonly string[];
    join: Readonly<{ requireCompleted: boolean; allowFailed: boolean; retryLimit: number }>;
  }>[];
  tasks: readonly Readonly<{
    taskId: string;
    roleId: string;
    title: string;
    prompt: string;
    dependsOnTaskIds: readonly string[];
    outputArtifactKind: string | null;
  }>[];
  idempotencyKey: string;
  createdAt: number;
}>;

const DECISION_TTL_MS = 30_000;
const UNAVAILABLE = { success: false, error: 'Team lifecycle is unavailable' } as const;
const REJECTED = { success: false, error: 'Team lifecycle request was rejected' } as const;

export type TeamLifecycleCreateRequest = Readonly<{
  teamId: string;
  runId: string;
  idempotencyKey: string;
  workflowPlan: WorkflowPlan;
  sourceIdentity: string;
  templateRevision: number;
}>;

type TeamRun = Readonly<{
  state: 'available';
  teamId: string;
  runId: string;
  teamRevision: number;
  graphStatus: 'pending' | 'ready' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
}> | Readonly<{ state: 'unavailable' | 'outcome_unknown' }>;

type ResumeRun = Readonly<{
  runId: string;
  state: 'active' | 'cancelled' | 'outcome_unknown' | 'tombstoned';
}>;

type LifecycleResponse = Readonly<{
  status: 200 | 409 | 503;
  body:
    | Readonly<{ success: true; action: 'list'; runs: readonly TeamRun[] }>
    | Readonly<{ success: true; action: 'create'; runId: string; outcome: 'created' | 'replayed' }>
    | Readonly<{ success: true; action: 'delete'; teamId: string; outcome: 'deleted' | 'outcome_unknown' }>
    | Readonly<{ success: true; action: 'delete'; runId: string; state: 'tombstoned' | 'cancellation_required' | 'outcome_unknown' }>
    | Readonly<{ success: true; action: 'resume'; runs: readonly ResumeRun[] }>
    | Readonly<{
      success: true;
      action: 'cancel';
      runId: string;
      state: 'cancelling' | 'cancelled' | 'outcome_unknown' | 'tombstoned';
    }>
    | typeof REJECTED
    | typeof UNAVAILABLE;
}>;

export interface TeamLifecycleTransport {
  list(request: Readonly<{ teamId: string }>): Promise<LifecycleResponse>;
  create(request: TeamLifecycleCreateRequest): Promise<LifecycleResponse>;
  delete(request: Readonly<{ teamId: string; idempotencyKey: string }> | Readonly<{ runId: string; idempotencyKey: string }>): Promise<LifecycleResponse>;
  resume(request: Readonly<{ teamId: string; idempotencyKey: string }>): Promise<LifecycleResponse>;
  cancel(request: Readonly<{ runId: string; idempotencyKey: string }>): Promise<LifecycleResponse>;
}

export function createTeamLifecycleTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): TeamLifecycleTransport {
  const url = `http://127.0.0.1:${port}/api/team/lifecycle`;
  return {
    list: (request) => send(url, issuer, fetcher, 'team.lifecycle.list', { action: 'list', ...request }),
    create: (request) => send(url, issuer, fetcher, 'team.lifecycle.create', { action: 'create', ...request }, 'create'),
    delete: (request) => send(url, issuer, fetcher, 'team.lifecycle.delete', { action: 'delete', ...request }),
    resume: (request) => send(url, issuer, fetcher, 'team.lifecycle.resume', { action: 'resume', ...request }),
    cancel: (request) => send(url, issuer, fetcher, 'team.lifecycle.cancel', { action: 'cancel', ...request }),
  };
}

async function send(
  url: string,
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  capability: 'team.lifecycle.list' | 'team.lifecycle.create' | 'team.lifecycle.delete' | 'team.lifecycle.resume' | 'team.lifecycle.cancel',
  body: Record<string, unknown>,
  expectedAction?: 'create',
): Promise<LifecycleResponse> {
  if (!isRequest(body)) return { status: 503, body: UNAVAILABLE };
  try {
    const response = await fetcher(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${issuer.signDecision({
          principal: 'electron-main-local',
          endpoint: '/api/team/lifecycle',
          scope: 'team:write',
          capability,
          subject: 'team-lifecycle',
          expiresAt: Date.now() + DECISION_TTL_MS,
          revision: '1',
        })}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json();
    if (response.status === 200 && isSuccess(result) && (expectedAction === undefined || result.action === expectedAction)) {
      return { status: 200, body: result };
    }
    if (response.status === 409 && isRejected(result)) return { status: 409, body: result };
  } catch {
    // Native transport details do not cross the Electron delivery boundary.
  }
  return { status: 503, body: UNAVAILABLE };
}

function isRequest(value: Record<string, unknown>): boolean {
  if (value.action === 'list') {
    return hasExactKeys(value, ['action', 'teamId']) && isIdentifier(value.teamId);
  }
  if (value.action === 'resume') {
    return hasExactKeys(value, ['action', 'teamId', 'idempotencyKey'])
      && isIdentifier(value.teamId)
      && isOpaque(value.idempotencyKey);
  }
  if (value.action === 'create') {
    return hasExactKeys(value, [
      'action', 'teamId', 'runId', 'idempotencyKey', 'workflowPlan', 'sourceIdentity', 'templateRevision',
    ])
      && isIdentifier(value.teamId)
      && isIdentifier(value.runId)
      && isOpaque(value.idempotencyKey)
      && isWorkflowPlan(value.workflowPlan)
      && isIdentifier(value.sourceIdentity)
      && Number.isSafeInteger(value.templateRevision)
      && value.templateRevision >= 0;
  }
  if (value.action === 'delete') {
    const isTeamDelete = hasExactKeys(value, ['action', 'teamId', 'idempotencyKey'])
      && isIdentifier(value.teamId)
      && isOpaque(value.idempotencyKey);
    const isRunDelete = hasExactKeys(value, ['action', 'runId', 'idempotencyKey'])
      && isIdentifier(value.runId)
      && isOpaque(value.idempotencyKey);
    return isTeamDelete || isRunDelete;
  }
  return value.action === 'cancel'
    && hasExactKeys(value, ['action', 'runId', 'idempotencyKey'])
    && isIdentifier(value.runId)
    && isOpaque(value.idempotencyKey);
}

function isWorkflowPlan(value: unknown): value is WorkflowPlan {
  if (!isRecord(value) || !hasExactKeys(value, ['workflowPlanId', 'runId', 'title', 'status', 'groups', 'tasks', 'idempotencyKey', 'createdAt'])) return false;
  return isIdentifier(value.workflowPlanId) && isIdentifier(value.runId) && isIdentifier(value.title)
    && isIdentifier(value.status) && isOpaque(value.idempotencyKey) && Number.isSafeInteger(value.createdAt)
    && value.createdAt >= 0 && Array.isArray(value.groups) && value.groups.every(isWorkflowGroup)
    && Array.isArray(value.tasks) && value.tasks.every(isWorkflowTask);
}
function isWorkflowGroup(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['groupId', 'title', 'taskIds', 'join'])) return false;
  const join = value.join;
  return isIdentifier(value.groupId) && isIdentifier(value.title) && Array.isArray(value.taskIds)
    && value.taskIds.every(isIdentifier) && isRecord(join)
    && hasExactKeys(join, ['requireCompleted', 'allowFailed', 'retryLimit'])
    && typeof join.requireCompleted === 'boolean' && typeof join.allowFailed === 'boolean'
    && Number.isSafeInteger(join.retryLimit) && join.retryLimit >= 0;
}
function isWorkflowTask(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['taskId', 'roleId', 'title', 'prompt', 'dependsOnTaskIds', 'outputArtifactKind'])) return false;
  return isIdentifier(value.taskId) && isIdentifier(value.roleId) && isIdentifier(value.title)
    && isIdentifier(value.prompt) && Array.isArray(value.dependsOnTaskIds) && value.dependsOnTaskIds.every(isIdentifier)
    && (value.outputArtifactKind === null || isIdentifier(value.outputArtifactKind));
}

function isSuccess(value: unknown): value is Extract<LifecycleResponse['body'], { success: true }> {
  return isRecord(value) && value.success === true && (
    (hasExactKeys(value, ['success', 'action', 'runs'])
      && value.action === 'list'
      && Array.isArray(value.runs)
      && value.runs.every(isTeamRun))
    || (hasExactKeys(value, ['success', 'action', 'runId', 'outcome'])
      && value.action === 'create'
      && isIdentifier(value.runId)
      && (value.outcome === 'created' || value.outcome === 'replayed'))
    || (hasExactKeys(value, ['success', 'action', 'teamId', 'outcome'])
      && value.action === 'delete'
      && isIdentifier(value.teamId)
      && (value.outcome === 'deleted' || value.outcome === 'outcome_unknown'))
    || (hasExactKeys(value, ['success', 'action', 'runs'])
      && value.action === 'resume'
      && Array.isArray(value.runs)
      && value.runs.every(isResumeRun))
    || (hasExactKeys(value, ['success', 'action', 'runId', 'state'])
      && value.action === 'cancel'
      && isIdentifier(value.runId)
      && isCancellationState(value.state))
    || (hasExactKeys(value, ['success', 'action', 'runId', 'state'])
      && value.action === 'delete'
      && isIdentifier(value.runId)
      && isTombstoneState(value.state))
  );
}

function isTeamRun(value: unknown): value is TeamRun {
  return isRecord(value) && (
    (hasExactKeys(value, ['state']) && (value.state === 'unavailable' || value.state === 'outcome_unknown'))
    || (hasExactKeys(value, ['state', 'teamId', 'runId', 'teamRevision', 'graphStatus'])
      && value.state === 'available'
      && isIdentifier(value.teamId)
      && isIdentifier(value.runId)
      && Number.isInteger(value.teamRevision)
      && value.teamRevision > 0
      && isGraphStatus(value.graphStatus))
  );
}

function isResumeRun(value: unknown): value is ResumeRun {
  return isRecord(value)
    && hasExactKeys(value, ['runId', 'state'])
    && isIdentifier(value.runId)
    && (value.state === 'active' || value.state === 'cancelled' || value.state === 'outcome_unknown' || value.state === 'tombstoned');
}

function isCancellationState(value: unknown): boolean {
  return value === 'cancelling' || value === 'cancelled' || value === 'outcome_unknown' || value === 'tombstoned';
}

function isTombstoneState(value: unknown): boolean {
  return value === 'tombstoned' || value === 'cancellation_required' || value === 'outcome_unknown';
}

function isGraphStatus(value: unknown): boolean {
  return value === 'pending' || value === 'ready' || value === 'running' || value === 'waiting'
    || value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isRejected(value: unknown): value is typeof REJECTED {
  return isRecord(value) && hasExactKeys(value, ['success', 'error']) && value.success === false && value.error === REJECTED.error;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}

function isOpaque(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
