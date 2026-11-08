import Ajv, { type ValidateFunction } from 'ajv';
import { createRequire } from 'node:module';
import { AsyncLocalStorage } from 'node:async_hooks';
import { APP_EXECUTION_OPERATIONS, APP_SERVICE_OPERATIONS, AppServiceError, AppConfirmationUnavailableError, isAppConfirmationRequest, type AppConfirmationRequest, type AppExecutionApi, type AppExecutionResult, type AppPluginContext, type AppServiceResult } from '../../../src/types/desktop/app-plugin-sdk';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppMediaModelList, AppMediaModelListRequest, AppModelRequest, AppModelResult, AppMusicModelRequest, AppSpeechModelRequest, AppTranscriptionModelRequest, AppTextModelRequest, AppTextModelResult, AppVideoTaskRequest, AppVideoTaskResult, AppPluginModule, AppToolHandler, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import type { HostRequest, PluginLoad, WorkerMessage } from './protocol';
import { isExecutionEnvelope, isExecutionPayload, parseExecutionRequest, isServiceEnvelope, isServicePayload, parseServiceRequest, serviceError, isJson, isModelErrorCode, isToolResult, toolError } from './protocol';

const port = process.parentPort;
if (!port) throw new Error('App plugin worker requires its Electron parent port.');
const send = (message: WorkerMessage) => port.postMessage(message);
const loadModule = createRequire(__filename);
interface ActivePlugin {
  load: PluginLoad;
  tools: Map<string, AppToolHandler>;
  schemas: Map<string, { input: ValidateFunction; output?: ValidateFunction }>;
  controller: AbortController;
  dispose?: () => void | Promise<void>;
  activation?: Promise<void | (() => void | Promise<void>)>;
  retiring?: { state: 'pending'; done: Promise<void> } | { state: 'failed'; error: Error };
}
const plugins = new Map<string, ActivePlugin>();
const calls = new Map<string, { pluginId: string; controller: AbortController; done: Promise<void> }>();
const hostRequests = new Map<string, { plugin: ActivePlugin; kind: 'model' | 'execution' | 'service'; resolve: (result: unknown) => void; reject: (error: Error) => void }>();
const toolScope = new AsyncLocalStorage<{ callId: string; pluginId: string }>();
const confirmations = new Map<string, { resolve: (result: boolean) => void; reject: (error: Error) => void }>();

function requestConfirmation(plugin: ActivePlugin, request: AppConfirmationRequest, signal?: AbortSignal): Promise<boolean> {
  const scope = toolScope.getStore();
  const call = scope && scope.pluginId === plugin.load.manifest.id ? calls.get(scope.callId) : undefined;
  if (!scope || !call || plugin.retiring) return Promise.reject(new AppConfirmationUnavailableError('Approval unavailable: confirmation requires an active tool call.'));
  if (!isAppConfirmationRequest(request)) return Promise.reject(new Error('Invalid confirmation request.'));
  if (confirmations.size >= 128) return Promise.reject(new Error('Too many confirmation requests.'));
  const combined = AbortSignal.any([call.controller.signal, plugin.controller.signal, ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  const requestId = randomUUID();
  return new Promise<boolean>((resolve, reject) => {
    const finish = () => { combined.removeEventListener('abort', cancel); confirmations.delete(requestId); };
    const cancel = () => {
      send({ type: 'confirmation-cancel', requestId });
      confirmations.get(requestId)?.reject(new Error('Confirmation cancelled.'));
    };
    confirmations.set(requestId, { resolve: (result) => { finish(); resolve(result); }, reject: (error) => { finish(); reject(error); } });
    combined.addEventListener('abort', cancel, { once: true });
    try { send({ type: 'confirmation', requestId, callId: scope.callId, pluginId: plugin.load.manifest.id, digest: plugin.load.digest, request }); }
    catch (error) { finish(); reject(error); }
  });
}

function requestHost<T>(plugin: ActivePlugin, kind: 'model' | 'execution' | 'service', sendRequest: (requestId: string) => void, signal?: AbortSignal): Promise<T> {
  const combined = signal ? AbortSignal.any([signal, plugin.controller.signal]) : plugin.controller.signal;
  if (kind === 'service') {
    if (combined.aborted) throw serviceError(new AppServiceError('cancelled', ''), combined);
    if (plugins.get(plugin.load.manifest.id) !== plugin || plugin.retiring || hostRequests.size >= 128) throw new AppServiceError('unavailable', 'App service request is inactive or exceeds the concurrency limit.');
  } else {
    combined.throwIfAborted();
    if (hostRequests.size >= 128) throw new Error('Too many plugin host requests.');
  }
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      try {
        send(kind === 'model' ? { type: 'model-cancel', requestId }
          : { type: kind === 'service' ? 'service-cancel' : 'execution-cancel', requestId, pluginId: plugin.load.manifest.id, digest: plugin.load.digest });
      } catch { /* A closed parent channel cannot receive cancellation; the local request still rejects. */ }
      finally { hostRequests.get(requestId)?.reject(kind === 'service'
        ? serviceError(new AppServiceError('outcome-unknown', ''))
        : new Error('Host request cancelled; native execution or external effects may already have occurred.')); }
    };
    const finish = () => { combined.removeEventListener('abort', cancel); hostRequests.delete(requestId); };
    hostRequests.set(requestId, {
      plugin, kind,
      resolve: (result) => { finish(); resolve(result as T); },
      reject: (error) => { finish(); reject(error); },
    });
    combined.addEventListener('abort', cancel, { once: true });
    try { sendRequest(requestId); }
    catch (error) { finish(); reject(kind === 'service' ? serviceError(error, combined) : error); }
  });
}

function executionApi(plugin: ActivePlugin): AppExecutionApi {
  // The SDK owns the method set and input guard; Main rechecks every request before native execution.
  return Object.freeze(Object.fromEntries(APP_EXECUTION_OPERATIONS.map((operation) => [operation, (input: unknown, signal?: AbortSignal) => {
    const request = parseExecutionRequest({ operation, input });
    const scope = request.operation === 'resolveTeamApproval' ? toolScope.getStore() : undefined;
    if (request.operation === 'resolveTeamApproval') {
      const call = scope?.pluginId === plugin.load.manifest.id ? calls.get(scope.callId) : undefined;
      if (!call || call.pluginId !== plugin.load.manifest.id || call.controller.signal.aborted || plugin.controller.signal.aborted
        || plugins.get(plugin.load.manifest.id) !== plugin || plugin.retiring) throw new AppConfirmationUnavailableError('Approval unavailable: resolving team approval requires an active tool call.');
      signal = AbortSignal.any([call.controller.signal, ...(signal ? [signal] : [])]);
    }
    return requestHost<AppExecutionResult>(plugin, 'execution', (requestId) => {
      const envelope = { type: 'execution-request' as const, requestId, pluginId: plugin.load.manifest.id, digest: plugin.load.digest };
      const message = request.operation === 'resolveTeamApproval' ? { ...envelope, request, callId: scope!.callId } : { ...envelope, request };
      if (!isExecutionEnvelope(message)) throw new Error('Execution request envelope exceeds 1 MiB.');
      send(message);
    }, signal);
  }]))) as AppExecutionApi;
}

function serviceApis(plugin: ActivePlugin): Pick<AppPluginContext, keyof typeof APP_SERVICE_OPERATIONS> {
  return Object.fromEntries(Object.entries(APP_SERVICE_OPERATIONS).map(([service, operations]) => [service,
    Object.freeze(Object.fromEntries(operations.map((operation) => [operation, (input: unknown, signal?: AbortSignal) => {
      const request = parseServiceRequest({ service, operation, input });
      return requestHost<AppServiceResult>(plugin, 'service', (requestId) => {
        const message = { type: 'service-request', requestId, pluginId: plugin.load.manifest.id, digest: plugin.load.digest, request } satisfies WorkerMessage;
        if (!isServiceEnvelope(message)) throw new AppServiceError('invalid-request', 'App service request envelope exceeds 8 MiB.');
        send(message);
      }, signal);
    }]))),
  ])) as Pick<AppPluginContext, keyof typeof APP_SERVICE_OPERATIONS>;
}

async function deactivate(pluginId: string): Promise<void> {
  const plugin = plugins.get(pluginId);
  if (!plugin) return;
  if (!plugin.retiring) {
    const done = (async () => {
      try {
        plugin.controller.abort(new Error('App plugin was deactivated.'));
        const running = [...calls.values()].filter((call) => call.pluginId === pluginId);
        for (const call of running) call.controller.abort(new Error('App plugin was deactivated.'));
        await Promise.all(running.map((call) => call.done));
        try {
          if (plugin.activation) {
            const dispose = await plugin.activation;
            if (typeof dispose === 'function') plugin.dispose = dispose;
          }
          await plugin.dispose?.();
        }
        finally {
          plugin.tools.clear();
          for (const path of Object.keys(loadModule.cache)) {
            const child = relative(plugin.load.packagePath, path);
            if (child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(child)) delete loadModule.cache[path];
          }
        }
      } catch (cause) {
        // A rejected dispose does not confirm that the plugin's own background work stopped.
        const error = new Error(`App plugin ${pluginId} cleanup failed; restart the application before activating it again.`, { cause });
        plugin.retiring = { state: 'failed', error };
        throw error;
      }
      plugins.delete(pluginId);
    })();
    plugin.retiring = { state: 'pending', done };
  }
  if (plugin.retiring.state === 'failed') throw plugin.retiring.error;
  await plugin.retiring.done;
}

async function activate(load: PluginLoad): Promise<void> {
  await deactivate(load.manifest.id);
  const ajv = new Ajv({ strict: true, addUsedSchema: false });
  const schemas = new Map((load.manifest.contributes.tools ?? []).map((tool) => {
    try {
      return [tool.name, { input: ajv.compile(tool.inputSchema), output: tool.outputSchema ? ajv.compile(tool.outputSchema) : undefined }] as const;
    } catch (error) {
      throw new Error(`Invalid JSON Schema for tool ${tool.name}: ${error instanceof Error ? error.message : 'schema compilation failed'}`, { cause: error });
    }
  }));
  const plugin: ActivePlugin = { load, tools: new Map(), schemas, controller: new AbortController() };
  plugins.set(load.manifest.id, plugin);
  const { manifest, digest } = load;
  try {
    const module = loadModule(join(load.packagePath, manifest.main!)) as AppPluginModule;
    if (typeof module.activate !== 'function') throw new Error('Plugin main must export activate(context).');
    plugin.activation = Promise.resolve(module.activate(Object.freeze({
      pluginId: manifest.id, version: manifest.version, storagePath: load.storagePath, packagePath: load.packagePath,
      registerTool(name: string, handler: AppToolHandler) {
        if (plugin.controller.signal.aborted || !manifest.contributes.tools?.some((tool) => tool.name === name)
          || typeof handler !== 'function' || plugin.tools.has(name)) throw new Error('Tool registration must use a unique manifest-declared local name.');
        plugin.tools.set(name, handler);
        return () => { if (plugin.tools.get(name) === handler) plugin.tools.delete(name); };
      },
      publish(topic: string, data: unknown) {
        if (plugin.controller.signal.aborted) return;
        if (typeof topic !== 'string' || !topic.length || topic.length > 200 || !isJson(data)) throw new Error('Invalid plugin event.');
        send({ type: 'event', event: { pluginId: manifest.id, digest, topic, data } });
      },
      requestConfirmation: (request: AppConfirmationRequest, signal?: AbortSignal) => requestConfirmation(plugin, request, signal),
      execution: executionApi(plugin),
      ...serviceApis(plugin),
      models: Object.freeze({
        list(request: AppMediaModelListRequest, signal?: AbortSignal) {
          return requestHost<AppMediaModelList>(plugin, 'model', (requestId) => send({ type: 'media-model', operation: 'list', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        generate(request: AppModelRequest, signal?: AbortSignal) {
          return requestHost<AppModelResult>(plugin, 'model', (requestId) => send({ type: 'model', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        submitVideo(request: AppModelRequest & { readonly kind: 'video' }, signal?: AbortSignal) {
          return requestHost<AppVideoTaskResult>(plugin, 'model', (requestId) => send({ type: 'media-model', operation: 'submitVideo', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        queryVideo(request: AppVideoTaskRequest, signal?: AbortSignal) {
          return requestHost<AppVideoTaskResult>(plugin, 'model', (requestId) => send({ type: 'media-model', operation: 'queryVideo', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        collectVideo(request: AppVideoTaskRequest, signal?: AbortSignal) {
          return requestHost<AppModelResult>(plugin, 'model', (requestId) => send({ type: 'media-model', operation: 'collectVideo', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        generateText(request: AppTextModelRequest, signal?: AbortSignal) {
          return requestHost<AppTextModelResult>(plugin, 'model', (requestId) => send({ type: 'text-model', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        generateSpeech(request: AppSpeechModelRequest, signal?: AbortSignal) {
          return requestHost<AppModelResult>(plugin, 'model', (requestId) => send({ type: 'media-model', operation: 'generateSpeech', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        transcribe(request: AppTranscriptionModelRequest, signal?: AbortSignal) {
          return requestHost<AppModelResult>(plugin, 'model', (requestId) => send({ type: 'media-model', operation: 'transcribe', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        generateMusic(request: AppMusicModelRequest, signal?: AbortSignal) {
          return requestHost<AppModelResult>(plugin, 'model', (requestId) => send({ type: 'media-model', operation: 'generateMusic', requestId, pluginId: manifest.id, digest, request }), signal);
        },
      }),
      log: Object.freeze({
        info: (message: string) => send({ type: 'log', pluginId: manifest.id, level: 'info', message: String(message).slice(0, 2000) }),
        error: (message: string) => send({ type: 'log', pluginId: manifest.id, level: 'error', message: String(message).slice(0, 2000) }),
      }),
    })));
    let dispose;
    try { dispose = await plugin.activation; }
    finally { plugin.activation = undefined; }
    if (dispose !== undefined && typeof dispose !== 'function') throw new Error('Plugin activate must return a cleanup function or void.');
    if (typeof dispose === 'function') plugin.dispose = dispose;
    if (plugin.controller.signal.aborted) throw new Error('App plugin activation was retired.');
    for (const tool of manifest.contributes.tools ?? []) if (!plugin.tools.has(tool.name)) throw new Error(`Plugin did not register declared tool ${tool.name}.`);
  } catch (error) {
    try { await deactivate(manifest.id); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'App plugin activation and cleanup failed; restart the application.', { cause: cleanupError });
    }
    throw error;
  }
}

async function dispatch(message: HostRequest): Promise<void> {
  if (message.type === 'cancel') { calls.get(message.requestId)?.controller.abort(new Error('Tool caller disconnected; external effects may already have occurred.')); return; }
  if (message.type === 'confirmation-result') {
    const pending = confirmations.get(message.requestId);
    if (message.error) pending?.reject(message.errorCode === 'approval_unavailable' ? new AppConfirmationUnavailableError(message.error) : new Error(message.error));
    else if (typeof message.result === 'boolean') pending?.resolve(message.result);
    else pending?.reject(new Error('Invalid confirmation response.'));
    return;
  }
  if (message.type === 'service-result') {
    const pending = hostRequests.get(message.requestId);
    if (!pending || pending.kind !== 'service' || pending.plugin.load.manifest.id !== message.pluginId
      || pending.plugin.load.digest !== message.digest || plugins.get(message.pluginId) !== pending.plugin) return;
    if (!isServiceEnvelope(message)) { pending.reject(new AppServiceError('response-too-large', 'Invalid app service response envelope.')); return; }
    if (typeof message.error === 'string') pending.reject(serviceError(new AppServiceError(message.errorCode!, '')));
    else if (pending.plugin.controller.signal.aborted || pending.plugin.retiring) pending.reject(serviceError(new AppServiceError('outcome-unknown', '')));
    else if (isServicePayload(message.result)) pending.resolve(message.result);
    else pending.reject(new AppServiceError('response-too-large', 'App service result must be a JSON object within 8 MiB.'));
    return;
  }
  if (message.type === 'execution-result') {
    const pending = hostRequests.get(message.requestId);
    if (!pending || pending.kind !== 'execution' || pending.plugin.load.manifest.id !== message.pluginId
      || pending.plugin.load.digest !== message.digest || plugins.get(message.pluginId) !== pending.plugin) return;
    if (!isExecutionEnvelope(message)) { pending.reject(new Error('Invalid execution response envelope.')); return; }
    if (typeof message.error === 'string') {
      const error = message.errorCode === 'approval_unavailable' ? new AppConfirmationUnavailableError(message.error.slice(0, 2000)) : new Error(message.error.slice(0, 2000));
      if (message.errorCode === 'unavailable' || message.errorCode === 'cancelled') Object.assign(error, { code: message.errorCode });
      pending.reject(error);
    } else if (isExecutionPayload(message.result)) pending.resolve(message.result);
    else pending.reject(new Error('Invalid execution response.'));
    return;
  }
  if (message.type === 'model-result' || message.type === 'text-model-result' || message.type === 'media-model-result') {
    const pending = hostRequests.get(message.requestId);
    if (pending?.kind !== 'model') return;
    if (message.error) {
      const error = new Error(message.error);
      if (isModelErrorCode(message.errorCode)) Object.assign(error, { code: message.errorCode });
      pending?.reject(error);
    } else if (message.result) pending?.resolve(message.result);
    return;
  }
  let result: AppToolResult | undefined;
  try {
    if (message.type === 'activate') await activate(message.plugin);
    else if (message.type === 'deactivate') await deactivate(message.pluginId);
    else {
      const plugin = plugins.get(message.pluginId);
      const handler = plugin?.tools.get(message.name);
      if (!plugin || plugin.controller.signal.aborted || plugin.load.digest !== message.digest || !handler) throw new Error('Plugin tool is not active.');
      const schema = plugin.schemas.get(message.name)!;
      if (!schema.input(message.arguments)) throw new Error(`Invalid tool arguments: ${JSON.stringify(schema.input.errors).slice(0, 1000)}`);
      if (calls.size >= 128) throw new Error('Too many plugin tool calls.');
      const controller = new AbortController();
      let finish = () => undefined as void;
      const done = new Promise<void>((resolve) => { finish = resolve; });
      calls.set(message.requestId, { pluginId: message.pluginId, controller, done });
      try {
        result = await toolScope.run({ callId: message.requestId, pluginId: message.pluginId }, () => handler(message.arguments, {
          signal: controller.signal,
          reportProgress(progress, total, text) {
            if (!Number.isFinite(progress) || progress < 0 || (total !== undefined && (!Number.isFinite(total) || total < progress))) return;
            send({ type: 'event', event: { pluginId: message.pluginId, digest: message.digest, topic: 'tool-progress',
              data: { name: message.name, progress, ...(total === undefined ? {} : { total }), ...(text === undefined ? {} : { message: String(text).slice(0, 1000) }) } } });
          },
        }));
        if (!isToolResult(result)) {
          throw new Error('Plugin handler must return a JSON AppToolResult with typed content blocks and valid optional fields.');
        }
        if (!result.isError && schema.output && !schema.output(result.structuredContent)) throw new Error('Plugin structuredContent does not match its declared outputSchema.');
      } finally { calls.delete(message.requestId); controller.abort(new Error('Tool call completed.')); finish(); }
    }
    send({ type: 'result', requestId: message.requestId, result });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message.slice(0, 2000) : 'Plugin execution failed.';
    send(message.type === 'call' ? { type: 'result', requestId: message.requestId, result: toolError(errorMessage) }
      : { type: 'result', requestId: message.requestId, error: errorMessage });
  }
}
port.on('message', (event) => { void dispatch(event.data as HostRequest); });
send({ type: 'ready' });
