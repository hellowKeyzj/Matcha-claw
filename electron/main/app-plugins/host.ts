import { rm } from 'node:fs/promises';
import type { AppPluginCatalog, InstalledAppPlugin } from '../../../src/types/desktop/app-plugin';
import { APP_SERVICE_VERSION, AppServiceError } from '../../../src/types/desktop/app-plugin-sdk';
import type { AppServiceRequest, AppServiceResult, AppExecutionRequest, AppExecutionResult, AppPluginContext, AppMediaModelList, AppMediaModelListRequest, AppModelRequest, AppModelResult, AppMusicModelRequest, AppSpeechModelRequest, AppTranscriptionModelRequest, AppTextModelRequest, AppTextModelResult, AppVideoTaskRequest, AppVideoTaskResult, AppPluginCall, AppRuntimeEvent, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import { logger } from '../../utils/logger';
import { materializePlugin } from './loader';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, requireDigest, requireObject, requirePluginId } from './package';
import type { AppPluginPackageWorker } from './package-client';
import type { PluginLoad } from './protocol';
import { AppPluginRuntimeStartupError, NodePluginWorker, type AppPluginDevelopmentRuntime, type AppPluginModels, type AppPluginRuntimeCallbacks } from './runtime';
import { StdioPluginRuntime } from './stdio-runtime';
import { AppPluginStorage } from './storage';
import { AppPluginConfirmations, type AppPluginConfirmationEvent } from './confirmation';

export type { AppPluginDevelopmentRuntime } from './runtime';
export { AppPluginRuntimeStartupError } from './runtime';

type PluginRetirement = { state: 'pending'; done: Promise<void> } | { state: 'failed'; error: Error };
interface ActivePlugin {
  digest: string;
  ready: Promise<void>;
  load?: PluginLoad;
  runtime?: AppPluginDevelopmentRuntime;
  failed?: Error;
  retiring?: PluginRetirement;
}

export interface AppPluginHostOptions {
  rootDir: string;
  owner: ApplicationPluginOwner;
  packageWorker: AppPluginPackageWorker;
  publish(event: AppRuntimeEvent): void;
  publishConfirmation?(event: AppPluginConfirmationEvent): void;
  execute?(request: AppExecutionRequest, signal: AbortSignal, requestConfirmation?: AppPluginContext['requestConfirmation']): Promise<AppExecutionResult>;
  service?(pluginId: string, request: AppServiceRequest, signal: AbortSignal): Promise<AppServiceResult>;
  list(request: AppMediaModelListRequest, signal: AbortSignal): Promise<AppMediaModelList>;
  generate(request: AppModelRequest, signal: AbortSignal): Promise<AppModelResult>;
  submitVideo(request: AppModelRequest & { readonly kind: 'video' }, signal: AbortSignal): Promise<AppVideoTaskResult>;
  queryVideo(request: AppVideoTaskRequest, signal: AbortSignal): Promise<AppVideoTaskResult>;
  collectVideo(request: AppVideoTaskRequest, signal: AbortSignal): Promise<AppModelResult>;
  generateText(request: AppTextModelRequest, signal: AbortSignal): Promise<AppTextModelResult>;
  generateSpeech(request: AppSpeechModelRequest, signal: AbortSignal): Promise<AppModelResult>;
  transcribe(request: AppTranscriptionModelRequest, signal: AbortSignal): Promise<AppModelResult>;
  generateMusic(request: AppMusicModelRequest, signal: AbortSignal): Promise<AppModelResult>;
}

export class AppPluginHost {
  private closed = false;
  private started = false;
  private catalog?: AppPluginCatalog;
  private stopping?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, ActivePlugin>();
  private readonly materializedPaths = new Set<string>();
  private readonly development = new Set<AppPluginDevelopmentRuntime>();
  private readonly launches = new Set<Promise<void>>();
  private readonly storage: AppPluginStorage;
  private readonly models: AppPluginModels;
  private readonly worker: NodePluginWorker;
  readonly confirmations: AppPluginConfirmations;

  constructor(private readonly options: AppPluginHostOptions) {
    this.confirmations = new AppPluginConfirmations((event) => options.publishConfirmation?.(event));
    this.storage = new AppPluginStorage(options.rootDir, options.packageWorker);
    this.models = {
      list: (request, signal) => options.list(request, signal ?? new AbortController().signal),
      generate: (request, signal) => options.generate(request, signal ?? new AbortController().signal),
      generateText: (request, signal) => options.generateText(request, signal ?? new AbortController().signal),
      generateSpeech: (request, signal) => options.generateSpeech(request, signal ?? new AbortController().signal),
      transcribe: (request, signal) => options.transcribe(request, signal ?? new AbortController().signal),
      generateMusic: (request, signal) => options.generateMusic(request, signal ?? new AbortController().signal),
      submitVideo: (request, signal) => options.submitVideo(request, signal ?? new AbortController().signal),
      queryVideo: (request, signal) => options.queryVideo(request, signal ?? new AbortController().signal),
      collectVideo: (request, signal) => options.collectVideo(request, signal ?? new AbortController().signal),
    };
    this.worker = new NodePluginWorker(this.models, (level, message) => logger[level](`[AppPlugins:worker] ${message}`));
  }

  start(catalog: AppPluginCatalog): Promise<void> {
    if (this.closed) return Promise.reject(new AppPluginError('closed', 'App plugin host is closing.'));
    this.started = true;
    return this.changed(this.catalog && this.catalog.revision > catalog.revision ? this.catalog : catalog);
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
    if ((!plugin.manifest.main && !plugin.manifest.backend) || !plugin.manifest.contributes.tools?.some((tool) => tool.name === input.name)) {
      throw new AppPluginError('not_found', 'The tool is not declared by this plugin.');
    }
    const entry = this.activate(plugin);
    await entry.ready;
    await this.requireEnabled(input.id, input.digest);
    signal.throwIfAborted();
    if (entry.failed) throw entry.failed;
    if (entry.retiring || !entry.runtime) throw new AppPluginError('conflict', 'App plugin is retiring. Refresh before calling.');
    return entry.runtime.call(input.name, input.arguments as Record<string, unknown>, signal);
  }

  async createDevelopment(load: PluginLoad, callbacks: AppPluginRuntimeCallbacks): Promise<AppPluginDevelopmentRuntime> {
    if (this.closed) throw new AppPluginError('closed', 'App plugin host is closing.');
    const developmentCallbacks: AppPluginRuntimeCallbacks = { ...callbacks, execute: undefined, service: undefined };
    const node = load.manifest.backend ? undefined : new NodePluginWorker(this.models, callbacks.log);
    const stdio = load.manifest.backend ? new StdioPluginRuntime(load, this.models, developmentCallbacks) : undefined;
    let runtime: AppPluginDevelopmentRuntime | undefined;
    const handle: AppPluginDevelopmentRuntime = {
      call: (name, args, signal) => {
        if (!runtime) return Promise.reject(new Error('Development app plugin is not ready.'));
        return runtime.call(name, args, signal);
      },
      close: async () => {
        if (node) await node.close(); else await stdio!.close();
        this.development.delete(handle);
      },
      forceClose: async () => {
        if (node) await node.forceClose(); else await stdio!.forceClose();
        this.development.delete(handle);
      },
    };
    this.development.add(handle);
    const launch = (async () => {
      try {
        if (stdio) { await stdio.start(); runtime = stdio; }
        else runtime = await node!.activate(load, developmentCallbacks);
        if (this.closed) { await handle.forceClose(); throw new AppPluginError('closed', 'App plugin host is closing.'); }
      } catch (error) {
        if (error instanceof AppPluginRuntimeStartupError) {
          runtime = error.runtime;
          // Preparation can fail before StdioPluginRuntime owns the spawned uv process.
          handle.close = () => runtime!.close().then(() => { this.development.delete(handle); });
          handle.forceClose = () => runtime!.forceClose().then(() => { this.development.delete(handle); });
          throw new AppPluginRuntimeStartupError(error, handle);
        }
        try { await handle.forceClose(); }
        catch (cleanupError) { throw new AppPluginRuntimeStartupError(new AggregateError([error, cleanupError]), handle); }
        throw error;
      }
    })();
    this.launches.add(launch);
    try { await launch; return handle; }
    finally { this.launches.delete(launch); }
  }

  async changed(catalog: AppPluginCatalog): Promise<void> {
    if (!this.closed) {
      if (this.catalog && catalog.revision < this.catalog.revision) return;
      this.catalog = catalog;
    }
    const plugins = this.closed ? [] : catalog.plugins;
    const retirements: Promise<void>[] = [];
    for (const [id, entry] of this.active) {
      if (entry.retiring?.state === 'failed') continue;
      if (!entry.retiring && plugins.some((plugin) => plugin.manifest.id === id && plugin.enabled && plugin.digest === entry.digest)) continue;
      if (!entry.retiring) {
        this.confirmations.invalidate(id, entry.digest);
        const done = this.serialize(async () => {
          try {
            await entry.ready.catch(() => undefined);
            await entry.runtime?.close();
            if (entry.load?.manifest.backend) await this.removeExecutionDirectory(entry.load.packagePath);
            this.active.delete(id);
          } catch (cause) {
            const error = new AppPluginError('conflict', `App plugin ${id} cleanup failed; its process and execution directory remain owned. Restart before activating it again.`);
            error.cause = cause;
            entry.retiring = { state: 'failed', error };
            throw error;
          }
        });
        entry.retiring = { state: 'pending', done };
      }
      if (entry.retiring.state === 'pending') retirements.push(entry.retiring.done);
    }
    const failures: unknown[] = (await Promise.allSettled(retirements)).flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (!this.closed && this.started && this.catalog?.revision === catalog.revision) {
      const activations: Promise<void>[] = [];
      for (const plugin of plugins) {
        if (!plugin.enabled || !plugin.manifest.background) continue;
        const existing = this.active.get(plugin.manifest.id);
        if (existing?.digest === plugin.digest && existing.failed && !existing.retiring) continue;
        try { activations.push(this.activate(plugin).ready); }
        catch (error) { failures.push(error); }
      }
      for (const result of await Promise.allSettled(activations)) if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'App plugin lifecycle reconciliation failed.');
  }

  async close(): Promise<void> {
    this.closed = true;
    this.confirmations.clear();
    const failures: unknown[] = [];
    try { await Promise.all([this.changed({ revision: 0, plugins: [] }), ...[...this.development].map((runtime) => runtime.close())]); }
    catch (error) { failures.push(error); }
    try { await this.forceClose(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'App plugin shutdown failed.');
  }

  forceClose(): Promise<void> {
    this.closed = true;
    this.confirmations.clear();
    this.stopping ??= (async () => {
      const stopOwned = () => Promise.allSettled([this.worker.forceClose(), ...[...this.active.values()].map((entry) => entry.runtime?.forceClose()), ...[...this.development].map((runtime) => runtime.forceClose())]);
      await stopOwned();
      // Activation/preparation observes the closed state; no new writer may survive this join.
      await Promise.allSettled([...this.launches]);
      await this.tail;
      const failures: unknown[] = [];
      for (const result of await stopOwned()) if (result.status === 'rejected') failures.push(result.reason);
      if (failures.length) throw new AggregateError(failures, 'App plugin process exit was not confirmed; execution directories were retained.');
      for (const path of this.materializedPaths) {
        try { await this.removeExecutionDirectory(path); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, 'App plugin execution directory cleanup failed.');
    })().catch((error) => { this.stopping = undefined; throw error; });
    return this.stopping;
  }

  private async requireEnabled(id: string, digest: string): Promise<InstalledAppPlugin> {
    if (this.closed) throw new AppPluginError('closed', 'App plugin host is closing.');
    const plugin = (await this.options.owner.list()).plugins.find((entry) => entry.manifest.id === id);
    if (!plugin) throw new AppPluginError('not_found', 'App plugin is not installed.');
    if (!plugin.enabled || plugin.digest !== digest) throw new AppPluginError('conflict', 'App plugin is disabled or has changed. Refresh it before calling.');
    return plugin;
  }

  private activate(plugin: InstalledAppPlugin): ActivePlugin {
    if (this.closed) throw new AppPluginError('closed', 'App plugin host is closing.');
    if (plugin.manifest.minSdkVersion) {
      const required = plugin.manifest.minSdkVersion.split('.').map(Number);
      const current = APP_SERVICE_VERSION.split('.').map(Number);
      const different = required.findIndex((part, index) => part !== current[index]);
      if (different >= 0 && required[different] > current[different]) throw new AppPluginError('conflict', `This plugin requires Matcha SDK ${plugin.manifest.minSdkVersion} or newer. Update the application before using it.`);
    }
    const existing = this.active.get(plugin.manifest.id);
    if (existing?.retiring) throw existing.retiring.state === 'failed' ? existing.retiring.error : new AppPluginError('conflict', 'App plugin is retiring. Wait before activating the new version.');
    if (existing?.failed) throw existing.failed;
    if (existing?.digest === plugin.digest) return existing;
    if (existing) throw new AppPluginError('conflict', 'The previous app plugin version has not retired.');
    const entry: ActivePlugin = { digest: plugin.digest, ready: Promise.resolve() };
    const failed = (cause: unknown) => {
      if (entry.failed) return;
      const error = new AppPluginError('conflict', `App plugin ${plugin.manifest.id} failed; the operation was not retried. Restart the application before using it again.`);
      error.cause = cause;
      entry.failed = error;
      this.confirmations.invalidate(plugin.manifest.id, plugin.digest);
      logger.error(`[AppPlugins:${plugin.manifest.id}] ${error.message} ${cause instanceof Error ? cause.message.slice(0, 2000) : ''}`);
    };
    entry.ready = this.serialize(async () => {
      try {
        await this.requireEnabled(plugin.manifest.id, plugin.digest);
        const load = await materializePlugin(this.storage, this.options.rootDir, plugin);
        entry.load = load;
        this.materializedPaths.add(load.packagePath);
        await this.requireEnabled(plugin.manifest.id, plugin.digest);
        const requestConfirmation: AppPluginContext['requestConfirmation'] = async (request, signal = new AbortController().signal) => {
          await this.requireEnabled(plugin.manifest.id, plugin.digest);
          signal.throwIfAborted();
          if (entry.failed) throw entry.failed;
          if (entry.retiring) throw new Error('Approval unavailable: the application is retiring.');
          const allowed = await this.confirmations.request(plugin.manifest.id, plugin.digest, plugin.manifest.name, request, signal);
          await this.requireEnabled(plugin.manifest.id, plugin.digest);
          signal.throwIfAborted();
          if (entry.failed) throw entry.failed;
          if (entry.retiring) throw new Error('Approval unavailable: the application is retiring.');
          return allowed;
        };
        const callbacks: AppPluginRuntimeCallbacks = {
          publish: (event) => { if (!entry.retiring && !entry.failed && !this.closed) this.options.publish(event); },
          failed,
          execute: async (request, signal) => {
            await this.requireEnabled(plugin.manifest.id, plugin.digest);
            if (entry.failed) throw entry.failed;
            if (entry.retiring || !this.options.execute) throw new AppPluginError('busy', 'Application execution is unavailable.');
            signal.throwIfAborted();
            return this.options.execute(request, signal, requestConfirmation);
          },
          service: async (request, signal) => {
            await this.requireEnabled(plugin.manifest.id, plugin.digest);
            if (entry.failed) throw entry.failed;
            if (entry.retiring || !this.options.service) throw new AppServiceError('unavailable', 'Application services are unavailable.');
            signal.throwIfAborted();
            return this.options.service(plugin.manifest.id, request, signal);
          },
          requestConfirmation,
          log: (level, message) => logger[level](`[AppPlugins:${plugin.manifest.id}] ${message.slice(0, 2000)}`),
        };
        if (load.manifest.backend) {
          const runtime = new StdioPluginRuntime(load, this.models, callbacks);
          entry.runtime = runtime;
          await runtime.start();
        } else {
          entry.runtime = this.worker.runtime(load);
          await this.worker.activate(load, callbacks);
        }
      } catch (error) {
        if (error instanceof AppPluginRuntimeStartupError) entry.runtime = error.runtime;
        failed(error);
        throw entry.failed;
      }
      if (entry.failed) throw entry.failed;
    });
    this.active.set(plugin.manifest.id, entry);
    return entry;
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async removeExecutionDirectory(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
    this.materializedPaths.delete(path);
  }
}
