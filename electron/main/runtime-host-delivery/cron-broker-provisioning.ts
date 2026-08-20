import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const PROVISIONING_VERSION = 1;
const PRIVATE_KEY_FILE = 'cron-broker-private-key.pem';
const PROVISIONING_FILE = 'cron-broker-provisioning.json';

export type RuntimeHostCronBrokerProvisioning = Readonly<{
  verificationKey: string;
  endpoint: string;
  privateKeyPath: string;
  close(): void;
}>;

export function createRuntimeHostCronBrokerProvisioning(input: {
  readonly storageRoot: string;
  readonly cronBrokerTransportPort: number;
}): RuntimeHostCronBrokerProvisioning {
  if (!Number.isSafeInteger(input.cronBrokerTransportPort)
    || input.cronBrokerTransportPort <= 0
    || input.cronBrokerTransportPort > 65_535) {
    throw new RangeError('cronBrokerTransportPort must be an integer between 1 and 65535');
  }

  const privateKeyPath = join(input.storageRoot, PRIVATE_KEY_FILE);
  const provisioningPath = join(input.storageRoot, PROVISIONING_FILE);
  const endpoint = `http://127.0.0.1:${input.cronBrokerTransportPort}/api/cron/broker`;
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateKeyBytes = Buffer.from(
    privateKey.export({ format: 'pem', type: 'pkcs8' }),
  );

  mkdirSync(input.storageRoot, { recursive: true, mode: 0o700 });
  try {
    chmodSync(input.storageRoot, 0o700);
    if (process.platform === 'win32') secureWindowsDirectory(input.storageRoot);
  } catch (error) {
    privateKeyBytes.fill(0);
    throw error;
  }
  removeFile(privateKeyPath);
  removeFile(provisioningPath);
  try {
    writePrivateFile(privateKeyPath, privateKeyBytes);
    writeAtomic(
      provisioningPath,
      JSON.stringify({
        version: PROVISIONING_VERSION,
        endpoint,
        privateKeyPath,
      }),
    );
  } catch (error) {
    removeFile(privateKeyPath);
    removeFile(provisioningPath);
    throw error;
  } finally {
    privateKeyBytes.fill(0);
  }

  let closed = false;
  return {
    verificationKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
    endpoint,
    privateKeyPath,
    close: () => {
      if (closed) return;
      closed = true;
      removeFile(privateKeyPath);
      removeFile(provisioningPath);
    },
  };
}

function writePrivateFile(path: string, contents: Uint8Array): void {
  writeAtomic(path, contents);
  try {
    chmodSync(path, 0o600);
  } catch {
    removeFile(path);
    throw new Error('Cron broker private key permissions could not be secured');
  }
}

function writeAtomic(path: string, contents: string | Uint8Array): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } catch (error) {
    removeFile(temporaryPath);
    throw error;
  }
}

function secureWindowsDirectory(path: string): void {
  const args = [path, '/inheritance:r', '/remove:g', '*S-1-3-0'];
  if (process.env.USERNAME) args.push(process.env.USERNAME);
  args.push('/grant:r', '*S-1-3-4:(OI)(CI)F');
  execFileSync('icacls.exe', args, { stdio: 'ignore', windowsHide: true });
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Missing handoff files are already cleaned up.
  }
}
