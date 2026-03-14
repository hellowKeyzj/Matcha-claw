import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TeamClaimLockRecord } from './types';

function lockPath(runtimeRoot: string, taskId: string): string {
  return join(runtimeRoot, 'claims', `${taskId}.lock`);
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

export function isLeaseExpired(leaseUntil: number, nowMs = Date.now()): boolean {
  return leaseUntil <= nowMs;
}

export async function readTaskClaimLock(runtimeRoot: string, taskId: string): Promise<TeamClaimLockRecord | null> {
  const pathname = lockPath(runtimeRoot, taskId);
  try {
    const raw = await readFile(pathname, 'utf8');
    return JSON.parse(raw) as TeamClaimLockRecord;
  } catch {
    return null;
  }
}

export async function claimTaskLock(input: {
  runtimeRoot: string;
  taskId: string;
  ownerAgentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<{ ok: true; lock: TeamClaimLockRecord } | { ok: false; lock?: TeamClaimLockRecord }> {
  const now = input.nowMs ?? Date.now();
  const pathname = lockPath(input.runtimeRoot, input.taskId);
  const lock: TeamClaimLockRecord = {
    taskId: input.taskId,
    ownerAgentId: input.ownerAgentId,
    sessionKey: input.sessionKey,
    claimedAt: now,
    leaseUntil: now + Math.max(1000, input.leaseMs),
  };

  await mkdir(dirname(pathname), { recursive: true });
  try {
    const handle = await open(pathname, 'wx');
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8');
    await handle.close();
    return { ok: true, lock };
  } catch {
    const existing = await readTaskClaimLock(input.runtimeRoot, input.taskId);
    if (!existing) {
      return { ok: false };
    }
    if (!isLeaseExpired(existing.leaseUntil, now)) {
      return { ok: false, lock: existing };
    }
    await rm(pathname, { force: true });
    try {
      const handle = await open(pathname, 'wx');
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, 'utf8');
      await handle.close();
      return { ok: true, lock };
    } catch {
      return { ok: false, lock: await readTaskClaimLock(input.runtimeRoot, input.taskId) ?? existing };
    }
  }
}

export async function heartbeatTaskLock(input: {
  runtimeRoot: string;
  taskId: string;
  ownerAgentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<{ ok: boolean; lock?: TeamClaimLockRecord }> {
  const now = input.nowMs ?? Date.now();
  const pathname = lockPath(input.runtimeRoot, input.taskId);
  const existing = await readTaskClaimLock(input.runtimeRoot, input.taskId);
  if (!existing) {
    return { ok: false };
  }
  if (existing.ownerAgentId !== input.ownerAgentId || existing.sessionKey !== input.sessionKey) {
    return { ok: false, lock: existing };
  }
  if (isLeaseExpired(existing.leaseUntil, now)) {
    return { ok: false, lock: existing };
  }
  const next: TeamClaimLockRecord = {
    ...existing,
    leaseUntil: now + Math.max(1000, input.leaseMs),
  };
  await atomicWriteJson(pathname, next);
  return { ok: true, lock: next };
}

export async function releaseTaskLock(input: {
  runtimeRoot: string;
  taskId: string;
  ownerAgentId: string;
  sessionKey: string;
}): Promise<{ ok: boolean }> {
  const pathname = lockPath(input.runtimeRoot, input.taskId);
  const existing = await readTaskClaimLock(input.runtimeRoot, input.taskId);
  if (!existing) {
    return { ok: true };
  }
  if (existing.ownerAgentId !== input.ownerAgentId || existing.sessionKey !== input.sessionKey) {
    return { ok: false };
  }
  await rm(pathname, { force: true });
  return { ok: true };
}

export async function touchClaimsDir(runtimeRoot: string): Promise<void> {
  await mkdir(join(runtimeRoot, 'claims'), { recursive: true });
}

export async function hasTaskClaimLock(runtimeRoot: string, taskId: string): Promise<boolean> {
  try {
    await stat(lockPath(runtimeRoot, taskId));
    return true;
  } catch {
    return false;
  }
}
