import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import type { BrowserActionParams } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import { canAccessPage, canClosePage } from '../../../packages/openclaw-browser-relay-plugin/src/state/page-ownership';
import type { IabJsonValue } from '../../../src/types/desktop/iab';
import type { IabAutomation, IabAutomationOptions, IabCdpLease, IabTrustedContext } from './contracts';
import type { AutomationEffect, AutomationReply, AutomationToMain, AutomationToWorker } from './automation-port';
import { deserializeAutomationError, serializeAutomationError } from './automation-port';
import { finishWorkspaceDownload, prepareWorkspaceDirectory, resolveWorkspacePath, saveWorkspaceFile } from './automation-files';
import { iabError } from './error';

type Invocation = {
  context: IabTrustedContext;
  controller: AbortController;
  work: Set<Promise<void>>;
  claims: Map<string, { signal: AbortSignal; unsubscribe(): void }>;
  openedTabId?: string;
  settled: Promise<void>;
  finish(): void;
  resolve(reply: AutomationReply): void;
};
type Lease = { lease: IabCdpLease; executorId: string; claim: AbortSignal; unsubscribe(): void; cleanup?: AbortController };
let nextGeneration = 0;

/** Main retains the original native authority and owns every physical side effect. */
export class IabAutomationWorker implements IabAutomation {
  private readonly generation = ++nextGeneration;
  private readonly requests = new Map<number, Invocation>();
  private readonly leases = new Map<string, Lease>();
  private readonly inflight = new Set<Promise<unknown>>();
  private readonly revoking = new Map<string, Promise<void>>();
  private readonly events: Extract<AutomationToWorker, { type: 'events' }>['events'] = [];
  private readonly unsubscribe: () => void;
  private nextId = 0;
  private worker?: Worker;
  private exited?: Promise<void>;
  private revoked?: Promise<void>;
  private failure?: Error;
  private closed = false;
  private closing?: Promise<void>;
  private acknowledged = false;
  private eventScheduled = false;

  constructor(private readonly options: IabAutomationOptions) {
    this.unsubscribe = options.manager.onEvent((event) => {
      if (event.type === 'tabs-changed' && this.worker) this.post({ type: 'tabs', tabs: event.snapshot.tabs.map(({ id, ownerId }) => ({ id, ownerId })) });
    });
  }

  handleRequest(params: BrowserActionParams, context: IabTrustedContext, signal: AbortSignal): Promise<IabJsonValue> {
    const work = this.run(params, context, signal);
    this.inflight.add(work);
    void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work));
    return work;
  }

  releaseClaim(tabId: string, executorId: string): Promise<void> {
    const reason = iabError('IAB_CLAIM_RELEASED', 'Browser page claim was released');
    const affected: Invocation[] = [];
    for (const [id, request] of this.requests) {
      if (request.context.executorId !== executorId || !request.claims.has(tabId)) continue;
      affected.push(request);
      request.controller.abort(reason);
      this.post({ type: 'cancel', id, error: serializeAutomationError(reason) });
    }
    for (const [id, state] of this.leases) {
      if (state.lease.tabId !== tabId || state.executorId !== executorId) continue;
      this.removeEvents(id);
      this.queueEvent(id, { method: 'IAB.leaseRevoked', params: {} });
      state.unsubscribe(); state.lease.release(); this.leases.delete(id);
    }
    const previous = this.revoking.get(tabId);
    const drained = this.options.broker.revokeTarget(tabId, this.options.manager.ownerId);
    const settled = Promise.allSettled([...(previous ? [previous] : []), drained, ...affected.map((request) => request.settled)]).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Browser page claim release did not physically drain');
    });
    this.revoking.set(tabId, settled);
    const clear = () => { if (this.revoking.get(tabId) === settled) this.revoking.delete(tabId); };
    void settled.then(clear, clear);
    this.flushEvents();
    return settled;
  }

  dispose(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      for (const [id, request] of this.requests) {
        const reason = iabError('IAB_AUTOMATION_CLOSED', 'IAB automation is closing');
        request.controller.abort(reason);
        this.post({ type: 'cancel', id, error: serializeAutomationError(reason) });
      }
      await Promise.allSettled([...this.inflight]);
      if (this.worker && !this.failure) this.post({ type: 'close' });
      await this.exited;
      this.unsubscribe();
      await this.revoke();
      for (const state of this.leases.values()) {
        if (state.cleanup) await state.lease.drain(state.cleanup.signal);
        state.unsubscribe(); state.lease.release();
      }
      this.leases.clear();
      if (this.failure) throw this.failure;
    })();
  }

  private start(): void {
    if (this.failure) throw this.failure;
    if (this.worker) return;
    const worker = new Worker(join(__dirname, 'iab', 'automation-worker.js'));
    this.worker = worker;
    worker.on('message', (message: AutomationToMain) => this.receive(message));
    worker.once('error', (error) => { this.failure = error instanceof Error ? error : new Error(String(error)); });
    worker.once('messageerror', (error) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      for (const [id, request] of this.requests) {
        request.controller.abort(error);
        this.post({ type: 'cancel', id, error: serializeAutomationError(error) });
      }
      // Never terminate a worker to manufacture a drain acknowledgement.
      this.post({ type: 'close' });
    });
    this.exited = new Promise<void>((resolve) => worker.once('exit', (code) => {
      this.worker = undefined;
      if (!this.acknowledged || code !== 0) this.failure ??= iabError('IAB_WORKER_EXITED', `IAB worker exited without a clean resource acknowledgement (${code})`);
      void this.revoke();
      for (const [id, request] of this.requests) {
        request.controller.abort(this.failure);
        request.resolve({ id, ok: false, error: serializeAutomationError(this.failure ?? iabError('IAB_WORKER_EXITED', 'IAB worker exited')) });
      }
      resolve();
    }));
  }

  private async run(params: BrowserActionParams, context: IabTrustedContext, signal: AbortSignal): Promise<IabJsonValue> {
    if (this.closed) throw iabError('IAB_AUTOMATION_CLOSED', 'IAB automation is closed');
    signal.throwIfAborted(); await context.assertCurrent(); signal.throwIfAborted();
    if (this.closed) throw iabError('IAB_AUTOMATION_CLOSED', 'IAB automation is closed');
    this.start();
    const id = ++this.nextId;
    const controller = new AbortController();
    let resolve!: (reply: AutomationReply) => void;
    const result = new Promise<AutomationReply>((done) => { resolve = done; });
    let finish!: () => void;
    const settled = new Promise<void>((done) => { finish = done; });
    const request: Invocation = { context, controller, work: new Set(), claims: new Map(), settled, finish, resolve };
    this.requests.set(id, request);
    const abort = () => {
      controller.abort(signal.reason);
      this.post({ type: 'cancel', id, error: serializeAutomationError(signal.reason) });
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      controller.signal.throwIfAborted();
      this.post({ type: 'request', id, params, context: { principalId: context.principalId, executorId: context.executorId, sessionKey: context.sessionKey, workspaceDir: context.workspaceDir } });
      const reply = await result;
      // Logical rejects, worker exit and CDP invalidation are not physical drain.
      while (request.work.size) await Promise.all([...request.work]);
      await this.options.broker.drain(controller.signal);
      if (this.revoked) await this.revoked;
      if (this.failure) for (const state of this.leases.values()) if (state.cleanup) await state.lease.drain(state.cleanup.signal);
      signal.throwIfAborted();
      if (!reply.ok) throw deserializeAutomationError(reply.error);
      await this.check(request);
      return reply.value as IabJsonValue;
    } catch (error) {
      if (request.openedTabId) {
        try {
          while (request.work.size) await Promise.all([...request.work]);
          await this.options.broker.drain(controller.signal);
          await this.check(request);
          const ownership = this.options.manager.getPageOwnership(request.openedTabId);
          if (ownership && canClosePage(ownership, context.executorId)) {
            request.claims.get(request.openedTabId)?.unsubscribe(); request.claims.delete(request.openedTabId);
            this.options.manager.close(request.openedTabId, this.options.manager.ownerId, context);
          }
        } catch { /* Failed-open cleanup must not replace the original action failure. */ }
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
      for (const claim of request.claims.values()) claim.unsubscribe();
      this.requests.delete(id);
      request.finish();
    }
  }

  private async check(request: Invocation): Promise<void> {
    request.controller.signal.throwIfAborted();
    await request.context.assertCurrent();
    request.controller.signal.throwIfAborted();
    for (const [tabId, claim] of request.claims) {
      claim.signal.throwIfAborted();
      if (this.options.manager.agentAccess(tabId, request.context, false) !== claim.signal) throw iabError('IAB_CLAIM_RELEASED', 'Browser page claim changed during this invocation');
    }
  }

  // Callers verify native currency before admitting a new page claim.
  private access(tabId: string, request: Invocation): AbortSignal {
    request.controller.signal.throwIfAborted();
    const signal = this.options.manager.agentAccess(tabId, request.context);
    signal.throwIfAborted();
    if (!request.claims.has(tabId)) {
      const abort = () => {
        request.controller.abort(signal.reason);
        for (const [id, candidate] of this.requests) if (candidate === request) this.post({ type: 'cancel', id, error: serializeAutomationError(signal.reason) });
      };
      signal.addEventListener('abort', abort, { once: true });
      request.claims.set(tabId, { signal, unsubscribe: () => signal.removeEventListener('abort', abort) });
    }
    return signal;
  }

  private revoke(): Promise<void> {
    return this.revoked ??= this.options.broker.revokeGeneration(this.generation);
  }

  private post(message: AutomationToWorker): void { this.worker?.postMessage(message); }

  private queueEvent(leaseId: string, event: Extract<AutomationToWorker, { type: 'events' }>['events'][number]['event']): void {
    this.events.push({ leaseId, event });
    if (this.events.length >= 64) this.flushEvents();
    else if (!this.eventScheduled) {
      this.eventScheduled = true;
      queueMicrotask(() => { this.eventScheduled = false; this.flushEvents(); });
    }
  }

  private removeEvents(leaseId: string): void {
    for (let index = this.events.length - 1; index >= 0; index--) if (this.events[index].leaseId === leaseId) this.events.splice(index, 1);
  }

  private flushEvents(): void {
    while (this.events.length) this.post({ type: 'events', events: this.events.splice(0, 64) });
  }

  private receive(message: AutomationToMain): void {
    switch (message.type) {
      case 'result': this.requests.get(message.reply.id)?.resolve(message.reply); return;
      case 'closed': this.acknowledged = true; return;
      case 'abort': this.requests.get(message.invocation)?.controller.abort(deserializeAutomationError(message.error)); return;
      case 'cancel-lease': {
        const request = this.requests.get(message.invocation);
        const state = this.leases.get(message.leaseId);
        if (request && state?.executorId === request.context.executorId) state.lease.cancel(request.controller.signal);
        return;
      }
      case 'release-download': {
        const lease = this.leases.get(message.leaseId)?.lease;
        if (lease) {
          const contents = this.options.manager.getWebContents(lease.tabId);
          if (contents) this.options.manager.data.downloads.releaseDownloadCapture(contents, lease.id);
        }
        return;
      }
      case 'release-lease': {
        const state = this.leases.get(message.leaseId);
        this.removeEvents(message.leaseId);
        state?.unsubscribe(); state?.lease.release(); this.leases.delete(message.leaseId); return;
      }
      case 'teardown': {
        const state = this.leases.get(message.leaseId);
        const work = (async () => {
          if (!state) return {};
          state.cleanup ??= new AbortController();
          if (message.method) return state.lease.cleanup(message.method, message.params, state.cleanup.signal);
          await state.lease.drain(state.cleanup.signal);
          state.cleanup = undefined;
          return {};
        })();
        void this.reply(message.id, work);
        return;
      }
      case 'effect': {
        const request = this.requests.get(message.invocation);
        if (!request) { void this.reply(message.id, Promise.reject(iabError('IAB_INVOCATION_STALE', 'Browser invocation has ended'))); return; }
        const work = this.effect(message.effect, request);
        if (message.effect.kind !== 'drain' && message.effect.kind !== 'release-claims') {
          const settled = work.then(() => {}, () => {});
          request.work.add(settled);
          void settled.then(() => request.work.delete(settled));
        }
        void this.reply(message.id, work);
      }
    }
  }

  private async reply(id: number, work: Promise<unknown>): Promise<void> {
    let reply: AutomationReply;
    try { reply = { id, ok: true, value: await work }; }
    catch (error) { reply = { id, ok: false, error: serializeAutomationError(error) }; }
    this.flushEvents(); this.post({ type: 'reply', reply });
  }

  private async effect(effect: AutomationEffect, request: Invocation): Promise<unknown> {
    const { manager, broker } = this.options;
    const { context, controller } = request;
    const signal = controller.signal;
    const check = () => this.check(request);
    const trusted: IabTrustedContext = { ...context, assertCurrent: check };
    if (effect.kind === 'drain') {
      while (request.work.size) await Promise.all([...request.work]);
      await broker.drain(signal);
      return {};
    }
    if (effect.kind === 'restore-screenshot-viewport') {
      const state = this.leases.get(effect.leaseId);
      if (!state || state.executorId !== context.executorId || state.lease.ownerId !== manager.ownerId || state.lease.generation !== this.generation) throw iabError('IAB_LEASE_INVALID', 'Screenshot lease does not belong to this worker and verified executor');
      return state.lease.executor.restoreScreenshotViewport(signal);
    }
    const ownedLease = (id: string) => {
      const state = this.leases.get(id);
      if (!state || state.executorId !== context.executorId || state.lease.ownerId !== manager.ownerId || state.lease.generation !== this.generation) throw iabError('IAB_LEASE_INVALID', 'CDP lease does not belong to this worker and verified executor');
      state.claim.throwIfAborted();
      if (manager.agentAccess(state.lease.tabId, context, false) !== state.claim) throw iabError('IAB_LEASE_INVALID', 'CDP lease belongs to an ended page claim');
      this.access(state.lease.tabId, request);
      broker.bindTarget(state.lease.tabId, manager.ownerId, signal);
      return state.lease;
    };
    // Existing-lease effects check native currency at the broker's physical dispatch boundary.
    switch (effect.kind) {
      case 'screenshot-viewport': return ownedLease(effect.leaseId).executor.setScreenshotViewport({ timeoutMs: effect.timeoutMs, signal, assertCurrent: check });
      case 'command': {
        const result = await ownedLease(effect.leaseId).executor.send(effect.method, effect.params, { sessionId: effect.sessionId, timeoutMs: effect.timeoutMs, signal, assertCurrent: check });
        if (effect.method !== 'Page.captureScreenshot') return result;
        await check();
        return { ...result, data: await normalizeScreenshot(String(result.data), check) };
      }
      case 'frames': return ownedLease(effect.leaseId).executor.listChildFrames({ signal, timeoutMs: effect.timeoutMs, assertCurrent: check });
      case 'intercept': return ownedLease(effect.leaseId).executor.setInterceptPolicy(effect.rules, { signal, assertCurrent: check });
    }
    await check();
    switch (effect.kind) {
      case 'tabs': {
        const tabs = manager.listAllTabs().filter((tab) => canAccessPage(tab, context.executorId, context.principalId));
        const activeTabId = manager.getActiveTabId(manager.ownerId);
        return { tabs, activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null };
      }
      case 'release-claims':
        await Promise.all([...request.work]);
        await broker.drain(signal);
        await check();
        // The releasing invocation must not cancel itself or join its own settled promise.
        for (const claim of request.claims.values()) claim.unsubscribe();
        request.claims.clear();
        await manager.releaseSessionClaims(context.executorId);
        return {};
      case 'check-target': {
        if (effect.operation === 'close' && manager.getOwner(effect.tabId) === null && manager.getWebContents(effect.tabId) === null) return false;
        this.access(effect.tabId, request);
        broker.bindTarget(effect.tabId, manager.ownerId, signal);
        if (effect.operation === 'close') {
          const ownership = manager.getPageOwnership(effect.tabId);
          if (!ownership || !canClosePage(ownership, context.executorId)) throw iabError('IAB_AGENT_CLOSE_DENIED', 'Only this agent session\'s non-retained browser tabs can be closed');
        }
        return true;
      }
      case 'open': {
        const tabId = manager.open(effect.url, { creator: context, retain: effect.retain, background: true });
        request.openedTabId = tabId;
        this.access(tabId, request);
        broker.bindTarget(tabId, manager.ownerId, signal);
        return tabId;
      }
      case 'close-tab':
        this.access(effect.tabId, request);
        request.claims.get(effect.tabId)?.unsubscribe(); request.claims.delete(effect.tabId);
        manager.close(effect.tabId, manager.ownerId, trusted);
        return {};
      case 'show': this.access(effect.tabId, request); broker.bindTarget(effect.tabId, manager.ownerId, signal); manager.requestShow(manager.ownerId, effect.tabId); return {};
      case 'acquire': {
        const claim = this.access(effect.tabId, request);
        const lease = await broker.acquire(effect.tabId, manager.ownerId, signal, this.generation, check);
        try { await check(); } catch (error) { lease.release(); throw error; }
        const unsubscribe = lease.executor.onEvent((event) => this.queueEvent(lease.id, event));
        this.leases.set(lease.id, { lease, executorId: context.executorId, claim, unsubscribe });
        return { id: lease.id, tabId: lease.tabId, ownerId: lease.ownerId, generation: lease.generation };
      }
      case 'read-script': {
        const read = async () => {
          const file = await resolveWorkspacePath(trusted, effect.path, false, signal);
          await check();
          const expression = await readFile(file, { encoding: 'utf8', signal });
          await check(); return expression;
        };
        try { return await read(); }
        catch (error) {
          await check();
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await delay(300, undefined, { signal });
          await check(); return read();
        }
      }
      case 'resolve-files': return Promise.all(effect.paths.map((path) => resolveWorkspacePath(trusted, path, false, signal)));
      case 'save-file': return saveWorkspaceFile(trusted, effect.path, Buffer.from(effect.bytes), signal, effect.atomic);
      case 'prepare-download': {
        const directory = await prepareWorkspaceDirectory(trusted, effect.dir ?? (effect.savePath ? dirname(effect.savePath) : 'downloads'), signal);
        if (effect.savePath && dirname(await resolveWorkspacePath(trusted, effect.savePath, true, signal)) !== directory) throw iabError('IAB_DOWNLOAD_DIRECTORY_MISMATCH', 'Download savePath and dir must refer to the same directory');
        await check(); return directory;
      }
      case 'finish-download': {
        const lease = ownedLease(effect.leaseId);
        return finishWorkspaceDownload(trusted, effect.file, lease, manager.resolveBrokerTarget(lease.tabId, manager.ownerId), manager.data.downloads, signal, this.options.log);
      }
    }
  }
}

async function normalizeScreenshot(data: string, check: () => Promise<void>): Promise<string> {
  const buffer = Buffer.from(data, 'base64');
  if (buffer.byteLength <= 5 * 1024 * 1024) return data;
  try {
    const sharp = (await import('sharp')).default;
    await check();
    const image = sharp(buffer);
    const metadata = await image.metadata();
    await check();
    const resize = { width: (metadata.width ?? 0) > (metadata.height ?? 0) ? 2000 : undefined, height: (metadata.height ?? 0) >= (metadata.width ?? 0) ? 2000 : undefined, fit: 'inside' as const, withoutEnlargement: true };
    let compressionLevel = 6;
    let output = await image.resize(resize).png({ compressionLevel }).toBuffer();
    await check();
    while (output.byteLength > 5 * 1024 * 1024 && compressionLevel < 9) {
      output = await sharp(buffer).resize(resize).png({ compressionLevel: ++compressionLevel }).toBuffer();
      await check();
    }
    return output.toString('base64');
  } catch {
    await check();
    return data;
  }
}
