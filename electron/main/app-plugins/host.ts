import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPluginCatalog, InstalledAppPlugin } from '../../../src/types/desktop/app-plugin';
import type { AppMediaModelList, AppMediaModelListRequest, AppModelRequest, AppModelResult, AppTextModelRequest, AppTextModelResult, AppVideoTaskRequest, AppVideoTaskResult, AppPluginCall, AppRuntimeEvent, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import { logger } from '../../utils/logger';
import { materializePlugin } from './loader';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, requireDigest, requireObject, requirePluginId } from './package';
import type { AppPluginPackageWorker } from './package-client';
import type { HostRequest, WorkerMessage } from './protocol';
import { AppPluginStorage } from './storage';

type PluginRetirement =
  | { state: 'pending'; done: Promise<void> }
  | { state: 'failed'; error: Error };

export interface AppPluginHostOptions {
  rootDir: string;
  owner: ApplicationPluginOwner;
  packageWorker: AppPluginPackageWorker;
  publish(event: AppRuntimeEvent): void;
  list(request: AppMediaModelListRequest, signal: AbortSignal): Promise<AppMediaModelList>;
  generate(request: AppModelRequest, signal: AbortSignal): Promise<AppModelResult>;
  submitVideo(request: AppModelRequest & { readonly kind: 'video' }, signal: AbortSignal): Promise<AppVideoTaskResult>;
  queryVideo(request: AppVideoTaskRequest, signal: AbortSignal): Promise<AppVideoTaskResult>;
  collectVideo(request: AppVideoTaskRequest, signal: AbortSignal): Promise<AppModelResult>;
  generateText(request: AppTextModelRequest, signal: AbortSignal): Promise<AppTextModelResult>;
}

export class AppPluginHost {
  private child?: UtilityProcess;
  private started?: Promise<void>;
  private exited?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, { digest: string; ready: Promise<void>; retiring?: PluginRetirement }>();
  private readonly materializedPaths = new Set<string>();
  private readonly pending = new Map<string, { type: 'activate' | 'deactivate' | 'call'; resolve: (result: AppToolResult | undefined) => void; reject: (error: Error) => void }>();
  private readonly models = new Map<string, { pluginId: string; controller: AbortController }>();
  private readonly storage: AppPluginStorage;

  constructor(private readonly options: AppPluginHostOptions) {
    this.storage = new AppPluginStorage(options.rootDir, options.packageWorker);
  }

  async call(value: AppPluginCall, signal: AbortSignal): Promise<AppToolResult> {
    const input = requireObject(value, ['id', 'digest', 'name', 'arguments']);
    requirePluginId(input.id);
    requireDigest(input.digest);
    if (typeof input.name !== 'string' || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)) {
      throw new AppPluginError('invalid_package', 'Plugin call requires a declared local tool name and object arguments.');
    }
    signal.throwIfAborted();
    const plugin = await this.requireEnabled(input.id, input.digest);
    if (!plugin.manifest.main || !plugin.manifest.contributes.tools?.some((tool) => tool.name === input.name)) {
      throw new AppPluginError('not_found', 'The tool is not declared by this plugin.');
    }
    await this.activate(plugin);
    await this.requireEnabled(input.id, input.digest);
    signal.throwIfAborted();
    return (await this.request({ type: 'call', requestId: randomUUID(), pluginId: input.id, digest: input.digest,
      name: input.name, arguments: input.arguments as Record<string, unknown> }, signal))!;
  }

  async changed(catalog: AppPluginCatalog): Promise<void> {
    const retirements: Promise<void>[] = [];
    for (const [id, entry] of this.active) {
      if (entry.retiring?.state === 'failed') continue;
      if (!entry.retiring && catalog.plugins.some((plugin) => plugin.manifest.id === id && plugin.enabled && plugin.digest === entry.digest)) continue;
      if (!entry.retiring) {
        for (const model of this.models.values()) if (model.pluginId === id) model.controller.abort();
        const done = this.serialize(async () => {
          try {
            if (this.child) await this.request({ type: 'deactivate', requestId: randomUUID(), pluginId: id });
          } catch (cause) {
            const error = new AppPluginError('conflict', `App plugin ${id} cleanup failed; restart the application before activating it again.`);
            error.cause = cause;
            entry.retiring = { state: 'failed', error };
            throw error;
          }
          this.active.delete(id);
        });
        entry.retiring = { state: 'pending', done };
      }
      retirements.push(entry.retiring.done);
    }
    const failures = (await Promise.allSettled(retirements)).filter((result) => result.status === 'rejected');
    if (failures.length === 1) throw failures[0].reason;
    if (failures.length > 1) throw new AggregateError(failures.map((result) => result.reason), 'App plugin cleanup failed; restart the application.');
  }

  async close(): Promise<void> {
    this.closed = true;
    const failures: unknown[] = [];
    for (const entry of this.active.values()) if (entry.retiring?.state === 'failed') failures.push(entry.retiring.error);
    try { await this.changed({ revision: 0, plugins: [] }); }
    catch (error) { failures.push(error); }
    try { await this.forceClose(); }
    catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'App plugin shutdown failed.');
  }

  forceClose(): Promise<void> {
    this.closed = true;
    this.stopping ??= (async () => {
      for (const model of this.models.values()) model.controller.abort();
      const child = this.child;
      if (child && !child.kill()) throw new Error('App plugin worker termination failed.');
      await this.exited;
      // Native modules stay mapped until worker exit; also wait for in-flight materialization.
      await this.tail;
      const failures: unknown[] = [];
      for (const path of this.materializedPaths) {
        try {
          await rm(path, { recursive: true, force: true });
          this.materializedPaths.delete(path);
        } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'App plugin execution directory cleanup failed.');
    })();
    return this.stopping;
  }

  private async requireEnabled(id: string, digest: string): Promise<InstalledAppPlugin> {
    if (this.closed) throw new AppPluginError('closed', 'App plugin host is closing.');
    const plugin = (await this.options.owner.list()).plugins.find((entry) => entry.manifest.id === id);
    if (!plugin) throw new AppPluginError('not_found', 'App plugin is not installed.');
    if (!plugin.enabled || plugin.digest !== digest) throw new AppPluginError('conflict', 'App plugin is disabled or has changed. Refresh it before calling.');
    return plugin;
  }

  private activate(plugin: InstalledAppPlugin): Promise<void> {
    const existing = this.active.get(plugin.manifest.id);
    if (existing?.retiring) return existing.retiring.state === 'failed'
      ? Promise.reject(existing.retiring.error) : existing.retiring.done.then(() => this.activate(plugin));
    if (existing?.digest === plugin.digest) return existing.ready;
    const entry = { digest: plugin.digest, ready: Promise.resolve() };
    entry.ready = this.serialize(async () => {
      if (this.closed) throw new AppPluginError('closed', 'App plugin host is closing.');
      await this.start();
      await this.requireEnabled(plugin.manifest.id, plugin.digest);
      const load = await materializePlugin(this.storage, this.options.rootDir, plugin);
      this.materializedPaths.add(load.packagePath);
      await this.request({ type: 'activate', requestId: randomUUID(), plugin: load });
    });
    this.active.set(plugin.manifest.id, entry);
    return entry.ready;
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private start(): Promise<void> {
    this.started ??= new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(join(__dirname, 'extensions', 'worker.js'), [], {
        serviceName: 'Matcha Application Plugins', stdio: 'pipe',
      });
      this.child = child;
      child.stdout?.on('data', () => undefined);
      child.stderr?.on('data', () => undefined);
      const startupTimer = setTimeout(() => { reject(new Error('App plugin worker did not become ready.')); child.kill(); }, 15_000);
      child.on('message', (message: WorkerMessage) => {
        if (message.type === 'ready') { clearTimeout(startupTimer); resolve(); }
        else this.receive(message);
      });
      this.exited = new Promise<void>((done) => child.once('exit', (code) => {
        clearTimeout(startupTimer);
        this.child = undefined;
        const error = new Error(`App plugin worker exited (${code}); the call was not retried.`);
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        for (const model of this.models.values()) model.controller.abort(error);
        done();
      }));
    });
    return this.started;
  }

  private request(message: Extract<HostRequest, { type: 'activate' | 'deactivate' | 'call' }>, signal?: AbortSignal): Promise<AppToolResult | undefined> {
    signal?.throwIfAborted();
    if (!this.child) return Promise.reject(new Error('App plugin worker is unavailable; restart the application to recover.'));
    if (message.type === 'call' && [...this.pending.values()].filter((pending) => pending.type === 'call').length >= 128) {
      return Promise.reject(new AppPluginError('busy', 'Too many plugin tool calls.'));
    }
    return new Promise((resolve, reject) => {
      const cancel = () => {
        this.child?.postMessage({ type: 'cancel', requestId: message.requestId } satisfies HostRequest);
        finish();
        reject(signal?.reason ?? new Error('Plugin call cancelled; external effects may already have occurred.'));
      };
      const finish = () => { signal?.removeEventListener('abort', cancel); this.pending.delete(message.requestId); };
      this.pending.set(message.requestId, {
        type: message.type,
        resolve: (result) => { finish(); resolve(result); },
        reject: (error) => { finish(); reject(error); },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.child!.postMessage(message); }
      catch (error) { finish(); reject(error); }
    });
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'result') {
      const pending = this.pending.get(message.requestId);
      if (message.error) pending?.reject(new Error(message.error));
      else pending?.resolve(message.result);
    } else if (message.type === 'event') {
      const entry = this.active.get(message.event.pluginId);
      if (entry?.digest === message.event.digest && !entry.retiring) this.options.publish(message.event);
    } else if (message.type === 'model-cancel') {
      this.models.get(message.requestId)?.controller.abort();
    } else if (message.type === 'model' || message.type === 'text-model' || message.type === 'media-model') {
      const controller = new AbortController();
      const resultType = message.type === 'media-model' ? 'media-model-result' : message.type === 'text-model' ? 'text-model-result' : 'model-result';
      void (async () => {
        try {
          if (this.models.size >= 128 || this.models.has(message.requestId)) throw new Error('Too many or duplicate plugin model requests.');
          this.models.set(message.requestId, { pluginId: message.pluginId, controller });
          const entry = this.active.get(message.pluginId);
          if (entry?.digest !== message.digest || entry.retiring) throw new Error('The plugin model request belongs to an inactive version.');
          if (message.type === 'media-model') {
            let result: AppMediaModelList | AppVideoTaskResult | AppModelResult;
            switch (message.operation) {
              case 'list': result = await this.options.list(message.request, controller.signal); break;
              case 'submitVideo': result = await this.options.submitVideo(message.request, controller.signal); break;
              case 'queryVideo': result = await this.options.queryVideo(message.request, controller.signal); break;
              case 'collectVideo': result = await this.options.collectVideo(message.request, controller.signal); break;
            }
            this.child?.postMessage({ type: 'media-model-result', requestId: message.requestId, result } satisfies HostRequest);
          } else if (message.type === 'text-model') {
            const result = await this.options.generateText(message.request, controller.signal);
            this.child?.postMessage({ type: 'text-model-result', requestId: message.requestId, result } satisfies HostRequest);
          } else {
            const result = await this.options.generate(message.request, controller.signal);
            this.child?.postMessage({ type: 'model-result', requestId: message.requestId, result } satisfies HostRequest);
          }
        } catch (error) {
          this.child?.postMessage({ type: resultType, requestId: message.requestId,
            error: error instanceof Error ? error.message.slice(0, 2000) : 'Model generation failed; external effects may already have occurred.' } satisfies HostRequest);
        } finally { if (this.models.get(message.requestId)?.controller === controller) this.models.delete(message.requestId); }
      })();
    } else if (message.type === 'log') {
      logger[message.level](`[AppPlugins:${message.pluginId}] ${message.message.slice(0, 2000)}`);
    }
  }
}
