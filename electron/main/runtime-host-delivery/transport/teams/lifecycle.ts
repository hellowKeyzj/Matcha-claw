import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, isSafeNonNegativeInteger, sendLoopbackJson } from '../client';

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

const ENDPOINT = '/api/team/lifecycle';
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
  status: 200 | 202 | 409 | 503;
  body:
    | CallReceipt
    | Readonly<{ success: true; action: 'list'; runs: readonly TeamRun[] }>
    | Readonly<{ success: true; action: 'create'; runId: string; outcome: 'created' | 'replayed' }>
    | Readonly<{ success: true; action: 'delete'; teamId: string; outcome: 'deleted' }>
    | Readonly<{ success: true; action: 'resume'; runs: readonly ResumeRun[] }>
    | Readonly<{
      success: true;
      action: 'cancel';
      runId: string;
      state: 'cancelling' | 'cancelled' | 'tombstoned';
    }>
    | Readonly<{ success: false; error: 'Team lifecycle outcome is unknown' }>
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
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamLifecycleTransport {
  return {
    list: (request) => send(runtimeHostTransportPort, issuer, fetcher, 'team.lifecycle.list', { action: 'list', ...request }),
    create: (request) => send(runtimeHostTransportPort, issuer, fetcher, 'team.lifecycle.create', { action: 'create', ...request }, 'create'),
    delete: (request) => send(runtimeHostTransportPort, issuer, fetcher, 'team.lifecycle.delete', { action: 'delete', ...request }),
    resume: (request) => send(runtimeHostTransportPort, issuer, fetcher, 'team.lifecycle.resume', { action: 'resume', ...request }),
    cancel: (request) => send(runtimeHostTransportPort, issuer, fetcher, 'team.lifecycle.cancel', { action: 'cancel', ...request }),
  };
}

async function send(
  runtimeHostTransportPort: number,
  issuer: RuntimeHostDeliveryIssuer,
  fetcher: typeof fetch,
  capability: 'team.lifecycle.list' | 'team.lifecycle.create' | 'team.lifecycle.delete' | 'team.lifecycle.resume' | 'team.lifecycle.cancel',
  body: Record<string, unknown>,
  expectedAction?: 'create',
): Promise<LifecycleResponse> {
  if (!isRequest(body)) return { status: 503, body: UNAVAILABLE };
  const response = await sendLoopbackJson({
    port: runtimeHostTransportPort,
    path: ENDPOINT,
    issuer,
    decision: {
      endpoint: ENDPOINT,
      scope: 'team:write',
      capability,
      subject: 'team-lifecycle',
    },
    method: 'POST',
    fetcher,
    body,
  });
  if (response === null) return { status: 503, body: UNAVAILABLE };
  const result = response.body;
  if (body.action === 'delete' && typeof body.runId === 'string') {
    if (response.status === 202) {
      try { return { status: 202, body: decodeCallReceipt(result) }; } catch { return { status: 503, body: UNAVAILABLE }; }
    }
    return { status: 503, body: UNAVAILABLE };
  }
  if (response.status === 200 && isSuccess(result) && (expectedAction === undefined || result.action === expectedAction)) {
    return { status: 200, body: result };
  }
  if (response.status === 409 && (isUnknown(result) || isRejected(result))) return { status: 409, body: result };
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
      && isSafeNonNegativeInteger(value.templateRevision);
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
    && isIdentifier(value.status) && isOpaque(value.idempotencyKey) && isSafeNonNegativeInteger(value.createdAt)
    && Array.isArray(value.groups) && value.groups.every(isWorkflowGroup)
    && Array.isArray(value.tasks) && value.tasks.every(isWorkflowTask);
}
function isWorkflowGroup(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['groupId', 'title', 'taskIds', 'join'])) return false;
  const join = value.join;
  return isIdentifier(value.groupId) && isIdentifier(value.title) && Array.isArray(value.taskIds)
    && value.taskIds.every(isIdentifier) && isRecord(join)
    && hasExactKeys(join, ['requireCompleted', 'allowFailed', 'retryLimit'])
    && typeof join.requireCompleted === 'boolean' && typeof join.allowFailed === 'boolean'
    && isSafeNonNegativeInteger(join.retryLimit);
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
      && value.outcome === 'deleted')
    || (hasExactKeys(value, ['success', 'action', 'runs'])
      && value.action === 'resume'
      && Array.isArray(value.runs)
      && value.runs.every(isResumeRun))
    || (hasExactKeys(value, ['success', 'action', 'runId', 'state'])
      && value.action === 'cancel'
      && isIdentifier(value.runId)
      && isCancellationState(value.state))
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
  return value === 'cancelling' || value === 'cancelled' || value === 'tombstoned';
}

function isGraphStatus(value: unknown): boolean {
  return value === 'pending' || value === 'ready' || value === 'running' || value === 'waiting'
    || value === 'completed' || value === 'failed' || value === 'cancelled';
}

function isUnknown(value: unknown): value is Readonly<{ success: false; error: 'Team lifecycle outcome is unknown' }> {
  return isRecord(value)
    && hasExactKeys(value, ['success', 'error'])
    && value.success === false
    && value.error === 'Team lifecycle outcome is unknown';
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
