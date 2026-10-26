import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { platform } from 'node:process';
import { app, safeStorage } from 'electron';
import { WorldPrivateAdmissionError } from './private-admission';

const STORE_FILE = 'world-source-credentials.v1.json';
const MAX_STORE_BYTES = 4 * 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;
const U64_MAX = 18_446_744_073_709_551_615n;

export type WorldCredentialIdentity = Readonly<{
  world: Readonly<{ tenantId: string; worldId: string }>;
  connectionId: string;
  revision: string;
}>;

// Private resolver wire only. These variants never belong to a ConnectionView.
export type WorldSourceCredential =
  | Readonly<{ kind: 'none' }>
  | Readonly<{ kind: 'http_bearer'; token: string }>
  | Readonly<{ kind: 'postgres'; user: string; password: string }>;

export type WorldSourceCredentialFailure = 'invalid-request' | 'credential-missing'
  | 'credential-decrypt-failed' | 'credential-invalid' | 'credential-store-unavailable'
  | 'credential-revision-conflict';

export class WorldSourceCredentialError extends Error {
  constructor(readonly code: WorldSourceCredentialFailure, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'WorldSourceCredentialError';
  }
}

type StoredCredential = Readonly<{
  identity: WorldCredentialIdentity;
  connectionDigest: string;
  credential: WorldSourceCredential;
}>;
type PrivateStore = Record<string, string>;
let writes = Promise.resolve();

export function isWorldCredentialIdentity(value: unknown): value is WorldCredentialIdentity {
  return record(value) && exact(value, ['world', 'connectionId', 'revision'])
    && record(value.world) && exact(value.world, ['tenantId', 'worldId'])
    && id(value.world.tenantId) && id(value.world.worldId) && id(value.connectionId)
    && decimalRevision(value.revision);
}

export function parseWorldSourceCredential(value: unknown): WorldSourceCredential {
  if (record(value)) {
    if (value.kind === 'none' && exact(value, ['kind'])) return { kind: 'none' };
    if (value.kind === 'http_bearer' && exact(value, ['kind', 'token']) && secret(value.token)
      && !/[\r\n]/.test(value.token)) return { kind: 'http_bearer', token: value.token };
    if (value.kind === 'postgres' && exact(value, ['kind', 'user', 'password'])
      && secret(value.user) && secret(value.password)) {
      return { kind: 'postgres', user: value.user, password: value.password };
    }
  }
  throw new WorldSourceCredentialError('credential-invalid');
}

/** Immutable exact world/connection/revision binding; retries cannot replace an old key. */
export async function storeWorldSourceCredential(
  identity: WorldCredentialIdentity, connection: unknown, credential: WorldSourceCredential, admit: () => Promise<void>,
): Promise<void> {
  if (!isWorldCredentialIdentity(identity)) throw new WorldSourceCredentialError('invalid-request');
  const value: StoredCredential = { identity, connectionDigest: connectionDigest(connection), credential: parseWorldSourceCredential(credential) };
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > MAX_CREDENTIAL_BYTES) throw new WorldSourceCredentialError('credential-invalid');
  const previous = writes;
  let release!: () => void;
  writes = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await admit();
    requireEncryption();
    const store = await readStore();
    const key = identityKey(identity);
    if (Object.hasOwn(store, key)) {
      const existing = decrypt(store[key]);
      if (existing.connectionDigest !== value.connectionDigest
        || identityKey(existing.identity) !== key || JSON.stringify(existing.credential) !== JSON.stringify(value.credential)) {
        throw new WorldSourceCredentialError('credential-revision-conflict');
      }
      return;
    }
    store[key] = safeStorage.encryptString(serialized).toString('base64');
    await replaceStore(store, admit);
  } catch (error) {
    if (error instanceof WorldSourceCredentialError || error instanceof WorldPrivateAdmissionError) throw error;
    throw new WorldSourceCredentialError('credential-store-unavailable', error);
  } finally { release(); }
}

export async function requireWorldSourceCredential(
  identity: WorldCredentialIdentity, connection: unknown,
): Promise<void> {
  const stored = await lookup(identity);
  if (stored.connectionDigest !== connectionDigest(connection)) {
    throw new WorldSourceCredentialError('credential-revision-conflict');
  }
}

export async function resolveWorldSourceCredential(identity: WorldCredentialIdentity): Promise<WorldSourceCredential> {
  return (await lookup(identity)).credential;
}

export async function drainWorldSourceCredentials(): Promise<void> { await writes; }

async function lookup(identity: WorldCredentialIdentity): Promise<StoredCredential> {
  if (!isWorldCredentialIdentity(identity)) throw new WorldSourceCredentialError('invalid-request');
  await writes;
  requireEncryption();
  const encrypted = (await readStore())[identityKey(identity)];
  if (!encrypted) throw new WorldSourceCredentialError('credential-missing');
  const value = decrypt(encrypted);
  if (identityKey(value.identity) !== identityKey(identity)) throw new WorldSourceCredentialError('credential-invalid');
  return value;
}

function decrypt(encrypted: string): StoredCredential {
  try {
    const value: unknown = JSON.parse(safeStorage.decryptString(Buffer.from(encrypted, 'base64')));
    if (!record(value) || !exact(value, ['identity', 'connectionDigest', 'credential'])
      || !isWorldCredentialIdentity(value.identity) || typeof value.connectionDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(value.connectionDigest)) throw new Error('invalid credential');
    return { identity: value.identity, connectionDigest: value.connectionDigest, credential: parseWorldSourceCredential(value.credential) };
  } catch (error) { throw new WorldSourceCredentialError('credential-decrypt-failed', error); }
}

function identityKey(identity: WorldCredentialIdentity): string {
  return createHash('sha256').update(JSON.stringify([
    'world.source.credentials/1', identity.world.tenantId, identity.world.worldId, identity.connectionId, identity.revision,
  ])).digest('hex');
}
function connectionDigest(connection: unknown): string {
  const serialized = JSON.stringify(connection, (_key, value: unknown) => record(value)
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value);
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}
function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) throw new WorldSourceCredentialError('credential-store-unavailable');
}
async function readStore(): Promise<PrivateStore> {
  try {
    const raw = await readFile(join(app.getPath('userData'), STORE_FILE), 'utf8');
    const value: unknown = JSON.parse(raw);
    if (Buffer.byteLength(raw) > MAX_STORE_BYTES || !record(value)
      || !Object.entries(value).every(([key, encrypted]) => /^[a-f0-9]{64}$/.test(key)
        && typeof encrypted === 'string' && encrypted.length <= MAX_CREDENTIAL_BYTES * 4)) {
      throw new WorldSourceCredentialError('credential-store-unavailable');
    }
    return value as PrivateStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof WorldSourceCredentialError) throw error;
    throw new WorldSourceCredentialError('credential-store-unavailable', error);
  }
}
async function replaceStore(store: PrivateStore, admit: () => Promise<void>): Promise<void> {
  const contents = JSON.stringify(store);
  if (Buffer.byteLength(contents) > MAX_STORE_BYTES) throw new WorldSourceCredentialError('credential-store-unavailable');
  const path = join(app.getPath('userData'), STORE_FILE);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents, 'utf8'); await file.sync(); }
    finally { await file.close(); }
    await admit();
    await rename(temporary, path);
    if (platform !== 'win32') {
      const directory = await open(dirname(path), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function id(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(value);
}
function decimalRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= U64_MAX;
}
function secret(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= MAX_CREDENTIAL_BYTES && !value.includes('\0');
}
