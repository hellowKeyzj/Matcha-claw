import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { claimTaskLock, heartbeatTaskLock, releaseTaskLock } from './claim-lock';
import { isTaskStatusTransitionAllowed, sanitizeTaskRecord } from './schema';
import type { TeamTaskRecord, TeamTaskStatus } from './types';

function tasksDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'tasks');
}

function taskPath(runtimeRoot: string, taskId: string): string {
  return join(tasksDir(runtimeRoot), `${taskId}.json`);
}

function tmpPath(pathname: string): string {
  return `${pathname}.${process.pid}.${Date.now()}.tmp`;
}

async function atomicWriteJson(pathname: string, payload: unknown): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  const tmp = tmpPath(pathname);
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, pathname);
}

export async function ensureTaskStore(runtimeRoot: string): Promise<void> {
  await mkdir(tasksDir(runtimeRoot), { recursive: true });
}

export async function readTask(runtimeRoot: string, taskId: string): Promise<TeamTaskRecord | null> {
  const pathname = taskPath(runtimeRoot, taskId);
  try {
    const raw = await readFile(pathname, 'utf8');
    return JSON.parse(raw) as TeamTaskRecord;
  } catch {
    return null;
  }
}

export async function writeTask(runtimeRoot: string, task: TeamTaskRecord): Promise<void> {
  await atomicWriteJson(taskPath(runtimeRoot, task.taskId), task);
}

export async function listTasks(runtimeRoot: string): Promise<TeamTaskRecord[]> {
  await ensureTaskStore(runtimeRoot);
  const entries = await readdir(tasksDir(runtimeRoot), { withFileTypes: true });
  const tasks: TeamTaskRecord[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(tasksDir(runtimeRoot), entry.name), 'utf8');
      tasks.push(JSON.parse(raw) as TeamTaskRecord);
    } catch {
      // Ignore malformed task files and continue loading remaining files.
    }
  }
  return tasks.sort((a, b) => a.createdAt - b.createdAt || a.taskId.localeCompare(b.taskId));
}

export async function upsertPlanTasks(input: {
  runtimeRoot: string;
  tasks: Array<Partial<TeamTaskRecord> & { taskId: string; instruction: string }>;
  nowMs?: number;
}): Promise<TeamTaskRecord[]> {
  const now = input.nowMs ?? Date.now();
  const existing = await listTasks(input.runtimeRoot);
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
    await writeTask(input.runtimeRoot, normalized);
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
  runtimeRoot: string;
  agentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<TeamTaskRecord | null> {
  const now = input.nowMs ?? Date.now();
  const tasks = await listTasks(input.runtimeRoot);
  const doneSet = new Set(tasks.filter((task) => task.status === 'done').map((task) => task.taskId));

  for (const task of tasks) {
    if (!canClaimTask(task, doneSet)) {
      continue;
    }
    const claim = await claimTaskLock({
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
    await writeTask(input.runtimeRoot, claimed);
    return claimed;
  }
  return null;
}

export async function heartbeatTaskClaim(input: {
  runtimeRoot: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
  const now = input.nowMs ?? Date.now();
  const heartbeat = await heartbeatTaskLock({
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
  const task = await readTask(input.runtimeRoot, input.taskId);
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
  await writeTask(input.runtimeRoot, next);
  return { ok: true, task: next };
}

export async function updateTaskStatus(input: {
  runtimeRoot: string;
  taskId: string;
  nextStatus: TeamTaskStatus;
  resultSummary?: string;
  error?: string;
  nowMs?: number;
}): Promise<TeamTaskRecord> {
  const now = input.nowMs ?? Date.now();
  const task = await readTask(input.runtimeRoot, input.taskId);
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
  await writeTask(input.runtimeRoot, next);
  return next;
}

export async function releaseTaskClaim(input: {
  runtimeRoot: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
  nowMs?: number;
}): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
  const now = input.nowMs ?? Date.now();
  const released = await releaseTaskLock({
    runtimeRoot: input.runtimeRoot,
    taskId: input.taskId,
    ownerAgentId: input.agentId,
    sessionKey: input.sessionKey,
  });
  if (!released.ok) {
    return { ok: false };
  }
  const task = await readTask(input.runtimeRoot, input.taskId);
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
  await writeTask(input.runtimeRoot, next);
  return { ok: true, task: next };
}

export async function clearTaskStore(runtimeRoot: string): Promise<void> {
  await rm(tasksDir(runtimeRoot), { recursive: true, force: true });
}
