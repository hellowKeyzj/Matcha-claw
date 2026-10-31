import type {
  TeamLifecycleCreateRequest,
  TeamLifecycleTransport,
  WorkflowPlan,
} from '../../main/runtime-host-delivery/transport/teams/lifecycle';
import { jsonResult, type HostApiRequest, type HostApiRouteResult } from '../execution';

const INVALID = {
  success: false,
  error: 'Team lifecycle request is invalid',
} as const;
const UNAVAILABLE = {
  success: false,
  error: 'Team lifecycle is unavailable',
} as const;

type TeamLifecycleRequest =
  | Readonly<{ action: 'list'; teamId: string }>
  | Readonly<{ action: 'create' } & TeamLifecycleCreateRequest>
  | Readonly<{ action: 'delete'; teamId: string; idempotencyKey: string }>
  | Readonly<{ action: 'delete'; runId: string; idempotencyKey: string }>
  | Readonly<{ action: 'resume'; teamId: string; idempotencyKey: string }>
  | Readonly<{ action: 'cancel'; runId: string; idempotencyKey: string }>;

type LifecycleResponse = Awaited<ReturnType<TeamLifecycleTransport['list']>>;

export async function handleTeamLifecycleRoutes(
  req: HostApiRequest,
  url: URL,
  transport: TeamLifecycleTransport,
): Promise<HostApiRouteResult> {
  if (url.pathname !== '/api/team/lifecycle' || req.method !== 'POST') return undefined;

  let request: unknown;
  try {
    request = await req.readJson<unknown>();
  } catch {
    return jsonResult(400, INVALID);
  }
  if (!isRequest(request)) {
    return jsonResult(400, INVALID);
  }

  try {
    const response = await dispatch(request, transport);
    return jsonResult(response.status, response.body);
  } catch {
    return jsonResult(503, UNAVAILABLE);
  }
}

function dispatch(request: TeamLifecycleRequest, transport: TeamLifecycleTransport): Promise<LifecycleResponse> {
  switch (request.action) {
    case 'list': {
      const { action: _action, ...input } = request;
      return transport.list(input);
    }
    case 'create': {
      const { action: _action, ...input } = request;
      return transport.create(input);
    }
    case 'delete': {
      const { action: _action, ...input } = request;
      return transport.delete(input);
    }
    case 'resume': {
      const { action: _action, ...input } = request;
      return transport.resume(input);
    }
    case 'cancel': {
      const { action: _action, ...input } = request;
      return transport.cancel(input);
    }
  }
}

function isRequest(value: unknown): value is TeamLifecycleRequest {
  if (!isRecord(value)) return false;
  if (value.action === 'list') {
    return hasExactKeys(value, ['action', 'teamId']) && isIdentifier(value.teamId);
  }
  if (value.action === 'resume') {
    return hasExactKeys(value, ['action', 'teamId', 'idempotencyKey'])
      && isIdentifier(value.teamId)
      && isOpaqueId(value.idempotencyKey);
  }
  if (value.action === 'create') {
    return hasExactKeys(value, [
      'action', 'teamId', 'runId', 'idempotencyKey', 'workflowPlan', 'sourceIdentity', 'templateRevision',
    ])
      && isIdentifier(value.teamId)
      && isIdentifier(value.runId)
      && isOpaqueId(value.idempotencyKey)
      && isWorkflowPlan(value.workflowPlan)
      && isIdentifier(value.sourceIdentity)
      && isUint(value.templateRevision);
  }
  if (value.action === 'delete') {
    const isTeamDelete = hasExactKeys(value, ['action', 'teamId', 'idempotencyKey'])
      && isIdentifier(value.teamId)
      && isOpaqueId(value.idempotencyKey);
    const isRunDelete = hasExactKeys(value, ['action', 'runId', 'idempotencyKey'])
      && isIdentifier(value.runId)
      && isOpaqueId(value.idempotencyKey);
    return isTeamDelete || isRunDelete;
  }
  return value.action === 'cancel'
    && hasExactKeys(value, ['action', 'runId', 'idempotencyKey'])
    && isIdentifier(value.runId)
    && isOpaqueId(value.idempotencyKey);
}

function isWorkflowPlan(value: unknown): value is WorkflowPlan {
  if (!isRecord(value) || !hasExactKeys(value, [
    'workflowPlanId', 'runId', 'title', 'status', 'tasks', 'idempotencyKey', 'createdAt',
  ])) return false;
  return isIdentifier(value.workflowPlanId)
    && isIdentifier(value.runId)
    && isIdentifier(value.title)
    && isIdentifier(value.status)
    && isOpaqueId(value.idempotencyKey)
    && isUint(value.createdAt)
    && Array.isArray(value.tasks)
    && value.tasks.every(isWorkflowTask);
}

function isWorkflowTask(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, [
    'taskId', 'roleId', 'title', 'prompt', 'dependsOnTaskIds', 'outputArtifactKind',
  ])) return false;
  return isIdentifier(value.taskId)
    && isIdentifier(value.roleId)
    && isIdentifier(value.title)
    && isIdentifier(value.prompt)
    && Array.isArray(value.dependsOnTaskIds)
    && value.dependsOnTaskIds.every(isIdentifier)
    && (value.outputArtifactKind === null || isIdentifier(value.outputArtifactKind));
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isUint(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
