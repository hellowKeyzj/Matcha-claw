import { join } from 'node:path';
import { TeamRuntimeApplicationService } from './team-runtime-application-service';
import * as runtimeStore from './runtime-store';
import * as taskStore from './task-store';
import * as mailboxStore from './mailbox-store';
import type { TeamMailboxKind, TeamTaskStatus } from './types';

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

export function createTeamRuntimeService(resolveRuntimeRoot: (teamId: string) => string) {
  const app = new TeamRuntimeApplicationService({
    initRun: runtimeStore.initTeamRun,
    readRun: runtimeStore.readTeamRun,
    appendEvent: runtimeStore.appendTeamEvent,
    buildSnapshot: runtimeStore.buildTeamSnapshot,
    upsertPlanTasks: taskStore.upsertPlanTasks,
    claimNextTask: taskStore.claimNextTask,
    heartbeatTaskClaim: taskStore.heartbeatTaskClaim,
    updateTaskStatus: taskStore.updateTaskStatus,
    mailboxPost: mailboxStore.mailboxPost,
    mailboxPull: mailboxStore.mailboxPull,
    releaseTaskClaim: taskStore.releaseTaskClaim,
    clearRuntime: runtimeStore.clearTeamRuntime,
    listTasks: taskStore.listTasks,
  }, resolveRuntimeRoot);

  return {
    async init(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.init({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        leadAgentId: assertRequiredString(body.leadAgentId, 'leadAgentId'),
      });
    },

    async snapshot(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.snapshot({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        mailboxCursor: typeof body.mailboxCursor === 'string' ? body.mailboxCursor : undefined,
        mailboxLimit: normalizePositiveNumber(body.mailboxLimit, 'mailboxLimit'),
      });
    },

    async planUpsert(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      const tasks = Array.isArray(body.tasks) ? body.tasks : null;
      if (!tasks) {
        throw new Error('tasks must be an array');
      }
      return await app.planUpsert({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        tasks,
      });
    },

    async claimNext(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.claimNext({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        agentId: assertRequiredString(body.agentId, 'agentId'),
        sessionKey: assertRequiredString(body.sessionKey, 'sessionKey'),
        leaseMs: normalizePositiveNumber(body.leaseMs, 'leaseMs'),
      });
    },

    async heartbeat(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.heartbeat({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        taskId: assertRequiredString(body.taskId, 'taskId'),
        agentId: assertRequiredString(body.agentId, 'agentId'),
        sessionKey: assertRequiredString(body.sessionKey, 'sessionKey'),
        leaseMs: normalizePositiveNumber(body.leaseMs, 'leaseMs'),
      });
    },

    async taskUpdate(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.taskUpdate({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        taskId: assertRequiredString(body.taskId, 'taskId'),
        status: normalizeTaskStatus(body.status),
        resultSummary: typeof body.resultSummary === 'string' ? body.resultSummary : undefined,
        error: typeof body.error === 'string' ? body.error : undefined,
      });
    },

    async mailboxPost(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.mailboxPost({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        message: normalizeMailboxMessagePayload(body.message),
      });
    },

    async mailboxPull(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.mailboxPull({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        cursor: typeof body.cursor === 'string' ? body.cursor : undefined,
        limit: normalizePositiveNumber(body.limit, 'limit'),
      });
    },

    async releaseClaim(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.releaseClaim({
        teamId: assertRequiredString(body.teamId, 'teamId'),
        taskId: assertRequiredString(body.taskId, 'taskId'),
        agentId: assertRequiredString(body.agentId, 'agentId'),
        sessionKey: assertRequiredString(body.sessionKey, 'sessionKey'),
      });
    },

    async reset(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.reset({
        teamId: assertRequiredString(body.teamId, 'teamId'),
      });
    },

    async listTasks(payload: unknown) {
      const body = isRecord(payload) ? payload : {};
      return await app.listTasks({
        teamId: assertRequiredString(body.teamId, 'teamId'),
      });
    },
  };
}

export function createTeamRuntimeRootResolver(getOpenClawConfigDir: () => string) {
  return (teamId: string) => join(getOpenClawConfigDir(), 'team-runtime', teamId);
}
