import crypto from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GatewayDeviceCryptoPort, GatewayDeviceIdentityRepositoryPort } from '../openclaw-bridge/client-auth-ports';
import type { RuntimeClockPort } from '../application/common/runtime-ports';
import type { DeviceIdentity } from '../shared/device-identity';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

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

export class NodeGatewayDeviceCrypto implements GatewayDeviceCryptoPort {
  generateIdentity(): DeviceIdentity {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    return {
      deviceId: this.fingerprintPublicKey(publicKeyPem),
      publicKeyPem,
      privateKeyPem,
    };
  }

  fingerprintPublicKey(publicKeyPem: string): string {
    return crypto.createHash('sha256').update(derivePublicKeyRaw(publicKeyPem)).digest('hex');
  }

  signDevicePayload(privateKeyPem: string, payload: string): string {
    const key = crypto.createPrivateKey(privateKeyPem);
    return base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), key));
  }

  publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
    return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
  }
}

export class NodeGatewayDeviceIdentityRepository implements GatewayDeviceIdentityRepositoryPort {
  constructor(
    private readonly cryptoPort: NodeGatewayDeviceCrypto,
    private readonly clock: RuntimeClockPort,
  ) {}

  async loadOrCreateDeviceIdentity(filePath: string): Promise<DeviceIdentity> {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as {
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
        const derivedId = this.cryptoPort.fingerprintPublicKey(parsed.publicKeyPem);
        if (derivedId && derivedId !== parsed.deviceId) {
          await this.writeIdentityFile(filePath, {
            ...parsed,
            deviceId: derivedId,
          });
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
    } catch {
      // Regenerate when the identity file is missing or corrupt.
    }

    const identity = this.cryptoPort.generateIdentity();
    await this.writeIdentityFile(filePath, {
      version: 1,
      deviceId: identity.deviceId,
      publicKeyPem: identity.publicKeyPem,
      privateKeyPem: identity.privateKeyPem,
      createdAtMs: this.clock.nowMs(),
    });
    return identity;
  }

  private async writeIdentityFile(filePath: string, data: Record<string, unknown>): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    try {
      await chmod(filePath, 0o600);
    } catch {
      // chmod is best effort on Windows.
    }
  }
}
