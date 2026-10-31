import i18n from '@/i18n';
import { validateAppComposeRequest, validateAppWorkspaceFileRequest, type AppComposeRequest, type AppSessionMediaData, type AppSessionMediaList, type AppToolResult, type AppWebviewApi, type AppWebviewContext } from '@/types/desktop/app-plugin-sdk';

declare global {
  interface Window {
    readonly matchaApp: AppWebviewApi;
  }
}

export function getAppBridgeMessages(): Record<string, string> {
  return i18n.t('common:appFrame', { returnObjects: true }) as Record<string, string>;
}

// Serialized into the iframe: keep this bootstrap independent of Renderer imports and credentials.
function installAppBridge(pluginId: string, context: AppWebviewContext, validateCompose: typeof validateAppComposeRequest, validateWorkspaceFile: typeof validateAppWorkspaceFileRequest, initialMessages: Record<string, string>): void {
  if (context.sessionIdentity) {
    Object.freeze(context.sessionIdentity.endpoint);
    Object.freeze(context.sessionIdentity);
  }
  Object.freeze(context);
  const applyTheme = (theme: 'light' | 'dark') => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  };
  if (context.theme) applyTheme(context.theme);
  let messages = initialMessages;
  let language = context.language;
  const text = (key: string) => messages[key.split('.').at(-1)!] ?? key;
  let port: MessagePort | null = null;
  let closed = false;
  let nextId = 0;
  const pending = new Map<number, { resolve: (result: AppToolResult) => void; reject: (error: Error) => void }>();
  const listeners = new Set<Parameters<AppWebviewApi['subscribe']>[0]>();
  let nextCloseOwner = 0;
  let closeOwner: { id: number; handler: Parameters<NonNullable<AppWebviewApi['onCloseRequested']>>[0] } | null = null;
  let lastCloseRequest = 0;
  let closeRequest: { id: number; owner: number; controller: AbortController } | null = null;
  const sendCloseOwner = () => { if (!closed && port) port.postMessage({ type: 'close-owner', owner: closeOwner?.id ?? null }); };
  let connectPort: (value: MessagePort) => void;
  let rejectConnection: (error: Error) => void;
  const connection = new Promise<MessagePort>((resolve, reject) => { connectPort = resolve; rejectConnection = reject; });
  void connection.catch(() => {});
  let failure: string | null = null;
  const reportError = (message: string) => {
    failure = message.slice(0, 500) || text('executionFailed');
    port?.postMessage({ type: 'error', message: failure });
  };
  const dispose = () => {
    if (closed) return;
    closed = true;
    window.removeEventListener('message', connect, true);
    window.removeEventListener('pagehide', dispose);
    window.removeEventListener('error', scriptError);
    window.removeEventListener('unhandledrejection', rejection);
    const error = new Error(text('closed'));
    rejectConnection(error);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    listeners.clear();
    closeRequest?.controller.abort();
    closeRequest = null;
    closeOwner = null;
    if (port) { port.onmessage = null; port.onmessageerror = null; port.close(); port = null; }
  };
  const connect = (event: MessageEvent<unknown>) => {
    if (event.source !== window.parent || !event.data || typeof event.data !== 'object'
      || (event.data as { type?: unknown }).type !== 'matcha:app-connect') return;
    event.stopImmediatePropagation();
    if (port || event.ports.length !== 1) { event.ports.forEach((value) => value.close()); return; }
    window.removeEventListener('message', connect, true);
    port = event.ports[0];
    port.onmessage = (message: MessageEvent<unknown>) => {
      message.ports.forEach((value) => value.close());
      if (message.ports.length || !message.data || typeof message.data !== 'object') { reportError(text('invalidMessage')); return; }
      const value = message.data as Record<string, unknown>;
      if (value.type === 'close-request') {
        if (Object.keys(value).some((key) => !['type', 'id', 'owner'].includes(key)) || !Number.isSafeInteger(value.id) || Number(value.id) <= lastCloseRequest
          || !closeOwner || value.owner !== closeOwner.id) { reportError(text('invalidRequest')); return; }
        closeRequest?.controller.abort();
        lastCloseRequest = Number(value.id);
        const owner = closeOwner;
        const active = { id: Number(value.id), owner: owner.id, controller: new AbortController() };
        closeRequest = active;
        void Promise.resolve().then(() => {
          active.controller.signal.throwIfAborted();
          return owner.handler(active.controller.signal);
        }).then((allowed) => {
          if (!closed && closeOwner === owner && closeRequest === active && !active.controller.signal.aborted) {
            if (allowed !== true) closeRequest = null;
            port?.postMessage({ type: 'close-result', id: active.id, owner: owner.id, allowed: allowed === true });
          }
        }, (error: unknown) => {
          if (!closed && closeOwner === owner && closeRequest === active && !active.controller.signal.aborted) {
            closeRequest = null;
            port?.postMessage({ type: 'close-result', id: active.id, owner: owner.id, allowed: false, error: error instanceof Error ? error.message.slice(0, 500) : text('closeFailed') });
          }
        });
      } else if (value.type === 'close-abort') {
        if (Object.keys(value).some((key) => !['type', 'id', 'owner'].includes(key)) || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.owner)) { reportError(text('invalidRequest')); return; }
        const active = closeRequest;
        if (active && active.id === value.id && active.owner === value.owner) {
          active.controller.abort();
          closeRequest = null;
        }
      } else if (value.type === 'result' && typeof value.id === 'number') {
        const request = pending.get(value.id);
        if (!request) return;
        pending.delete(value.id);
        if (typeof value.error === 'string') {
          const error = new Error(value.error);
          if (typeof value.code === 'string' && ['unsupported', 'cursorInvalid', 'invalidReference', 'tooLarge', 'unavailable'].includes(value.code)) Object.assign(error, { code: value.code });
          request.reject(error);
        }
        else if (value.result && typeof value.result === 'object' && Array.isArray((value.result as AppToolResult).content)) request.resolve(value.result as AppToolResult);
        else request.reject(new Error(text('invalidResult')));
      } else if (value.type === 'locale' && typeof value.language === 'string' && value.messages && typeof value.messages === 'object') {
        messages = value.messages as Record<string, string>;
        language = value.language;
        for (const listener of listeners) {
          try { listener({ topic: 'locale.changed', data: { language: value.language } }); }
          catch (error) { reportError(error instanceof Error ? error.message : text('eventHandlerFailed')); }
        }
      } else if (value.type === 'theme' && (value.theme === 'light' || value.theme === 'dark')) {
        applyTheme(value.theme);
      } else if (value.type === 'event' && typeof value.topic === 'string') {
        for (const listener of listeners) {
          try { listener({ topic: value.topic, data: value.data as Parameters<typeof listener>[0]['data'] }); }
          catch (error) { reportError(error instanceof Error ? error.message : text('eventHandlerFailed')); }
        }
      } else { reportError(text('unsupportedMessage')); }
    };
    port.onmessageerror = () => reportError(text('decodeFailed'));
    port.start();
    connectPort(port);
    port.postMessage(failure ? { type: 'error', message: failure } : { type: 'ready' });
    sendCloseOwner();
  };
  const scriptError = (event: ErrorEvent) => reportError(event.message || text('scriptFailed'));
  const rejection = (event: PromiseRejectionEvent) => reportError(event.reason instanceof Error ? event.reason.message : text('asyncFailed'));
  const request = (message: { type: 'call'; name: string; arguments: Readonly<Record<string, unknown>> } | { type: 'compose'; request: AppComposeRequest } | { type: 'clipboard'; request: Parameters<AppWebviewApi['writeClipboardImage']>[0] } | { type: 'workspace-save'; request: Parameters<NonNullable<AppWebviewApi['saveWorkspaceFile']>>[0] } | { type: 'media-list'; request?: Parameters<AppWebviewApi['listSessionMedia']>[0] } | { type: 'media-read'; request: Parameters<AppWebviewApi['readSessionMedia']>[0] }): Promise<AppToolResult> => {
    if (closed) return Promise.reject(new Error(text('closed')));
    if (pending.size >= 64) return Promise.reject(new Error(text('tooManyRequests')));
    const id = ++nextId;
    return new Promise<AppToolResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      void connection.then((target) => {
        if (!closed) target.postMessage({ ...message, id });
      }).catch((error: unknown) => {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(text('requestFailed')));
      });
    });
  };
  const api: AppWebviewApi = Object.freeze({
    pluginId,
    context,
    call(name: string, arguments_: Readonly<Record<string, unknown>> = {}) {
      if (!name || typeof name !== 'string' || name.length > 128 || !arguments_ || typeof arguments_ !== 'object' || Array.isArray(arguments_)) return Promise.reject(new Error(text('invalidTool')));
      return request({ type: 'call', name, arguments: arguments_ });
    },
    compose(input: AppComposeRequest) {
      const error = validateCompose(input);
      if (error) return Promise.reject(new Error(text(error)));
      return request({ type: 'compose', request: input }).then(() => {});
    },
    async listSessionMedia(input?: Parameters<AppWebviewApi['listSessionMedia']>[0]): Promise<AppSessionMediaList> {
      if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => key !== 'cursor')
        || (input.cursor !== undefined && (typeof input.cursor !== 'string' || !/^media_cursor_[a-f0-9]{64}$/.test(input.cursor))))) throw new Error(text('invalidRequest'));
      const result = await request({ type: 'media-list', ...(input ? { request: input } : {}) });
      const value = result.structuredContent;
      if (!value || !['loaded-window', 'session-images'].includes(String(value.scope)) || !Array.isArray(value.items)
        || Object.keys(value).some((key) => !['items', 'scope', 'nextCursor', 'historyImages', 'omittedOversized'].includes(key))
        || (value.nextCursor !== undefined && (typeof value.nextCursor !== 'string' || !/^media_cursor_[a-f0-9]{64}$/.test(value.nextCursor)))
        || (value.historyImages !== undefined && value.historyImages !== 'supported' && value.historyImages !== 'unsupported')
        || (value.omittedOversized !== undefined && typeof value.omittedOversized !== 'boolean')
        || (value.scope === 'session-images' ? value.historyImages !== 'supported' : value.nextCursor !== undefined)
        || value.items.some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).some((key) => !['id', 'name', 'mimeType', 'readable'].includes(key))
          || typeof (item as Record<string, unknown>).id !== 'string' || !/^media_[a-f0-9]{64}$/.test(String((item as Record<string, unknown>).id))
          || typeof (item as Record<string, unknown>).name !== 'string'
          || ((item as Record<string, unknown>).mimeType !== undefined && typeof (item as Record<string, unknown>).mimeType !== 'string')
          || ((item as Record<string, unknown>).readable !== undefined && typeof (item as Record<string, unknown>).readable !== 'boolean'))) throw new Error(text('invalidResult'));
      return value as unknown as AppSessionMediaList;
    },
    async readSessionMedia(input: Parameters<AppWebviewApi['readSessionMedia']>[0]): Promise<AppSessionMediaData> {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'id')
        || typeof input.id !== 'string' || !/^media_[a-f0-9]{64}$/.test(input.id)) return Promise.reject(new Error(text('invalidRequest')));
      const result = await request({ type: 'media-read', request: input });
      const value = result.structuredContent;
      if (!value || Object.keys(value).some((key) => !['data', 'mimeType', 'name'].includes(key))
        || typeof value.data !== 'string' || typeof value.mimeType !== 'string' || typeof value.name !== 'string') throw new Error(text('invalidResult'));
      return { data: value.data, mimeType: value.mimeType, name: value.name };
    },
    writeClipboardImage(input: Parameters<AppWebviewApi['writeClipboardImage']>[0]) {
      if (!port || !navigator.userActivation?.isActive || !document.hasFocus()) return Promise.reject(new Error(text('requestFailed')));
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => key !== 'data' && key !== 'mimeType')
        || input.mimeType !== 'image/png' || typeof input.data !== 'string' || !input.data.length
        || input.data.length > 4 * Math.ceil(20 * 1024 * 1024 / 3)) return Promise.reject(new Error(text('invalidRequest')));
      return request({ type: 'clipboard', request: input }).then(() => {});
    },
    async saveWorkspaceFile(input: Parameters<NonNullable<AppWebviewApi['saveWorkspaceFile']>>[0]) {
      if (!port || !context.sessionIdentity || !navigator.userActivation?.isActive || !document.hasFocus()) throw new Error(text('requestFailed'));
      const error = validateWorkspaceFile(input);
      if (error) throw new Error(text(error));
      const result = await request({ type: 'workspace-save', request: input });
      const value = result.structuredContent;
      if (!value || Object.keys(value).some((key) => key !== 'name' && key !== 'size')
        || typeof value.name !== 'string' || !value.name || !Number.isSafeInteger(value.size) || Number(value.size) < 0) throw new Error(text('workspaceSaveUnknown'));
      return { name: value.name, size: Number(value.size) };
    },
    onCloseRequested(handler: Parameters<NonNullable<AppWebviewApi['onCloseRequested']>>[0]) {
      if (closed) throw new Error(text('closed'));
      if (typeof handler !== 'function') throw new TypeError(text('invalidListener'));
      if (closeOwner) throw new Error(text('closeOwnerExists'));
      const owner = { id: ++nextCloseOwner, handler };
      closeOwner = owner;
      sendCloseOwner();
      return () => {
        if (closeOwner !== owner) return;
        closeOwner = null;
        closeRequest?.controller.abort();
        closeRequest = null;
        sendCloseOwner();
      };
    },
    subscribe(listener: Parameters<AppWebviewApi['subscribe']>[0]) {
      if (typeof listener !== 'function') throw new TypeError(text('invalidListener'));
      if (closed) throw new Error(text('closed'));
      listeners.add(listener);
      if (language && language !== context.language) listener({ topic: 'locale.changed', data: { language } });
      return () => { listeners.delete(listener); };
    },
  });
  Object.defineProperty(window, 'matchaApp', { value: api, writable: false, configurable: false });
  window.addEventListener('message', connect, true);
  window.addEventListener('error', scriptError);
  window.addEventListener('unhandledrejection', rejection);
  window.addEventListener('pagehide', dispose);
  window.parent.postMessage({ type: 'matcha:app-ready' }, '*');
}

export function buildAppDocument(pluginId: string, html: string, context: AppWebviewContext): string {
  const serialize = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
  return `<!doctype html><meta charset="utf-8"><script>(${installAppBridge.toString()})(${serialize(pluginId)},${serialize(context)},${validateAppComposeRequest.toString()},${validateAppWorkspaceFileRequest.toString()},${serialize(getAppBridgeMessages())})</script>${html}`;
}
