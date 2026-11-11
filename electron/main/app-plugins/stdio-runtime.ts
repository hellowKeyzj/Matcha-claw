import Ajv, { type ValidateFunction } from 'ajv';
import { APP_SERVICE_MAX_BYTES, APP_SERVICE_OPERATIONS, AppServiceError, AppConfirmationUnavailableError, isAppConfirmationRequest, isAppExecutionOperation } from '../../../src/types/desktop/app-plugin-sdk';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import type { AppJson, AppRenderDocumentRead, AppMediaModelListRequest, AppModelRequest, AppMusicModelRequest, AppSpeechModelRequest, AppTranscriptionModelRequest, AppTextModelRequest, AppVideoTaskRequest, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import { isExecutionPayload, parseExecutionRequest, isServicePayload, parseServiceRequest, serviceError, isServiceErrorCode, isServiceReadEnvelope, isJson, isModelErrorCode, isToolResult, toolError, type PluginLoad } from './protocol';
import { preparePluginPython, pluginProcessEnvironment } from './python-runtime';
import { AppPluginProcess } from './runtime-process';
import { AppPluginRuntimeStartupError, capturePluginLog, within, type AppPluginDevelopmentRuntime, type AppPluginModels, type AppPluginRuntimeCallbacks } from './runtime';
import { preparePluginBackend } from './loader';

const MAX_FRAME_BYTES = 128 * 1024 * 1024;
const PROTOCOL_VERSION = '2025-11-25';
const SERVICE_METHODS = new Map<string, { service: string; operation: string }>(Object.entries(APP_SERVICE_OPERATIONS).flatMap(([service, operations]) =>
  operations.map((operation) => [`matcha/${service}/${operation}`, { service, operation }] as const)));
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
  private readonly hostRequests = new Map<RequestId, { callId?: string; controller: AbortController; done: Promise<void> }>();
  private readonly confirmations = new Map<RequestId, { callId: string; controller: AbortController }>();
  private readonly serviceReads = new Map<string, { parentRequestId: RequestId; resolve(result: AppJson): void; reject(error: unknown): void }>();
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
        await Promise.all([this.process?.close(), this.joinHostRequests()]);
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
    await Promise.all([this.process?.forceClose(), this.joinHostRequests()]);
  }

  private async joinHostRequests(): Promise<void> {
    await within(Promise.all([...this.hostRequests.values()].map((request) => request.done)), 5000, 'App plugin host request cleanup was not confirmed; retain its execution directory.');
  }

  private request(method: string, params: Record<string, unknown>, signal: AbortSignal, name?: string): Promise<unknown> {
    signal.throwIfAborted();
    if (this.pending.size >= 128) return Promise.reject(new Error('Too many app plugin requests.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', cancel);
        this.pending.delete(id);
        for (const request of this.hostRequests.values()) if (request.callId === id) request.controller.abort();
        for (const confirmation of this.confirmations.values()) if (confirmation.callId === id) confirmation.controller.abort();
      };
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

  private readService(parentRequestId: RequestId, input: AppJson, signal: AbortSignal): Promise<AppJson> {
    const parent = this.hostRequests.get(parentRequestId);
    if (!parent || this.state !== 'active' || this.controller.signal.aborted || parent.controller.signal.aborted) return Promise.reject(new AppServiceError('unavailable', 'Document read requires the active parent render request.'));
    if (this.serviceReads.size >= 128 || [...this.serviceReads.values()].filter(read => read.parentRequestId === parentRequestId).length >= 32) return Promise.reject(new AppServiceError('unavailable', 'Document reads exceed the bounded concurrency limit.'));
    signal.throwIfAborted();
    const readId = randomUUID();
    const params = { parentRequestId, pluginId: this.load.manifest.id, digest: this.load.digest, readId, input };
    if (!isServiceReadEnvelope({ type: 'service-read', ...params })) return Promise.reject(new AppServiceError('invalid-request', 'Document read input exceeds 8 MiB or is not JSON.'));
    return new Promise((resolve, reject) => {
      const finish = () => { signal.removeEventListener('abort', cancel); this.serviceReads.delete(readId); };
      const cancel = () => { finish(); parent.controller.abort(signal.reason); reject(new AppServiceError('cancelled', 'Document read cancelled.')); };
      this.serviceReads.set(readId, { parentRequestId, resolve: result => { finish(); resolve(result); }, reject: error => { finish(); reject(error); } });
      signal.addEventListener('abort', cancel, { once: true });
      try { this.send({ jsonrpc: '2.0', id: readId, method: 'matcha/service-read', params }, APP_SERVICE_MAX_BYTES); }
      catch (error) { finish(); reject(error); }
    });
  }

  private send(value: Record<string, unknown>, maximum = MAX_FRAME_BYTES): void {
    const input = this.process?.child.stdin;
    if (!input || input.destroyed || input.writableEnded) throw new Error('App plugin stdio is closed; the operation was not retried.');
    const frame = JSON.stringify(value) + '\n';
    const bytes = Buffer.byteLength(frame);
    if (bytes > maximum) {
      if (maximum === APP_SERVICE_MAX_BYTES) throw new AppServiceError('response-too-large', 'App service response envelope exceeds 8 MiB.');
      throw new Error('App plugin stdio write exceeds its bounded frame limit.');
    }
    if (input.writableLength + bytes > MAX_FRAME_BYTES) throw new Error('App plugin stdio write exceeds its bounded queue limit.');
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
        const bytes = this.frameBytes + 1;
        const text = Buffer.concat(this.chunks, this.frameBytes).toString('utf8');
        this.chunks = []; this.frameBytes = 0;
        if (text.trim()) {
          let value: unknown;
          try { value = JSON.parse(text) as unknown; }
          catch { throw new Error('Invalid app plugin JSON frame.'); }
          this.receive(value, bytes);
        }
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

  private receive(value: unknown, bytes: number): void {
    if (!isRecord(value) || value.jsonrpc !== '2.0') throw new Error('Invalid app plugin JSON-RPC envelope.');
    if (typeof value.method === 'string') {
      if (('result' in value) || ('error' in value)) throw new Error('Invalid app plugin JSON-RPC request or notification.');
      if (value.id !== undefined) {
        if (!isRequestId(value.id)) throw new Error('Invalid app plugin JSON-RPC request.');
        if (SERVICE_METHODS.has(value.method) && typeof value.id === 'string' && (!value.id.length || value.id.length > 128)) throw new Error('Invalid app service request identifier.');
        if (SERVICE_METHODS.has(value.method) && (bytes > APP_SERVICE_MAX_BYTES || Object.keys(value).some((key) => !['jsonrpc', 'id', 'method', 'params', 'hasRead'].includes(key))
          || Object.hasOwn(value, 'hasRead') && (value.hasRead !== true || value.method !== 'matcha/rendering/renderDocument'))) {
          this.send({ jsonrpc: '2.0', id: value.id, error: { code: -32602, message: 'App service request must use a closed JSON-RPC envelope within 8 MiB.', data: { code: 'invalid-request' } } }, APP_SERVICE_MAX_BYTES);
          return;
        }
        void this.receiveRequest(value.id, value.method, value.params, value.hasRead === true);
      } else this.receiveNotification(value.method, value.params);
      return;
    }
    if (!isRequestId(value.id) || ('result' in value) === ('error' in value)) throw new Error('Invalid app plugin JSON-RPC response.');
    if (typeof value.id !== 'string') return;
    const read = this.serviceReads.get(value.id);
    if (read) {
      const parent = this.hostRequests.get(read.parentRequestId);
      if (!parent || parent.controller.signal.aborted || this.state !== 'active' || this.controller.signal.aborted) return;
      if (bytes > APP_SERVICE_MAX_BYTES || Object.keys(value).some(key => !['jsonrpc', 'id', 'result', 'error'].includes(key))) {
        read.reject(new AppServiceError('response-too-large', 'Invalid document read JSON-RPC response envelope.')); return;
      }
      if (value.error !== undefined) {
        if (!isRecord(value.error) || !Number.isInteger(value.error.code) || typeof value.error.message !== 'string') throw new Error('Invalid document read JSON-RPC error.');
        const code = isRecord(value.error.data) && isServiceErrorCode(value.error.data.code) ? value.error.data.code : 'unavailable';
        const error = new AppServiceError(code, value.error.message.slice(0, 2000));
        read.reject(error);
        return;
      }
      const response = value.result;
      if (!isRecord(response) || response.parentRequestId !== read.parentRequestId || response.readId !== value.id
        || response.pluginId !== this.load.manifest.id || response.digest !== this.load.digest) return;
      if (!isServiceReadEnvelope({ type: 'service-read-result', ...response })) read.reject(new AppServiceError('response-too-large', 'Invalid document read response envelope.'));
      else if (typeof response.error === 'string') read.reject(new AppServiceError(isServiceErrorCode(response.errorCode) ? response.errorCode : 'unavailable', response.error));
      else read.resolve(response.result as AppJson);
      return;
    }
    const pending = this.pending.get(value.id);
    if (value.error !== undefined) {
      if (!isRecord(value.error) || !Number.isInteger(value.error.code) || typeof value.error.message !== 'string') throw new Error('Invalid app plugin JSON-RPC error.');
      pending?.reject(new Error(value.error.message.slice(0, 2000)));
    } else pending?.resolve(value.result);
  }

  private receiveNotification(method: string, value: unknown): void {
    if (method === 'notifications/cancelled') {
      if (isRecord(value) && isRequestId(value.requestId)) {
        this.hostRequests.get(value.requestId)?.controller.abort(new Error('Plugin cancelled the host request; native execution or external effects may already have occurred.'));
        this.confirmations.get(value.requestId)?.controller.abort(new Error('Plugin cancelled the confirmation request.'));
      }
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

  private async receiveRequest(id: RequestId, method: string, request: unknown, hasRead = false): Promise<void> {
    let controller: AbortController | undefined;
    let finish = () => undefined as void;
    const service = SERVICE_METHODS.get(method);
    try {
      if (method === 'ping') { this.send({ jsonrpc: '2.0', id, result: {} }); return; }
      if (method === 'matcha/requestConfirmation') {
        if (this.state !== 'active' || !isRecord(request) || Object.keys(request).some((key) => key !== 'request' && key !== 'callId')
          || typeof request.callId !== 'string' || !this.pending.get(request.callId)?.name || !isAppConfirmationRequest(request.request)
          || !this.callbacks.requestConfirmation || this.confirmations.has(id) || this.hostRequests.has(id) || this.confirmations.size >= 128) throw new AppConfirmationUnavailableError('Approval unavailable: confirmation requires an active tool call and foreground owner.');
        const confirmation = { callId: request.callId, controller: new AbortController() };
        this.confirmations.set(id, confirmation);
        try {
          const result = await this.callbacks.requestConfirmation(request.request, confirmation.controller.signal);
          confirmation.controller.signal.throwIfAborted();
          this.send({ jsonrpc: '2.0', id, result });
        } finally { if (this.confirmations.get(id) === confirmation) this.confirmations.delete(id); }
        return;
      }
      const execution = method.startsWith('matcha/execution/');
      const operation = method.slice('matcha/execution/'.length);
      if (!service && (execution ? !isAppExecutionOperation(operation)
        : !method.startsWith('matcha/models/') || !['list', 'generate', 'generateText', 'generateSpeech', 'transcribe', 'generateMusic', 'submitVideo', 'queryVideo', 'collectVideo'].includes(method.slice('matcha/models/'.length)))) {
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } }); return;
      }
      let callId: string | undefined;
      let executionInput = request;
      if (execution && operation === 'resolveTeamApproval') {
        if (this.state !== 'active' || !isRecord(request) || typeof request.callId !== 'string' || !request.callId.length || request.callId.length > 128
          || !this.pending.get(request.callId)?.name) throw new AppConfirmationUnavailableError('Approval unavailable: resolving team approval requires an active tool call.');
        const { callId: activeCallId, ...input } = request;
        callId = activeCallId;
        executionInput = input;
      }
      const serviceRequest = service ? parseServiceRequest({ ...service, input: request }) : undefined;
      if (!isRecord(request) || !isJson(request)) { this.send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'Host params must contain the original JSON request object.' } }); return; }
      if (service && (this.state !== 'active' || this.controller.signal.aborted || this.hostRequests.size >= 128 || this.hostRequests.has(id) || this.confirmations.has(id))) throw new AppServiceError('unavailable', 'App service request is inactive, duplicate or exceeds the concurrency limit.');
      if (this.controller.signal.aborted || this.hostRequests.size >= 128 || this.hostRequests.has(id) || this.confirmations.has(id)) throw new Error('App plugin host request is inactive, duplicate or exceeds the concurrency limit.');
      controller = new AbortController();
      const done = new Promise<void>((resolve) => { finish = resolve; });
      this.hostRequests.set(id, { ...(callId === undefined ? {} : { callId }), controller, done });
      const signal = AbortSignal.any([controller.signal, this.controller.signal]);
      let result: unknown;
      if (serviceRequest) {
        if (!isServicePayload({ jsonrpc: '2.0', id, method, params: request })) throw new AppServiceError('invalid-request', 'App service request envelope exceeds 8 MiB.');
        if (!this.callbacks.service) throw new AppServiceError('unavailable', 'App service unavailable: this plugin runtime has no service owner.');
        const read: AppRenderDocumentRead | undefined = hasRead ? (input, readSignal) => this.readService(id, input, readSignal ? AbortSignal.any([signal, readSignal]) : signal) : undefined;
        result = await this.callbacks.service(serviceRequest, signal, read);
        if (signal.aborted || this.state !== 'active') throw new AppServiceError('outcome-unknown', 'App service observation ended; external effects may already have occurred.');
        if (!isServicePayload(result)) throw new AppServiceError('response-too-large', 'App service result must be a JSON object within 8 MiB.');
      } else if (execution) {
        if (!isExecutionPayload({ jsonrpc: '2.0', id, method, params: request })) throw new Error('Execution request exceeds 1 MiB.');
        const input = parseExecutionRequest({ operation, input: executionInput });
        if (!this.callbacks.execute) throw Object.assign(new Error('Execution unavailable: this plugin runtime has no execution owner.'), { code: 'unavailable' });
        result = await this.callbacks.execute(input, signal);
        signal.throwIfAborted();
        if (!isExecutionPayload(result) || !isExecutionPayload({ jsonrpc: '2.0', id, result })) throw new Error('Execution result must be a JSON object within 1 MiB.');
      } else switch (method.slice('matcha/models/'.length)) {
        case 'list': result = await this.modelApi.list(request as unknown as AppMediaModelListRequest, signal); break;
        case 'generate': result = await this.modelApi.generate(request as unknown as AppModelRequest, signal); break;
        case 'generateText': result = await this.modelApi.generateText(request as unknown as AppTextModelRequest, signal); break;
        case 'generateSpeech': result = await this.modelApi.generateSpeech(request as unknown as AppSpeechModelRequest, signal); break;
        case 'transcribe': result = await this.modelApi.transcribe(request as unknown as AppTranscriptionModelRequest, signal); break;
        case 'generateMusic': result = await this.modelApi.generateMusic(request as unknown as AppMusicModelRequest, signal); break;
        case 'submitVideo': result = await this.modelApi.submitVideo(request as unknown as AppModelRequest & { readonly kind: 'video' }, signal); break;
        case 'queryVideo': result = await this.modelApi.queryVideo(request as unknown as AppVideoTaskRequest, signal); break;
        case 'collectVideo': result = await this.modelApi.collectVideo(request as unknown as AppVideoTaskRequest, signal); break;
      }
      this.send({ jsonrpc: '2.0', id, result }, service ? APP_SERVICE_MAX_BYTES : MAX_FRAME_BYTES);
    } catch (error) {
      if (service) {
        const safeError = hasRead && error instanceof AppServiceError ? new AppServiceError(error.code, error.message.slice(0, 2000)) : serviceError(error, controller?.signal);
        try { this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: safeError.message, data: { code: safeError.code } } }, APP_SERVICE_MAX_BYTES); }
        catch { /* Never replay a reverse service request or expose its input/result after process exit. */ }
        return;
      }
      const code = method.startsWith('matcha/execution/') && controller?.signal.aborted ? 'cancelled' : error instanceof Error && 'code' in error && (isModelErrorCode(error.code) || error.code === 'approval_unavailable' || error.code === 'unavailable') ? error.code : undefined;
      try { this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: error instanceof Error ? error.message.slice(0, 2000) : 'Model request failed; external effects may already have occurred.',
        ...(code === undefined ? {} : { data: { code } }) } }); }
      catch { /* Never replay a reverse request after process exit. */ }
    } finally {
      if (controller && this.hostRequests.get(id)?.controller === controller) {
        for (const read of this.serviceReads.values()) if (read.parentRequestId === id) read.reject(new AppServiceError('cancelled', 'Parent document render request ended.'));
        this.hostRequests.delete(id);
      }
      finish();
    }
  }

  private fail(error: unknown): void {
    this.controller.abort(error);
    for (const pending of this.pending.values()) pending.reject(error);
    for (const request of this.hostRequests.values()) request.controller.abort(error);
    for (const confirmation of this.confirmations.values()) confirmation.controller.abort(error);
  }
}
