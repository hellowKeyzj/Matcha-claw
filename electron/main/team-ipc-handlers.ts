import { ipcMain } from 'electron';
import { join } from 'node:path';
import { getOpenClawConfigDir } from '../utils/paths';
import { logger } from '../utils/logger';
import {
  TeamRuntimeApplicationService,
  type TeamRuntimeStoragePort,
  type TeamTaskStatus,
} from '../core/application';
import { mailboxPost, mailboxPull } from '../adapters/platform/team-runtime/mailbox-store';
import {
  appendTeamEvent,
  buildTeamSnapshot,
  clearTeamRuntime,
  initTeamRun,
  readTeamRun,
} from '../adapters/platform/team-runtime/runtime-store';
import {
  claimNextTask,
  heartbeatTaskClaim,
  listTasks,
  releaseTaskClaim,
  upsertPlanTasks,
  updateTaskStatus,
} from '../adapters/platform/team-runtime/task-store';

function normalizeRequired(value: unknown, field: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    throw new Error(`${field} is required`);
  }
  return normalized;
}

function normalizeLeaseMs(value: unknown): number | undefined {
  if (value == null) return undefined;
  const lease = Number(value);
  if (!Number.isFinite(lease) || lease <= 0) {
    throw new Error('leaseMs must be a positive number');
  }
  return lease;
}

function normalizeMailboxLimit(value: unknown): number | undefined {
  if (value == null) return undefined;
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('mailboxLimit must be a positive number');
  }
  return Math.floor(limit);
}

function normalizeTaskStatus(value: unknown): TeamTaskStatus {
  const status = String(value ?? '').trim() as TeamTaskStatus;
  const allowed: TeamTaskStatus[] = ['todo', 'claimed', 'running', 'blocked', 'done', 'failed'];
  if (!allowed.includes(status)) {
    throw new Error('status is invalid');
  }
  return status;
}

function resolveRuntimeRoot(teamId: string): string {
  return join(getOpenClawConfigDir(), 'team-runtime', teamId);
}

const teamRuntimeStorage: TeamRuntimeStoragePort = {
  initRun: initTeamRun,
  readRun: readTeamRun,
  appendEvent: appendTeamEvent,
  buildSnapshot: buildTeamSnapshot,
  upsertPlanTasks,
  claimNextTask,
  heartbeatTaskClaim,
  updateTaskStatus,
  mailboxPost,
  mailboxPull,
  releaseTaskClaim,
  clearRuntime: clearTeamRuntime,
  listTasks,
};

const teamRuntimeService = new TeamRuntimeApplicationService(teamRuntimeStorage, resolveRuntimeRoot);

export function registerTeamIpcHandlers(): void {
  ipcMain.handle('team:init', async (_, input: { teamId: string; leadAgentId: string }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    const leadAgentId = normalizeRequired(input?.leadAgentId, 'leadAgentId');
    return teamRuntimeService.init({ teamId, leadAgentId });
  });

  ipcMain.handle('team:snapshot', async (_, input: {
    teamId: string;
    mailboxCursor?: string;
    mailboxLimit?: number;
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    return teamRuntimeService.snapshot({
      teamId,
      mailboxCursor: input?.mailboxCursor,
      mailboxLimit: normalizeMailboxLimit(input?.mailboxLimit),
    });
  });

  ipcMain.handle('team:planUpsert', async (_, input: {
    teamId: string;
    tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    if (!Array.isArray(input?.tasks)) {
      throw new Error('tasks must be an array');
    }
    return teamRuntimeService.planUpsert({
      teamId,
      tasks: input.tasks,
    });
  });

  ipcMain.handle('team:claimNext', async (_, input: {
    teamId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    const agentId = normalizeRequired(input?.agentId, 'agentId');
    const sessionKey = normalizeRequired(input?.sessionKey, 'sessionKey');
    return teamRuntimeService.claimNext({
      teamId,
      agentId,
      sessionKey,
      leaseMs: normalizeLeaseMs(input?.leaseMs),
    });
  });

  ipcMain.handle('team:heartbeat', async (_, input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    const taskId = normalizeRequired(input?.taskId, 'taskId');
    const agentId = normalizeRequired(input?.agentId, 'agentId');
    const sessionKey = normalizeRequired(input?.sessionKey, 'sessionKey');
    return teamRuntimeService.heartbeat({
      teamId,
      taskId,
      agentId,
      sessionKey,
      leaseMs: normalizeLeaseMs(input?.leaseMs),
    });
  });

  ipcMain.handle('team:taskUpdate', async (_, input: {
    teamId: string;
    taskId: string;
    status: TeamTaskStatus;
    resultSummary?: string;
    error?: string;
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    const taskId = normalizeRequired(input?.taskId, 'taskId');
    return teamRuntimeService.taskUpdate({
      teamId,
      taskId,
      status: normalizeTaskStatus(input?.status),
      resultSummary: input?.resultSummary,
      error: input?.error,
    });
  });

  ipcMain.handle('team:mailboxPost', async (_, input: {
    teamId: string;
    message: {
      msgId: string;
      fromAgentId: string;
      to?: 'broadcast' | string;
      kind?: 'question' | 'proposal' | 'decision' | 'report';
      content: string;
      relatedTaskId?: string;
      replyToMsgId?: string;
      createdAt?: number;
    };
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    const message = input?.message;
    if (!message || typeof message !== 'object') {
      throw new Error('message is required');
    }
    normalizeRequired(message.msgId, 'message.msgId');
    normalizeRequired(message.fromAgentId, 'message.fromAgentId');
    normalizeRequired(message.content, 'message.content');
    return teamRuntimeService.mailboxPost({
      teamId,
      message,
    });
  });

  ipcMain.handle('team:mailboxPull', async (_, input: {
    teamId: string;
    cursor?: string;
    limit?: number;
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    return teamRuntimeService.mailboxPull({
      teamId,
      cursor: input?.cursor,
      limit: normalizeMailboxLimit(input?.limit),
    });
  });

  ipcMain.handle('team:releaseClaim', async (_, input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
  }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    const taskId = normalizeRequired(input?.taskId, 'taskId');
    const agentId = normalizeRequired(input?.agentId, 'agentId');
    const sessionKey = normalizeRequired(input?.sessionKey, 'sessionKey');
    return teamRuntimeService.releaseClaim({
      teamId,
      taskId,
      agentId,
      sessionKey,
    });
  });

  ipcMain.handle('team:reset', async (_, input: { teamId: string }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    const result = await teamRuntimeService.reset({ teamId });
    logger.info(`Team runtime reset: ${teamId}`);
    return result;
  });

  ipcMain.handle('team:listTasks', async (_, input: { teamId: string }) => {
    const teamId = normalizeRequired(input?.teamId, 'teamId');
    return teamRuntimeService.listTasks({ teamId });
  });

  logger.info('Team runtime IPC handlers registered');
}
