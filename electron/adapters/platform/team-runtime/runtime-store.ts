import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';
import { listTasks } from './task-store';
import { mailboxPull } from './mailbox-store';
import type { TeamEventRecord, TeamRunRecord } from './types';

function runPath(runtimeRoot: string): string {
  return join(runtimeRoot, 'run.json');
}

function eventsDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'events');
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

export async function ensureRuntimeLayout(runtimeRoot: string): Promise<void> {
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(join(runtimeRoot, 'tasks'), { recursive: true });
  await mkdir(join(runtimeRoot, 'claims'), { recursive: true });
  await mkdir(join(runtimeRoot, 'mailbox'), { recursive: true });
  await mkdir(join(runtimeRoot, 'events'), { recursive: true });
}

export async function readTeamRun(runtimeRoot: string): Promise<TeamRunRecord | null> {
  try {
    const raw = await readFile(runPath(runtimeRoot), 'utf8');
    return JSON.parse(raw) as TeamRunRecord;
  } catch {
    return null;
  }
}

export async function initTeamRun(input: {
  runtimeRoot: string;
  teamId: string;
  leadAgentId: string;
  nowMs?: number;
}): Promise<TeamRunRecord> {
  await ensureRuntimeLayout(input.runtimeRoot);
  const now = input.nowMs ?? Date.now();
  const existing = await readTeamRun(input.runtimeRoot);
  if (existing) {
    return existing;
  }
  const created: TeamRunRecord = {
    teamId: input.teamId,
    leadAgentId: input.leadAgentId,
    status: 'active',
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
  await atomicWriteJson(runPath(input.runtimeRoot), created);
  return created;
}

export async function updateTeamRun(input: {
  runtimeRoot: string;
  patch: Partial<Omit<TeamRunRecord, 'teamId' | 'createdAt'>>;
  nowMs?: number;
}): Promise<TeamRunRecord> {
  const now = input.nowMs ?? Date.now();
  const current = await readTeamRun(input.runtimeRoot);
  if (!current) {
    throw new Error('Team run not initialized');
  }
  const next: TeamRunRecord = {
    ...current,
    ...input.patch,
    revision: current.revision + 1,
    updatedAt: now,
  };
  await atomicWriteJson(runPath(input.runtimeRoot), next);
  return next;
}

export async function appendTeamEvent(input: {
  runtimeRoot: string;
  teamId: string;
  type: string;
  payload: Record<string, unknown>;
  nowMs?: number;
}): Promise<TeamEventRecord> {
  const now = input.nowMs ?? Date.now();
  const event: TeamEventRecord = {
    id: crypto.randomUUID(),
    teamId: input.teamId,
    type: input.type,
    createdAt: now,
    payload: input.payload,
  };
  await mkdir(eventsDir(input.runtimeRoot), { recursive: true });
  const pathname = join(eventsDir(input.runtimeRoot), `${now}-${event.id}.json`);
  await atomicWriteJson(pathname, event);
  return event;
}

export async function readRecentEvents(runtimeRoot: string, limit = 200): Promise<TeamEventRecord[]> {
  await mkdir(eventsDir(runtimeRoot), { recursive: true });
  const entries = await readdir(eventsDir(runtimeRoot), { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .slice(-Math.max(1, Math.min(2000, limit)));
  const rows: TeamEventRecord[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(eventsDir(runtimeRoot), file), 'utf8');
      rows.push(JSON.parse(raw) as TeamEventRecord);
    } catch {
      // Ignore malformed event files.
    }
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function buildTeamSnapshot(input: {
  runtimeRoot: string;
  mailboxCursor?: string;
  mailboxLimit?: number;
}): Promise<{
  run: TeamRunRecord | null;
  tasks: Awaited<ReturnType<typeof listTasks>>;
  mailbox: Awaited<ReturnType<typeof mailboxPull>>;
  events: TeamEventRecord[];
}> {
  const [run, tasks, mailbox, events] = await Promise.all([
    readTeamRun(input.runtimeRoot),
    listTasks(input.runtimeRoot),
    mailboxPull({
      runtimeRoot: input.runtimeRoot,
      cursor: input.mailboxCursor,
      limit: input.mailboxLimit ?? 100,
    }),
    readRecentEvents(input.runtimeRoot, 200),
  ]);
  return {
    run,
    tasks,
    mailbox,
    events,
  };
}

export async function clearTeamRuntime(runtimeRoot: string): Promise<void> {
  await rm(runtimeRoot, { recursive: true, force: true });
}
