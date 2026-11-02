import Ajv, { type ValidateFunction } from 'ajv';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppMediaModelList, AppMediaModelListRequest, AppModelRequest, AppModelResult, AppTextModelRequest, AppTextModelResult, AppVideoTaskRequest, AppVideoTaskResult, AppPluginModule, AppToolHandler, AppToolResult } from '../../../src/types/desktop/app-plugin-sdk';
import type { HostRequest, PluginLoad, WorkerMessage } from './protocol';
import { isJson, isToolResult, toolError } from './protocol';

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
const models = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void }>();

function requestModel<T>(plugin: ActivePlugin, sendRequest: (requestId: string) => void, signal?: AbortSignal): Promise<T> {
  const combined = signal ? AbortSignal.any([signal, plugin.controller.signal]) : plugin.controller.signal;
  combined.throwIfAborted();
  if (models.size >= 128) throw new Error('Too many plugin model requests.');
  const requestId = randomUUID();
  return new Promise<T>((resolve, reject) => {
    const cancel = () => {
      send({ type: 'model-cancel', requestId });
      models.get(requestId)?.reject(new Error('Model request cancelled; external effects may already have occurred.'));
    };
    const finish = () => { combined.removeEventListener('abort', cancel); models.delete(requestId); };
    models.set(requestId, {
      resolve: (result) => { finish(); resolve(result as T); },
      reject: (error) => { finish(); reject(error); },
    });
    combined.addEventListener('abort', cancel, { once: true });
    try { sendRequest(requestId); }
    catch (error) { finish(); reject(error); }
  });
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
      models: Object.freeze({
        list(request: AppMediaModelListRequest, signal?: AbortSignal) {
          return requestModel<AppMediaModelList>(plugin, (requestId) => send({ type: 'media-model', operation: 'list', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        generate(request: AppModelRequest, signal?: AbortSignal) {
          return requestModel<AppModelResult>(plugin, (requestId) => send({ type: 'model', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        submitVideo(request: AppModelRequest & { readonly kind: 'video' }, signal?: AbortSignal) {
          return requestModel<AppVideoTaskResult>(plugin, (requestId) => send({ type: 'media-model', operation: 'submitVideo', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        queryVideo(request: AppVideoTaskRequest, signal?: AbortSignal) {
          return requestModel<AppVideoTaskResult>(plugin, (requestId) => send({ type: 'media-model', operation: 'queryVideo', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        collectVideo(request: AppVideoTaskRequest, signal?: AbortSignal) {
          return requestModel<AppModelResult>(plugin, (requestId) => send({ type: 'media-model', operation: 'collectVideo', requestId, pluginId: manifest.id, digest, request }), signal);
        },
        generateText(request: AppTextModelRequest, signal?: AbortSignal) {
          return requestModel<AppTextModelResult>(plugin, (requestId) => send({ type: 'text-model', requestId, pluginId: manifest.id, digest, request }), signal);
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
  if (message.type === 'model-result' || message.type === 'text-model-result' || message.type === 'media-model-result') {
    const pending = models.get(message.requestId);
    if (message.error) pending?.reject(new Error(message.error));
    else if (message.result) pending?.resolve(message.result);
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
        result = await handler(message.arguments, {
          signal: controller.signal,
          reportProgress(progress, total, text) {
            if (!Number.isFinite(progress) || progress < 0 || (total !== undefined && (!Number.isFinite(total) || total < progress))) return;
            send({ type: 'event', event: { pluginId: message.pluginId, digest: message.digest, topic: 'tool-progress',
              data: { name: message.name, progress, ...(total === undefined ? {} : { total }), ...(text === undefined ? {} : { message: String(text).slice(0, 1000) }) } } });
          },
        });
        if (!isToolResult(result)) {
          throw new Error('Plugin handler must return a JSON AppToolResult with typed content blocks and valid optional fields.');
        }
        if (!result.isError && schema.output && !schema.output(result.structuredContent)) throw new Error('Plugin structuredContent does not match its declared outputSchema.');
      } finally { calls.delete(message.requestId); finish(); }
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
