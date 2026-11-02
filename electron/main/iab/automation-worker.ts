import { parentPort } from 'node:worker_threads';
import type { IabCdpEvent, IabCdpExecutor, IabCdpLease } from './contracts';
import type { IabJsonObject, IabTab } from '../../../src/types/desktop/iab';
import { IabAutomation } from './automation';
import { iabError } from './error';
import { deserializeAutomationError, serializeAutomationError } from './automation-port';
import type { AutomationContext, AutomationEffect, AutomationReply, AutomationServices, AutomationToMain, AutomationToWorker } from './automation-port';

const port = parentPort!;
const requests = new Map<number, { context: AutomationContext; controller: AbortController; settled: Promise<void> }>();
const operations = new WeakMap<AbortSignal, AutomationContext>();
const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
const listeners = new Map<string, Set<(event: IabCdpEvent) => void>>();
const tabListeners = new Set<(tabs: Pick<IabTab, 'id' | 'ownerId'>[]) => void>();
const teardownSignals = new WeakSet<AbortSignal>();
let nextId = 0;
let closing = false;
const post = (message: AutomationToMain) => port.postMessage(message);
function effect<T>(context: AutomationContext, value: AutomationEffect): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (result) => resolve(result as T), reject });
    post({ type: 'effect', id, invocation: context.invocation, effect: value });
  });
}
function teardown<T>(leaseId: string, method?: string, params?: IabJsonObject): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (result) => resolve(result as T), reject });
    post({ type: 'teardown', id, leaseId, method, params });
  });
}
function operationContext(signal?: AbortSignal): AutomationContext {
  const context = signal && operations.get(signal);
  if (!context) throw iabError('IAB_OPERATION_REQUIRED', 'A live browser operation is required');
  signal!.throwIfAborted(); context.assertCurrent();
  return context;
}
const services: AutomationServices = {
  tabs: (context) => effect(context, { kind: 'tabs' }),
  checkTarget: (tabId, context) => effect(context, { kind: 'check-target', tabId }),
  open: (url, context) => effect(context, { kind: 'open', url }),
  closeTab: (tabId, context) => effect(context, { kind: 'close-tab', tabId }),
  show: (tabId, context) => effect(context, { kind: 'show', tabId }),
  async acquire(tabId, context, signal) {
    signal.throwIfAborted();
    const descriptor = await effect<Pick<IabCdpLease, 'id' | 'tabId' | 'ownerId' | 'generation'>>(context, { kind: 'acquire', tabId });
    const events = new Set<(event: IabCdpEvent) => void>();
    listeners.set(descriptor.id, events);
    const executor: IabCdpExecutor = {
      send: (method, params, options) => {
        options?.assertCurrent?.();
        if (options?.signal && teardownSignals.has(options.signal)) return teardown(descriptor.id, method, params);
        return effect(operationContext(options?.signal), { kind: 'command', leaseId: descriptor.id, method, params, sessionId: options?.sessionId, timeoutMs: options?.timeoutMs });
      },
      setScreenshotViewport(options) {
        options.assertCurrent?.();
        return effect(operationContext(options.signal), { kind: 'screenshot-viewport', leaseId: descriptor.id, timeoutMs: options.timeoutMs });
      },
      restoreScreenshotViewport(signal) {
        const context = operations.get(signal);
        if (!context) throw iabError('IAB_OPERATION_REQUIRED', 'Screenshot restoration requires its original operation');
        return effect(context, { kind: 'restore-screenshot-viewport', leaseId: descriptor.id });
      },
      onEvent(listener) { events.add(listener); return () => { events.delete(listener); }; },
      setInterceptPolicy: (rules, options) => {
        options.assertCurrent?.();
        return effect(operationContext(options.signal), { kind: 'intercept', leaseId: descriptor.id, rules });
      },
      listChildFrames: (options) => {
        options?.assertCurrent?.();
        return effect(operationContext(options?.signal), { kind: 'frames', leaseId: descriptor.id, timeoutMs: options?.timeoutMs });
      },
    };
    return {
      ...descriptor, executor,
      cleanup: (method, params) => teardown(descriptor.id, method, params),
      drain: () => teardown(descriptor.id),
      cancel: (operationSignal?: AbortSignal) => {
        const invocation = operationSignal && operations.get(operationSignal)?.invocation;
        if (invocation) post({ type: 'cancel-lease', invocation, leaseId: descriptor.id });
      },
      release() { listeners.delete(descriptor.id); post({ type: 'release-lease', leaseId: descriptor.id }); },
    };
  },
  bindOperation(context, signal) {
    operations.set(signal, context);
    const abort = () => post({ type: 'abort', invocation: context.invocation, error: serializeAutomationError(signal.reason) });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => { signal.removeEventListener('abort', abort); operations.delete(signal); };
  },
  drain: (context) => effect(context, { kind: 'drain' }),
  async teardown(lease, signal, cleanup) {
    teardownSignals.add(signal);
    try { await cleanup(); }
    finally { try { await teardown(lease.id); } finally { teardownSignals.delete(signal); } }
  },
  onTabsChanged(listener) { tabListeners.add(listener); return () => { tabListeners.delete(listener); }; },
};
const automation = new IabAutomation(services);
port.on('message', (message: AutomationToWorker) => {
  switch (message.type) {
    case 'reply': {
      const reply = message.reply;
      const waiting = pending.get(reply.id);
      pending.delete(reply.id);
      if (reply.ok) waiting?.resolve(reply.value);
      else waiting?.reject(deserializeAutomationError(reply.error));
      return;
    }
    case 'events':
      for (const { leaseId, event } of message.events) for (const listener of listeners.get(leaseId) ?? []) listener(event);
      return;
    case 'tabs':
      for (const listener of tabListeners) listener(message.tabs);
      return;
    case 'cancel': requests.get(message.id)?.controller.abort(deserializeAutomationError(message.error)); return;
    case 'request': {
      if (closing) { post({ type: 'result', reply: { id: message.id, ok: false, error: { code: 'IAB_AUTOMATION_CLOSED', message: 'IAB automation is closing' } } }); return; }
      const controller = new AbortController();
      const context: AutomationContext = {
        ...message.context, invocation: message.id,
        assertCurrent() { controller.signal.throwIfAborted(); if (!requests.has(message.id)) throw iabError('IAB_INVOCATION_STALE', 'Browser invocation has ended'); },
        readScript: (path) => effect(context, { kind: 'read-script', path }),
        resolveFiles: (paths) => effect(context, { kind: 'resolve-files', paths }),
        saveFile: (path, bytes, _signal, atomic = false) => effect(context, { kind: 'save-file', path, bytes, atomic }),
        prepareDownload: (dir, savePath) => effect(context, { kind: 'prepare-download', dir, savePath }),
        finishDownload: (leaseId, file) => effect(context, { kind: 'finish-download', leaseId, file }),
        releaseDownload: (leaseId) => post({ type: 'release-download', leaseId }),
      };
      operations.set(controller.signal, context);
      const settled = Promise.resolve().then(async () => {
        let reply: AutomationReply;
        try { reply = { id: message.id, ok: true, value: await automation.handleRequest(message.params, context, controller.signal) }; }
        catch (error) { reply = { id: message.id, ok: false, error: serializeAutomationError(error) }; }
        finally { requests.delete(message.id); operations.delete(controller.signal); }
        post({ type: 'result', reply });
      });
      requests.set(message.id, { context, controller, settled });
      return;
    }
    case 'close':
      closing = true;
      for (const request of requests.values()) request.controller.abort(iabError('IAB_AUTOMATION_CLOSED', 'IAB automation is closing'));
      void Promise.all([...requests.values()].map((request) => request.settled)).then(async () => {
        await automation.dispose();
        post({ type: 'closed' }); port.close();
      });
  }
});
