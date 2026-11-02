import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { BrowserActionParams } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
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
  grants: Map<string, { signal: AbortSignal; unsubscribe(): void }>;
  settled: Promise<void>;
  finish(): void;
  resolve(reply: AutomationReply): void;
};
type Lease = { lease: IabCdpLease; principalId: string; grant: AbortSignal; unsubscribe(): void; cleanup?: AbortController };
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

  revokeAccess(tabId: string, principalId: string): Promise<void> {
    const reason = iabError('IAB_ACCESS_REVOKED', 'Browser page access was revoked');
    const affected: Invocation[] = [];
    for (const [id, request] of this.requests) {
      if (request.context.principalId !== principalId || !request.grants.has(tabId)) continue;
      affected.push(request);
      request.controller.abort(reason);
      this.post({ type: 'cancel', id, error: serializeAutomationError(reason) });
    }
    for (const [id, state] of this.leases) {
      if (state.lease.tabId !== tabId) continue;
      this.removeEvents(id);
      this.queueEvent(id, { method: 'IAB.leaseRevoked', params: {} });
      state.unsubscribe(); state.lease.release(); this.leases.delete(id);
    }
    const previous = this.revoking.get(tabId);
    const drained = this.options.broker.revokeTarget(tabId, this.options.manager.ownerId);
    const settled = Promise.allSettled([...(previous ? [previous] : []), drained, ...affected.map((request) => request.settled)]).then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) throw new AggregateError(failures, 'Browser page access revocation did not physically drain');
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
    signal.throwIfAborted(); context.assertCurrent(); this.start();
    const id = ++this.nextId;
    const controller = new AbortController();
    let resolve!: (reply: AutomationReply) => void;
    const result = new Promise<AutomationReply>((done) => { resolve = done; });
    let finish!: () => void;
    const settled = new Promise<void>((done) => { finish = done; });
    const request: Invocation = { context, controller, work: new Set(), grants: new Map(), settled, finish, resolve };
    this.requests.set(id, request);
    const abort = () => {
      controller.abort(signal.reason);
      this.post({ type: 'cancel', id, error: serializeAutomationError(signal.reason) });
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) abort();
      controller.signal.throwIfAborted();
      const tabId = ('targetId' in params ? params.targetId : undefined) ?? (params.action === 'act' || params.action === 'utility' ? params.request?.targetId : undefined);
      if (tabId) {
        this.access(tabId, request);
        this.options.broker.bindTarget(tabId, this.options.manager.ownerId, controller.signal);
      }
      this.post({ type: 'request', id, params, context: { principalId: context.principalId, sessionKey: context.sessionKey, workspaceDir: context.workspaceDir } });
      const reply = await result;
      // Logical rejects, worker exit and CDP invalidation are not physical drain.
      while (request.work.size) await Promise.all([...request.work]);
      await this.options.broker.drain(controller.signal);
      if (this.revoked) await this.revoked;
      if (this.failure) for (const state of this.leases.values()) if (state.cleanup) await state.lease.drain(state.cleanup.signal);
      signal.throwIfAborted();
      if (!reply.ok) throw deserializeAutomationError(reply.error);
      this.check(request);
      return reply.value as IabJsonValue;
    } finally {
      signal.removeEventListener('abort', abort);
      for (const grant of request.grants.values()) grant.unsubscribe();
      this.requests.delete(id);
      request.finish();
    }
  }

  private check(request: Invocation): void {
    request.controller.signal.throwIfAborted(); request.context.assertCurrent();
    for (const [tabId, grant] of request.grants) {
      grant.signal.throwIfAborted();
      if (this.options.manager.agentAccess(tabId, request.context.principalId) !== grant.signal) throw iabError('IAB_ACCESS_REVOKED', 'Browser page access changed during this invocation');
    }
  }

  private access(tabId: string, request: Invocation): AbortSignal {
    this.check(request);
    const signal = this.options.manager.agentAccess(tabId, request.context.principalId);
    signal.throwIfAborted();
    if (!request.grants.has(tabId)) {
      const abort = () => {
        request.controller.abort(signal.reason);
        for (const [id, candidate] of this.requests) if (candidate === request) this.post({ type: 'cancel', id, error: serializeAutomationError(signal.reason) });
      };
      signal.addEventListener('abort', abort, { once: true });
      request.grants.set(tabId, { signal, unsubscribe: () => signal.removeEventListener('abort', abort) });
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
        if (request && state?.principalId === request.context.principalId) state.lease.cancel(request.controller.signal);
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
        if (message.effect.kind !== 'drain') {
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
      if (!state || state.principalId !== context.principalId || state.lease.ownerId !== manager.ownerId || state.lease.generation !== this.generation) throw iabError('IAB_LEASE_INVALID', 'Screenshot lease does not belong to this worker and verified principal');
      return state.lease.executor.restoreScreenshotViewport(signal);
    }
    check();
    const ownedLease = (id: string) => {
      const state = this.leases.get(id);
      if (!state || state.principalId !== context.principalId || state.lease.ownerId !== manager.ownerId || state.lease.generation !== this.generation) throw iabError('IAB_LEASE_INVALID', 'CDP lease does not belong to this worker and verified principal');
      if (this.access(state.lease.tabId, request) !== state.grant) throw iabError('IAB_LEASE_INVALID', 'CDP lease belongs to a revoked page grant');
      broker.bindTarget(state.lease.tabId, manager.ownerId, signal);
      return state.lease;
    };
    switch (effect.kind) {
      case 'tabs': {
        const tabs = manager.listAllTabs().filter((tab) => tab.agentSessionIds.includes(context.principalId) && !this.access(tab.id, request).aborted);
        const activeTabId = manager.getActiveTabId(manager.ownerId);
        return { tabs, activeTabId: tabs.some((tab) => tab.id === activeTabId) ? activeTabId : null };
      }
      case 'check-target': this.access(effect.tabId, request); broker.bindTarget(effect.tabId, manager.ownerId, signal); return {};
      case 'open': {
        const tabId = manager.open(effect.url, { creator: context });
        this.access(tabId, request);
        broker.bindTarget(tabId, manager.ownerId, signal);
        return tabId;
      }
      case 'close-tab':
        this.access(effect.tabId, request);
        manager.close(effect.tabId, manager.ownerId);
        request.grants.get(effect.tabId)?.unsubscribe(); request.grants.delete(effect.tabId);
        return {};
      case 'show': this.access(effect.tabId, request); broker.bindTarget(effect.tabId, manager.ownerId, signal); manager.requestShow(manager.ownerId, effect.tabId); return {};
      case 'acquire': {
        const grant = this.access(effect.tabId, request);
        const lease = await broker.acquire(effect.tabId, manager.ownerId, signal, this.generation, check);
        try { check(); } catch (error) { lease.release(); throw error; }
        const stopEvents = lease.executor.onEvent((event) => this.queueEvent(lease.id, event));
        const abort = () => {
          const work = this.revokeAccess(effect.tabId, context.principalId);
          this.inflight.add(work);
          void work.then(() => this.inflight.delete(work), () => this.inflight.delete(work));
        };
        grant.addEventListener('abort', abort, { once: true });
        const unsubscribe = () => { stopEvents(); grant.removeEventListener('abort', abort); };
        this.leases.set(lease.id, { lease, principalId: context.principalId, grant, unsubscribe });
        return { id: lease.id, tabId: lease.tabId, ownerId: lease.ownerId, generation: lease.generation };
      }
      case 'screenshot-viewport': return ownedLease(effect.leaseId).executor.setScreenshotViewport({ timeoutMs: effect.timeoutMs, signal, assertCurrent: check });
      case 'command': return ownedLease(effect.leaseId).executor.send(effect.method, effect.params, { sessionId: effect.sessionId, timeoutMs: effect.timeoutMs, signal, assertCurrent: check });
      case 'frames': return ownedLease(effect.leaseId).executor.listChildFrames({ signal, timeoutMs: effect.timeoutMs, assertCurrent: check });
      case 'intercept': return ownedLease(effect.leaseId).executor.setInterceptPolicy(effect.rules, { signal, assertCurrent: check });
      case 'read-script': {
        const file = await resolveWorkspacePath(trusted, effect.path, false);
        check(); return readFile(file, { encoding: 'utf8', signal });
      }
      case 'resolve-files': return Promise.all(effect.paths.map((path) => resolveWorkspacePath(trusted, path, false)));
      case 'save-file': return saveWorkspaceFile(trusted, effect.path, Buffer.from(effect.bytes), signal, effect.atomic);
      case 'prepare-download': {
        const directory = await prepareWorkspaceDirectory(trusted, effect.dir ?? (effect.savePath ? dirname(effect.savePath) : 'downloads'));
        if (effect.savePath && dirname(await resolveWorkspacePath(trusted, effect.savePath, true)) !== directory) throw iabError('IAB_DOWNLOAD_DIRECTORY_MISMATCH', 'Download savePath and dir must refer to the same directory');
        check(); return directory;
      }
      case 'finish-download': {
        const lease = ownedLease(effect.leaseId);
        return finishWorkspaceDownload(trusted, effect.file, lease, manager.resolveBrokerTarget(lease.tabId, manager.ownerId), manager.data.downloads, signal, this.options.log);
      }
    }
  }
}
