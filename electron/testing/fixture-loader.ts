import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { app } from 'electron';
import { configureWorldStorage } from '../main/world/storage-config';
import { configuredConnection } from '../main/world/transport';
import { parseWorldSourceCredential, storeWorldSourceCredential } from '../main/world/source-credentials';
import { MAX_RUNTIME_HOST_BOOTSTRAP_BYTES } from '../main/runtime-host-delivery/bootstrap';

/** Explicit isolated startup input; never runs for the normal application profile. */
export async function configureE2EWorldBootstrap(defaultUserDataDir: string): Promise<void> {
  const fixture = process.env.MATCHACLAW_E2E_WORLD_CONFIG_FILE?.trim();
  if (process.env.MATCHACLAW_E2E !== '1' || !fixture) return;
  const configuredDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();
  if (!configuredDir || !isAbsolute(configuredDir) || !isAbsolute(fixture)) {
    throw new Error('world.e2e_config_invalid');
  }
  const userData = await realpath(configuredDir);
  const fixturePath = await realpath(fixture);
  const within = (parent: string, child: string): boolean => {
    const part = relative(parent, child);
    return !!part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part);
  };
  if (resolve(app.getPath('userData')) !== resolve(configuredDir)
    || resolve(userData) === resolve(defaultUserDataDir)
    || within(resolve(defaultUserDataDir), userData) || !within(userData, fixturePath)) {
    throw new Error('world.e2e_config_invalid');
  }
  const file = await open(fixturePath, 'r');
  let value: unknown;
  try {
    const bytes = Buffer.alloc(MAX_RUNTIME_HOST_BOOTSTRAP_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size === 0 || size > MAX_RUNTIME_HOST_BOOTSTRAP_BYTES) throw new Error();
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)));
  } catch {
    throw new Error('world.e2e_config_invalid');
  } finally { await file.close(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['connectionString,initialWorld', 'connectionString,initialWorld,sourceCredentials'].includes(Object.keys(value).sort().join(','))) {
    throw new Error('world.e2e_config_invalid');
  }
  const input = value as { connectionString: unknown; initialWorld: unknown; sourceCredentials?: unknown };
  if (!input.initialWorld || typeof input.initialWorld !== 'object' || Array.isArray(input.initialWorld)
    || Object.hasOwn(input.initialWorld, 'storageId')) throw new Error('world.e2e_config_invalid');
  if (input.sourceCredentials !== undefined) {
    if (!Array.isArray(input.sourceCredentials)) throw new Error('world.e2e_config_invalid');
    for (const seed of input.sourceCredentials) {
      if (!seed || typeof seed !== 'object' || Array.isArray(seed)
        || Object.keys(seed).sort().join(',') !== 'credential,request') throw new Error('world.e2e_config_invalid');
      const configured = configuredConnection(seed.request);
      if (!configured) throw new Error('world.e2e_config_invalid');
      const kind = (configured.connection.config as { kind: string }).kind;
      const credential = parseWorldSourceCredential(seed.credential);
      if ((kind === 'postgres' && credential.kind !== 'postgres')
        || (kind === 'http_json' && credential.kind !== 'none' && credential.kind !== 'http_bearer')
        || kind === 'plugin') throw new Error('world.e2e_config_invalid');
      await storeWorldSourceCredential(configured.identity, configured.connection, credential, async () => undefined);
    }
  }
  const saved = await configureWorldStorage({ kind: 'initial', connectionString: input.connectionString }, async () => undefined);
  if (saved.outcome === 'unknown') throw new Error('world.e2e_storage_unknown');
  if (saved.outcome !== 'saved') throw new Error('world.e2e_storage_not_saved');
  const initial = await open(join(userData, 'world-initial.v1.json'), 'wx', 0o600);
  try {
    await initial.writeFile(JSON.stringify({ ...input.initialWorld, storageId: saved.storageId }), 'utf8');
    await initial.sync();
  } finally { await initial.close(); }
}

type HostApiFetchRequest = {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

type HostApiProxyEnvelope =
  | {
    ok: true;
    data: {
      status: number;
      ok: boolean;
      json?: unknown;
      text?: string;
    };
  }
  | {
    ok: false;
    error: { message: string };
  };

export type E2EDialogStagedAttachmentPayload = {
  stagedAttachmentId?: string;
  entryKind?: 'file' | 'directory';
  fileName: string;
  mimeType: string;
  fileSize: number;
  preview: string | null;
  sourcePath?: string;
};

export async function handleE2EHostApiFetch(
  _request: HostApiFetchRequest,
): Promise<HostApiProxyEnvelope | null> {
  return null;
}

export async function getE2EDialogOpenResult(): Promise<{ canceled: boolean; filePaths: string[] } | null> {
  return null;
}

export async function getE2EDialogStagedAttachments(): Promise<E2EDialogStagedAttachmentPayload[] | null> {
  return null;
}

export async function getE2EDiagnosticsArchiveSavePath(): Promise<string | null> {
  const configured = process.env.MATCHACLAW_E2E_DIAGNOSTICS_SAVE_PATH?.trim();
  const userDataDir = process.env.MATCHACLAW_E2E_USER_DATA_DIR?.trim();
  return configured || (process.env.MATCHACLAW_E2E === '1' && userDataDir
    ? join(userDataDir, 'diagnostics-archive.zip')
    : null);
}

export async function getE2EGatewayStatus<TStatus>(): Promise<TStatus | null> {
  return null;
}
