import { dirname, join } from 'node:path';
import { atomicWriteJson, readJsonFile, type TeamRuntimeStorageContext } from './storage-context';
import type { TeamClaimLockRecord } from './types';

function lockPath(runtimeRoot: string, taskId: string): string {
  return join(runtimeRoot, 'claims', `${taskId}.lock`);
}

export function isLeaseExpired(leaseUntil: number, nowMs: number): boolean {
  return leaseUntil <= nowMs;
}

export async function readTaskClaimLock(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
  taskId: string,
): Promise<TeamClaimLockRecord | null> {
  return await readJsonFile<TeamClaimLockRecord>(context, lockPath(runtimeRoot, taskId));
}

export async function claimTaskLock(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  taskId: string;
  ownerAgentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<{ ok: true; lock: TeamClaimLockRecord } | { ok: false; lock?: TeamClaimLockRecord }> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const pathname = lockPath(input.runtimeRoot, input.taskId);
  const lock: TeamClaimLockRecord = {
    taskId: input.taskId,
    ownerAgentId: input.ownerAgentId,
    sessionKey: input.sessionKey,
    claimedAt: now,
    leaseUntil: now + Math.max(1000, input.leaseMs),
  };

  await input.context.fileSystem.ensureDirectory(dirname(pathname));
  if (await input.context.fileSystem.writeTextFileExclusive(pathname, `${JSON.stringify(lock, null, 2)}\n`)) {
    return { ok: true, lock };
  }
  {
    const existing = await readTaskClaimLock(input.context, input.runtimeRoot, input.taskId);
    if (!existing) {
      return { ok: false };
    }
    if (!isLeaseExpired(existing.leaseUntil, now)) {
      return { ok: false, lock: existing };
    }
    await input.context.fileSystem.removeFile(pathname);
    if (await input.context.fileSystem.writeTextFileExclusive(pathname, `${JSON.stringify(lock, null, 2)}\n`)) {
      return { ok: true, lock };
    }
    return { ok: false, lock: await readTaskClaimLock(input.context, input.runtimeRoot, input.taskId) ?? existing };
  }
}

export async function heartbeatTaskLock(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  taskId: string;
  ownerAgentId: string;
  sessionKey: string;
  leaseMs: number;
  nowMs?: number;
}): Promise<{ ok: boolean; lock?: TeamClaimLockRecord }> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const pathname = lockPath(input.runtimeRoot, input.taskId);
  const existing = await readTaskClaimLock(input.context, input.runtimeRoot, input.taskId);
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
  await atomicWriteJson(input.context, pathname, next);
  return { ok: true, lock: next };
}

export async function releaseTaskLock(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  taskId: string;
  ownerAgentId: string;
  sessionKey: string;
}): Promise<{ ok: boolean }> {
  const pathname = lockPath(input.runtimeRoot, input.taskId);
  const existing = await readTaskClaimLock(input.context, input.runtimeRoot, input.taskId);
  if (!existing) {
    return { ok: true };
  }
  if (existing.ownerAgentId !== input.ownerAgentId || existing.sessionKey !== input.sessionKey) {
    return { ok: false };
  }
  await input.context.fileSystem.removeFile(pathname);
  return { ok: true };
}

export async function touchClaimsDir(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<void> {
  await context.fileSystem.ensureDirectory(join(runtimeRoot, 'claims'));
}

export async function hasTaskClaimLock(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
  taskId: string,
): Promise<boolean> {
  return await context.fileSystem.exists(lockPath(runtimeRoot, taskId));
}
