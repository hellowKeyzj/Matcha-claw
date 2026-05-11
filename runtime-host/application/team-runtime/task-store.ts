import { join } from 'node:path';
import { claimTaskLock, heartbeatTaskLock, releaseTaskLock } from './claim-lock';
import { isTaskStatusTransitionAllowed, sanitizeTaskRecord } from './schema';
import { atomicWriteJson, readJsonFile, type TeamRuntimeStorageContext } from './storage-context';
import type { TeamTaskRecord, TeamTaskStatus } from './types';

function tasksDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'tasks');
}

function taskPath(runtimeRoot: string, taskId: string): string {
  return join(tasksDir(runtimeRoot), `${taskId}.json`);
}

export async function ensureTaskStore(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<void> {
  await context.fileSystem.ensureDirectory(tasksDir(runtimeRoot));
}

export async function readTask(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
  taskId: string,
): Promise<TeamTaskRecord | null> {
  return await readJsonFile<TeamTaskRecord>(context, taskPath(runtimeRoot, taskId));
}

export async function writeTask(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
  task: TeamTaskRecord,
): Promise<void> {
  await atomicWriteJson(context, taskPath(runtimeRoot, task.taskId), task);
}

export async function listTasks(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<TeamTaskRecord[]> {
  await ensureTaskStore(context, runtimeRoot);
  const entries = await context.fileSystem.listDirectory(tasksDir(runtimeRoot));
  const tasks: TeamTaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith('.json')) {
      continue;
    }
    const task = await readJsonFile<TeamTaskRecord>(context, join(tasksDir(runtimeRoot), entry.name));
    if (task) {
      tasks.push(task);
    } else {
      // Ignore malformed task files and continue loading remaining files.
    }
  }
  return tasks.sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
}

export async function upsertPlanTasks(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  tasks: Array<Partial<TeamTaskRecord> & { taskId: string; instruction: string }>;
  nowMs?: number;
}): Promise<TeamTaskRecord[]> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const existing = await listTasks(input.context, input.runtimeRoot);
  const existingById = new Map(existing.map((task) => [task.taskId, task]));
  const next: TeamTaskRecord[] = [];
  for (const row of input.tasks) {
    const prev = existingById.get(row.taskId);
    const normalized = sanitizeTaskRecord(
      {
        ...row,
        status: prev?.status ?? row.status ?? 'todo',
        ownerAgentId: prev?.ownerAgentId,
        claimSessionKey: prev?.claimSessionKey,
        claimedAt: prev?.claimedAt,
        leaseUntil: prev?.leaseUntil,
        attempt: prev?.attempt ?? 0,
        resultSummary: prev?.resultSummary,
        error: prev?.error,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      },
      now,
    );
    await writeTask(input.context, input.runtimeRoot, normalized);
    next.push(normalized);
  }
  return next.sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
}

function canClaimTask(task: TeamTaskRecord, doneSet: Set<string>): boolean {
  if (task.status !== 'todo') {
    return false;
  }
  if (task.dependsOn.length === 0) {
    return true;
  }
  return task.dependsOn.every((taskId) => doneSet.has(taskId));
}

export async function claimNextTask(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  agentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<TeamTaskRecord | null> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const tasks = await listTasks(input.context, input.runtimeRoot);
  const doneSet = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.taskId));

  for (const task of tasks) {
    if (!canClaimTask(task, doneSet)) {
      continue;
    }
    const claim = await claimTaskLock({
      context: input.context,
      runtimeRoot: input.runtimeRoot,
      taskId: task.taskId,
      ownerAgentId: input.agentId,
      sessionKey: input.sessionKey,
      leaseMs: input.leaseMs,
      nowMs: now,
    });
    if (!claim.ok) {
      continue;
    }
    const claimed: TeamTaskRecord = {
      ...task,
      status: 'claimed',
      ownerAgentId: input.agentId,
      claimSessionKey: input.sessionKey,
      claimedAt: now,
      leaseUntil: claim.lock.leaseUntil,
      updatedAt: now,
    };
    await writeTask(input.context, input.runtimeRoot, claimed);
    return claimed;
  }
  return null;
}

export async function heartbeatTaskClaim(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const heartbeat = await heartbeatTaskLock({
    context: input.context,
    runtimeRoot: input.runtimeRoot,
    taskId: input.taskId,
    ownerAgentId: input.agentId,
    sessionKey: input.sessionKey,
    leaseMs: input.leaseMs,
    nowMs: now,
  });
  if (!heartbeat.ok || !heartbeat.lock) {
    return { ok: false };
  }
  const task = await readTask(input.context, input.runtimeRoot, input.taskId);
  if (!task) {
    return { ok: false };
  }
  const next: TeamTaskRecord = {
    ...task,
    ownerAgentId: input.agentId,
    claimSessionKey: input.sessionKey,
    leaseUntil: heartbeat.lock.leaseUntil,
    claimedAt: task.claimedAt ?? now,
    updatedAt: now,
  };
  await writeTask(input.context, input.runtimeRoot, next);
  return { ok: true, task: next };
}

export async function updateTaskStatus(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  taskId: string;
  nextStatus: TeamTaskStatus;
  resultSummary?: string;
  error?: string;
  nowMs?: number;
}): Promise<TeamTaskRecord> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const task = await readTask(input.context, input.runtimeRoot, input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }
  if (!isTaskStatusTransitionAllowed(task.status, input.nextStatus)) {
    throw new Error(`Invalid task transition: ${task.status} -> ${input.nextStatus}`);
  }
  const next: TeamTaskRecord = {
    ...task,
    status: input.nextStatus,
    attempt: input.nextStatus === 'running' && task.status !== 'running'
      ? task.attempt + 1
      : task.attempt,
    resultSummary: input.resultSummary ?? task.resultSummary,
    error: input.error ?? (
      input.nextStatus === 'done'
      || input.nextStatus === 'todo'
      || input.nextStatus === 'running'
      || input.nextStatus === 'claimed'
        ? undefined
        : task.error
    ),
    updatedAt: now,
  };
  if (input.nextStatus === 'todo' || input.nextStatus === 'done' || input.nextStatus === 'failed') {
    next.ownerAgentId = undefined;
    next.claimSessionKey = undefined;
    next.claimedAt = undefined;
    next.leaseUntil = undefined;
  }
  await writeTask(input.context, input.runtimeRoot, next);
  return next;
}

export async function releaseTaskClaim(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
  nowMs?: number;
}): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const released = await releaseTaskLock({
    context: input.context,
    runtimeRoot: input.runtimeRoot,
    taskId: input.taskId,
    ownerAgentId: input.agentId,
    sessionKey: input.sessionKey,
  });
  if (!released.ok) {
    return { ok: false };
  }
  const task = await readTask(input.context, input.runtimeRoot, input.taskId);
  if (!task) {
    return { ok: true };
  }
  const next: TeamTaskRecord = {
    ...task,
    ownerAgentId: undefined,
    claimSessionKey: undefined,
    claimedAt: undefined,
    leaseUntil: undefined,
    status: task.status === 'claimed' ? 'todo' : task.status,
    updatedAt: now,
  };
  await writeTask(input.context, input.runtimeRoot, next);
  return { ok: true, task: next };
}

export async function clearTaskStore(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<void> {
  await context.fileSystem.removeDirectory(tasksDir(runtimeRoot));
}
