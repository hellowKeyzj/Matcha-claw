import { join } from 'node:path';
import { listTasks } from './task-store';
import { mailboxPull } from './mailbox-store';
import { atomicWriteJson, readJsonFile, type TeamRuntimeStorageContext } from './storage-context';
import type { TeamEventRecord, TeamRunRecord } from './types';

function runPath(runtimeRoot: string): string {
  return join(runtimeRoot, 'run.json');
}

function eventsDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'events');
}

export async function ensureRuntimeLayout(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<void> {
  await context.fileSystem.ensureDirectory(runtimeRoot);
  await context.fileSystem.ensureDirectory(join(runtimeRoot, 'tasks'));
  await context.fileSystem.ensureDirectory(join(runtimeRoot, 'claims'));
  await context.fileSystem.ensureDirectory(join(runtimeRoot, 'mailbox'));
  await context.fileSystem.ensureDirectory(join(runtimeRoot, 'events'));
}

export async function readTeamRun(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<TeamRunRecord | null> {
  return await readJsonFile<TeamRunRecord>(context, runPath(runtimeRoot));
}

export async function initTeamRun(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  teamId: string;
  leadAgentId: string;
  nowMs?: number;
}): Promise<TeamRunRecord> {
  await ensureRuntimeLayout(input.context, input.runtimeRoot);
  const now = input.nowMs ?? input.context.clock.nowMs();
  const existing = await readTeamRun(input.context, input.runtimeRoot);
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
  await atomicWriteJson(input.context, runPath(input.runtimeRoot), created);
  return created;
}

export async function updateTeamRun(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  patch: Partial<Omit<TeamRunRecord, 'teamId' | 'createdAt'>>;
  nowMs?: number;
}): Promise<TeamRunRecord> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const current = await readTeamRun(input.context, input.runtimeRoot);
  if (!current) {
    throw new Error('Team run not initialized');
  }
  const next: TeamRunRecord = {
    ...current,
    ...input.patch,
    revision: current.revision + 1,
    updatedAt: now,
  };
  await atomicWriteJson(input.context, runPath(input.runtimeRoot), next);
  return next;
}

export async function appendTeamEvent(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  teamId: string;
  type: string;
  payload: Record<string, unknown>;
  nowMs?: number;
}): Promise<TeamEventRecord> {
  const now = input.nowMs ?? input.context.clock.nowMs();
  const event: TeamEventRecord = {
    id: input.context.idGenerator.randomId(),
    teamId: input.teamId,
    type: input.type,
    createdAt: now,
    payload: input.payload,
  };
  await input.context.fileSystem.ensureDirectory(eventsDir(input.runtimeRoot));
  const pathname = join(eventsDir(input.runtimeRoot), `${now}-${event.id}.json`);
  await atomicWriteJson(input.context, pathname, event);
  return event;
}

export async function readRecentEvents(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
  limit = 200,
): Promise<TeamEventRecord[]> {
  await context.fileSystem.ensureDirectory(eventsDir(runtimeRoot));
  const entries = await context.fileSystem.listDirectory(eventsDir(runtimeRoot));
  const files = entries
    .filter((entry) => entry.isFile && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .slice(-Math.max(1, Math.min(2000, limit)));
  const rows: TeamEventRecord[] = [];
  for (const file of files) {
    const event = await readJsonFile<TeamEventRecord>(context, join(eventsDir(runtimeRoot), file));
    if (event) {
      rows.push(event);
    } else {
      // Ignore malformed event files.
    }
  }
  return rows.sort((a, b) => a.createdAt - b.createdAt);
}

export async function buildTeamSnapshot(input: {
  context: TeamRuntimeStorageContext;
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
    readTeamRun(input.context, input.runtimeRoot),
    listTasks(input.context, input.runtimeRoot),
    mailboxPull({
      context: input.context,
      runtimeRoot: input.runtimeRoot,
      cursor: input.mailboxCursor,
      limit: input.mailboxLimit ?? 100,
    }),
    readRecentEvents(input.context, input.runtimeRoot, 200),
  ]);
  return {
    run,
    tasks,
    mailbox,
    events,
  };
}

export async function clearTeamRuntime(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<void> {
  await context.fileSystem.removeDirectory(runtimeRoot);
}
