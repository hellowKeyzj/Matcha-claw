import Ajv, { type ValidateFunction } from 'ajv';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { AppMediaModelListRequest, AppModelRequest, AppTextModelRequest, AppVideoTaskRequest, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import { isJson, isToolResult, toolError, type PluginLoad } from './protocol';
import { preparePluginPython, pluginProcessEnvironment } from './python-runtime';
import { AppPluginProcess } from './runtime-process';
import { AppPluginRuntimeStartupError, capturePluginLog, type AppPluginDevelopmentRuntime, type AppPluginModels, type AppPluginRuntimeCallbacks } from './runtime';
import { preparePluginBackend } from './loader';

const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const PROTOCOL_VERSION = '2025-11-25';
type RequestId = string | number;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isRequestId = (value: unknown): value is RequestId => typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));

export class StdioPluginRuntime implements AppPluginDevelopmentRuntime {
  private process?: AppPluginProcess;
  private stopping?: Promise<void>;
  private starting?: Promise<void>;
  private failedPreparation?: AppPluginDevelopmentRuntime;
  private state: 'starting' | 'active' | 'closing' | 'exited' = 'starting';
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, { name?: string; resolve(value: unknown): void; reject(error: unknown): void }>();
  private readonly models = new Map<RequestId, AbortController>();
  private readonly schemas = new Map<string, { input: ValidateFunction; output?: ValidateFunction }>();
  private chunks: Buffer[] = [];
  private frameBytes = 0;

  constructor(private readonly load: PluginLoad, private readonly modelApi: AppPluginModels, private readonly callbacks: AppPluginRuntimeCallbacks) {
    const ajv = new Ajv({ strict: true, addUsedSchema: false });
    for (const tool of load.manifest.contributes.tools ?? []) {
      try { this.schemas.set(tool.name, { input: ajv.compile(tool.inputSchema), output: tool.outputSchema ? ajv.compile(tool.outputSchema) : undefined }); }
      catch (error) { throw new Error(`Invalid JSON Schema for tool ${tool.name}.`, { cause: error }); }
    }
  }

  start(): Promise<void> {
    this.starting ??= this.launch();
    return this.starting;
  }

  private async launch(): Promise<void> {
    try {
      await preparePluginBackend(this.load);
      const backend = this.load.manifest.backend!;
      const executable = backend.language === 'python' ? await preparePluginPython(this.load, this.callbacks, this.controller.signal) : join(this.load.packagePath, backend.entry);
      this.controller.signal.throwIfAborted();
      const args = backend.language === 'python' ? ['-u', '-E', '-s', join(this.load.packagePath, backend.entry)] : [];
      this.process = await AppPluginProcess.launch(executable, args, this.load.packagePath, pluginProcessEnvironment());
      this.controller.signal.throwIfAborted();
      capturePluginLog(this.process.child.stderr, 'error', this.callbacks.log);
      this.process.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
      this.process.child.stdin.on('error', (error) => this.protocolFailed(error));
      this.process.child.stdout.on('error', (error) => this.protocolFailed(error));
      void this.process.exited.then(() => {
        const expected = this.state === 'closing' || this.state === 'exited';
        this.state = 'exited';
        const error = new Error('App plugin process exited; the call was not retried.');
        this.fail(error);
        if (!expected) this.callbacks.failed?.(error);
        void this.process!.forceClose().catch((cleanupError) => this.callbacks.log('error', String(cleanupError).slice(0, 2000)));
        this.chunks = [];
        this.frameBytes = 0;
      });
      const initialized = await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { experimental: { matcha: {} } },
        clientInfo: { name: 'Matcha', version: '1' },
        _meta: { matcha: { pluginId: this.load.manifest.id, version: this.load.manifest.version, packagePath: this.load.packagePath, storagePath: this.load.storagePath } },
      }, AbortSignal.timeout(15_000));
      if (!isRecord(initialized) || initialized.protocolVersion !== PROTOCOL_VERSION || !isRecord(initialized.capabilities)
        || !isRecord(initialized.capabilities.tools) || !isRecord(initialized.serverInfo)
        || typeof initialized.serverInfo.name !== 'string' || typeof initialized.serverInfo.version !== 'string') throw new Error('App plugin MCP initialize response is invalid or uses an unsupported protocol version.');
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const listed = await this.request('tools/list', {}, AbortSignal.timeout(15_000));
      const declared = this.load.manifest.contributes.tools ?? [];
      if (!isRecord(listed) || !Array.isArray(listed.tools) || listed.nextCursor !== undefined || listed.tools.length !== declared.length
        || new Set(listed.tools.map((tool) => isRecord(tool) ? tool.name : undefined)).size !== declared.length
        || !listed.tools.every((tool) => isRecord(tool) && declared.some((entry) => entry.name === tool.name && isDeepStrictEqual(entry, tool)))) {
        throw new Error('App plugin tools/list must exactly match the manifest tool names, descriptions, schemas and metadata.');
      }
      this.controller.signal.throwIfAborted();
      this.state = 'active';
    } catch (error) {
      if (error instanceof AppPluginRuntimeStartupError) { this.failedPreparation = error.runtime; throw new AppPluginRuntimeStartupError(error, this); }
      try { await this.stopProcess(); }
      catch (cleanupError) { throw new AppPluginRuntimeStartupError(new AggregateError([error, cleanupError]), this); }
      throw error;
    }
  }

  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<AppToolResult> {
    signal.throwIfAborted();
    if (this.state !== 'active') throw new Error('App plugin backend is not active.');
    const schema = this.schemas.get(name);
    if (!schema) throw new Error('The tool is not declared by this app plugin.');
    if (!isRecord(args) || !isJson(args) || !schema.input(args)) return toolError(`Invalid tool arguments: ${JSON.stringify(schema.input.errors).slice(0, 1000)}`);
    try {
      const result = await this.request('tools/call', { name, arguments: args }, AbortSignal.any([signal, this.controller.signal]), name);
      if (!isToolResult(result)) throw new Error('Plugin tools/call must return JSON content blocks and valid optional result fields.');
      if (!result.isError && schema.output && !schema.output(result.structuredContent)) throw new Error('Plugin structuredContent does not match its declared outputSchema.');
      return result;
    } catch (error) {
      signal.throwIfAborted();
      return toolError(error instanceof Error ? error.message.slice(0, 2000) : 'App plugin execution failed; the call was not retried.');
    }
  }

  async close(): Promise<void> {
    if (!this.stopping) {
      this.state = 'closing';
      this.fail(new Error('App plugin was deactivated; external effects may already have occurred.'));
      this.stopping = (async () => {
        await this.starting?.catch(() => undefined);
        await this.failedPreparation?.close();
        await this.process?.close();
      })().catch((error) => { this.stopping = undefined; throw error; });
    }
    return this.stopping;
  }

  async forceClose(): Promise<void> {
    await this.stopProcess();
    await this.starting?.catch(() => undefined);
    await this.stopProcess();
  }

  private async stopProcess(): Promise<void> {
    this.state = 'closing';
    this.fail(new Error('App plugin was terminated; external effects may already have occurred.'));
    await this.failedPreparation?.forceClose();
    await this.process?.forceClose();
  }

  private request(method: string, params: Record<string, unknown>, signal: AbortSignal, name?: string): Promise<unknown> {
    signal.throwIfAborted();
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many app plugin requests.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', cancel); this.pending.delete(id); };
      const cancel = () => {
        try { this.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Caller cancelled; external effects may already have occurred.' } }); }
        catch { /* Process exit is already reported to all pending callers. */ }
        finish(); reject(signal.reason);
      };
      this.pending.set(id, { name, resolve: (value) => { finish(); resolve(value); }, reject: (error) => { finish(); reject(error); } });
      signal.addEventListener('abort', cancel, { once: true });
      try { this.send({ jsonrpc: '2.0', id, method, params: name ? { ...params, _meta: { progressToken: id } } : params }); }
      catch (error) { finish(); reject(error); }
    });
  }

  private send(value: Record<string, unknown>): void {
    const input = this.process?.child.stdin;
    if (!input || input.destroyed || input.writableEnded) throw new Error('App plugin stdio is closed; the operation was not retried.');
    const frame = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_FRAME_BYTES || input.writableLength + bytes > MAX_FRAME_BYTES) throw new Error('App plugin stdio write exceeds its bounded frame/queue limit.');
    input.write(frame);
  }

  private read(chunk: Buffer): void {
    try {
      let start = 0;
      for (;;) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const part = chunk.subarray(start, end);
        this.frameBytes += part.length;
        if (this.frameBytes > MAX_FRAME_BYTES) throw new Error('App plugin stdio frame exceeds 128 MiB.');
        if (part.length) this.chunks.push(part);
        if (newline === -1) return;
        const text = Buffer.concat(this.chunks, this.frameBytes).toString('utf8');
        this.chunks = []; this.frameBytes = 0;
        if (text.trim()) this.receive(JSON.parse(text) as unknown);
        start = newline + 1;
        if (start === chunk.length) return;
      }
    } catch (error) { this.protocolFailed(error); }
  }

  private protocolFailed(cause: unknown): void {
    if (this.state === 'closing' || this.state === 'exited') return;
    const error = cause instanceof Error ? cause : new Error('Invalid app plugin stdio protocol.');
    this.callbacks.log('error', error.message.slice(0, 2000));
    this.fail(error);
    this.callbacks.failed?.(error);
    void this.forceClose().catch((cleanupError) => this.callbacks.log('error', String(cleanupError).slice(0, 2000)));
  }

  private receive(value: unknown): void {
    if (!isRecord(value) || value.jsonrpc !== '2.0') throw new Error('Invalid app plugin JSON-RPC envelope.');
    if (typeof value.method === 'string') {
      if (('result' in value) || ('error' in value)) throw new Error('Invalid app plugin JSON-RPC request or notification.');
      if (value.id !== undefined) {
        if (!isRequestId(value.id)) throw new Error('Invalid app plugin JSON-RPC request.');
        void this.receiveRequest(value.id, value.method, value.params);
      } else this.receiveNotification(value.method, value.params);
      return;
    }
    if (!isRequestId(value.id) || ('result' in value) === ('error' in value)) throw new Error('Invalid app plugin JSON-RPC response.');
    if (typeof value.id !== 'string') return;
    const pending = this.pending.get(value.id);
    if (value.error !== undefined) {
      if (!isRecord(value.error) || !Number.isInteger(value.error.code) || typeof value.error.message !== 'string') throw new Error('Invalid app plugin JSON-RPC error.');
      pending?.reject(new Error(value.error.message.slice(0, 2000)));
    } else pending?.resolve(value.result);
  }

  private receiveNotification(method: string, value: unknown): void {
    if (method === 'notifications/cancelled') {
      if (isRecord(value) && isRequestId(value.requestId)) this.models.get(value.requestId)?.abort(new Error('Plugin cancelled the model request; external effects may already have occurred.'));
      return;
    }
    if (method === 'notifications/message') {
      if (!isRecord(value) || typeof value.level !== 'string' || !isJson(value.data)) throw new Error('Invalid app plugin log notification.');
      this.callbacks.log(['error', 'critical', 'alert', 'emergency'].includes(value.level) ? 'error' : 'info', (typeof value.data === 'string' ? value.data : JSON.stringify(value.data)).slice(0, 2000));
      return;
    }
    if (this.state === 'closing' || this.state === 'exited') return;
    if (method === 'notifications/matcha/event') {
      if (!isRecord(value) || typeof value.topic !== 'string' || !value.topic.length || value.topic.length > 200 || !isJson(value.data)) throw new Error('Invalid app plugin event notification.');
      this.callbacks.publish({ pluginId: this.load.manifest.id, digest: this.load.digest, topic: value.topic, data: value.data });
    } else if (method === 'notifications/progress') {
      if (!isRecord(value) || typeof value.progressToken !== 'string') return;
      const name = this.pending.get(value.progressToken)?.name;
      const { progress, total, message } = value;
      if (!name || typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0
        || (total !== undefined && (typeof total !== 'number' || !Number.isFinite(total) || total < progress))) return;
      this.callbacks.publish({ pluginId: this.load.manifest.id, digest: this.load.digest, topic: 'tool-progress', data: {
        name, progress, ...(total === undefined ? {} : { total: total as number }), ...(message === undefined ? {} : { message: String(message).slice(0, 1000) }),
      } });
    } else if (method === 'notifications/tools/list_changed') throw new Error('App plugin tools are fixed by its manifest; update the package before changing tools.');
  }

  private async receiveRequest(id: RequestId, method: string, request: unknown): Promise<void> {
    let controller: AbortController | undefined;
    try {
      if (method === 'ping') { this.send({ jsonrpc: '2.0', id, result: {} }); return; }
      if (!method.startsWith('matcha/models/') || !['list', 'generate', 'generateText', 'submitVideo', 'queryVideo', 'collectVideo'].includes(method.slice('matcha/models/'.length))) {
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } }); return;
      }
      if (!isRecord(request) || !isJson(request)) { this.send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Model params must contain the original request object.' } }); return; }
      if (this.controller.signal.aborted || this.models.size >= 128 || this.models.has(id)) throw new Error('App plugin model request is inactive, duplicate or exceeds the concurrency limit.');
      controller = new AbortController();
      this.models.set(id, controller);
      const signal = AbortSignal.any([controller.signal, this.controller.signal]);
      let result: unknown;
      switch (method.slice('matcha/models/'.length)) {
        case 'list': result = await this.modelApi.list(request as unknown as AppMediaModelListRequest, signal); break;
        case 'generate': result = await this.modelApi.generate(request as unknown as AppModelRequest, signal); break;
        case 'generateText': result = await this.modelApi.generateText(request as unknown as AppTextModelRequest, signal); break;
        case 'submitVideo': result = await this.modelApi.submitVideo(request as unknown as AppModelRequest & { readonly kind: 'video' }, signal); break;
        case 'queryVideo': result = await this.modelApi.queryVideo(request as unknown as AppVideoTaskRequest, signal); break;
        case 'collectVideo': result = await this.modelApi.collectVideo(request as unknown as AppVideoTaskRequest, signal); break;
      }
      this.send({ jsonrpc: '2.0', id, result });
    } catch (error) {
      try { this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message.slice(0, 2000) : 'Model request failed; external effects may already have occurred.' } }); }
      catch { /* Never replay a reverse request after process exit. */ }
    } finally { if (controller && this.models.get(id) === controller) this.models.delete(id); }
  }

  private fail(error: unknown): void {
    this.controller.abort(error);
    for (const pending of this.pending.values()) pending.reject(error);
    for (const model of this.models.values()) model.abort(error);
  }
}
