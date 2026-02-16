import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

const DEVICE_IDENTITY_VERSION = 1;
const DEVICE_IDENTITY_FILE = 'device.json';
const IDENTITY_DIR_NAME = 'identity';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type StoredDeviceIdentity = {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

export type GatewayDeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

export type GatewayDeviceAuthPayloadParams = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce?: string | null;
  version?: 'v1' | 'v2';
};

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function setSecureFileMode(filePath: string): void {
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort on non-posix file systems.
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const key = crypto.createPublicKey(publicKeyPem);
  const spki = key.export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function deriveDeviceIdFromPublicKeyPem(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function resolveIdentityFilePath(configDir: string): string {
  return path.join(configDir, IDENTITY_DIR_NAME, DEVICE_IDENTITY_FILE);
}

function createDeviceIdentity(): GatewayDeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = deriveDeviceIdFromPublicKeyPem(publicKeyPem);
  return { deviceId, publicKeyPem, privateKeyPem };
}

export function loadOrCreateGatewayDeviceIdentity(configDir: string): GatewayDeviceIdentity {
  const identityFile = resolveIdentityFilePath(configDir);
  try {
    if (existsSync(identityFile)) {
      const raw = readFileSync(identityFile, 'utf8');
      const parsed = JSON.parse(raw) as StoredDeviceIdentity;
      if (
        parsed?.version === DEVICE_IDENTITY_VERSION &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKeyPem === 'string' &&
        typeof parsed.privateKeyPem === 'string'
      ) {
        const derivedId = deriveDeviceIdFromPublicKeyPem(parsed.publicKeyPem);
        if (derivedId !== parsed.deviceId) {
          const updated: StoredDeviceIdentity = {
            ...parsed,
            deviceId: derivedId,
          };
          writeFileSync(identityFile, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
          setSecureFileMode(identityFile);
          return {
            deviceId: derivedId,
            publicKeyPem: parsed.publicKeyPem,
            privateKeyPem: parsed.privateKeyPem,
          };
        }
        return {
          deviceId: parsed.deviceId,
          publicKeyPem: parsed.publicKeyPem,
          privateKeyPem: parsed.privateKeyPem,
        };
      }
    }
  } catch {
    // Fall through and regenerate.
  }

  const identity = createDeviceIdentity();
  ensureDir(identityFile);
  const stored: StoredDeviceIdentity = {
    version: DEVICE_IDENTITY_VERSION,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  writeFileSync(identityFile, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  setSecureFileMode(identityFile);
  return identity;
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}

export function signGatewayDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature);
}

export function buildGatewayDeviceAuthPayload(params: GatewayDeviceAuthPayloadParams): string {
  const version = params.version ?? (params.nonce ? 'v2' : 'v1');
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
  ];
  if (version === 'v2') {
    base.push(params.nonce ?? '');
  }
  return base.join('|');
}
