import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { buildSessionIdentityKey, type SessionIdentity } from '../../../src/types/desktop/runtime-address';
import { getOpenClawConfigDir, getOpenClawDir } from '../../utils/paths';
import type { IabTrustedContext } from './contracts';

type SessionSdk = Pick<typeof import('openclaw/plugin-sdk/session-store-runtime'), 'getSessionEntry' | 'resolveStorePath'>;
type RoutingSdk = Pick<typeof import('openclaw/plugin-sdk/routing'), 'parseAgentSessionKey' | 'normalizeAgentIdStrict' | 'isSubagentSessionKey' | 'isIncognitoSessionKey'>;
type ContextFailure = 'INVALID' | 'STALE' | 'UNAVAILABLE' | 'INCOGNITO' | 'CANCELLED';
const failureMessages: Record<ContextFailure, string> = {
  INVALID: 'The OpenClaw session has no verifiable browser ownership lineage',
  STALE: 'The OpenClaw session or its spawn lineage is no longer current',
  UNAVAILABLE: 'OpenClaw session ownership could not be verified',
  INCOGNITO: 'Process-only OpenClaw sessions cannot control the in-app browser',
  CANCELLED: 'Browser session verification was cancelled',
};
function failure(kind: ContextFailure): Error {
  return Object.assign(new Error(failureMessages[kind]), { code: `IAB_CONTEXT_${kind}` });
}
function assertActive(signal: AbortSignal): void {
  if (signal.aborted) throw failure('CANCELLED');
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 16_384 && !value.includes('\0');
}

let sdkPromise: Promise<{ sessions: SessionSdk; routing: RoutingSdk; configUrl: string }> | undefined;
function loadSdk() {
  return sdkPromise ??= (async () => {
    try {
      const require = createRequire(join(getOpenClawDir(), 'package.json'));
      const url = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
      const [sessions, routing] = await Promise.all([
        import(url('openclaw/plugin-sdk/session-store-runtime')) as Promise<SessionSdk>,
        import(url('openclaw/plugin-sdk/routing')) as Promise<RoutingSdk>,
      ]);
      return { sessions, routing, configUrl: url('openclaw/plugin-sdk/health') };
    } catch {
      throw failure('UNAVAILABLE');
    }
  })();
}

// The public config SDK has no env argument. A private worker gives it the native
// launch environment without changing Main's process.env or reimplementing JSON5/includes.
const configReader = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { resolve } = require('node:path');
const { stat } = require('node:fs/promises');
const stamp = async (path) => {
  const value = await stat(path, { bigint: true });
  if (!value.isFile()) throw new Error('Invalid config source');
  return { path, stamp: [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':') };
};
(async () => {
  try {
    const { readConfigFileSnapshot } = await import(workerData.configUrl);
    const options = { isolateEnv: true, observe: false, pluginValidation: 'skip', recoverSuspicious: false };
    const snapshot = await readConfigFileSnapshot(options);
    if (!snapshot.valid || !snapshot.exists || resolve(snapshot.path) !== resolve(workerData.configPath)) {
      parentPort.postMessage({ ok: false });
      return;
    }
    const store = snapshot.runtimeConfig.session?.store;
    if (store !== undefined && (typeof store !== 'string' || !store.trim() || store.includes('\0'))) {
      parentPort.postMessage({ ok: false });
      return;
    }
    const paths = [...new Set([snapshot.path, ...(snapshot.includedPaths ?? [])])];
    const sources = await Promise.all(paths.map(stamp));
    const current = await readConfigFileSnapshot(options);
    const after = await Promise.all(paths.map(stamp));
    if (!current.valid || !current.exists || current.path !== snapshot.path || !snapshot.hash || current.hash !== snapshot.hash
      || current.runtimeConfig.session?.store !== store
      || JSON.stringify([...(current.includedPaths ?? [])].sort()) !== JSON.stringify([...(snapshot.includedPaths ?? [])].sort())
      || sources.some((source, index) => source.stamp !== after[index].stamp)) {
      parentPort.postMessage({ ok: false });
      return;
    }
    parentPort.postMessage({ ok: true, store, sources });
  } catch {
    parentPort.postMessage({ ok: false });
  } finally {
    parentPort.close();
  }
})();
`;

type ConfigSource = { path: string; stamp: string };
type StoreSelection = { store: string | undefined; sources: ConfigSource[] };
async function readSessionStore(configUrl: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<StoreSelection> {
  assertActive(signal);
  let worker: Worker;
  try {
    worker = new Worker(configReader, {
      eval: true, env, stdout: true, stderr: true,
      workerData: { configUrl, configPath: join(env.OPENCLAW_CONFIG_DIR!, 'openclaw.json') },
    });
  } catch { throw failure('UNAVAILABLE'); }
  worker.stdout.resume();
  worker.stderr.resume();
  let abort: (() => void) | undefined;
  try {
    return await new Promise<StoreSelection>((resolve, reject) => {
      abort = () => reject(failure('CANCELLED'));
      worker.once('error', () => reject(failure('UNAVAILABLE')));
      worker.once('exit', () => reject(failure('UNAVAILABLE')));
      worker.once('message', (reply: unknown) => {
        if (reply === null || typeof reply !== 'object' || !('ok' in reply) || reply.ok !== true
          || !('store' in reply) || reply.store !== undefined && !identifier(reply.store)
          || !('sources' in reply) || !Array.isArray(reply.sources) || reply.sources.length === 0
          || reply.sources.some((source: unknown) => source === null || typeof source !== 'object'
            || !('path' in source) || !identifier(source.path) || !('stamp' in source) || typeof source.stamp !== 'string')) {
          reject(failure('UNAVAILABLE'));
          return;
        }
        resolve({ store: reply.store as string | undefined, sources: reply.sources as ConfigSource[] });
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

function receipt(entry: SessionEntry) {
  return {
    sessionId: entry.sessionId,
    lifecycleRevision: entry.lifecycleRevision,
    incognito: entry.incognito,
    initializationPending: entry.initializationPending,
    spawnedBy: entry.spawnedBy,
    spawnedBySessionId: entry.spawnedBySessionId,
    spawnedBySenderIsOwner: entry.spawnedBySenderIsOwner,
    parentSessionKey: entry.parentSessionKey,
    parentSessionId: entry.parentSessionId,
    parentSessionLifecycleRevision: entry.parentSessionLifecycleRevision,
  };
}
type CapturedHop = {
  agentId: string;
  sessionKey: string;
  storePath: string;
  receipt: ReturnType<typeof receipt>;
};

export async function resolveIabOpenClawContext(
  leaf: { agentId: string; sessionKey: string; sessionId: string; workspaceDir?: string },
  signal: AbortSignal,
): Promise<IabTrustedContext> {
  assertActive(signal);
  const { sessions, routing, configUrl } = await loadSdk();
  assertActive(signal);
  const root = getOpenClawConfigDir();
  const nativeSelectionKeys = new Set([
    'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_SEALED_LAUNCH',
    'MATCHACLAW_OPENCLAW_CONFIG_FD', 'MATCHACLAW_OPENCLAW_TLS_CERT_FD', 'MATCHACLAW_OPENCLAW_TLS_KEY_FD',
  ]);
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !nativeSelectionKeys.has(key.toUpperCase()))),
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_DIR: root,
  };
  const { store, sources } = await readSessionStore(configUrl, env, signal);
  assertActive(signal);
  const hops: CapturedHop[] = [];
  const seen = new Set<string>();
  let sessionKey = leaf.sessionKey;
  let sessionId = leaf.sessionId;
  let lifecycleRevision: string | undefined;

  const read = (hop: Pick<CapturedHop, 'agentId' | 'sessionKey' | 'storePath'>): SessionEntry | undefined => {
    try {
      return sessions.getSessionEntry({ ...hop, env, readConsistency: 'latest', hydrateSkillPromptRefs: false });
    } catch { throw failure('UNAVAILABLE'); }
  };
  const assertCurrent = () => {
    assertActive(signal);
    let changed: boolean;
    try {
      changed = getOpenClawConfigDir() !== root || sources.some((source) => {
        const value = statSync(source.path, { bigint: true });
        return !value.isFile() || [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':') !== source.stamp;
      });
    } catch { throw failure('UNAVAILABLE'); }
    if (changed) throw failure('STALE');
    // These are read-only currency checks, not native generation leases.
    for (const hop of hops) {
      const entry = read(hop);
      if (!entry) throw failure('STALE');
      const current = receipt(entry);
      if ((Object.keys(hop.receipt) as (keyof typeof current)[]).some((key) => current[key] !== hop.receipt[key])) {
        throw failure('STALE');
      }
    }
    assertActive(signal);
  };

  for (let depth = 0; depth < 64; depth += 1) {
    assertActive(signal);
    const parsed = routing.parseAgentSessionKey(sessionKey);
    if (!parsed || !identifier(sessionId) || depth === 0 && parsed.agentId !== leaf.agentId) throw failure('INVALID');
    const agentId = routing.normalizeAgentIdStrict(parsed.agentId);
    if (!agentId.ok || agentId.value !== parsed.agentId) throw failure('INVALID');
    if (routing.isIncognitoSessionKey(sessionKey)) throw failure('INCOGNITO');
    // The SDK supplies canonical pieces, including case-sensitive opaque peer IDs.
    sessionKey = `agent:${parsed.agentId}:${parsed.rest}`;
    if (seen.has(sessionKey)) throw failure('INVALID');
    seen.add(sessionKey);
    let storePath: string;
    try { storePath = sessions.resolveStorePath(store, { agentId: parsed.agentId, env }); }
    catch { throw failure('UNAVAILABLE'); }
    const address = { agentId: parsed.agentId, sessionKey, storePath };
    const entry = read(address);
    if (!entry || entry.sessionId !== sessionId || depth > 0 && entry.lifecycleRevision !== lifecycleRevision) throw failure('STALE');
    if (entry.incognito) throw failure('INCOGNITO');
    if (entry.initializationPending || entry.lifecycleRevision !== undefined && !identifier(entry.lifecycleRevision)) throw failure('INVALID');
    hops.push({ ...address, receipt: receipt(entry) });
    if (entry.spawnedBy !== undefined) {
      if (!identifier(entry.spawnedBy) || !identifier(entry.spawnedBySessionId)
        || typeof entry.spawnedBySenderIsOwner !== 'boolean'
        || entry.parentSessionKey !== undefined && entry.parentSessionKey !== entry.spawnedBy
        || entry.parentSessionId !== undefined && entry.parentSessionId !== entry.spawnedBySessionId
        || entry.parentSessionLifecycleRevision !== undefined && !identifier(entry.parentSessionLifecycleRevision)) {
        throw failure('INVALID');
      }
      sessionKey = entry.spawnedBy;
      sessionId = entry.spawnedBySessionId;
      lifecycleRevision = entry.parentSessionLifecycleRevision;
      continue;
    }
    if (routing.isSubagentSessionKey(sessionKey) || entry.parentSessionKey !== undefined || entry.parentSessionId !== undefined
      || entry.parentSessionLifecycleRevision !== undefined || entry.spawnedBySessionId !== undefined
      || entry.spawnedBySenderIsOwner !== undefined) throw failure('INVALID');
    const identity: SessionIdentity = Object.freeze({
      endpoint: Object.freeze({ kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }),
      agentId: parsed.agentId,
      sessionKey,
    });
    assertCurrent();
    return Object.freeze({
      principalId: buildSessionIdentityKey(identity),
      identity,
      sessionKey: leaf.sessionKey,
      ...(leaf.workspaceDir !== undefined ? { workspaceDir: leaf.workspaceDir } : {}),
      assertCurrent,
    });
  }
  throw failure('INVALID');
}
