import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AppServiceError, AppConfirmationUnavailableError, type AppServiceRequest, type AppServiceResult, type AppExecutionRequest, type AppExecutionResult, type AppPluginContext, type AppRuntimeEvent, type AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import { isExecutionEnvelope, isExecutionPayload, parseExecutionRequest, isServiceEnvelope, isServicePayload, parseServiceRequest, serviceError, isModelErrorCode, type HostRequest, type PluginLoad, type WorkerMessage } from './protocol';

export type AppPluginModels = AppPluginContext['models'];
export interface AppPluginRuntimeCallbacks {
  publish(event: AppRuntimeEvent): void;
  log(level: 'info' | 'error', message: string): void;
  failed?(error: Error): void;
  execute?(request: AppExecutionRequest, signal: AbortSignal): Promise<AppExecutionResult>;
  service?(request: AppServiceRequest, signal: AbortSignal): Promise<AppServiceResult>;
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
  private readonly hostRequests = new Map<string, { pluginId: string; digest: string; kind: 'model' | 'execution' | 'service'; callId?: string; controller: AbortController; done: Promise<void> }>();
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
    const requests = [...this.hostRequests.values()].filter((request) => request.pluginId === pluginId);
    for (const request of requests) request.controller.abort();
    for (const confirmation of this.confirmations.values()) if (confirmation.pluginId === pluginId) confirmation.controller.abort();
    await within(Promise.all([...(this.child ? [this.request({ type: 'deactivate', requestId: randomUUID(), pluginId })] : []),
      ...requests.map((request) => request.done)]), 3000, 'App plugin cleanup timed out; its shared worker remains owned until application shutdown.');
    this.plugins.delete(pluginId);
  }

  async close(): Promise<void> {
    try { await within(Promise.all([...this.plugins.keys()].map((id) => this.deactivate(id))), 3000, 'App plugin worker cleanup timed out.'); }
    finally { await this.forceClose(); }
  }

  forceClose(): Promise<void> {
    this.stopped = true;
    this.stopping ??= (async () => {
      const requests = [...this.hostRequests.values()];
      for (const request of requests) request.controller.abort();
      for (const confirmation of this.confirmations.values()) confirmation.controller.abort();
      if (this.child && !this.child.kill()) throw new Error('App plugin worker termination failed; execution files must be retained.');
      await within(Promise.all([this.exited, ...requests.map((request) => request.done)]), 5000, 'App plugin worker exit or host request cleanup was not confirmed; execution files must be retained.');
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
        for (const request of this.hostRequests.values()) request.controller.abort(error);
        for (const confirmation of this.confirmations.values()) confirmation.controller.abort(error);
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
        for (const request of this.hostRequests.values()) if (request.callId === message.requestId) request.controller.abort();
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
    if (message.type === 'service-cancel') {
      const pending = this.hostRequests.get(message.requestId);
      const plugin = this.plugins.get(message.pluginId);
      if (isServiceEnvelope(message) && pending?.kind === 'service' && pending.pluginId === message.pluginId && pending.digest === message.digest
        && plugin?.load.digest === message.digest && !plugin.retiring && !this.stopped) pending.controller.abort();
      return;
    }
    if (message.type === 'execution-cancel') {
      const pending = this.hostRequests.get(message.requestId);
      if (isExecutionEnvelope(message) && pending?.kind === 'execution' && pending.pluginId === message.pluginId && pending.digest === message.digest) pending.controller.abort();
      return;
    }
    if (message.type === 'model-cancel') {
      const pending = this.hostRequests.get(message.requestId);
      if (pending?.kind === 'model') pending.controller.abort();
      return;
    }
    if (message.type === 'log') { this.plugins.get(message.pluginId)?.callbacks.log(message.level, message.message.slice(0, 2000)); return; }
    if (message.type === 'event') {
      const plugin = this.plugins.get(message.event.pluginId);
      if (plugin?.load.digest === message.event.digest && !plugin.retiring) plugin.callbacks.publish(message.event);
      return;
    }
    if (message.type !== 'model' && message.type !== 'text-model' && message.type !== 'media-model' && message.type !== 'execution-request' && message.type !== 'service-request') return;
    if (message.type === 'execution-request' && !isExecutionEnvelope(message)) return;
    if (message.type === 'service-request' && !isServiceEnvelope(message)) return;
    const controller = new AbortController();
    let finish = () => undefined as void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const responseType = message.type === 'model' ? 'model-result' : message.type === 'text-model' ? 'text-model-result' : 'media-model-result';
    void (async () => {
      try {
        const plugin = this.plugins.get(message.pluginId);
        if (!plugin || plugin.retiring || this.stopped || plugin.load.digest !== message.digest) {
          if (message.type === 'service-request') throw new AppServiceError('unavailable', 'The app service request belongs to an inactive plugin version.');
          throw new Error('The plugin host request belongs to an inactive version.');
        }
        if (this.hostRequests.size >= 128 || this.hostRequests.has(message.requestId)) {
          if (message.type === 'service-request') throw new AppServiceError('unavailable', 'Too many or duplicate app service requests.');
          throw new Error('Too many or duplicate plugin host requests.');
        }
        const executionRequest = message.type === 'execution-request' ? parseExecutionRequest(message.request) : undefined;
        let callId: string | undefined;
        if (message.type === 'execution-request' && executionRequest?.operation === 'resolveTeamApproval') {
          const call = message.callId ? this.pending.get(message.callId) : undefined;
          if (call?.type !== 'call' || call.pluginId !== message.pluginId) throw new AppConfirmationUnavailableError('Approval unavailable: resolving team approval requires an active tool call.');
          callId = message.callId;
        }
        this.hostRequests.set(message.requestId, { pluginId: message.pluginId, digest: message.digest, kind: message.type === 'execution-request' ? 'execution' : message.type === 'service-request' ? 'service' : 'model', ...(callId === undefined ? {} : { callId }), controller, done });
        if (message.type === 'service-request') {
          const request = parseServiceRequest(message.request);
          if (!plugin.callbacks.service) throw new AppServiceError('unavailable', 'App service unavailable: this plugin runtime has no service owner.');
          const result = await plugin.callbacks.service(request, controller.signal);
          if (controller.signal.aborted || this.plugins.get(message.pluginId) !== plugin || plugin.retiring || this.stopped) throw new AppServiceError('outcome-unknown', 'App service observation ended; external effects may already have occurred.');
          const response = { type: 'service-result', requestId: message.requestId, pluginId: message.pluginId, digest: message.digest, result } satisfies HostRequest;
          if (!isServicePayload(result) || !isServiceEnvelope(response)) throw new AppServiceError('response-too-large', 'App service result must be a JSON object within 8 MiB.');
          this.child?.postMessage(response);
        } else if (message.type === 'execution-request') {
          if (!plugin.callbacks.execute) throw Object.assign(new Error('Execution unavailable: this plugin runtime has no execution owner.'), { code: 'unavailable' });
          const result = await plugin.callbacks.execute(executionRequest!, controller.signal);
          controller.signal.throwIfAborted();
          if (this.plugins.get(message.pluginId) !== plugin || plugin.retiring) throw new Error('The execution response belongs to an inactive plugin version.');
          const response = { type: 'execution-result', requestId: message.requestId, pluginId: message.pluginId, digest: message.digest, result } satisfies HostRequest;
          if (!isExecutionPayload(result) || !isExecutionEnvelope(response)) throw new Error('Execution result must be a JSON object within 1 MiB.');
          this.child?.postMessage(response);
        } else if (message.type === 'model') {
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
        const safeError = message.type === 'service-request' ? serviceError(error, controller.signal) : undefined;
        const text = safeError?.message ?? (error instanceof Error ? error.message.slice(0, 2000) : 'Host request failed; native execution or external effects may already have occurred.');
        if (message.type === 'service-request') {
          this.child?.postMessage({ type: 'service-result', requestId: message.requestId, pluginId: message.pluginId, digest: message.digest,
            error: safeError!.message, errorCode: safeError!.code } satisfies HostRequest);
        } else if (message.type === 'execution-request') {
          this.child?.postMessage({ type: 'execution-result', requestId: message.requestId, pluginId: message.pluginId, digest: message.digest, error: text,
            ...(controller.signal.aborted ? { errorCode: 'cancelled' as const }
              : error instanceof Error && 'code' in error && (error.code === 'unavailable' || error.code === 'approval_unavailable') ? { errorCode: error.code } : {}) } satisfies HostRequest);
        } else {
          const response: Extract<HostRequest, { type: typeof responseType }> = { type: responseType, requestId: message.requestId, error: text };
          if (error instanceof Error && 'code' in error && isModelErrorCode(error.code)) response.errorCode = error.code;
          this.child?.postMessage(response);
        }
      } finally {
        if (this.hostRequests.get(message.requestId)?.controller === controller) this.hostRequests.delete(message.requestId);
        finish();
      }
    })().catch((error) => this.log('error', message.type === 'service-request' ? 'App service response delivery failed.'
      : error instanceof Error ? error.message.slice(0, 2000) : 'Plugin host response delivery failed.'));
  }
}
