import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { platform } from 'node:process';
import { isDeepStrictEqual } from 'node:util';
import { app, safeStorage } from 'electron';
import { WorldPrivateAdmissionError } from './private-admission';

const STORE_FILE = 'world-storage-config.v1.json';
const MAX_STORE_BYTES = 1024 * 1024;
const MAX_CONNECTION_BYTES = 64 * 1024;
const STORAGE_ID = /^[A-Za-z0-9_.:-]{1,256}$/;

/** Private bootstrap input, never a public world DTO or the active storage locator. */
export type WorldPostgresConfiguration = Readonly<{ storageId: string; connectionString: string }>;
type Configuration = { initial?: WorldPostgresConfiguration; targets: WorldPostgresConfiguration[] };
export type WorldStorageConfigurationResult =
  | Readonly<{ outcome: 'saved'; storageId: string; restartRequired: true }>
  | Readonly<{ outcome: 'not-saved'; reason: 'invalid-request' | 'already-configured' | 'unauthorized' }>
  | Readonly<{ outcome: 'unknown'; reason: 'storage-unavailable' }>;
export type WorldStorageConfigurationStatus =
  | Readonly<{ outcome: 'available'; configured: boolean; initialStorageId?: string; targetStorageIds: string[]; registeredTargetStorageIds: string[] }>
  | Readonly<{ outcome: 'unavailable'; reason: 'storage-unavailable' }>;
let writes = Promise.resolve();
let registeredTargets: readonly string[] = [];

/** Successful private Host bootstrap observation, not the world's active storage locator. */
export function observeWorldStorageRegistration(storageIds: readonly string[]): () => void {
  const observed = [...storageIds];
  registeredTargets = observed;
  return () => { if (registeredTargets === observed) registeredTargets = []; };
}

export async function readWorldStorageBootstrap(): Promise<{
  worldPostgres?: WorldPostgresConfiguration;
  worldStorageTargets: WorldPostgresConfiguration[];
}> {
  await writes;
  try {
    const config = await readConfiguration();
    return { ...(config.initial ? { worldPostgres: config.initial } : {}), worldStorageTargets: config.targets };
  } catch { throw new Error('world.storage_config_unavailable'); }
}

export async function worldStorageConfigurationStatus(): Promise<WorldStorageConfigurationStatus> {
  try {
    await writes;
    const config = await readConfiguration();
    return { outcome: 'available', configured: !!config.initial,
      ...(config.initial ? { initialStorageId: config.initial.storageId } : {}),
      targetStorageIds: config.targets.map((target) => target.storageId), registeredTargetStorageIds: [...registeredTargets] };
  } catch { return { outcome: 'unavailable', reason: 'storage-unavailable' }; }
}

/** Saves pending credentials only. Rust validates the database marker on the next launch. */
export async function configureWorldStorage(input: unknown, admit: () => Promise<void>): Promise<WorldStorageConfigurationResult> {
  if (!record(input) || !isWorldStorageConnectionString(input.connectionString)
    || !(input.kind === 'initial' || input.kind === 'target' || input.kind === 'credentials')
    || !exact(input, input.kind === 'credentials' ? ['kind', 'storageId', 'connectionString'] : ['kind', 'connectionString'])
    || (input.kind === 'credentials' && (typeof input.storageId !== 'string' || !STORAGE_ID.test(input.storageId)))) {
    return { outcome: 'not-saved', reason: 'invalid-request' };
  }
  const previous = writes;
  let release!: () => void;
  writes = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await admit();
    const config = await readConfiguration();
    let storageId: string;
    if (input.kind === 'credentials') {
      const existing = [config.initial, ...config.targets].find((target) => target?.storageId === input.storageId);
      if (!existing) return { outcome: 'not-saved', reason: 'invalid-request' };
      storageId = existing.storageId;
      const updated = { storageId, connectionString: input.connectionString };
      if (config.initial?.storageId === storageId) config.initial = updated;
      else config.targets = config.targets.map((target) => target.storageId === storageId ? updated : target);
    } else {
      if (input.kind === 'initial' && config.initial) return { outcome: 'not-saved', reason: 'already-configured' };
      if (input.kind === 'target' && !config.initial) return { outcome: 'not-saved', reason: 'invalid-request' };
      storageId = randomUUID();
      const target = { storageId, connectionString: input.connectionString };
      if (input.kind === 'initial') config.initial = target;
      else config.targets.push(target);
    }
    await replaceConfiguration(config, admit);
    return { outcome: 'saved', storageId, restartRequired: true };
  } catch (error) {
    return error instanceof WorldPrivateAdmissionError ? { outcome: 'not-saved', reason: 'unauthorized' }
      : { outcome: 'unknown', reason: 'storage-unavailable' };
  }
  finally { release(); }
}

/** Preserve the Host-observed marker ID; connection credentials never establish World authority. */
export async function saveOpenedWorldStorage(
  storage: WorldPostgresConfiguration, previous: WorldPostgresConfiguration | undefined, admit: () => Promise<void>,
): Promise<'saved' | 'conflict'> {
  if (!target(storage)) throw new Error('world.storage_config_invalid');
  const pending = writes;
  let release!: () => void;
  writes = new Promise<void>((resolve) => { release = resolve; });
  await pending;
  try {
    await admit();
    const config = await readConfiguration();
    if (!isDeepStrictEqual(config.initial, previous)) return 'conflict';
    if (!isDeepStrictEqual(config.initial, storage)) {
      config.initial = storage;
      config.targets = config.targets.filter((entry) => entry.storageId !== storage.storageId);
      await replaceConfiguration(config, admit);
    }
    return 'saved';
  } finally { release(); }
}

export async function drainWorldStorageConfiguration(): Promise<void> { await writes; }

async function readConfiguration(): Promise<Configuration> {
  let encrypted: Buffer;
  try { encrypted = await readFile(join(app.getPath('userData'), STORE_FILE)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { targets: [] };
    throw error;
  }
  if (encrypted.length > MAX_STORE_BYTES || !safeStorage.isEncryptionAvailable()) throw new Error('world.storage_config_unavailable');
  const value: unknown = JSON.parse(safeStorage.decryptString(encrypted));
  if (!record(value) || !exact(value, value.initial === undefined ? ['targets'] : ['initial', 'targets'])
    || (value.initial !== undefined && !target(value.initial)) || !Array.isArray(value.targets)
    || !value.targets.every(target)) throw new Error('world.storage_config_invalid');
  const entries = [...(value.initial ? [value.initial as WorldPostgresConfiguration] : []), ...value.targets];
  if (new Set(entries.map((entry) => entry.storageId)).size !== entries.length) throw new Error('world.storage_config_invalid');
  return { ...(value.initial ? { initial: value.initial as WorldPostgresConfiguration } : {}), targets: value.targets };
}

async function replaceConfiguration(config: Configuration, admit: () => Promise<void>): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('world.storage_config_unavailable');
  const contents = safeStorage.encryptString(JSON.stringify(config));
  if (contents.length > MAX_STORE_BYTES) throw new Error('world.storage_config_unavailable');
  const path = join(app.getPath('userData'), STORE_FILE);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
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
export function isWorldStorageConnectionString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= MAX_CONNECTION_BYTES && !value.includes('\0');
}
function target(value: unknown): value is WorldPostgresConfiguration {
  return record(value) && exact(value, ['storageId', 'connectionString'])
    && typeof value.storageId === 'string' && STORAGE_ID.test(value.storageId) && isWorldStorageConnectionString(value.connectionString);
}
