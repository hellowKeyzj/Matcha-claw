import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SessionEntry } from 'openclaw/plugin-sdk/session-store-runtime';
import { getOpenClawConfigDir, getOpenClawDir } from '../../utils/paths';

export type SessionReceipt = Pick<SessionEntry, 'sessionId' | 'lifecycleRevision' | 'incognito' | 'initializationPending' | 'spawnedBy' | 'parentSessionKey' | 'parentSessionId'>;
export type CapturedHop = { agentId: string; sessionKey: string; storePath: string; receipt: SessionReceipt };
type ConfigSource = { path: string; stamp: string };
type StoreSelection = { store: string | undefined; sources: ConfigSource[] };
type Failure = 'STALE' | 'UNAVAILABLE' | 'CANCELLED';
export function storeFailure(kind: Failure): Error {
  const messages = {
    STALE: 'The OpenClaw session or its spawn lineage is no longer current',
    UNAVAILABLE: 'OpenClaw session ownership could not be verified',
    CANCELLED: 'Browser session verification was cancelled',
  };
  return Object.assign(new Error(messages[kind]), { code: `IAB_CONTEXT_${kind}` });
}

// Invocation-local observations skip unchanged native reads; SQLite stays off Main.
const readerSource = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { resolve } = require('node:path');
const { stat } = require('node:fs/promises');
const { statSync } = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const stampValue = (value) => {
  if (!value.isFile()) throw new Error('UNAVAILABLE');
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
};
const stamp = async (path) => ({ path, stamp: stampValue(await stat(path, { bigint: true })) });
const receipt = (entry) => entry && ({
  sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision,
  incognito: entry.incognito, initializationPending: entry.initializationPending,
  spawnedBy: entry.spawnedBy, parentSessionKey: entry.parentSessionKey, parentSessionId: entry.parentSessionId,
});
const sdk = Promise.all([import(workerData.sessionsUrl), import(workerData.configUrl)]);
sdk.catch(() => {});
const scopes = new Map();
let closed = false;
const file = (path) => {
  const value = statSync(path, { bigint: true });
  return { identity: [value.dev, value.ino, value.birthtimeNs].join(':'), stamp: stampValue(value) };
};
const assertFile = (observer) => {
  const current = file(observer.path);
  if (current.identity !== observer.identity) throw new Error('STALE');
  return current;
};
const sample = (observer) => {
  assertFile(observer);
  const version = observer.database.prepare('PRAGMA data_version').get().data_version;
  return { version, stamp: assertFile(observer).stamp };
};
const closeScope = (id) => {
  const scope = scopes.get(id);
  if (!scope) return;
  const failures = [];
  for (const [path, observer] of scope.databases) {
    try { observer.database.close(); scope.databases.delete(path); }
    catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures);
  scopes.delete(id);
};
process.on('exit', () => { for (const id of scopes.keys()) closeScope(id); });
const flush = async (batch) => {
  await Promise.all(batch.map(async ({ id, scopeId, operation, input }) => {
    let scope;
    try {
      if (operation === 'release') {
        closeScope(scopeId);
        parentPort.postMessage({ id, ok: true });
        return;
      }
      if (operation === 'close') {
        closed = true;
        const failures = [];
        for (const id of scopes.keys()) { try { closeScope(id); } catch (error) { failures.push(error); } }
        if (failures.length) throw new AggregateError(failures);
        parentPort.postMessage({ id, ok: true });
        return;
      }
      if (closed) throw new Error('UNAVAILABLE');
      scope = scopes.get(scopeId);
      if (!scope) { scope = { databases: new Map(), targets: new Map() }; scopes.set(scopeId, scope); }
      if (scope.failure) throw scope.failure;
      const [sessions, config] = await sdk;
      if (scopes.get(scopeId) !== scope) throw new Error('UNAVAILABLE');
      if (scope.failure) throw scope.failure;
      const target = (hop) => {
        const paths = new Set(sessions.resolveSessionStoreBackupPaths({ agentId: hop.agentId, storePath: hop.storePath }));
        const candidates = [...paths].filter((path) => ['-wal', '-shm', '-journal'].every((suffix) => paths.has(path + suffix)));
        if (candidates.length !== 1) throw new Error('UNAVAILABLE');
        const key = JSON.stringify([hop.agentId, hop.storePath]);
        const previous = scope.targets.get(key);
        if (previous && previous !== candidates[0]) throw new Error('STALE');
        scope.targets.set(key, candidates[0]);
        return candidates[0];
      };
      const observe = (hop) => {
        const path = target(hop);
        let observer = scope.databases.get(path);
        if (!observer) {
          const before = file(path);
          const database = new DatabaseSync(path, { readOnly: true, timeout: 0 });
          observer = { path, database, identity: before.identity };
          scope.databases.set(path, observer);
          // Fix this before the first SDK read, including later hops in this DB.
          observer.baseline = sample(observer);
        }
        return observer;
      };
      const read = (hop, observer) => {
        assertFile(observer);
        const value = receipt(sessions.getSessionEntry({
          agentId: hop.agentId, sessionKey: hop.sessionKey, storePath: hop.storePath,
          env: process.env, readConsistency: 'latest', hydrateSkillPromptRefs: false,
        }));
        assertFile(observer);
        target(hop);
        return value;
      };
      let value;
      if (operation === 'select') {
        const options = { isolateEnv: true, observe: false, pluginValidation: 'skip', recoverSuspicious: false };
        const snapshot = await config.readConfigFileSnapshot(options);
        if (!snapshot.valid || !snapshot.exists || resolve(snapshot.path) !== resolve(workerData.configPath)) throw new Error('UNAVAILABLE');
        const store = snapshot.runtimeConfig.session?.store;
        if (store !== undefined && (typeof store !== 'string' || !store.trim() || store.includes('\0'))) throw new Error('UNAVAILABLE');
        const paths = [...new Set([snapshot.path, ...(snapshot.includedPaths ?? [])])];
        const sources = await Promise.all(paths.map(stamp));
        const current = await config.readConfigFileSnapshot(options);
        const after = await Promise.all(paths.map(stamp));
        if (!current.valid || !current.exists || current.path !== snapshot.path || !snapshot.hash || current.hash !== snapshot.hash
          || current.runtimeConfig.session?.store !== store
          || JSON.stringify([...(current.includedPaths ?? [])].sort()) !== JSON.stringify([...(snapshot.includedPaths ?? [])].sort())
          || sources.some((source, index) => source.stamp !== after[index].stamp)) throw new Error('UNAVAILABLE');
        value = { store, sources };
      } else if (operation === 'read') {
        value = read(input, observe(input));
      } else if (operation === 'check') {
        const checkSources = () => {
          for (const source of input.sources) {
            if (stampValue(statSync(source.path, { bigint: true })) !== source.stamp) throw new Error('STALE');
          }
        };
        checkSources();
        const grouped = new Map();
        const targets = new Map();
        for (const hop of input.hops) {
          const key = JSON.stringify([hop.agentId, hop.storePath]);
          if (!targets.has(key)) targets.set(key, target(hop));
          const observer = scope.databases.get(targets.get(key));
          if (!observer) throw new Error('UNAVAILABLE');
          if (!grouped.has(observer)) grouped.set(observer, []);
          grouped.get(observer).push(hop);
        }
        for (const [observer, hops] of grouped) {
          const before = sample(observer);
          if (before.version === observer.baseline.version && before.stamp === observer.baseline.stamp) continue;
          for (const hop of hops) {
            const current = read(hop, observer);
            if (!current || Object.keys(hop.receipt).some((key) => current[key] !== hop.receipt[key])) throw new Error('STALE');
          }
          // A commit during the SDK reads stays visible on the next check.
          observer.baseline = before;
        }
        checkSources();
      } else throw new Error('UNAVAILABLE');
      parentPort.postMessage({ id, ok: true, value });
    } catch (error) {
      if (scope) scope.failure ??= error;
      parentPort.postMessage({ id, ok: false, kind: error?.message === 'STALE' ? 'STALE' : 'UNAVAILABLE' });
    }
  }));
};
const inbox = [];
let flushing = false;
const schedule = () => {
  if (flushing || !inbox.length) return;
  flushing = true;
  setImmediate(() => {
    // Freeze membership before SDK/config awaits; later arrivals get a fresh batch.
    const batch = inbox.splice(0);
    void flush(batch).then(() => {
      flushing = false;
      schedule();
    }, (error) => { setImmediate(() => { throw error; }); });
  });
};
parentPort.on('message', (message) => { inbox.push(message); schedule(); });
`;

export class IabOpenClawStore {
  readonly root = getOpenClawConfigDir();
  readonly env: NodeJS.ProcessEnv;
  private worker?: Worker;
  private nextId = 0;
  private nextScope = 0;
  private failure?: Error;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor() {
    const nativeSelectionKeys = new Set([
      'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_SEALED_LAUNCH',
      'MATCHACLAW_OPENCLAW_CONFIG_FD', 'MATCHACLAW_OPENCLAW_TLS_CERT_FD', 'MATCHACLAW_OPENCLAW_TLS_KEY_FD',
    ]);
    this.env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !nativeSelectionKeys.has(key.toUpperCase()))),
      OPENCLAW_STATE_DIR: this.root, OPENCLAW_CONFIG_DIR: this.root,
    };
  }

  scope() {
    const scopeId = ++this.nextScope;
    let released = false;
    return {
      env: this.env,
      select: async (signal: AbortSignal) => {
        if (released) throw storeFailure('CANCELLED');
        return await this.request('select', undefined, signal, scopeId) as StoreSelection;
      },
      read: async (hop: Pick<CapturedHop, 'agentId' | 'sessionKey' | 'storePath'>, signal: AbortSignal) => {
        if (released) throw storeFailure('CANCELLED');
        return await this.request('read', hop, signal, scopeId) as SessionReceipt | undefined;
      },
      assertCurrent: async (sources: ConfigSource[], hops: CapturedHop[], signal: AbortSignal) => {
        if (released) throw storeFailure('CANCELLED');
        await this.request('check', { sources, hops }, signal, scopeId);
      },
      close: async () => {
        if (released) return;
        released = true;
        if (this.worker) await this.request('release', undefined, undefined, scopeId);
      },
    };
  }

  async close(): Promise<void> {
    try { if (this.worker) await this.request('close'); }
    finally {
      this.fail(storeFailure('CANCELLED'));
      await this.worker?.terminate();
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw storeFailure('CANCELLED');
    if (this.failure) throw this.failure;
    if (getOpenClawConfigDir() !== this.root) throw storeFailure('STALE');
  }

  private async request(operation: string, input?: unknown, signal?: AbortSignal, scopeId?: number): Promise<unknown> {
    if (signal) this.assertActive(signal);
    else if (this.failure) throw this.failure;
    if (!this.worker) {
      try {
        const require = createRequire(join(getOpenClawDir(), 'package.json'));
        const url = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
        this.worker = new Worker(readerSource, {
          eval: true, env: this.env, stdout: true, stderr: true,
          workerData: { sessionsUrl: url('openclaw/plugin-sdk/session-store-runtime'), configUrl: url('openclaw/plugin-sdk/health'), configPath: join(this.root, 'openclaw.json') },
        });
        this.worker.stdout.resume(); this.worker.stderr.resume();
        this.worker.on('message', (reply: { id: number; ok: boolean; value?: unknown; kind: Failure }) => {
          const pending = this.pending.get(reply.id);
          this.pending.delete(reply.id);
          if (reply.ok) pending?.resolve(reply.value);
          else pending?.reject(storeFailure(reply.kind));
        });
        this.worker.once('error', () => this.fail(storeFailure('UNAVAILABLE')));
        this.worker.once('messageerror', () => this.fail(storeFailure('UNAVAILABLE')));
        this.worker.once('exit', () => this.fail(storeFailure('UNAVAILABLE')));
      } catch { this.fail(storeFailure('UNAVAILABLE')); throw this.failure; }
    }
    const id = ++this.nextId;
    const result = await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.worker!.postMessage({ id, scopeId, operation, input }); }
      catch { this.fail(storeFailure('UNAVAILABLE')); }
    });
    if (signal) this.assertActive(signal);
    return result;
  }
}
