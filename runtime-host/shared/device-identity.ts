import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface DeviceIdentity {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export interface DeviceAuthPayloadV3Params {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function ensureDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  const raw = derivePublicKeyRaw(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateIdentity(): DeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = (publicKey.export({ type: 'spki', format: 'pem' }) as Buffer).toString();
  const privateKeyPem = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as Buffer).toString();
  return {
    deviceId: fingerprintPublicKey(publicKeyPem),
    publicKeyPem,
    privateKeyPem,
  };
}

function normalizeTrimmedMetadata(value: string | null | undefined): string {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed || '';
}

function toLowerAscii(input: string): string {
  return input.replace(/[A-Z]/g, (char) => String.fromCharCode(char.charCodeAt(0) + 32));
}

function normalizeDeviceMetadataForAuth(value: string | null | undefined): string {
  const trimmed = normalizeTrimmedMetadata(value);
  if (!trimmed) {
    return '';
  }
  return toLowerAscii(trimmed);
}

export function buildDeviceAuthPayloadV3(params: DeviceAuthPayloadV3Params): string {
  const scopes = params.scopes.join(',');
  const token = params.token ?? '';
  const platform = normalizeDeviceMetadataForAuth(params.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
  return [
    'v3',
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join('|');
}

export function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
  try {
    if (fs.existsSync(filePath)) {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        deviceId?: unknown;
        publicKeyPem?: unknown;
        privateKeyPem?: unknown;
      };
      if (
        parsed?.version === 1
        && typeof parsed.deviceId === 'string'
        && typeof parsed.publicKeyPem === 'string'
        && typeof parsed.privateKeyPem === 'string'
      ) {
        const derivedId = fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId && derivedId !== parsed.deviceId) {
          const updated = {
            ...parsed,
            deviceId: derivedId,
          };
          fs.writeFileSync(filePath, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
          try {
            fs.chmodSync(filePath, 0o600);
          } catch {
            // ignore chmod failures
          }
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
    // fall through and regenerate identity
  }

  const identity = generateIdentity();
  ensureDir(filePath);
  const stored = {
    version: 1,
    deviceId: identity.deviceId,
    publicKeyPem: identity.publicKeyPem,
    privateKeyPem: identity.privateKeyPem,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // ignore chmod failures
  }
  return identity;
}

export function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
}

export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
  return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}
