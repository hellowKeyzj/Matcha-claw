import { randomUUID } from 'node:crypto';
import type { Debugger, WebContents } from 'electron';
import type { BrowserInterceptRule } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import { resolveIntercept } from './automation-intercept';
import { emulationResetCommands } from './automation-emulation';
import { invalidateIabClientHints } from './client-hints';
import type { IabBroker as IabBrokerContract, IabBrokerOptions, IabCdpEvent, IabCdpExecutor, IabCdpLease } from './contracts';
import type { IabJsonObject, IabJsonValue } from '../../../src/types/desktop/iab';

type TargetKey = { tabId: string; ownerId: string };
type PendingCommand = { epoch: number; leaseId?: string; sessionId?: string; invalidate(reason: string): void };
type PhysicalCommand = { epoch: number; epochScoped: boolean; settled: Promise<void> };
type Controller = {
  key: TargetKey;
  webContents: WebContents;
  contentsId: number;
  debugger: Debugger;
  epoch: number;
  state: 'detached' | 'attached' | 'closed';
  prepared: boolean;
  preparation: Promise<void>;
  resolvePreparation(): void;
  rejectPreparation(error: Error): void;
  leases: Set<string>;
  acquiring: Map<number, number>;
  pending: Set<PendingCommand>;
  physical: Set<PhysicalCommand>;
  childFrames: Map<string, string>;
  childSessions: Set<string>;
  discoveries: Map<string, Promise<void>>;
  attachFlight?: Promise<number>;
  metricsOverride?: IabJsonObject;
  listeners: { message: (...args: any[]) => void; detach: (...args: any[]) => void; destroyed: () => void; gone: () => void };
};
type LeaseState = { id: string; generation: number; controller: Controller; events: Set<(event: IabCdpEvent) => void>; rules: readonly BrowserInterceptRule[]; fetchParams?: IabJsonObject; fetchDisabling?: boolean; cacheDisabled?: boolean };
export type IabCdpBrokerOptions = IabBrokerOptions;

import { iabError } from './error';

/** One physical debugger per WebContents; leases never own the physical connection. */
export class IabBroker implements IabBrokerContract {
  private readonly controllers = new Map<number, Controller>();
  private readonly leases = new Map<string, LeaseState>();
  private readonly revokedGenerations = new Set<number>();
  private readonly generationControllers = new Map<number, Set<Controller>>();
  private readonly operations = new WeakMap<AbortSignal, Set<Promise<void>>>();
  private readonly activeScopes = new Map<AbortSignal, Map<Controller, number>>();
  private readonly drainedSignals = new WeakSet<AbortSignal>();
  private disposed = false;

  constructor(private readonly options: IabCdpBrokerOptions) {}

  async prepareTarget(tabId: string, ownerId: string, webContents: WebContents): Promise<void> {
    const controller = this.resolveController(tabId, ownerId, webContents);
    controller.prepared = true;
    try { await this.attach(controller); controller.resolvePreparation(); }
    catch (error) { controller.rejectPreparation(error instanceof Error ? error : new Error(String(error))); throw error; }
  }

  bindTarget(tabId: string, ownerId: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.drainedSignals.has(signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
    const controller = this.resolveController(tabId, ownerId);
    if (controller.state === 'attached' && !controller.debugger.isAttached()) this.invalidate(controller, controller.epoch, 'debugger detached', false);
    for (const bound of this.activeScopes.get(signal)?.keys() ?? []) {
      if (bound !== controller && bound.key.tabId === tabId && bound.key.ownerId === ownerId) throw iabError('IAB_OPERATION_EPOCH_CHANGED', 'The invocation target lifecycle changed');
    }
    this.checkOperationEpoch(controller, signal);
    const epoch = controller.state === 'attached' ? controller.epoch : controller.epoch + 1;
    this.bindOperation(controller, epoch, signal);
    if (!controller.prepared) this.trackOperation(signal, controller.preparation.then(() => {}, () => {}));
  }

  async acquire(tabId: string, ownerId: string, signal: AbortSignal, generation = 1, assertCurrent?: () => void | Promise<void>): Promise<IabCdpLease> {
    signal.throwIfAborted();
    await assertCurrent?.();
    signal.throwIfAborted();
    this.checkGeneration(generation);
    this.bindTarget(tabId, ownerId, signal);
    const controller = this.resolveController(tabId, ownerId);
    let targets = this.generationControllers.get(generation);
    if (!targets) { targets = new Set(); this.generationControllers.set(generation, targets); }
    targets.add(controller);
    controller.acquiring.set(generation, (controller.acquiring.get(generation) ?? 0) + 1);
    const abortAcquire = () => {
      if (this.activeScopes.get(signal)?.get(controller) === controller.epoch) this.invalidate(controller, controller.epoch, 'acquisition aborted');
    };
    signal.addEventListener('abort', abortAcquire, { once: true });
    try {
      await this.awaitPreparation(controller, signal);
      const epoch = await this.attach(controller, signal, assertCurrent, undefined, generation);
      await assertCurrent?.();
      signal.throwIfAborted();
      if (this.drainedSignals.has(signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
      this.checkGeneration(generation);
      this.checkOperationEpoch(controller, signal);
      this.checkEpoch(controller, epoch);
      const state: LeaseState = {
        id: randomUUID(), generation, controller, events: new Set(), rules: [],
      };
      this.leases.set(state.id, state);
      controller.leases.add(state.id);
      const screenshotEpochs = new WeakMap<AbortSignal, number>();
      const executor: IabCdpExecutor = {
        send: <T extends IabJsonValue = IabJsonObject>(method: string, params?: IabJsonObject, commandOptions?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal; assertCurrent?: () => void | Promise<void> }) => {
          this.checkLease(state);
          if (!/^[A-Za-z]+\.[A-Za-z]+$/u.test(method) || ['Browser', 'Target', 'SystemInfo', 'Tethering'].includes(method.split('.')[0])) {
            throw iabError('IAB_CDP_METHOD_FORBIDDEN', `CDP domain is not available to IAB callers: ${method}`);
          }
          const work = this.sendForLease<T>(state, method, params, commandOptions);
          this.trackPhysical(controller, controller.epoch, false, work, commandOptions?.signal);
          return work;
        },
        setScreenshotViewport: (options) => {
          const work = (async () => {
            options.signal.throwIfAborted(); await options.assertCurrent?.();
            options.signal.throwIfAborted(); this.checkLease(state);
            this.checkOperationEpoch(controller, options.signal);
            const epoch = await this.attach(controller, options.signal, options.assertCurrent, state);
            await options.assertCurrent?.();
            options.signal.throwIfAborted(); this.checkLease(state);
            this.checkOperationEpoch(controller, options.signal); this.checkEpoch(controller, epoch);
            screenshotEpochs.set(options.signal, epoch);
            await this.command(controller, epoch, 'Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 0, mobile: false }, undefined, options.timeoutMs, options.signal, state.id, options.assertCurrent);
          })();
          this.trackPhysical(controller, controller.epoch, false, work, options.signal);
          return work;
        },
        restoreScreenshotViewport: (signal) => {
          const epoch = screenshotEpochs.get(signal);
          screenshotEpochs.delete(signal);
          if (epoch === undefined || controller.state !== 'attached' || controller.epoch !== epoch) return Promise.resolve();
          const override = controller.metricsOverride;
          const work = this.command(controller, epoch, override ? 'Emulation.setDeviceMetricsOverride' : 'Emulation.clearDeviceMetricsOverride', override ?? {}, undefined, 5_000, undefined, state.id, () => { this.checkLease(state); this.checkEpoch(controller, epoch); }, false, signal).then(() => {});
          this.trackOperation(signal, work.then(() => {}, () => {}));
          return work;
        },
        onEvent: (listener) => {
          this.checkLease(state);
          state.events.add(listener);
          return () => state.events.delete(listener);
        },
        setInterceptPolicy: async (rules, options) => {
          options.signal.throwIfAborted();
          const epoch = controller.epoch;
          const targetState = controller.state;
          await options.assertCurrent?.();
          options.signal.throwIfAborted(); this.checkLease(state);
          if (this.drainedSignals.has(options.signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
          this.checkOperationEpoch(controller, options.signal);
          if (controller.epoch !== epoch || controller.state !== targetState) throw iabError('IAB_OPERATION_EPOCH_CHANGED', 'The physical epoch changed during interception policy validation');
          if (targetState === 'attached') this.checkEpoch(controller, epoch);
          if ([...controller.leases].some((id) => id !== state.id && this.leases.get(id)?.fetchParams)) throw iabError('IAB_INTERCEPT_OWNER_CONFLICT', 'Only one live lease may settle intercepted requests for this tab');
          state.rules = structuredClone(rules);
        },
        listChildFrames: (options) => {
          const work = (async () => {
            this.checkLease(state);
            const requestSignal = options?.signal;
            requestSignal?.throwIfAborted();
            await options?.assertCurrent?.();
            requestSignal?.throwIfAborted(); this.checkLease(state);
            this.checkOperationEpoch(controller, requestSignal);
            const epoch = await this.attach(controller, requestSignal, options?.assertCurrent, state);
            await this.command(controller, epoch, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }, undefined, options?.timeoutMs ?? 30_000, requestSignal, state.id, options?.assertCurrent);
            while (controller.discoveries.size) {
              await Promise.all([...controller.discoveries.values()]);
              this.checkLease(state);
              this.checkEpoch(controller, epoch);
            }
            await options?.assertCurrent?.();
            requestSignal?.throwIfAborted(); this.checkLease(state);
            this.checkOperationEpoch(controller, requestSignal); this.checkEpoch(controller, epoch);
            return [...controller.childFrames].map(([sessionId, frameId]) => ({ sessionId, frameId }));
          })();
          this.trackPhysical(controller, controller.epoch, false, work, options?.signal);
          return work;
        },
      };
      const cleanupEpochs = new WeakMap<AbortSignal, number>();
      return {
        id: state.id, tabId, ownerId, generation, executor,
        cancel: (requestSignal) => {
          const epoch = requestSignal && this.activeScopes.get(requestSignal)?.get(controller);
          if (!requestSignal || epoch === controller.epoch) this.invalidate(controller, controller.epoch, 'request cancelled');
        },
        cleanup: async (method, params, cleanupSignal) => {
          this.checkLease(state);
          if (!Object.values(emulationResetCommands).some((command) => command.method === method && JSON.stringify(command.params) === JSON.stringify(params))) throw iabError('IAB_CLEANUP_COMMAND_FORBIDDEN', 'Only exact emulation resets may run during lease teardown');
          const cleanupEpoch = cleanupEpochs.get(cleanupSignal) ?? controller.epoch;
          cleanupEpochs.set(cleanupSignal, cleanupEpoch);
          if (controller.state !== 'attached' || controller.epoch !== cleanupEpoch) return {};
          const override = method === 'Emulation.setUserAgentOverride' ? this.options.resolveUserAgentOverride?.(tabId, ownerId) : undefined;
          return this.command(controller, cleanupEpoch, method, override ?? params, undefined, 10_000, cleanupSignal, state.id, () => { this.checkLease(state); this.checkEpoch(controller, cleanupEpoch); });
        },
        drain: async (cleanupSignal) => {
          const cleanupEpoch = cleanupEpochs.get(cleanupSignal) ?? controller.epoch;
          cleanupEpochs.set(cleanupSignal, cleanupEpoch);
          this.invalidate(controller, cleanupEpoch, 'lease resource teardown');
          this.bindOperation(controller, cleanupEpoch, cleanupSignal);
          await this.drain(cleanupSignal);
        },
        release: () => this.release(state),
      };
    } finally {
      signal?.removeEventListener('abort', abortAcquire);
      const count = (controller.acquiring.get(generation) ?? 1) - 1;
      if (count) controller.acquiring.set(generation, count);
      else controller.acquiring.delete(generation);
      this.collect(controller);
    }
  }

  async drain(signal: AbortSignal): Promise<void> {
    // Pending results may reject on invalidation; only the native promises prove physical drain.
    try {
      for (;;) {
        const work = this.operations.get(signal);
        if (!work?.size) {
          if (!signal.aborted) this.drainedSignals.add(signal);
          return;
        }
        await Promise.all([...work]);
      }
    } finally { this.operations.delete(signal); this.activeScopes.delete(signal); }
  }

  private trackOperation(signal: AbortSignal, work: Promise<void>): void {
    let pending = this.operations.get(signal);
    if (!pending) { pending = new Set(); this.operations.set(signal, pending); }
    pending.add(work);
    void work.then(() => pending!.delete(work));
  }

  private trackPhysical(controller: Controller, epoch: number, epochScoped: boolean, raw: Promise<unknown>, signal?: AbortSignal): void {
    const physical: PhysicalCommand = { epoch, epochScoped, settled: raw.then(() => {}, () => {}) };
    controller.physical.add(physical);
    if (signal) this.trackOperation(signal, physical.settled);
    if (epochScoped) for (const [requestSignal, scopes] of this.activeScopes) if (scopes.get(controller) === epoch) this.trackOperation(requestSignal, physical.settled);
    void physical.settled.then(() => { controller.physical.delete(physical); this.collect(controller); });
  }

  private bindOperation(controller: Controller, epoch: number, signal?: AbortSignal): void {
    if (!signal) return;
    let scopes = this.activeScopes.get(signal);
    if (!scopes) { scopes = new Map(); this.activeScopes.set(signal, scopes); }
    const bound = scopes.get(controller);
    if (bound !== undefined && bound !== epoch) throw iabError('IAB_OPERATION_EPOCH_CHANGED', 'The invocation cannot bind to another physical epoch');
    scopes.set(controller, epoch);
    for (const command of controller.physical) if (command.epochScoped && command.epoch === epoch) this.trackOperation(signal, command.settled);
  }

  readClientHintsPolicy(webContents: WebContents, expression: string, signal?: AbortSignal): Promise<IabJsonValue | undefined> {
    signal?.throwIfAborted();
    const controller = !webContents.isDestroyed() && this.controllers.get(webContents.id);
    if (!controller || controller.webContents !== webContents) throw iabError('IAB_TARGET_UNAVAILABLE', 'Client hints target is not prepared');
    const epoch = controller.epoch;
    this.checkEpoch(controller, epoch);
    const work = (async () => {
      const send = <T extends IabJsonValue = IabJsonObject>(method: string, params?: IabJsonObject) => this.command<T>(controller, epoch, method, params, undefined, 30_000, signal, undefined, undefined, true, signal, 'command');
      const tree = await send('Page.getFrameTree');
      const frameId = (tree.frameTree as IabJsonObject)?.frame as IabJsonObject;
      const world = await send('Page.createIsolatedWorld', { frameId: frameId.id, worldName: 'matcha-iab-client-hints' });
      const result = await send('Runtime.evaluate', { expression, contextId: world.executionContextId, returnByValue: true, silent: true });
      return result.exceptionDetails ? undefined : (result.result as IabJsonObject)?.value;
    })();
    this.trackPhysical(controller, epoch, true, work);
    return work;
  }

  async revokeTarget(tabId: string, ownerId: string): Promise<void> {
    const affected = [...this.controllers.values()].filter((controller) => controller.key.tabId === tabId && controller.key.ownerId === ownerId);
    for (const controller of affected) {
      if (controller.state === 'detached') controller.epoch++;
      else this.invalidate(controller, controller.epoch, 'page access revoked');
    }
    for (const controller of affected) for (const id of [...controller.leases]) {
      const lease = this.leases.get(id);
      if (lease) this.release(lease);
    }
    for (;;) {
      const work = affected.flatMap((controller) => [...controller.physical].map((command) => command.settled));
      if (!work.length) return;
      await Promise.all(work);
    }
  }

  async revokeGeneration(generation: number): Promise<void> {
    this.revokedGenerations.add(generation);
    const affected = [...this.generationControllers.get(generation) ?? []];
    for (const controller of affected) this.invalidate(controller, controller.epoch, 'caller generation revoked');
    for (const lease of [...this.leases.values()]) if (lease.generation === generation) this.release(lease);
    for (;;) {
      const work = affected.flatMap((controller) => [...controller.physical].map((command) => command.settled));
      if (!work.length) { this.generationControllers.delete(generation); return; }
      await Promise.all(work);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const controller of [...this.controllers.values()]) this.closeController(controller, 'broker disposed');
  }

  private resolveController(tabId: string, ownerId: string, expected?: WebContents): Controller {
    if (this.disposed) throw iabError('IAB_BROKER_CLOSED', 'IAB broker is closed');
    if (!tabId || !ownerId) throw iabError('IAB_KEY_INVALID', 'IAB tab and trusted owner are required');
    const webContents = this.options.resolveTarget(tabId, ownerId);
    if (webContents.isDestroyed()) throw iabError('IAB_TARGET_CLOSED', `IAB tab is closed: ${tabId}`);
    if (expected && expected !== webContents) throw iabError('IAB_TARGET_CHANGED', `IAB tab changed: ${tabId}`);
    const existing = this.controllers.get(webContents.id);
    if (existing) {
      if (existing.webContents !== webContents || existing.key.tabId !== tabId || existing.key.ownerId !== ownerId) {
        this.closeController(existing, 'WebContents ownership changed');
        throw iabError('IAB_TARGET_CONFLICT', 'IAB WebContents ownership changed');
      }
      return existing;
    }
    let controller: Controller;
    const listeners: Controller['listeners'] = {
      message: (_event, method: string, params: IabJsonObject, sessionId?: string) => {
        if (controller.state !== 'attached' || (sessionId && !controller.childSessions.has(sessionId))) return;
        try { this.checkEpoch(controller, controller.epoch); } catch { return; }
        if (method === 'Target.attachedToTarget') this.discoverChild(controller, params);
        if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') {
          const frameId = controller.childFrames.get(params.sessionId);
          controller.childFrames.delete(params.sessionId);
          controller.childSessions.delete(params.sessionId);
          for (const pending of [...controller.pending]) if (pending.sessionId === params.sessionId) pending.invalidate('child session detached');
          this.emit(controller, { method: 'IAB.childFrameDetached', params: { sessionId: params.sessionId, ...(frameId ? { frameId } : {}) } });
        }
        if (method.startsWith('Target.')) return;
        const event = { method, params, ...(sessionId ? { sessionId } : {}) };
        if (method === 'Fetch.requestPaused') this.settleRequestPaused(controller, controller.epoch, event);
        if (controller.state === 'attached') this.emit(controller, event);
      },
      detach: (_event, reason: string) => this.invalidate(controller, controller.epoch, reason, false),
      destroyed: () => this.closeController(controller, 'WebContents destroyed'),
      gone: () => this.invalidate(controller, controller.epoch, 'render process gone'),
    };
    let resolvePreparation!: () => void;
    let rejectPreparation!: (error: Error) => void;
    const preparation = new Promise<void>((resolve, reject) => { resolvePreparation = resolve; rejectPreparation = reject; });
    void preparation.catch(() => {});
    controller = { key: { tabId, ownerId }, webContents, contentsId: webContents.id, debugger: webContents.debugger, epoch: 0, state: 'detached', prepared: false, preparation, resolvePreparation, rejectPreparation, leases: new Set(), acquiring: new Map(), pending: new Set(), physical: new Set(), childFrames: new Map(), childSessions: new Set(), discoveries: new Map(), listeners };
    controller.debugger.on('message', listeners.message);
    controller.debugger.on('detach', listeners.detach);
    webContents.once('destroyed', listeners.destroyed);
    webContents.on('render-process-gone', listeners.gone);
    this.controllers.set(webContents.id, controller);
    return controller;
  }

  private async awaitPreparation(controller: Controller, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
      const abort = () => finish(signal?.reason ?? iabError('IAB_ABORTED', 'Browser acquisition aborted'));
      const timer = setTimeout(() => finish(iabError('IAB_TARGET_NOT_READY', 'Main did not finish preparing the browser tab before the readiness deadline')), 30_000);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      void controller.preparation.then(() => finish(), finish);
      if (signal?.aborted) abort();
    });
    this.checkController(controller);
  }

  private async attach(controller: Controller, signal?: AbortSignal, assertCurrent?: () => void | Promise<void>, lease?: LeaseState, generation = lease?.generation): Promise<number> {
    signal?.throwIfAborted();
    if (signal && this.drainedSignals.has(signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
    this.checkController(controller);
    this.checkOperationEpoch(controller, signal);
    if (controller.attachFlight) { this.bindOperation(controller, controller.epoch, signal); return controller.attachFlight; }
    if (controller.state === 'attached' && controller.debugger.isAttached()) { this.bindOperation(controller, controller.epoch, signal); return controller.epoch; }
    if (controller.state === 'attached') this.invalidate(controller, controller.epoch, 'debugger detached', false);
    this.checkOperationEpoch(controller, signal);
    const previousEpoch = controller.epoch;
    const current = assertCurrent?.();
    if (current) await current;
    signal?.throwIfAborted();
    if (signal && this.drainedSignals.has(signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
    if (lease) this.checkLease(lease);
    if (generation !== undefined) this.checkGeneration(generation);
    this.checkController(controller);
    this.checkOperationEpoch(controller, signal);
    if (controller.attachFlight) { this.bindOperation(controller, controller.epoch, signal); return controller.attachFlight; }
    if (controller.state === 'attached' && controller.debugger.isAttached()) { this.bindOperation(controller, controller.epoch, signal); return controller.epoch; }
    if (controller.epoch !== previousEpoch) throw iabError('IAB_OPERATION_EPOCH_CHANGED', 'The physical epoch changed during debugger acquisition');
    if (controller.debugger.isAttached()) throw iabError('IAB_DEBUGGER_IN_USE', 'IAB debugger is already in use');
    controller.debugger.attach('1.3');
    controller.state = 'attached';
    const epoch = ++controller.epoch;
    this.bindOperation(controller, epoch, signal);
    const flight = (async () => {
      try {
        const override = this.options.resolveUserAgentOverride?.(controller.key.tabId, controller.key.ownerId);
        if (override) await this.command(controller, epoch, 'Emulation.setUserAgentOverride', override, undefined, 30_000, signal, lease?.id, assertCurrent, true);
        await this.command(controller, epoch, 'Page.enable', undefined, undefined, 30_000, signal, lease?.id, assertCurrent, true);
        await this.command(controller, epoch, 'Page.addScriptToEvaluateOnNewDocument', { source: "(() => { if (globalThis === globalThis.top || location.href !== 'about:blank' || typeof globalThis.chrome !== 'undefined') return; Object.defineProperty(globalThis, 'chrome', {value:{},configurable:true,enumerable:true,writable:true}); })()" }, undefined, 30_000, signal, lease?.id, assertCurrent, true);
        this.checkEpoch(controller, epoch);
        return epoch;
      } catch (error) {
        this.invalidate(controller, epoch, 'debugger bootstrap failed');
        throw error;
      }
    })();
    controller.attachFlight = flight;
    this.trackPhysical(controller, epoch, true, flight);
    void flight.finally(() => { if (controller.attachFlight === flight) controller.attachFlight = undefined; }).catch(() => {});
    return flight;
  }

  private discoverChild(controller: Controller, params: IabJsonObject): void {
    const info = params.targetInfo as IabJsonObject | undefined;
    const sessionId = params.sessionId;
    if (info?.type !== 'iframe' || typeof sessionId !== 'string' || controller.childSessions.has(sessionId)) return;
    const epoch = controller.epoch;
    controller.childSessions.add(sessionId);
    const flight = Promise.resolve().then(async () => {
      const response = await this.command(controller, epoch, 'Page.getFrameTree', undefined, sessionId, 30_000, undefined, undefined, undefined, true);
      this.checkEpoch(controller, epoch);
      const tree = response.frameTree as IabJsonObject;
      const frameId = (tree?.frame as IabJsonObject)?.id;
      if (typeof frameId === 'string' && controller.childSessions.has(sessionId)) controller.childFrames.set(sessionId, frameId);
      await this.command(controller, epoch, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }] }, sessionId, 30_000, undefined, undefined, undefined, true);
      const policies = [...controller.leases].map((id) => this.leases.get(id)).filter((lease): lease is LeaseState => !!lease);
      if (policies.some((lease) => lease.cacheDisabled !== undefined)) {
        await this.command(controller, epoch, 'Network.setCacheDisabled', { cacheDisabled: policies.some((lease) => lease.cacheDisabled) }, sessionId, 30_000, undefined, undefined, () => { for (const lease of policies) this.checkLease(lease); }, true);
      }
      const policy = policies.find((lease) => lease.fetchParams && !lease.fetchDisabling);
      if (policy) await this.command(controller, epoch, 'Fetch.enable', policy.fetchParams, sessionId, 30_000, undefined, undefined, () => this.checkLease(policy), true);
      await this.command(controller, epoch, 'Network.enable', { maxResourceBufferSize: 262144, maxTotalBufferSize: 1048576 }, sessionId, 30_000, undefined, undefined, undefined, true);
      if (controller.childSessions.has(sessionId)) this.emit(controller, { method: 'IAB.childFrameAttached', params: { sessionId, frameId: String(frameId ?? '') } });
    }).catch((error) => {
      if (controller.state !== 'attached' || controller.epoch !== epoch || !controller.childSessions.has(sessionId)) return;
      this.invalidate(controller, epoch, 'child frame discovery failed');
      throw error;
    }).finally(() => controller.discoveries.delete(sessionId));
    this.trackPhysical(controller, epoch, true, flight);
    controller.discoveries.set(sessionId, flight);
    void flight.catch(() => {});
  }

  private settleRequestPaused(controller: Controller, epoch: number, event: IabCdpEvent): void {
    try {
      this.checkEpoch(controller, epoch);
      const lease = [...controller.leases].map((id) => this.leases.get(id)).find((candidate) => candidate?.fetchParams);
      if (!lease?.fetchParams) throw iabError('IAB_INTERCEPT_OWNER_UNAVAILABLE', 'Intercepted request has no live policy owner');
      this.checkLease(lease);
      const requestId = event.params.requestId;
      const sessionId = event.sessionId;
      if (typeof requestId !== 'string' || !requestId) throw iabError('IAB_INTERCEPT_REQUEST_INVALID', 'Native intercepted request has no requestId');
      const rules = lease.rules;
      const resolution = resolveIntercept(rules, event.params);
      if (!resolution || !['Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.fulfillRequest'].includes(resolution.method) || !resolution.params || typeof resolution.params !== 'object' || Array.isArray(resolution.params)) throw iabError('IAB_INTERCEPT_RESOLUTION_INVALID', 'Interception policy must synchronously choose a Fetch resolution');
      const settlement = this.command(controller, epoch, resolution.method, { ...resolution.params, requestId }, sessionId, 10_000, undefined, undefined, () => {
        this.checkLease(lease);
        if (lease.rules !== rules || !lease.fetchParams) throw iabError('IAB_INTERCEPT_OWNER_UNAVAILABLE', 'Interception policy owner was released');
      }, true).catch(() => {
        if (!sessionId || controller.childSessions.has(sessionId)) this.invalidate(controller, epoch, 'intercepted request settlement failed');
      });
      this.trackPhysical(controller, epoch, true, settlement);
    } catch { this.invalidate(controller, epoch, 'intercepted request policy failed'); }
  }

  private async sendForLease<T extends IabJsonValue>(lease: LeaseState, method: string, params?: IabJsonObject, options?: { sessionId?: string; timeoutMs?: number; signal?: AbortSignal; assertCurrent?: () => void | Promise<void> }): Promise<T> {
    options?.signal?.throwIfAborted();
    if (options?.signal && this.drainedSignals.has(options.signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
    const controller = lease.controller;
    this.checkOperationEpoch(controller, options?.signal);
    const epoch = await this.attach(controller, options?.signal, options?.assertCurrent, lease);
    this.checkLease(lease);
    this.checkEpoch(controller, epoch);
    // Native currency is checked at dispatch: command() for CDP, here for Main-owned effects.
    if (method === 'Page.setDownloadBehavior' && this.options.downloads) {
      await options?.assertCurrent?.();
      options?.signal?.throwIfAborted();
      if (options?.signal && this.drainedSignals.has(options.signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
      this.checkLease(lease);
      this.checkOperationEpoch(controller, options?.signal); this.checkEpoch(controller, epoch);
      if (options?.sessionId) throw iabError('IAB_DOWNLOAD_FRAME_UNSUPPORTED', 'Download capture belongs to the owning tab');
      if (params?.behavior === 'default') this.options.downloads.releaseDownloadCapture(controller.webContents, lease.id);
      else {
        const behavior = params?.behavior;
        if (behavior !== 'allow' && behavior !== 'allowAndName' && behavior !== 'deny') throw iabError('IAB_DOWNLOAD_BEHAVIOR_INVALID', 'Invalid IAB download behavior');
        this.options.downloads.setDownloadBehavior(controller.webContents, {
          owner: lease.id, behavior,
          ...(typeof params?.downloadPath === 'string' ? { downloadPath: params.downloadPath } : {}),
          ...(options?.timeoutMs ? { requestDeadlineAt: Date.now() + options.timeoutMs } : {}),
          emit: (event) => {
            const { type, ...payload } = event;
            this.emitToLease(lease, { method: type === 'will-begin' ? 'Page.downloadWillBegin' : 'Page.downloadProgress', params: payload });
          },
          onError: () => this.invalidate(controller, epoch, 'download capture failed'),
        });
      }
      return {} as T;
    }
    if (method === 'Emulation.setUserAgentOverride' && params) {
      const override = this.options.resolveUserAgentOverride?.(controller.key.tabId, controller.key.ownerId);
      if (override && (params.userAgent === '' || params.userAgent === override.userAgent)) params = { ...override, ...params, userAgent: override.userAgent };
    }
    // Page-wide CDP settings must preserve every other live lease's active policy.
    const cacheDisabled = method === 'Network.setCacheDisabled' ? params?.cacheDisabled : undefined;
    let dispatchCheck = options?.assertCurrent;
    if (method === 'Fetch.enable' || method === 'Fetch.disable' || typeof cacheDisabled === 'boolean') {
      await dispatchCheck?.();
      options?.signal?.throwIfAborted(); this.checkLease(lease);
      this.checkOperationEpoch(controller, options?.signal); this.checkEpoch(controller, epoch);
      const otherLeases = [...controller.leases].filter((id) => id !== lease.id).map((id) => this.leases.get(id));
      if (method === 'Fetch.enable' || method === 'Fetch.disable') {
        const otherPolicy = otherLeases.some((other) => other?.fetchParams);
        if (otherPolicy && method === 'Fetch.enable') throw iabError('IAB_INTERCEPT_OWNER_CONFLICT', 'Only one live lease may settle intercepted requests for this tab');
        if (otherPolicy) return {} as T;
      }
      if (typeof cacheDisabled === 'boolean') params = { ...params, cacheDisabled: cacheDisabled || otherLeases.some((other) => other?.cacheDisabled) };
      // Dispatch synchronously after this check so policy ownership cannot change in another await.
      dispatchCheck = undefined;
    }
    // Fetch may pause a request before the enable command acknowledgement arrives.
    if (!options?.sessionId && method === 'Fetch.enable') lease.fetchParams = params ?? {};
    const disablingFetch = !options?.sessionId && method === 'Fetch.disable';
    if (disablingFetch) lease.fetchDisabling = true;
    try {
      const result = await this.command<T>(controller, epoch, method, params, options?.sessionId, options?.timeoutMs, options?.signal, lease.id, dispatchCheck);
      this.checkLease(lease); this.checkEpoch(controller, epoch);
      if (method === 'Network.clearBrowserCookies') invalidateIabClientHints(controller.webContents.session);
      if (!options?.sessionId) {
        if (method === 'Emulation.setDeviceMetricsOverride') controller.metricsOverride = params;
        else if (method === 'Emulation.clearDeviceMetricsOverride') controller.metricsOverride = undefined;
        if (method === 'Fetch.enable') lease.fetchParams = params ?? {};
        else if (typeof cacheDisabled === 'boolean') lease.cacheDisabled = cacheDisabled;
        if (disablingFetch) while (controller.discoveries.size) await Promise.all([...controller.discoveries.values()]);
        if (method === 'Fetch.enable' || method === 'Fetch.disable' || method === 'Network.setCacheDisabled') {
          for (const sessionId of controller.childSessions) {
            try {
              await options?.assertCurrent?.();
              options?.signal?.throwIfAborted(); this.checkLease(lease);
              this.checkOperationEpoch(controller, options?.signal); this.checkEpoch(controller, epoch);
              const childParams = typeof cacheDisabled === 'boolean' ? { ...params, cacheDisabled: cacheDisabled || [...controller.leases].some((id) => id !== lease.id && this.leases.get(id)?.cacheDisabled) } : params;
              await this.command(controller, epoch, method, childParams, sessionId, options?.timeoutMs, options?.signal, lease.id);
            } catch (error) { if (controller.childSessions.has(sessionId)) throw error; this.checkEpoch(controller, epoch); }
          }
        }
        if (disablingFetch) lease.fetchParams = undefined;
      }
      return result;
    } catch (error) {
      if (disablingFetch) this.invalidate(controller, epoch, 'interception disable failed');
      throw error;
    } finally { if (disablingFetch) lease.fetchDisabling = undefined; }
  }

  private command<T extends IabJsonValue = IabJsonObject>(controller: Controller, epoch: number, method: string, params?: IabJsonObject, sessionId?: string, timeoutMs = 30_000, signal?: AbortSignal, leaseId?: string, assertCurrent?: () => void | Promise<void>, epochScoped = false, physicalSignal = signal, cancellation: 'epoch' | 'command' = 'epoch'): Promise<T> {
    this.checkEpoch(controller, epoch);
    signal?.throwIfAborted();
    if (signal && this.drainedSignals.has(signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
    if (sessionId && !controller.childSessions.has(sessionId)) throw iabError('IAB_CDP_SESSION_INVALID', 'CDP child session does not belong to this tab');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw iabError('IAB_CDP_TIMEOUT_INVALID', 'CDP timeout must be positive and finite');
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        controller.pending.delete(pending);
        if (error) reject(error);
        else resolve(value as T);
      };
      const pending: PendingCommand = { epoch, leaseId, sessionId, invalidate: (reason) => finish(iabError('IAB_CDP_OUTCOME_UNKNOWN', `CDP command outcome is unknown (${reason}): ${method}`)) };
      const cancel = (reason: string) => {
        if (cancellation === 'command' || (sessionId && !controller.childSessions.has(sessionId))) pending.invalidate(reason);
        else this.invalidate(controller, epoch, reason);
      };
      const abort = () => cancel('command aborted');
      const timer = setTimeout(() => cancel(`${timeoutMs}ms command timeout`), timeoutMs);
      timer.unref?.();
      controller.pending.add(pending);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      const dispatch = (async () => {
        try {
          const current = assertCurrent?.();
          if (current) await current;
          if (settled) return;
          signal?.throwIfAborted();
          if (signal && this.drainedSignals.has(signal)) throw iabError('IAB_OPERATION_DRAINED', 'Browser operation has already physically drained');
          if (leaseId) {
            const lease = this.leases.get(leaseId);
            if (!lease) throw iabError('IAB_LEASE_INVALID', 'IAB lease is unavailable');
            this.checkLease(lease);
          }
          this.checkOperationEpoch(controller, signal);
          this.checkEpoch(controller, epoch);
          if (sessionId && !controller.childSessions.has(sessionId)) throw iabError('IAB_CDP_SESSION_INVALID', 'CDP child session does not belong to this tab');
          const raw = controller.debugger.sendCommand(method, params, sessionId);
          this.trackPhysical(controller, epoch, epochScoped, raw, physicalSignal);
          void raw.then((value: T) => {
            if (settled) return;
            try { this.checkEpoch(controller, epoch); finish(undefined, value); } catch { pending.invalidate('target or physical epoch changed'); }
          }, (error: unknown) => finish(error));
        } catch (error) { finish(error); }
      })();
      this.trackPhysical(controller, epoch, epochScoped, dispatch, physicalSignal);
    });
  }

  private checkOperationEpoch(controller: Controller, signal?: AbortSignal): void {
    const epoch = signal && this.activeScopes.get(signal)?.get(controller);
    if (epoch !== undefined && !(controller.state === 'attached' && controller.epoch === epoch) && !(controller.state === 'detached' && controller.epoch + 1 === epoch)) throw iabError('IAB_OPERATION_EPOCH_CHANGED', 'The invocation physical epoch was invalidated; queued commands were not dispatched');
  }

  private checkController(controller: Controller): void {
    if (this.disposed || controller.state === 'closed') throw iabError('IAB_TARGET_CLOSED', 'IAB controller is closed');
    let target: WebContents;
    try { target = this.options.resolveTarget(controller.key.tabId, controller.key.ownerId); }
    catch (error) { this.closeController(controller, 'ownership changed'); throw error; }
    if (target !== controller.webContents || target.isDestroyed()) {
      this.closeController(controller, 'target changed');
      throw iabError('IAB_TARGET_CHANGED', 'IAB tab target changed');
    }
  }

  private checkEpoch(controller: Controller, epoch: number): void {
    this.checkController(controller);
    if (controller.epoch !== epoch || controller.state !== 'attached' || !controller.debugger.isAttached()) throw iabError('IAB_CDP_EPOCH_INVALID', 'IAB physical debugger epoch changed');
  }

  private checkGeneration(generation: number): void {
    if (!Number.isSafeInteger(generation) || generation <= 0 || this.revokedGenerations.has(generation)) throw iabError('IAB_LEASE_STALE', 'IAB caller generation is invalid or revoked');
  }

  private checkLease(lease: LeaseState): void {
    if (this.leases.get(lease.id) !== lease) throw iabError('IAB_LEASE_INVALID', 'IAB lease is unavailable');
    this.checkGeneration(lease.generation);
    this.checkController(lease.controller);
  }

  private emitToLease(lease: LeaseState, event: IabCdpEvent): void {
    if (this.leases.get(lease.id) !== lease) return;
    for (const listener of lease.events) { try { listener(event); } catch { /* A subscriber cannot interrupt physical debugger cleanup. */ } }
  }

  private emit(controller: Controller, event: IabCdpEvent): void {
    for (const id of controller.leases) { const lease = this.leases.get(id); if (lease) this.emitToLease(lease, event); }
  }

  private invalidate(controller: Controller, epoch: number, reason: string, detach = true): void {
    if (controller.epoch !== epoch || controller.state !== 'attached') return;
    controller.state = 'detached';
    controller.attachFlight = undefined;
    controller.metricsOverride = undefined;
    controller.childSessions.clear();
    controller.childFrames.clear();
    controller.discoveries.clear();
    for (const pending of [...controller.pending]) if (pending.epoch === epoch) pending.invalidate(reason);
    for (const id of controller.leases) {
      const lease = this.leases.get(id);
      if (lease) { lease.fetchParams = undefined; lease.fetchDisabling = undefined; }
      this.options.downloads?.releaseDownloadCapture(controller.webContents, id);
    }
    if (detach && !controller.webContents.isDestroyed() && controller.debugger.isAttached()) controller.debugger.detach();
    this.emit(controller, { method: 'IAB.epochInvalidated', params: { epoch, reason } });
  }

  private release(lease: LeaseState): void {
    if (this.leases.get(lease.id) !== lease) return;
    if (lease.fetchParams || [...lease.controller.pending].some((pending) => pending.leaseId === lease.id)) this.invalidate(lease.controller, lease.controller.epoch, 'lease released with active commands or interception');
    this.options.downloads?.releaseDownloadCapture(lease.controller.webContents, lease.id);
    this.leases.delete(lease.id);
    lease.controller.leases.delete(lease.id);
    lease.events.clear();
    lease.rules = [];
    lease.fetchParams = undefined;
    this.collect(lease.controller);
  }

  private collect(controller: Controller): void {
    if (!controller.physical.size && !controller.leases.size && !controller.acquiring.size) {
      for (const targets of this.generationControllers.values()) targets.delete(controller);
    }
    if (!controller.prepared && !controller.leases.size && !controller.acquiring.size) this.closeController(controller, 'last lease released');
  }

  private closeController(controller: Controller, reason: string): void {
    if (controller.state === 'closed') return;
    controller.rejectPreparation(iabError('IAB_TARGET_CLOSED', reason));
    this.invalidate(controller, controller.epoch, reason);
    controller.state = 'closed';
    const { webContents, listeners } = controller;
    controller.debugger.removeListener('message', listeners.message);
    controller.debugger.removeListener('detach', listeners.detach);
    webContents.removeListener('destroyed', listeners.destroyed);
    webContents.removeListener('render-process-gone', listeners.gone);
    for (const id of [...controller.leases]) { const lease = this.leases.get(id); if (lease) this.release(lease); }
    if (this.controllers.get(controller.contentsId) === controller) this.controllers.delete(controller.contentsId);
  }
}
