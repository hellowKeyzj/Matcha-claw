import type { RuntimeAddress } from '../../../shared/runtime-address';
import type { TeamRuntimeApplicationService } from '../../team-runtime/team-runtime-application-service';
import type { TeamMailboxKind, TeamTaskStatus } from '../../team-runtime/types';

export interface TeamRuntimeOperationsWorkflowDeps {
  readonly app: TeamRuntimeApplicationService;
}

export class TeamRuntimeOperationsWorkflow {
  constructor(private readonly deps: TeamRuntimeOperationsWorkflowDeps) {}

  async init(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.init({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      leadAgentId: assertRequiredString(body.leadAgentId, 'leadAgentId'),
      runtimeAddress: assertRuntimeAddress(body.runtimeAddress),
    });
  }

  async snapshot(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.snapshot({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      mailboxCursor: typeof body.mailboxCursor === 'string' ? body.mailboxCursor : undefined,
      mailboxLimit: normalizePositiveNumber(body.mailboxLimit, 'mailboxLimit'),
    });
  }

  async planUpsert(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    const tasks = Array.isArray(body.tasks) ? body.tasks : null;
    if (!tasks) {
      throw new Error('tasks must be an array');
    }
    return await this.deps.app.planUpsert({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      tasks,
    });
  }

  async claimNext(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.claimNext({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      agentId: assertRequiredString(body.agentId, 'agentId'),
      sessionKey: assertRequiredString(body.sessionKey, 'sessionKey'),
      leaseMs: normalizePositiveNumber(body.leaseMs, 'leaseMs'),
    });
  }

  async heartbeat(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.heartbeat({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      taskId: assertRequiredString(body.taskId, 'taskId'),
      agentId: assertRequiredString(body.agentId, 'agentId'),
      sessionKey: assertRequiredString(body.sessionKey, 'sessionKey'),
      leaseMs: normalizePositiveNumber(body.leaseMs, 'leaseMs'),
    });
  }

  async taskUpdate(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.taskUpdate({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      taskId: assertRequiredString(body.taskId, 'taskId'),
      status: normalizeTaskStatus(body.status),
      resultSummary: typeof body.resultSummary === 'string' ? body.resultSummary : undefined,
      error: typeof body.error === 'string' ? body.error : undefined,
    });
  }

  async mailboxPost(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.mailboxPost({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      message: normalizeMailboxMessagePayload(body.message),
    });
  }

  async mailboxPull(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.mailboxPull({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
      limit: normalizePositiveNumber(body.limit, 'limit'),
    });
  }

  async releaseClaim(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.releaseClaim({
      teamId: assertRequiredString(body.teamId, 'teamId'),
      taskId: assertRequiredString(body.taskId, 'taskId'),
      agentId: assertRequiredString(body.agentId, 'agentId'),
      sessionKey: assertRequiredString(body.sessionKey, 'sessionKey'),
    });
  }

  async reset(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.reset({
      teamId: assertRequiredString(body.teamId, 'teamId'),
    });
  }

  async listTasks(payload: unknown) {
    const body = isRecord(payload) ? payload : {};
    return await this.deps.app.listTasks({
      teamId: assertRequiredString(body.teamId, 'teamId'),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertRequiredString(value: unknown, fieldName: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}

function assertRuntimeAddress(value: unknown): RuntimeAddress {
  if (!isRecord(value)) {
    throw new Error('runtimeAddress is required');
  }
  return value as unknown as RuntimeAddress;
}

function normalizePositiveNumber(value: unknown, fieldName: string) {
  if (value == null) {
    return undefined;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return Math.floor(numeric);
}

function normalizeTaskStatus(value: unknown): TeamTaskStatus {
  const status = typeof value === 'string' ? value.trim() : '';
  if (
    status !== 'todo'
    && status !== 'claimed'
    && status !== 'running'
    && status !== 'blocked'
    && status !== 'done'
    && status !== 'failed'
  ) {
    throw new Error('status is invalid');
  }
  return status;
}

function normalizeMailboxKind(value: unknown): TeamMailboxKind | undefined {
  const kind = typeof value === 'string' ? value.trim() : '';
  if (
    kind === 'question'
    || kind === 'proposal'
    || kind === 'decision'
    || kind === 'report'
  ) {
    return kind;
  }
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeMailboxMessagePayload(value: unknown) {
  if (!isRecord(value)) {
    throw new Error('message is required');
  }

  return {
    msgId: assertRequiredString(value.msgId, 'message.msgId'),
    fromAgentId: assertRequiredString(value.fromAgentId, 'message.fromAgentId'),
    content: assertRequiredString(value.content, 'message.content'),
    to: normalizeOptionalString(value.to),
    kind: normalizeMailboxKind(value.kind),
    relatedTaskId: normalizeOptionalString(value.relatedTaskId),
    replyToMsgId: normalizeOptionalString(value.replyToMsgId),
    createdAt: normalizePositiveNumber(value.createdAt, 'message.createdAt'),
  };
}
