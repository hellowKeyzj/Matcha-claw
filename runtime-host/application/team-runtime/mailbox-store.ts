import { dirname, join } from 'node:path';
import { sanitizeMailboxMessage } from './schema';
import { atomicWriteJson, readJsonFile, type TeamRuntimeStorageContext } from './storage-context';
import type { TeamMailboxMessage } from './types';

function mailboxDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'mailbox');
}

function mailboxPath(runtimeRoot: string, msgId: string): string {
  return join(mailboxDir(runtimeRoot), `${msgId}.json`);
}

function parseCursor(cursor?: string): { createdAt: number; msgId: string } | null {
  if (!cursor) {
    return null;
  }
  const [ts, msgId] = cursor.split(':', 2);
  const createdAt = Number(ts);
  if (!Number.isFinite(createdAt) || !msgId) {
    return null;
  }
  return { createdAt, msgId };
}

function buildCursor(message: TeamMailboxMessage): string {
  return `${message.createdAt}:${message.msgId}`;
}

function compareCursor(a: TeamMailboxMessage, b: { createdAt: number; msgId: string }): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  return a.msgId.localeCompare(b.msgId);
}

export async function ensureMailboxStore(
  context: TeamRuntimeStorageContext,
  runtimeRoot: string,
): Promise<void> {
  await context.fileSystem.ensureDirectory(mailboxDir(runtimeRoot));
}

export async function mailboxPost(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  message: Partial<TeamMailboxMessage> & { msgId: string; fromAgentId: string; content: string };
  nowMs?: number;
}): Promise<{ created: boolean; message: TeamMailboxMessage }> {
  const message = sanitizeMailboxMessage(input.message, input.nowMs ?? input.context.clock.nowMs());
  const pathname = mailboxPath(input.runtimeRoot, message.msgId);
  await input.context.fileSystem.ensureDirectory(dirname(pathname));

  if (await input.context.fileSystem.writeTextFileExclusive(pathname, `${JSON.stringify(message, null, 2)}\n`)) {
    return { created: true, message };
  }
  const existing = await readJsonFile<TeamMailboxMessage>(input.context, pathname);
  if (existing) {
    return { created: false, message: existing };
  }
  await atomicWriteJson(input.context, pathname, message);
  return { created: true, message };
}

export async function mailboxPull(input: {
  context: TeamRuntimeStorageContext;
  runtimeRoot: string;
  cursor?: string;
  limit?: number;
}): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }> {
  await ensureMailboxStore(input.context, input.runtimeRoot);
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const entries = await input.context.fileSystem.listDirectory(mailboxDir(input.runtimeRoot));
  const rows: TeamMailboxMessage[] = [];
  for (const entry of entries) {
    if (!entry.isFile || !entry.name.endsWith('.json')) {
      continue;
    }
    const message = await readJsonFile<TeamMailboxMessage>(input.context, join(mailboxDir(input.runtimeRoot), entry.name));
    if (message) {
      rows.push(message);
    } else {
      // Skip malformed mailbox files.
    }
  }

  rows.sort((a, b) => a.createdAt - b.createdAt || a.msgId.localeCompare(b.msgId));
  const cursor = parseCursor(input.cursor);
  const filtered = cursor
    ? rows.filter((row) => compareCursor(row, cursor) > 0)
    : rows;
  const messages = filtered.slice(0, limit);
  const nextCursor = messages.length > 0 ? buildCursor(messages[messages.length - 1]) : input.cursor;
  return {
    messages,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
