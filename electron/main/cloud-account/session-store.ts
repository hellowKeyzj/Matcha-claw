import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { platform } from 'node:process';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';

import type { CloudUser } from './types';

const SESSION_FILE = 'cloud-account-session.v1.json';
const MAX_SESSION_BYTES = 64 * 1024;

export type CloudAccountSession = Readonly<{
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
  tokenType: string;
  user: CloudUser;
}>;

type PersistedSession = Readonly<{
  version: 1;
  encrypted: string;
}>;

let sessionStoreWrite = Promise.resolve();

export async function readCloudAccountSession(): Promise<CloudAccountSession | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const raw = await readFile(sessionStorePath(), 'utf8');
    if (Buffer.byteLength(raw) > MAX_SESSION_BYTES) return null;
    const persisted: unknown = JSON.parse(raw);
    if (!isPersistedSession(persisted)) return null;
    const decrypted = safeStorage.decryptString(Buffer.from(persisted.encrypted, 'base64'));
    const session: unknown = JSON.parse(decrypted);
    return isCloudAccountSession(session) ? session : null;
  } catch {
    return null;
  }
}

export async function writeCloudAccountSession(session: CloudAccountSession): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Cloud account credential storage is unavailable');
  }
  const serialized = JSON.stringify(session);
  if (Buffer.byteLength(serialized) > MAX_SESSION_BYTES) {
    throw new Error('Cloud account credential request is invalid');
  }
  const encrypted = safeStorage.encryptString(serialized).toString('base64');
  await updateSessionFile(JSON.stringify({ version: 1, encrypted }));
}

export async function clearCloudAccountSession(): Promise<void> {
  const previous = sessionStoreWrite;
  let release!: () => void;
  sessionStoreWrite = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await unlink(sessionStorePath()).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  } finally {
    release();
  }
}

function sessionStorePath(): string {
  return join(app.getPath('userData'), SESSION_FILE);
}

async function updateSessionFile(contents: string): Promise<void> {
  const previous = sessionStoreWrite;
  let release!: () => void;
  sessionStoreWrite = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await replacePrivateFile(sessionStorePath(), contents);
  } finally {
    release();
  }
}

async function replacePrivateFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'w', 0o600);
    try {
      await file.writeFile(contents, { encoding: 'utf8' });
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    await syncContainingDirectory(path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncContainingDirectory(path: string): Promise<void> {
  if (platform === 'win32') return;
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isPersistedSession(value: unknown): value is PersistedSession {
  return isRecord(value)
    && value.version === 1
    && typeof value.encrypted === 'string'
    && value.encrypted.length > 0;
}

function isCloudAccountSession(value: unknown): value is CloudAccountSession {
  return isRecord(value)
    && isSecret(value.accessToken)
    && (value.refreshToken === undefined || isSecret(value.refreshToken))
    && isExpiresAt(value.expiresAt)
    && typeof value.tokenType === 'string'
    && value.tokenType.length > 0
    && isCloudUser(value.user);
}

function isCloudUser(value: unknown): value is CloudUser {
  return isRecord(value)
    && isPositiveInteger(value.id)
    && typeof value.username === 'string'
    && typeof value.email === 'string'
    && (value.avatarUrl === undefined || typeof value.avatarUrl === 'string' || value.avatarUrl === null)
    && (value.role === 'admin' || value.role === 'user')
    && typeof value.balance === 'number'
    && (value.frozenBalance === undefined || typeof value.frozenBalance === 'number')
    && typeof value.concurrency === 'number'
    && (value.rpmLimit === undefined || typeof value.rpmLimit === 'number')
    && (value.status === 'active' || value.status === 'disabled')
    && (Array.isArray(value.allowedGroups) || value.allowedGroups === null)
    && typeof value.balanceNotifyEnabled === 'boolean'
    && (typeof value.balanceNotifyThreshold === 'number' || value.balanceNotifyThreshold === null)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && (value.runMode === undefined || value.runMode === 'standard' || value.runMode === 'simple');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

function isExpiresAt(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
