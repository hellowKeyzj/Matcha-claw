import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppConfirmationUnavailableError, type AppPluginContext, type AppRuntimeEvent, type AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import { isModelErrorCode, type HostRequest, type PluginLoad, type WorkerMessage } from './protocol';

export type AppPluginModels = AppPluginContext['models'];
export interface AppPluginRuntimeCallbacks {
  publish(event: AppRuntimeEvent): void;
  log(level: 'info' | 'error', message: string): void;
  failed?(error: Error): void;
  requestConfirmation?(request: import('../../../src/types/desktop/app-plugin-sdk').AppConfirmationRequest, signal: AbortSignal): Promise<boolean>;
}
export interface AppPluginDevelopmentRuntime {
  call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<AppToolResult>;
  close(): Promise<void>;
  forceClose(): Promise<void>;
}
export class AppPluginRuntimeStartupError extends Error {
  constructor(cause: unknown, readonly runtime: AppPluginDevelopmentRuntime) {
    super('App plugin launch cleanup did not confirm process exit; keep its execution directory and retry forceClose.', { cause });
  }
}
export async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

export function capturePluginLog(stream: NodeJS.ReadableStream | null | undefined, level: 'info' | 'error', log: AppPluginRuntimeCallbacks['log']): void {
  if (!stream) return;
  let windowStart = Date.now(), remaining = 32 * 1024;
  stream.on('data', (chunk: Buffer | string) => {
    if (Date.now() - windowStart >= 1000) { windowStart = Date.now(); remaining = 32 * 1024; }
    if (remaining <= 0) return;
    const text = String(chunk).slice(0, Math.min(remaining, 2000));
    remaining -= Buffer.byteLength(text);
    log(level, text);
  });
}

export class NodePluginWorker {
  private child?: UtilityProcess;
  private started?: Promise<void>;
  private exited: Promise<void> = Promise.resolve();
  private stopped = false;
  private stopping?: Promise<void>;
  private readonly plugins = new Map<string, { load: PluginLoad; callbacks: AppPluginRuntimeCallbacks; retiring?: true }>();
  private readonly pending = new Map<string, { resolve(value?: AppToolResult): void; reject(error: unknown): void; type: 'activate' | 'deactivate' | 'call'; pluginId: string }>();
  private readonly models = new Map<string, { pluginId: string; controller: AbortController }>();
  private readonly confirmations = new Map<string, { pluginId: string; callId: string; controller: AbortController }>();

  constructor(private readonly modelApi: AppPluginModels, private readonly log: AppPluginRuntimeCallbacks['log']) {}

  async activate(load: PluginLoad, callbacks: AppPluginRuntimeCallbacks): Promise<AppPluginDevelopmentRuntime> {
    await this.start();
    this.plugins.set(load.manifest.id, { load, callbacks });
    await this.request({ type: 'activate', requestId: randomUUID(), plugin: load }, AbortSignal.timeout(15_000));
    return this.runtime(load);
  }

  runtime(load: PluginLoad): AppPluginDevelopmentRuntime {
    return {
      call: async (name, args, signal) => (await this.request({ type: 'call', requestId: randomUUID(), pluginId: load.manifest.id, digest: load.digest, name, arguments: args }, signal))!,
      close: () => this.deactivate(load.manifest.id),
      forceClose: () => this.forceClose(),
    };
  }

  async deactivate(pluginId: string): Promise<void> {
    const plugin = this.plugins.get(pluginId);
    if (!plugin) return;
    plugin.retiring = true;
    for (const model of this.models.values()) if (model.pluginId === pluginId) model.controller.abort();
    for (const confirmation of this.confirmations.values()) if (confirmation.pluginId === pluginId) confirmation.controller.abort();
    if (this.child) await within(this.request({ type: 'deactivate', requestId: randomUUID(), pluginId }), 3000, 'App plugin cleanup timed out; its shared worker remains owned until application shutdown.');
    this.plugins.delete(pluginId);
  }

  async close(): Promise<void> {
    try { await within(Promise.all([...this.plugins.keys()].map((id) => this.deactivate(id))), 3000, 'App plugin worker cleanup timed out.'); }
    finally { await this.forceClose(); }
  }

  forceClose(): Promise<void> {
    this.stopped = true;
    this.stopping ??= (async () => {
      for (const model of this.models.values()) model.controller.abort();
      for (const confirmation of this.confirmations.values()) confirmation.controller.abort();
      if (this.child && !this.child.kill()) throw new Error('App plugin worker termination failed; execution files must be retained.');
      await within(this.exited, 5000, 'App plugin worker exit was not confirmed; execution files must be retained.');
    })().catch((error) => { this.stopping = undefined; throw error; });
    return this.stopping;
  }

  private start(): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('App plugin worker is closed.'));
    this.started ??= new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(join(__dirname, 'extensions', 'worker.js'), [], { serviceName: 'Matcha Application Plugins', stdio: 'pipe' });
      this.child = child;
      capturePluginLog(child.stdout, 'info', this.log);
      capturePluginLog(child.stderr, 'error', this.log);
      const timer = setTimeout(() => { reject(new Error('App plugin worker did not become ready.')); child.kill(); }, 15_000);
      child.on('message', (message: WorkerMessage) => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(); }
        else this.receive(message);
      });
      this.exited = new Promise<void>((done) => child.once('exit', (code) => {
        clearTimeout(timer);
        this.child = undefined;
        const expected = this.stopped;
        this.stopped = true;
        const error = new Error(`App plugin worker exited (${code}); the call was not retried.`);
        if (!expected) for (const plugin of this.plugins.values()) if (!plugin.retiring) plugin.callbacks.failed?.(error);
        reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        for (const model of this.models.values()) model.controller.abort(error);
        this.plugins.clear();
        done();
      }));
    });
    return this.started;
  }

  private request(message: Extract<HostRequest, { type: 'activate' | 'deactivate' | 'call' }>, signal?: AbortSignal): Promise<AppToolResult | undefined> {
    signal?.throwIfAborted();
    if (!this.child) return Promise.reject(new Error('App plugin worker is unavailable; the operation was not retried.'));
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many plugin requests.'));
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(message.requestId);
        for (const confirmation of this.confirmations.values()) if (confirmation.callId === message.requestId) confirmation.controller.abort();
      };
      const cancel = () => {
        this.child?.postMessage({ type: 'cancel', requestId: message.requestId } satisfies HostRequest);
        finish();
        reject(signal?.reason ?? new Error('Plugin call cancelled; external effects may already have occurred.'));
      };
      this.pending.set(message.requestId, { type: message.type, pluginId: message.type === 'activate' ? message.plugin.manifest.id : message.pluginId, resolve: (value) => { finish(); resolve(value); }, reject: (error) => { finish(); reject(error); } });
      signal?.addEventListener('abort', cancel, { once: true });
      try { this.child!.postMessage(message); } catch (error) { finish(); reject(error); }
    });
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'result') {
      const pending = this.pending.get(message.requestId);
      if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
      return;
    }
    if (message.type === 'confirmation-cancel') { this.confirmations.get(message.requestId)?.controller.abort(); return; }
    if (message.type === 'confirmation') {
      const controller = new AbortController();
      void (async () => {
        try {
          const plugin = this.plugins.get(message.pluginId);
          if (!plugin || plugin.retiring || plugin.load.digest !== message.digest || this.pending.get(message.callId)?.type !== 'call' || this.pending.get(message.callId)?.pluginId !== message.pluginId
            || !plugin.callbacks.requestConfirmation || this.confirmations.has(message.requestId) || this.confirmations.size >= 128) throw new AppConfirmationUnavailableError('Approval unavailable: no active tool call or foreground confirmation owner.');
          this.confirmations.set(message.requestId, { pluginId: message.pluginId, callId: message.callId, controller });
          const result = await plugin.callbacks.requestConfirmation(message.request, controller.signal);
          controller.signal.throwIfAborted();
          this.child?.postMessage({ type: 'confirmation-result', requestId: message.requestId, result } satisfies HostRequest);
        } catch (error) {
          this.child?.postMessage({ type: 'confirmation-result', requestId: message.requestId, error: error instanceof Error ? error.message : 'Confirmation failed.',
            ...(error instanceof Error && 'code' in error && error.code === 'approval_unavailable' ? { errorCode: 'approval_unavailable' as const } : {}) } satisfies HostRequest);
        } finally { if (this.confirmations.get(message.requestId)?.controller === controller) this.confirmations.delete(message.requestId); }
      })();
      return;
    }
    if (message.type === 'model-cancel') { this.models.get(message.requestId)?.controller.abort(); return; }
    if (message.type === 'log') { this.plugins.get(message.pluginId)?.callbacks.log(message.level, message.message.slice(0, 2000)); return; }
    if (message.type === 'event') {
      const plugin = this.plugins.get(message.event.pluginId);
      if (plugin?.load.digest === message.event.digest && !plugin.retiring) plugin.callbacks.publish(message.event);
      return;
    }
    if (message.type !== 'model' && message.type !== 'text-model' && message.type !== 'media-model') return;
    const controller = new AbortController();
    const responseType = message.type === 'model' ? 'model-result' : message.type === 'text-model' ? 'text-model-result' : 'media-model-result';
    void (async () => {
      try {
        const plugin = this.plugins.get(message.pluginId);
        if (!plugin || plugin.retiring || plugin.load.digest !== message.digest) throw new Error('The plugin model request belongs to an inactive version.');
        if (this.models.size >= 128 || this.models.has(message.requestId)) throw new Error('Too many or duplicate plugin model requests.');
        this.models.set(message.requestId, { pluginId: message.pluginId, controller });
        if (message.type === 'model') {
          const result = await this.modelApi.generate(message.request, controller.signal);
          this.child?.postMessage({ type: 'model-result', requestId: message.requestId, result } satisfies HostRequest);
        } else if (message.type === 'text-model') {
          const result = await this.modelApi.generateText(message.request, controller.signal);
          this.child?.postMessage({ type: 'text-model-result', requestId: message.requestId, result } satisfies HostRequest);
        } else {
          let result;
          switch (message.operation) {
            case 'generateSpeech': result = await this.modelApi.generateSpeech(message.request, controller.signal); break;
            case 'transcribe': result = await this.modelApi.transcribe(message.request, controller.signal); break;
            case 'generateMusic': result = await this.modelApi.generateMusic(message.request, controller.signal); break;
            case 'list': result = await this.modelApi.list(message.request, controller.signal); break;
            case 'submitVideo': result = await this.modelApi.submitVideo(message.request, controller.signal); break;
            case 'queryVideo': result = await this.modelApi.queryVideo(message.request, controller.signal); break;
            case 'collectVideo': result = await this.modelApi.collectVideo(message.request, controller.signal); break;
          }
          this.child?.postMessage({ type: 'media-model-result', requestId: message.requestId, result } satisfies HostRequest);
        }
      } catch (error) {
        const response: Extract<HostRequest, { type: typeof responseType }> = { type: responseType, requestId: message.requestId, error: error instanceof Error ? error.message.slice(0, 2000) : 'Model generation failed; external effects may already have occurred.' };
        if (error instanceof Error && 'code' in error && isModelErrorCode(error.code)) response.errorCode = error.code;
        this.child?.postMessage(response);
      } finally { if (this.models.get(message.requestId)?.controller === controller) this.models.delete(message.requestId); }
    })();
  }
}
