import { mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { sanitizeMailboxMessage } from './schema';
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

function tmpPath(pathname: string): string {
  return `${pathname}.${process.pid}.${Date.now()}.tmp`;
}

async function atomicWriteJson(pathname: string, payload: unknown): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true });
  const tmp = tmpPath(pathname);
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await rename(tmp, pathname);
}

export async function ensureMailboxStore(runtimeRoot: string): Promise<void> {
  await mkdir(mailboxDir(runtimeRoot), { recursive: true });
}

export async function mailboxPost(input: {
  runtimeRoot: string;
  message: Partial<TeamMailboxMessage> & { msgId: string; fromAgentId: string; content: string };
  nowMs?: number;
}): Promise<{ created: boolean; message: TeamMailboxMessage }> {
  const message = sanitizeMailboxMessage(input.message, input.nowMs ?? Date.now());
  const pathname = mailboxPath(input.runtimeRoot, message.msgId);
  await mkdir(dirname(pathname), { recursive: true });

  try {
    const handle = await open(pathname, 'wx');
    await handle.writeFile(`${JSON.stringify(message, null, 2)}\n`, 'utf8');
    await handle.close();
    return { created: true, message };
  } catch {
    try {
      const raw = await readFile(pathname, 'utf8');
      return { created: false, message: JSON.parse(raw) as TeamMailboxMessage };
    } catch {
      await atomicWriteJson(pathname, message);
      return { created: true, message };
    }
  }
}

export async function mailboxPull(input: {
  runtimeRoot: string;
  cursor?: string;
  limit?: number;
}): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }> {
  await ensureMailboxStore(input.runtimeRoot);
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  const entries = await readdir(mailboxDir(input.runtimeRoot), { withFileTypes: true });
  const rows: TeamMailboxMessage[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue;
    }
    try {
      const raw = await readFile(join(mailboxDir(input.runtimeRoot), entry.name), 'utf8');
      rows.push(JSON.parse(raw) as TeamMailboxMessage);
    } catch {
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
