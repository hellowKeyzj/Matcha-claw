import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { platform } from 'node:process';
import { dirname, join } from 'node:path';
import { app, safeStorage } from 'electron';
import type { CloudPackageEnvelope } from './types';

const DEVICE_KEY_FILE = 'cloud-package-device-key.v1.json';
const MAX_DEVICE_KEY_BYTES = 32 * 1024;
const DEVICE_ENVELOPE_ALGORITHM = 'rsa-oaep-sha256';
const AUTHORIZATION_KEY_BYTES = 32;

type CloudPackageDeviceKey = Readonly<{
  version: 1;
  publicKey: string;
  privateKey: string;
}>;

type PersistedDeviceKey = Readonly<{
  version: 1;
  encrypted: string;
}>;

let deviceKeyStoreWrite = Promise.resolve();

export async function getCloudPackageDevicePublicKey(): Promise<string> {
  const existing = await readCloudPackageDeviceKey();
  if (existing) return existing.publicKey;
  const generated = generateCloudPackageDeviceKey();
  await writeCloudPackageDeviceKey(generated);
  return generated.publicKey;
}

export async function unwrapCloudPackageDeviceEnvelope(envelope: CloudPackageEnvelope | undefined): Promise<string | undefined> {
  if (!envelope) return undefined;
  if (envelope.algorithm !== DEVICE_ENVELOPE_ALGORITHM) {
    throw new Error('Cloud package device envelope is invalid');
  }
  const key = await readCloudPackageDeviceKey();
  if (!key) throw new Error('Cloud package device key is unavailable');
  let authorizationKey: Buffer;
  try {
    authorizationKey = privateDecrypt(
      {
        key: key.privateKey,
        oaepHash: 'sha256',
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      },
      Buffer.from(envelope.ciphertextBase64, 'base64url'),
    );
  } catch {
    throw new Error('Cloud package device envelope is invalid');
  }
  if (authorizationKey.byteLength !== AUTHORIZATION_KEY_BYTES) {
    throw new Error('Cloud package authorization key is invalid');
  }
  return authorizationKey.toString('base64url');
}

async function readCloudPackageDeviceKey(): Promise<CloudPackageDeviceKey | null> {
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const raw = await readFile(deviceKeyStorePath(), 'utf8');
    if (Buffer.byteLength(raw) > MAX_DEVICE_KEY_BYTES) return null;
    const persisted: unknown = JSON.parse(raw);
    if (!isPersistedDeviceKey(persisted)) return null;
    const decrypted = safeStorage.decryptString(Buffer.from(persisted.encrypted, 'base64'));
    const key: unknown = JSON.parse(decrypted);
    return parseCloudPackageDeviceKey(key);
  } catch {
    return null;
  }
}

async function writeCloudPackageDeviceKey(key: CloudPackageDeviceKey): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Cloud package device key storage is unavailable');
  }
  const serialized = JSON.stringify(key);
  if (Buffer.byteLength(serialized) > MAX_DEVICE_KEY_BYTES) {
    throw new Error('Cloud package device key request is invalid');
  }
  const encrypted = safeStorage.encryptString(serialized).toString('base64');
  await updateDeviceKeyFile(JSON.stringify({ version: 1, encrypted }));
}

function generateCloudPackageDeviceKey(): CloudPackageDeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { version: 1, publicKey, privateKey };
}

function deviceKeyStorePath(): string {
  return join(app.getPath('userData'), DEVICE_KEY_FILE);
}

async function updateDeviceKeyFile(contents: string): Promise<void> {
  const previous = deviceKeyStoreWrite;
  let release!: () => void;
  deviceKeyStoreWrite = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    await replacePrivateFile(deviceKeyStorePath(), contents);
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

function isPersistedDeviceKey(value: unknown): value is PersistedDeviceKey {
  return isRecord(value)
    && value.version === 1
    && typeof value.encrypted === 'string'
    && value.encrypted.length > 0;
}

function parseCloudPackageDeviceKey(value: unknown): CloudPackageDeviceKey | null {
  if (!isCloudPackageDeviceKey(value)) return null;
  try {
    const publicKey = createPublicKey(value.publicKey);
    const privateKey = createPrivateKey(value.privateKey);
    if (publicKey.asymmetricKeyType !== 'rsa' || privateKey.asymmetricKeyType !== 'rsa') return null;
    return value;
  } catch {
    return null;
  }
}

function isCloudPackageDeviceKey(value: unknown): value is CloudPackageDeviceKey {
  return isRecord(value)
    && value.version === 1
    && isSecret(value.publicKey)
    && isSecret(value.privateKey);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}
