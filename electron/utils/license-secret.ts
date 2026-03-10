import crypto from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface LicenseSecretFileV1 {
  version: 1;
  alg: 'aes-256-gcm';
  kdf: 'hkdf-sha256';
  salt: string;
  iv: string;
  ciphertext: string;
  tag: string;
  updatedAt: string;
}

const SECRET_CONTEXT = 'matchaclaw-license-secret-v1';

function toBase64(raw: Buffer): string {
  return raw.toString('base64');
}

function fromBase64(raw: string): Buffer {
  return Buffer.from(raw, 'base64');
}

function deriveAesKey(material: string, salt: Buffer): Buffer {
  const derived = crypto.hkdfSync(
    'sha256',
    Buffer.from(material, 'utf8'),
    salt,
    Buffer.from(SECRET_CONTEXT, 'utf8'),
    32,
  );
  return Buffer.isBuffer(derived) ? derived : Buffer.from(derived);
}

function assertValidSecretFile(input: unknown): asserts input is LicenseSecretFileV1 {
  if (!input || typeof input !== 'object') {
    throw new Error('invalid_license_secret_file');
  }
  const candidate = input as Partial<LicenseSecretFileV1>;
  if (
    candidate.version !== 1 ||
    candidate.alg !== 'aes-256-gcm' ||
    candidate.kdf !== 'hkdf-sha256' ||
    typeof candidate.salt !== 'string' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.ciphertext !== 'string' ||
    typeof candidate.tag !== 'string'
  ) {
    throw new Error('invalid_license_secret_file');
  }
}

export function encryptLicenseKeyForFile(
  plainLicenseKey: string,
  material: string,
): LicenseSecretFileV1 {
  const normalizedKey = plainLicenseKey.trim();
  if (!normalizedKey) {
    throw new Error('empty_license_key');
  }
  if (!material.trim()) {
    throw new Error('empty_secret_material');
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveAesKey(material, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(normalizedKey, 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    alg: 'aes-256-gcm',
    kdf: 'hkdf-sha256',
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(ciphertext),
    tag: toBase64(tag),
    updatedAt: new Date().toISOString(),
  };
}

export function decryptLicenseKeyFromFile(
  file: LicenseSecretFileV1,
  material: string,
): string {
  assertValidSecretFile(file);
  if (!material.trim()) {
    throw new Error('empty_secret_material');
  }

  const salt = fromBase64(file.salt);
  const iv = fromBase64(file.iv);
  const ciphertext = fromBase64(file.ciphertext);
  const tag = fromBase64(file.tag);
  const key = deriveAesKey(material, salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8').trim();

  if (!plain) {
    throw new Error('empty_decrypted_license_key');
  }

  return plain;
}

export async function readEncryptedLicenseKey(
  filePath: string,
  material: string,
): Promise<string | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return decryptLicenseKeyFromFile(parsed as LicenseSecretFileV1, material);
  } catch {
    return null;
  }
}

export async function writeEncryptedLicenseKey(
  filePath: string,
  plainLicenseKey: string,
  material: string,
): Promise<void> {
  const payload = encryptLicenseKeyForFile(plainLicenseKey, material);
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tmpFilePath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backupFilePath = `${filePath}.bak`;
  await writeFile(tmpFilePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });

  try {
    await copyFile(filePath, backupFilePath);
  } catch {
    // ignore backup failures
  }

  await rm(filePath, { force: true });
  await rename(tmpFilePath, filePath);
}

export async function removeEncryptedLicenseFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(`${filePath}.bak`, { force: true });
}
