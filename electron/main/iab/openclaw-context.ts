import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserActionContext, BrowserSessionCleanup } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import { buildSessionIdentityKey, type SessionIdentity } from '../../../src/types/desktop/runtime-address';
import { getOpenClawDir } from '../../utils/paths';
import type { IabTrustedContext } from './contracts';
import { IabOpenClawStore, type CapturedHop } from './openclaw-store';

type SessionSdk = Pick<typeof import('openclaw/plugin-sdk/session-store-runtime'), 'resolveStorePath'>;
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

let sdkPromise: Promise<{ sessions: SessionSdk; routing: RoutingSdk }> | undefined;
function loadSdk() {
  return sdkPromise ??= (async () => {
    try {
      const require = createRequire(join(getOpenClawDir(), 'package.json'));
      const url = (specifier: string) => pathToFileURL(require.resolve(specifier)).href;
      const [sessions, routing] = await Promise.all([
        import(url('openclaw/plugin-sdk/session-store-runtime')) as Promise<SessionSdk>,
        import(url('openclaw/plugin-sdk/routing')) as Promise<RoutingSdk>,
      ]);
      return { sessions, routing };
    } catch {
      throw failure('UNAVAILABLE');
    }
  })();
}

export async function resolveIabOpenClawContext(
  leaf: { agentId: string; sessionKey: string; sessionId: string; workspaceDir?: string },
  signal: AbortSignal,
  reader: ReturnType<IabOpenClawStore['scope']>,
): Promise<IabTrustedContext> {
  assertActive(signal);
  const { sessions, routing } = await loadSdk();
  assertActive(signal);
  const { env } = reader;
  const { store, sources } = await reader.select(signal);
  assertActive(signal);
  const hops: CapturedHop[] = [];
  const seen = new Set<string>();
  let sessionKey = leaf.sessionKey;
  let sessionId: string | undefined = leaf.sessionId;

  const assertCurrent = () => reader.assertCurrent(sources, hops, signal);

  for (let depth = 0; depth < 64; depth += 1) {
    assertActive(signal);
    const parsed = routing.parseAgentSessionKey(sessionKey);
    if (!parsed || sessionId !== undefined && !identifier(sessionId) || depth === 0 && parsed.agentId !== leaf.agentId) throw failure('INVALID');
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
    const entry = await reader.read(address, signal);
    if (!entry || !identifier(entry.sessionId) || sessionId !== undefined && entry.sessionId !== sessionId) throw failure('STALE');
    if (entry.incognito) throw failure('INCOGNITO');
    if (entry.initializationPending || entry.lifecycleRevision !== undefined && !identifier(entry.lifecycleRevision)) throw failure('INVALID');
    hops.push({ ...address, receipt: entry });
    if (entry.spawnedBy !== undefined || entry.parentSessionKey !== undefined) {
      const parentKey = entry.parentSessionKey ?? entry.spawnedBy;
      if (!identifier(parentKey) || entry.parentSessionId !== undefined && !identifier(entry.parentSessionId)
        || entry.spawnedBy !== undefined && (!identifier(entry.spawnedBy) || entry.spawnedBy !== parentKey)) {
        throw failure('INVALID');
      }
      // Key-only dashboard grouping is navigation, not browser execution ancestry.
      // Spawn edges still capture the parent's current entry, not a generation lease.
      if (entry.spawnedBy !== undefined || entry.parentSessionId !== undefined || routing.isSubagentSessionKey(sessionKey)) {
        sessionKey = parentKey;
        sessionId = entry.parentSessionId;
        continue;
      }
    }
    if (routing.isSubagentSessionKey(sessionKey) || entry.parentSessionId !== undefined) throw failure('INVALID');
    const identity: SessionIdentity = Object.freeze({
      endpoint: Object.freeze({ kind: 'native-runtime' as const, runtimeAdapterId: 'openclaw', runtimeInstanceId: 'local' }),
      agentId: parsed.agentId,
      sessionKey,
    });
    return Object.freeze({
      principalId: buildSessionIdentityKey(identity),
      executorId: buildSessionIdentityKey({
        endpoint: identity.endpoint,
        agentId: hops[0].agentId,
        sessionKey: hops[0].sessionKey,
      }),
      identity,
      sessionKey: leaf.sessionKey,
      ...(leaf.workspaceDir !== undefined ? { workspaceDir: leaf.workspaceDir } : {}),
      assertCurrent,
    });
  }
  throw failure('INVALID');
}

type BrowserRun = {
  context: Pick<IabTrustedContext, 'principalId' | 'executorId'>;
  controller: AbortController;
  pending: Set<Promise<void>>;
  release?: Promise<void>;
  cleanup?: Promise<void>;
};
function runKey(context: BrowserActionContext): string {
  return JSON.stringify([context.agentId, context.sessionKey, context.sessionId, context.runId]);
}

/** Only admitted native identities can be cleaned; late end never resolves a reset key. */
export class IabOpenClawRuns {
  private readonly runs = new Map<string, BrowserRun>();
  private readonly ended = new Set<string>();
  private readonly executors = new Map<string, BrowserRun>();
  private readonly groups = new Map<string, Promise<unknown>>();
  private readonly cleanupBarriers = new Map<string, Promise<void>>();
  private closed = false;
  private readonly reader = new IabOpenClawStore();

  constructor(private readonly cleanupSession: (executorId: string, principalId: string, scope: 'executor' | 'group') => Promise<void>) {}

  async execute<T>(leaf: BrowserActionContext, signal: AbortSignal, action: (context: IabTrustedContext, signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = runKey(leaf);
    if (this.closed || leaf.runId && this.ended.has(key)) throw failure('STALE');
    const scope = this.reader.scope();
    try {
      const verified = await resolveIabOpenClawContext(leaf, signal, scope);
      if (!leaf.runId) {
        if (this.closed) throw failure('CANCELLED');
        await verified.assertCurrent();
        if (this.closed) throw failure('CANCELLED');
        assertActive(signal);
        return await action(verified, signal);
      }
      const run = await this.inGroup(verified.principalId, async () => {
        if (this.closed) throw failure('CANCELLED');
        if (this.ended.has(key)) throw failure('STALE');
        await this.cleanupBarriers.get(verified.principalId);
        assertActive(signal);
        if (this.closed || this.ended.has(key)) throw failure('STALE');
        let captured = this.runs.get(key);
        if (captured) {
          if (captured.context.executorId !== verified.executorId || captured.context.principalId !== verified.principalId) throw failure('STALE');
        } else {
          const previous = this.executors.get(verified.executorId);
          if (previous) await this.cleanup(previous, previous.context.executorId === previous.context.principalId ? 'group' : 'executor');
          await verified.assertCurrent();
          assertActive(signal);
          if (this.closed || this.ended.has(key)) throw failure('STALE');
          captured = { context: { principalId: verified.principalId, executorId: verified.executorId }, controller: new AbortController(), pending: new Set() };
          this.runs.set(key, captured);
          this.executors.set(verified.executorId, captured);
        }
        captured.controller.signal.throwIfAborted();
        return captured;
      });
      const combined = AbortSignal.any([signal, run.controller.signal]);
      const current: IabTrustedContext = Object.freeze({ ...verified, assertCurrent: async () => {
        combined.throwIfAborted();
        await verified.assertCurrent();
        combined.throwIfAborted();
      } });
      const pending = (async () => {
        await current.assertCurrent();
        if (this.closed || this.ended.has(key)) throw failure('STALE');
        combined.throwIfAborted();
        return action(current, combined);
      })();
      const settled = pending.then(() => {}, () => {});
      run.pending.add(settled);
      try { return await pending; }
      finally { run.pending.delete(settled); }
    } finally { await scope.close(); }
  }

  async end(input: BrowserSessionCleanup): Promise<void> {
    const key = runKey(input.context);
    this.ended.add(key);
    const run = this.runs.get(key);
    if (!run) return;
    run.controller.abort(failure('STALE'));
    // A completed A cleanup must not cancel a replacement B in the same group.
    if (input.scope === 'group' && !run.cleanup) {
      for (const candidate of this.runs.values()) {
        if (candidate.context.principalId === run.context.principalId && !candidate.cleanup) candidate.controller.abort(failure('STALE'));
      }
    }
    await this.inGroup(run.context.principalId, () => this.cleanup(run, input.scope));
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const run of this.runs.values()) run.controller.abort(failure('CANCELLED'));
    const outcomes = await Promise.allSettled([...this.runs.values()].map((run) => this.inGroup(run.context.principalId, () => this.cleanup(run, 'group'))));
    await this.reader.close();
    const failures = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected').map((outcome) => outcome.reason);
    if (failures.length) throw new AggregateError(failures, 'OpenClaw browser runs did not finish cleanup');
  }

  private inGroup<T>(principalId: string, action: () => Promise<T>): Promise<T> {
    const pending = (this.groups.get(principalId) ?? Promise.resolve()).then(action, action);
    const tail = pending.then(() => {}, () => {});
    this.groups.set(principalId, tail);
    void tail.then(() => { if (this.groups.get(principalId) === tail) this.groups.delete(principalId); });
    return pending;
  }

  private cleanup(run: BrowserRun, scope: 'executor' | 'group'): Promise<void> {
    if (run.cleanup) return run.cleanup;
    if (scope === 'executor' && run.release) return run.release;
    const affected = scope === 'group'
      ? [...this.runs.values()].filter((candidate) => candidate.context.principalId === run.context.principalId && !candidate.cleanup)
      : [run];
    for (const candidate of affected) candidate.controller.abort(failure('STALE'));
    const settling = affected.flatMap((candidate) => [...candidate.pending, ...(candidate.release ? [candidate.release] : [])]);
    const pending = Promise.resolve().then(async () => {
      await this.cleanupSession(run.context.executorId, run.context.principalId, scope);
      await Promise.all(settling);
    });
    if (scope === 'group') for (const candidate of affected) candidate.cleanup = pending;
    else run.release = pending;
    this.cleanupBarriers.set(run.context.principalId, pending);
    void pending.then(() => {
      if (this.cleanupBarriers.get(run.context.principalId) === pending) this.cleanupBarriers.delete(run.context.principalId);
    }, () => {});
    return pending;
  }
}
