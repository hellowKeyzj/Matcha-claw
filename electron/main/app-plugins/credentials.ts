import { join } from 'node:path';
import { safeStorage } from 'electron';
import { ensurePrivateDirectory, readBoundedFile, replacePrivateFile } from '../../utils/private-file';
import { requirePluginId } from './package';

const MAX_VALUE_BYTES = 64 * 1024;
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_PENDING = 32;

type CredentialErrorCode = 'invalid-request' | 'storage-unavailable' | 'decryption-failed' | 'storage-limit';
const ERROR_MESSAGES: Record<CredentialErrorCode, string> = {
  'invalid-request': 'App plugin credential request is invalid.',
  'storage-unavailable': 'App plugin credential storage is unavailable.',
  'decryption-failed': 'App plugin credentials could not be decrypted.',
  'storage-limit': 'App plugin credential storage limit exceeded.',
};

export class AppPluginCredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'AppPluginCredentialError';
  }
}

export type AppPluginCredentialsAvailability =
  | { available: true }
  | { available: false; reason: 'encryption-unavailable' | 'insecure-backend' | 'storage-unavailable' };

export interface AppPluginCredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  availability(): Promise<AppPluginCredentialsAvailability>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.exec(value)?.[0] === value;
}
function isValue(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_VALUE_BYTES;
}
function encryptionAvailability(): AppPluginCredentialsAvailability {
  try {
    if (!safeStorage.isEncryptionAvailable()) return { available: false, reason: 'encryption-unavailable' };
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      return { available: false, reason: 'insecure-backend' };
    }
    return { available: true };
  } catch { return { available: false, reason: 'encryption-unavailable' }; }
}

async function readCredentials(path: string, pluginId: string): Promise<Record<string, string>> {
  let bytes: Buffer;
  try { bytes = await readBoundedFile(path, MAX_FILE_BYTES); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  const envelope: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(envelope) || Object.keys(envelope).length !== 2 || envelope.schemaVersion !== 1
    || typeof envelope.encrypted !== 'string' || !envelope.encrypted.length) {
    throw new AppPluginCredentialError('storage-unavailable');
  }
  const encrypted = Buffer.from(envelope.encrypted, 'base64');
  if (encrypted.toString('base64') !== envelope.encrypted) throw new AppPluginCredentialError('storage-unavailable');
  try {
    const plaintext = safeStorage.decryptString(encrypted);
    if (Buffer.byteLength(plaintext, 'utf8') > MAX_PAYLOAD_BYTES) throw new AppPluginCredentialError('decryption-failed');
    const payload: unknown = JSON.parse(plaintext);
    if (!isRecord(payload) || Object.keys(payload).length !== 2 || payload.pluginId !== pluginId || !isRecord(payload.values)
      || Object.keys(payload.values).length > MAX_ENTRIES
      || !Object.entries(payload.values).every(([key, value]) => isKey(key) && isValue(value))) {
      throw new AppPluginCredentialError('decryption-failed');
    }
    return payload.values as Record<string, string>;
  } catch { throw new AppPluginCredentialError('decryption-failed'); }
}

async function writeCredentials(path: string, pluginId: string, values: Record<string, string>): Promise<void> {
  const plaintext = JSON.stringify({ pluginId, values });
  if (Object.keys(values).length > MAX_ENTRIES || Buffer.byteLength(plaintext, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new AppPluginCredentialError('storage-limit');
  }
  const contents = JSON.stringify({ schemaVersion: 1, encrypted: safeStorage.encryptString(plaintext).toString('base64') });
  if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) throw new AppPluginCredentialError('storage-limit');
  await replacePrivateFile(path, contents);
}

export function createAppPluginCredentials(rootDir: string): {
  forPlugin(pluginId: string): AppPluginCredentialStore;
  availability(): Promise<AppPluginCredentialsAvailability>;
} {
  const lanes = new Map<string, { tail: Promise<void>; pending: number }>();
  let directoryReady: Promise<void> | undefined;
  function prepareDirectory(): Promise<void> {
    directoryReady ??= ensurePrivateDirectory(rootDir).catch(() => {
      directoryReady = undefined;
      throw new AppPluginCredentialError('storage-unavailable');
    });
    return directoryReady;
  }
  async function availability(): Promise<AppPluginCredentialsAvailability> {
    const encryption = encryptionAvailability();
    if (!encryption.available) return encryption;
    try { await prepareDirectory(); return { available: true }; }
    catch { return { available: false, reason: 'storage-unavailable' }; }
  }
  function serialize<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const lane = lanes.get(pluginId) ?? { tail: Promise.resolve(), pending: 0 };
    if (lane.pending >= MAX_PENDING) return Promise.reject(new AppPluginCredentialError('storage-limit'));
    lane.pending++;
    lanes.set(pluginId, lane);
    const result = lane.tail.then(async () => {
      if (!encryptionAvailability().available) throw new AppPluginCredentialError('storage-unavailable');
      await prepareDirectory();
      try { return await operation(); }
      catch (error) {
        if (error instanceof AppPluginCredentialError) throw error;
        throw new AppPluginCredentialError('storage-unavailable');
      }
    });
    lane.tail = result.then(() => {}, () => {}).then(() => {
      if (--lane.pending === 0) lanes.delete(pluginId);
    });
    return result;
  }
  return {
    availability,
    // Main binds the current Host instance's manifest ID; plugins never receive this factory.
    forPlugin(pluginId) {
      try { requirePluginId(pluginId); }
      catch { throw new AppPluginCredentialError('invalid-request'); }
      const path = join(rootDir, `${pluginId}.json`);
      return {
        availability,
        async get(key) {
          if (!isKey(key)) throw new AppPluginCredentialError('invalid-request');
          return serialize(pluginId, async () => {
            const values = await readCredentials(path, pluginId);
            return Object.hasOwn(values, key) ? values[key] : null;
          });
        },
        async set(key, value) {
          if (!isKey(key) || !isValue(value)) throw new AppPluginCredentialError('invalid-request');
          return serialize(pluginId, async () => {
            const values = await readCredentials(path, pluginId);
            values[key] = value;
            await writeCredentials(path, pluginId, values);
          });
        },
        async delete(key) {
          if (!isKey(key)) throw new AppPluginCredentialError('invalid-request');
          return serialize(pluginId, async () => {
            const values = await readCredentials(path, pluginId);
            if (!Object.hasOwn(values, key)) return;
            delete values[key];
            await writeCredentials(path, pluginId, values);
          });
        },
      };
    },
  };
}
