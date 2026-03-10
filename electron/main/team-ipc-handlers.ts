import { ipcMain } from 'electron';
import { join } from 'node:path';
import { getOpenClawConfigDir } from '../utils/paths';
import { logger } from '../utils/logger';
import { mailboxPost, mailboxPull } from './team-runtime/mailbox-store';
import {
  appendTeamEvent,
  buildTeamSnapshot,
  clearTeamRuntime,
  initTeamRun,
  readTeamRun,
} from './team-runtime/runtime-store';
import {
  claimNextTask,
  heartbeatTaskClaim,
  listTasks,
  releaseTaskClaim,
  upsertPlanTasks,
  updateTaskStatus,
} from './team-runtime/task-store';

function resolveRuntimeRoot(teamId: string): string {
  const normalized = String(teamId ?? '').trim();
  if (!normalized) {
    throw new Error('teamId is required');
  }
  return join(getOpenClawConfigDir(), 'team-runtime', normalized);
}

export function registerTeamIpcHandlers(): void {
  ipcMain.handle('team:init', async (_, input: { teamId: string; leadAgentId: string }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const run = await initTeamRun({
      runtimeRoot,
      teamId: input.teamId,
      leadAgentId: input.leadAgentId,
    });
    await appendTeamEvent({
      runtimeRoot,
      teamId: run.teamId,
      type: 'team:init',
      payload: { leadAgentId: run.leadAgentId },
    });
    return {
      runtimeRoot,
      run,
    };
  });

  ipcMain.handle('team:snapshot', async (_, input: {
    teamId: string;
    mailboxCursor?: string;
    mailboxLimit?: number;
  }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    return buildTeamSnapshot({
      runtimeRoot,
      mailboxCursor: input.mailboxCursor,
      mailboxLimit: input.mailboxLimit,
    });
  });

  ipcMain.handle('team:planUpsert', async (_, input: {
    teamId: string;
    tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
  }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const run = await readTeamRun(runtimeRoot);
    if (!run) {
      throw new Error(`Team run not initialized: ${input.teamId}`);
    }
    const tasks = await upsertPlanTasks({
      runtimeRoot,
      tasks: input.tasks,
    });
    await appendTeamEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:planUpsert',
      payload: { taskCount: tasks.length },
    });
    return { tasks };
  });

  ipcMain.handle('team:claimNext', async (_, input: {
    teamId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const task = await claimNextTask({
      runtimeRoot,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      leaseMs: input.leaseMs ?? 60_000,
    });
    await appendTeamEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:claimNext',
      payload: {
        agentId: input.agentId,
        taskId: task?.taskId ?? null,
      },
    });
    return { task };
  });

  ipcMain.handle('team:heartbeat', async (_, input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const result = await heartbeatTaskClaim({
      runtimeRoot,
      taskId: input.taskId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      leaseMs: input.leaseMs ?? 60_000,
    });
    if (result.ok) {
      await appendTeamEvent({
        runtimeRoot,
        teamId: input.teamId,
        type: 'team:heartbeat',
        payload: {
          taskId: input.taskId,
          agentId: input.agentId,
          leaseUntil: result.task?.leaseUntil ?? null,
        },
      });
    }
    return result;
  });

  ipcMain.handle('team:taskUpdate', async (_, input: {
    teamId: string;
    taskId: string;
    status: 'todo' | 'claimed' | 'running' | 'blocked' | 'done' | 'failed';
    resultSummary?: string;
    error?: string;
  }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const task = await updateTaskStatus({
      runtimeRoot,
      taskId: input.taskId,
      nextStatus: input.status,
      resultSummary: input.resultSummary,
      error: input.error,
    });
    await appendTeamEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:taskUpdate',
      payload: {
        taskId: input.taskId,
        status: input.status,
      },
    });
    return { task };
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
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const result = await mailboxPost({
      runtimeRoot,
      message: input.message,
    });
    await appendTeamEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:mailboxPost',
      payload: {
        msgId: result.message.msgId,
        fromAgentId: result.message.fromAgentId,
        kind: result.message.kind,
      },
    });
    return result;
  });

  ipcMain.handle('team:mailboxPull', async (_, input: {
    teamId: string;
    cursor?: string;
    limit?: number;
  }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    return mailboxPull({
      runtimeRoot,
      cursor: input.cursor,
      limit: input.limit,
    });
  });

  ipcMain.handle('team:releaseClaim', async (_, input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
  }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const result = await releaseTaskClaim({
      runtimeRoot,
      taskId: input.taskId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
    });
    await appendTeamEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:releaseClaim',
      payload: {
        taskId: input.taskId,
        agentId: input.agentId,
        ok: result.ok,
      },
    });
    return result;
  });

  ipcMain.handle('team:reset', async (_, input: { teamId: string }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    await clearTeamRuntime(runtimeRoot);
    logger.info(`Team runtime reset: ${input.teamId}`);
    return { ok: true };
  });

  ipcMain.handle('team:listTasks', async (_, input: { teamId: string }) => {
    const runtimeRoot = resolveRuntimeRoot(input.teamId);
    const tasks = await listTasks(runtimeRoot);
    return { tasks };
  });

  logger.info('Team runtime IPC handlers registered');
}
