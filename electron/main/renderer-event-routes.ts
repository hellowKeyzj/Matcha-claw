import { randomBytes } from 'node:crypto';
import type { WebContents } from 'electron';
import type { SessionObservationResult } from '../../src/types/session/snapshot';
import { logger } from '../utils/logger';
import { isSessionTraceEnabled, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity } from './runtime-host-delivery/transport/sessions/trace';
import {
  isSessionIdentity,
  sameSessionIdentity,
  type SessionDelta,
  type SessionIdentity,
} from './runtime-host-delivery/transport/sessions/session-contract';

export const SESSION_PAGE_HEADER = 'X-MatchaClaw-Session-Page';
export type SessionPage = Readonly<{ token: string; contents: WebContents }>;
type ObservationLease = {
  page: SessionPage;
  identity: SessionIdentity;
  leaseId: string;
  nativeLeaseId: string;
  pending: number;
  acquired: boolean;
};
type Observation = {
  lease: ObservationLease;
  nativeLeaseId: string;
  settled: boolean;
};
type SendDemand = {
  page: SessionPage;
  identity: SessionIdentity;
  runId?: string;
  terminalRuns: Set<string>;
  goalOutcomeUnknown?: true;
};

export class RendererSessionObservationRegistry {
  private readonly pages = new Map<string, SessionPage>();
  private readonly contents = new Map<number, SessionPage>();
  private readonly observations = new Set<ObservationLease>();
  private readonly sends = new Set<SendDemand>();
  private releaseNative?: (identity: SessionIdentity, leaseId: string) => Promise<unknown>;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly releases = new Set<Promise<void>>();
  private closed = false;
  private releaseFailed = false;
  private closing?: Promise<void>;

  attach(contents: WebContents): void {
    const renew = (): void => {
      this.clearContents(contents.id);
      if (this.closed || contents.isDestroyed()) return;
      const page = { token: randomBytes(24).toString('base64url'), contents };
      this.pages.set(page.token, page);
      this.contents.set(contents.id, page);
    };
    renew();
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) renew();
    });
    contents.on('render-process-gone', () => this.clearContents(contents.id));
    contents.on('destroyed', () => this.clearContents(contents.id));
  }

  capture(contents: WebContents): SessionPage | undefined {
    return this.contents.get(contents.id);
  }

  resolve(token: string | string[] | undefined): SessionPage | undefined {
    return typeof token === 'string' ? this.pages.get(token) : undefined;
  }

  isCurrent(page: SessionPage | undefined): page is SessionPage {
    return page !== undefined && this.pages.get(page.token) === page && !page.contents.isDestroyed();
  }

  setNativeRelease(release: (identity: SessionIdentity, leaseId: string) => Promise<unknown>): void {
    this.releaseNative = release;
  }

  beginObservation(page: SessionPage | undefined, identity: SessionIdentity, leaseId: string): Observation {
    this.requirePage(page, identity);
    let lease = [...this.observations].find((entry) => entry.leaseId === leaseId);
    if (lease) {
      if (lease.page !== page || !sameSessionIdentity(lease.identity, identity)) {
        throw new Error('Session observation lease is not authorized');
      }
    } else {
      lease = { page, identity, leaseId, nativeLeaseId: randomBytes(24).toString('base64url'), pending: 0, acquired: false };
      this.observations.add(lease);
    }
    lease.pending += 1;
    return { lease, nativeLeaseId: lease.nativeLeaseId, settled: false };
  }

  completeObservation(entry: Observation, nativeLeaseId: string): boolean {
    const { lease } = entry;
    if (entry.settled || nativeLeaseId !== entry.nativeLeaseId || !this.observations.has(lease) || !this.isCurrent(lease.page)) return false;
    entry.settled = true;
    lease.pending -= 1;
    lease.acquired = true;
    for (const demand of this.sends) {
      if (demand.goalOutcomeUnknown && demand.page === lease.page
        && sameSessionIdentity(demand.identity, lease.identity)) this.sends.delete(demand);
    }
    return true;
  }

  async rollbackObservation(entry: Observation): Promise<void> {
    const { lease } = entry;
    if (!entry.settled) { entry.settled = true; lease.pending -= 1; }
    if (this.observations.has(lease) && (lease.acquired || lease.pending > 0)) return;
    this.observations.delete(lease);
    await this.releaseLease(lease.identity, lease.nativeLeaseId);
  }

  async releaseObservation(page: SessionPage | undefined, identity: SessionIdentity, leaseId: string): Promise<boolean> {
    this.requirePage(page, identity);
    const entry = [...this.observations].find((candidate) => candidate.page === page
      && candidate.leaseId === leaseId && sameSessionIdentity(candidate.identity, identity));
    if (!entry) return false;
    this.observations.delete(entry);
    await this.releaseLease(entry.identity, entry.nativeLeaseId);
    return true;
  }

  async trackOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error('Session observation registry is closed');
    const pending = operation();
    this.operations.add(pending);
    try { return await pending; } finally { this.operations.delete(pending); }
  }

  beginSend(page: SessionPage | undefined, identity: SessionIdentity, runId?: string): SendDemand {
    this.requirePage(page, identity);
    const entry = { page, identity, runId, terminalRuns: new Set<string>() };
    this.sends.add(entry);
    return entry;
  }

  bindSend(entry: SendDemand, runId: string): void {
    if (!this.sends.has(entry)) return;
    entry.runId = runId;
    if (entry.terminalRuns.has(runId)) this.sends.delete(entry);
    entry.terminalRuns.clear();
  }

  releaseSend(entry: SendDemand): void {
    this.sends.delete(entry);
  }

  retainUnknownGoalSend(entry: SendDemand): void {
    if (!this.sends.has(entry)) return;
    entry.goalOutcomeUnknown = true;
    if ([...this.observations].some((lease) => lease.acquired && lease.page === entry.page
      && sameSessionIdentity(lease.identity, entry.identity))) this.sends.delete(entry);
  }

  publish(identity: SessionIdentity, eventName: 'session.delta' | 'session.resync', payload: unknown): void {
    let delivered = 0;
    for (const { page, identity: authorized } of this.active()) {
      const matches = sameSessionIdentity(identity, authorized);
      const current = matches && this.isCurrent(page);
      if (isSessionTraceEnabled()) logSessionTrace('electron.session.route.receiver', 'session-route-boundary', {
        identity: summarizeSessionIdentity(identity), authorized: summarizeSessionIdentity(authorized),
        eventName, pageHash: summarizeIdentifier(page.token).hash, delivered: !!current,
        reason: !matches ? 'identity-not-authorized' : !current ? 'page-not-current' : null,
        ...sessionEventWatermark(payload),
      });
      if (current) {
        try {
          page.contents.send('host:event', { eventName, payload });
          delivered += 1;
        } catch (error) {
          if (isSessionTraceEnabled()) logSessionTrace('electron.session.route.delivery.failed', 'session-route-boundary', {
            identity: summarizeSessionIdentity(identity), eventName, pageHash: summarizeIdentifier(page.token).hash,
            ...sessionEventWatermark(payload), error: summarizeIdentifier(error instanceof Error ? error.message : String(error)),
          });
          throw error;
        }
      }
    }
    if (isSessionTraceEnabled()) logSessionTrace('electron.session.route.publish', 'session-route-boundary', {
      identity: summarizeSessionIdentity(identity), eventName, delivered, reason: delivered ? null : 'no-authorized-receiver',
      ...sessionEventWatermark(payload),
    });
  }

  terminal(delta: SessionDelta): void {
    const terminalRuns = delta.changes.flatMap((change) => {
      if (change.kind === 'runPhaseChanged' && isTerminal(change.phase)) return [change.runId];
      if (change.kind === 'runtimeChanged' && isTerminal(change.runtime.phase)) {
        const runId = change.runtime.activeRunId ?? delta.runId;
        return runId ? [runId] : [];
      }
      return [];
    });
    terminalRuns.forEach((runId) => this.terminalRun(delta.identity, runId));
  }

  active(): readonly Readonly<{ page: SessionPage; identity: SessionIdentity }>[] {
    const entries = new Map<string, { page: SessionPage; identity: SessionIdentity }>();
    for (const { page, identity } of [...this.observations, ...this.sends]) {
      if (this.isCurrent(page)) entries.set(JSON.stringify([page.token, identity.endpoint.kind, identity.endpoint.runtimeAdapterId,
        identity.endpoint.runtimeInstanceId, identity.agentId, identity.sessionKey]), { page, identity });
    }
    return [...entries.values()];
  }

  async resync(observe: (identity: SessionIdentity, leaseId: string) => Promise<SessionObservationResult<{ epoch: number; seq: number; runtime: unknown }> | null>): Promise<void> {
    if (this.closed) return;
    await this.trackOperation(() => Promise.allSettled(this.active().map(async ({ page, identity }) => {
      const entry = [...this.observations].find((candidate) => candidate.page === page && sameSessionIdentity(candidate.identity, identity));
      if (entry && !entry.acquired) {
        if (isSessionTraceEnabled()) logSessionTrace('electron.session.route.resync.drop', 'session-route-boundary', {
          identity: summarizeSessionIdentity(identity), pageHash: summarizeIdentifier(page.token).hash, reason: 'observation-pending',
        });
        return;
      }
      const attempt = entry ? this.beginObservation(page, identity, entry.leaseId) : undefined;
      const leaseId = attempt?.nativeLeaseId ?? randomBytes(24).toString('base64url');
      const trace = (stage: string, extra: Record<string, unknown> = {}) => {
        if (isSessionTraceEnabled()) logSessionTrace(stage, 'session-route-boundary', {
          identity: summarizeSessionIdentity(identity), pageHash: summarizeIdentifier(page.token).hash,
          leaseHash: summarizeIdentifier(leaseId).hash, ...extra,
        });
      };
      let completed = false;
      try {
        trace('electron.session.route.resync.request');
        const result = await observe(identity, leaseId).catch((error) => {
          if (isSessionTraceEnabled()) trace('electron.session.route.resync.failed', { error: summarizeIdentifier(error instanceof Error ? error.message : String(error)) });
          return null;
        });
        if (!result || result.leaseId !== leaseId || !this.isCurrent(page)) {
          trace('electron.session.route.resync.drop', { reason: !result ? 'observe-unavailable' : result.leaseId !== leaseId ? 'lease-mismatch' : 'page-not-current',
            epoch: result && 'view' in result ? result.view.epoch : null, seq: result && 'view' in result ? result.view.seq : null });
          return;
        }
        if ('outcome' in result) {
          trace('electron.session.route.resync.drop', { reason: 'observation-released' });
          return;
        }
        trace('electron.session.route.resync.response', { epoch: result.view.epoch, seq: result.view.seq });
        if (attempt && !(completed = this.completeObservation(attempt, result.leaseId))) {
          trace('electron.session.route.resync.drop', { reason: 'observation-not-current', epoch: result.view.epoch, seq: result.view.seq });
          return;
        }
        if (typeof result.view.runtime === 'object' && result.view.runtime !== null) {
          const runtime = result.view.runtime as { phase?: unknown; activeRunId?: unknown };
          if (typeof runtime.phase === 'string' && isTerminal(runtime.phase) && typeof runtime.activeRunId === 'string') {
            this.terminalRun(identity, runtime.activeRunId);
          }
        }
        if (this.active().some((candidate) => candidate.page === page && sameSessionIdentity(candidate.identity, identity))) {
          try {
            page.contents.send('host:event', { eventName: 'session.resync', payload: { identity, epoch: result.view.epoch, seq: result.view.seq } });
            trace('electron.session.route.resync.delivered', { epoch: result.view.epoch, seq: result.view.seq });
          } catch (error) {
            if (isSessionTraceEnabled()) trace('electron.session.route.resync.failed', { epoch: result.view.epoch, seq: result.view.seq,
              error: summarizeIdentifier(error instanceof Error ? error.message : String(error)) });
            throw error;
          }
        } else trace('electron.session.route.resync.drop', { epoch: result.view.epoch, seq: result.view.seq, reason: 'no-active-demand' });
      } finally {
        if (!attempt) await this.releaseLease(identity, leaseId);
        else if (!completed) await this.rollbackObservation(attempt);
      }
    }))).then(() => undefined);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const id of [...this.contents.keys()]) this.clearContents(id);
    this.closing = (async () => {
      await Promise.allSettled([...this.operations]);
      while (this.releases.size > 0) await Promise.allSettled([...this.releases]);
      if (this.releaseFailed) throw new Error('Session observation release failed');
    })();
    return this.closing;
  }

  private terminalRun(identity: SessionIdentity, runId: string): void {
    for (const demand of this.sends) {
      if (!sameSessionIdentity(demand.identity, identity)) continue;
      if (demand.runId === runId) this.sends.delete(demand);
      else demand.terminalRuns.add(runId);
    }
  }

  private requirePage(page: SessionPage | undefined, identity: SessionIdentity): asserts page is SessionPage {
    if (this.closed || !this.isCurrent(page) || !isSessionIdentity(identity)) throw new Error('Session receiver is not authorized');
  }

  private clearContents(id: number): void {
    const page = this.contents.get(id);
    if (!page) return;
    this.contents.delete(id);
    this.pages.delete(page.token);
    for (const entry of this.observations) {
      if (entry.page === page) {
        this.observations.delete(entry);
        void this.releaseLease(entry.identity, entry.nativeLeaseId).catch(() => undefined);
      }
    }
    for (const entry of this.sends) {
      if (entry.page === page) this.sends.delete(entry);
    }
  }

  private releaseLease(identity: SessionIdentity, leaseId: string): Promise<void> {
    const pending = Promise.resolve().then(async () => {
      if (!this.releaseNative) throw new Error('Session observation release is unavailable');
      await this.releaseNative(identity, leaseId);
    });
    this.releases.add(pending);
    void pending.then(() => this.releases.delete(pending), () => {
      this.releases.delete(pending);
      this.releaseFailed = true;
      logger.warn('Session observation native lease release failed');
    });
    return pending;
  }
}

function sessionEventWatermark(payload: unknown) {
  const value = payload as { epoch?: number; seq?: number; cursor?: number } | null;
  return { epoch: value?.epoch ?? null, seq: value?.seq ?? null, cursor: value?.cursor ?? null };
}

function isTerminal(phase: string): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled' || phase === 'interrupted';
}
