import i18n from '@/i18n';
import { installAppDesktopMediaBridge } from './desktop-media-bridge';
import { isApplicationOpenRequest } from './application-open';
import { installAppDevelopmentBridge, type AppDevelopmentAction } from './development-protocol';
import { APP_RENDER_PDF_MAX_BYTES, isAppRenderPdfRequest, isAppClipboardWriteRequest, isAppSpellcheckRequest, validateAppComposeRequest, validateAppWorkspaceFileRequest, type AppComposeRequest, type AppSessionMediaData, type AppSessionMediaList, type AppToolResult, type AppWebviewApi, type AppWebviewContext } from '@/types/desktop/app-plugin-sdk';

declare global {
  interface Window {
    readonly matchaApp: AppWebviewApi;
  }
}

export function getAppBridgeMessages(): Record<string, string> {
  return i18n.t('common:appFrame', { returnObjects: true }) as Record<string, string>;
}

// Serialized into the iframe: keep this bootstrap independent of Renderer imports and credentials.
function installAppBridge(pluginId: string, context: AppWebviewContext, validateCompose: typeof validateAppComposeRequest, validateWorkspaceFile: typeof validateAppWorkspaceFileRequest, validatePdf: typeof isAppRenderPdfRequest, validateClipboard: typeof isAppClipboardWriteRequest, validateSpellcheck: typeof isAppSpellcheckRequest, validateOpen: typeof isApplicationOpenRequest, installDesktopMedia: typeof installAppDesktopMediaBridge, pdfMaxBytes: number, initialMessages: Record<string, string>, development?: typeof installAppDevelopmentBridge): void {
  const developer = development?.();
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
  const desktopMedia = installDesktopMedia(value => port?.postMessage(value));
  let nextId = 0;
  const pending = new Map<number, { resolve: (result: AppToolResult) => void; reject: (error: Error) => void }>();
  const listeners = new Set<Parameters<AppWebviewApi['subscribe']>[0]>();
  const applicationOpens: Parameters<Parameters<AppWebviewApi['subscribe']>[0]>[0][] = [];
  const spellListeners = new Set<Parameters<AppWebviewApi['spellcheck']['onContextMenuRequest']>[0]>();
  let spellEpoch = '';
  let spellArming = false;
  let nativeMenuSeq = 0;
  let currentMenu: { event: MouseEvent; claim?: { seq: number; resolve: () => void; reject: (error: unknown) => void } } | undefined;
  const captureMenu = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    if (spellArming) { event.preventDefault(); return; }
    if (!spellEpoch) return;
    const menu = { event } as NonNullable<typeof currentMenu>;
    currentMenu = menu;
    queueMicrotask(() => {
      if (currentMenu === menu) currentMenu = undefined;
      if (event.defaultPrevented) { menu.claim?.reject(new Error(text('requestFailed'))); return; }
      const nativeSeq = ++nativeMenuSeq;
      if (menu.claim) void request({ type: 'spellcheck', request: { operation: 'claimContextMenu', seq: menu.claim.seq, nativeSeq, epoch: spellEpoch,
        x: event.clientX, y: event.clientY, source: event.clientX === 0 && event.clientY === 0 ? 'keyboard' : 'pointer' } }).then(() => menu.claim?.resolve(), error => menu.claim?.reject(error));
    });
  };
  window.addEventListener('contextmenu', captureMenu, true);
  const presentationListeners = new Set<Parameters<AppWebviewApi['presentation']['subscribe']>[0]>();
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
    applicationOpens.length = 0;
    spellListeners.clear();
    window.removeEventListener('contextmenu', captureMenu, true);
    currentMenu?.claim?.reject(error);
    currentMenu = undefined;
    spellEpoch = '';
    presentationListeners.clear();
    closeRequest?.controller.abort();
    closeRequest = null;
    closeOwner = null;
    desktopMedia.dispose();
    developer?.dispose();
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
      if (desktopMedia.handleMessage(value)) return;
      if (value.type === 'development-request' && developer) {
        if (!Number.isSafeInteger(value.id) || Number(value.id) < 1) { reportError(text('invalidRequest')); return; }
        try {
          const action = value.action as Record<string, unknown> | undefined;
          if (value.method !== 'inspect' && (value.method !== 'act' || !action || typeof action !== 'object'
            || Object.keys(action).some((key) => !['type', 'id', 'value'].includes(key))
            || (action.type !== 'click' && action.type !== 'fill') || typeof action.id !== 'string'
            || action.id.length > 80 || (action.value !== undefined && (typeof action.value !== 'string' || action.value.length > 10_000)))) throw new Error(text('invalidRequest'));
          const result = value.method === 'inspect' ? developer.inspect() : developer.act(action as unknown as AppDevelopmentAction);
          port?.postMessage({ type: 'development-result', id: value.id, result });
        } catch (error) {
          port?.postMessage({ type: 'development-result', id: value.id, error: error instanceof Error ? error.message : text('requestFailed') });
        }
      } else if (value.type === 'spellcheck-context-menu') {
        const event = value.event as Parameters<Parameters<AppWebviewApi['spellcheck']['onContextMenuRequest']>[0]>[0];
        if (!event || !Number.isSafeInteger(event.seq) || typeof event.misspelledWord !== 'string' || !Array.isArray(event.suggestions) || event.suggestions.some(item => typeof item !== 'string')) { reportError(text('invalidMessage')); return; }
        for (const listener of spellListeners) listener(event);
      } else if (value.type === 'presentation-event') {
        const event = value.event as Parameters<Parameters<AppWebviewApi['presentation']['subscribe']>[0]>[0];
        if (!event || event.type !== 'closed' && event.type !== 'message') { reportError(text('invalidMessage')); return; }
        for (const listener of presentationListeners) listener(event);
      } else if (value.type === 'close-request') {
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
          if (typeof value.code === 'string' && ['unsupported', 'cursorInvalid', 'invalidReference', 'tooLarge', 'unavailable', 'invalid-request', 'too-large', 'busy', 'cancelled', 'deadline', 'render-failed'].includes(value.code)) Object.assign(error, { code: value.code });
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
        if (value.topic === 'application.open' && !listeners.size) {
          if (applicationOpens.length >= 64) { reportError(text('tooManyRequests')); return; }
          applicationOpens.push({ topic: value.topic, data: value.data as Parameters<Parameters<AppWebviewApi['subscribe']>[0]>[0]['data'] });
          return;
        }
        for (const listener of listeners) {
          try { listener({ topic: value.topic, data: value.data as Parameters<typeof listener>[0]['data'] }); }
          catch (error) { reportError(error instanceof Error ? error.message : text('eventHandlerFailed')); }
        }
      } else { reportError(text('unsupportedMessage')); }
    };
    port.onmessageerror = () => reportError(text('decodeFailed'));
    port.start();
    connectPort(port);
    // Connection readiness is not evidence that the application rendered successfully.
    port.postMessage(failure ? { type: 'error', message: failure } : { type: 'ready' });
    sendCloseOwner();
  };
  const scriptError = (event: ErrorEvent) => reportError(event.message || text('scriptFailed'));
  const rejection = (event: PromiseRejectionEvent) => reportError(event.reason instanceof Error ? event.reason.message : text('asyncFailed'));
  const request = (message: { type: 'document-resources'; request: { operation: 'create'; input: Parameters<AppWebviewApi['documentResources']['create']>[0] } | { operation: 'release'; input: { id: string } } } | { type: 'open-application'; request: Parameters<AppWebviewApi['openApplication']>[0] } | { type: 'desktop-media'; request: { operation: string; id?: string } } | { type: 'rich-clipboard-read' } | { type: 'rich-clipboard-write'; request: Parameters<AppWebviewApi['writeClipboard']>[0] } | { type: 'spellcheck'; request: Parameters<typeof validateSpellcheck>[0] } | { type: 'presentation'; request: { operation: string; input?: unknown } } | { type: 'render-pdf'; request: Parameters<AppWebviewApi['renderPdf']>[0] } | { type: 'call'; name: string; arguments: Readonly<Record<string, unknown>> } | { type: 'compose'; request: AppComposeRequest } | { type: 'clipboard'; request: Parameters<AppWebviewApi['writeClipboardImage']>[0] } | { type: 'workspace-save'; request: Parameters<NonNullable<AppWebviewApi['saveWorkspaceFile']>>[0] } | { type: 'media-list'; request?: Parameters<AppWebviewApi['listSessionMedia']>[0] } | { type: 'media-read'; request: Parameters<AppWebviewApi['readSessionMedia']>[0] }): Promise<AppToolResult> => {
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
  const spell = async (input: Parameters<typeof validateSpellcheck>[0]): Promise<unknown> => {
    if (!validateSpellcheck(input)) throw new Error(text('invalidRequest'));
    const result = await request({ type: 'spellcheck', request: input });
    return result.structuredContent?.value;
  };
  const present = async (operation: string, input?: unknown): Promise<unknown> => {
    const result = await request({ type: 'presentation', request: { operation, ...(input !== undefined ? { input } : {}) } });
    return result.structuredContent?.value;
  };
  const api: AppWebviewApi = Object.freeze({
    getMicrophoneStream: desktopMedia.getMicrophoneStream,
    getScreenStream: desktopMedia.getScreenStream,
    async captureScreenSources() {
      if (!navigator.userActivation?.isActive || !document.hasFocus()) throw new Error(text('requestFailed'));
      const result = await request({ type: 'desktop-media', request: { operation: 'captureScreenSources' } });
      return result.structuredContent?.value as Awaited<ReturnType<AppWebviewApi['captureScreenSources']>>;
    },
    async captureScreenSource(input: Parameters<AppWebviewApi['captureScreenSource']>[0]) {
      if (!navigator.userActivation?.isActive || !document.hasFocus() || !input || Object.keys(input).some(key => key !== 'id') || typeof input.id !== 'string' || input.id.length > 256) throw new Error(text('invalidRequest'));
      const result = await request({ type: 'desktop-media', request: { operation: 'captureScreenSource', id: input.id } });
      return result.structuredContent?.value as Awaited<ReturnType<AppWebviewApi['captureScreenSource']>>;
    },
    async requestMicrophoneAccess() {
      if (!navigator.userActivation?.isActive || !document.hasFocus()) throw new Error(text('requestFailed'));
      const result = await request({ type: 'desktop-media', request: { operation: 'requestMicrophoneAccess' } });
      return result.structuredContent?.value === true;
    },
    spellcheck: Object.freeze({
      armContextMenu: async () => {
        if (spellEpoch || spellArming) return;
        spellArming = true;
        try {
          const armed = await spell({ operation: 'armContextMenu' }) as { epoch?: unknown };
          if (!armed || typeof armed.epoch !== 'string') throw new Error(text('invalidResult'));
          await request({ type: 'spellcheck', request: { operation: 'contextMenuReady', epoch: armed.epoch } });
          nativeMenuSeq = 0;
          spellEpoch = armed.epoch;
        } finally { spellArming = false; }
      },
      claimContextMenu: (seq: number) => {
        if (!spellEpoch || !currentMenu || currentMenu.claim || !Number.isSafeInteger(seq) || seq < 1) return Promise.reject(new Error(text('requestFailed')));
        return new Promise<void>((resolve, reject) => { currentMenu!.claim = { seq, resolve, reject }; });
      },
      onContextMenuRequest(listener: Parameters<AppWebviewApi['spellcheck']['onContextMenuRequest']>[0]) {
        if (closed || typeof listener !== 'function') throw new Error(text('invalidListener'));
        spellListeners.add(listener); return () => { spellListeners.delete(listener); };
      },
      addWord: async (word: string) => await spell({ operation: 'addWord', word }) as boolean,
      ignoreWord: async (word: string) => await spell({ operation: 'ignoreWord', word }) as boolean,
      replace: async (word: string) => { await spell({ operation: 'replace', word }); },
      languages: async () => await spell({ operation: 'languages' }) as Awaited<ReturnType<AppWebviewApi['spellcheck']['languages']>>,
      setLanguages: async (languages: string[]) => await spell({ operation: 'setLanguages', languages }) as Awaited<ReturnType<AppWebviewApi['spellcheck']['languages']>>,
      respellKick: async () => { await spell({ operation: 'respellKick' }); },
      checkWord: async (word: string) => await spell({ operation: 'checkWord', word }) as Awaited<ReturnType<AppWebviewApi['spellcheck']['checkWord']>>,
    }),
    documentResources: Object.freeze({
      async create(input: Parameters<AppWebviewApi['documentResources']['create']>[0]) {
        const result = await request({ type: 'document-resources', request: { operation: 'create', input } });
        const value = result.structuredContent?.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some(key => !['id', 'url', 'rootUrl'].includes(key))) throw new Error(text('invalidResult'));
        const fields = value as Record<string, unknown>;
        if (typeof fields.id !== 'string' || typeof fields.url !== 'string' || typeof fields.rootUrl !== 'string') throw new Error(text('invalidResult'));
        return { id: fields.id, url: fields.url, rootUrl: fields.rootUrl };
      },
      async release(input: { id: string }) {
        if (!input || Object.keys(input).some(key => key !== 'id') || typeof input.id !== 'string') throw new Error(text('invalidRequest'));
        await request({ type: 'document-resources', request: { operation: 'release', input } });
      },
    }),
    presentation: Object.freeze({
      displays: async () => await present('displays') as Awaited<ReturnType<AppWebviewApi['presentation']['displays']>>,
      open: async (input: Parameters<AppWebviewApi['presentation']['open']>[0]) => await present('open', input) as Awaited<ReturnType<AppWebviewApi['presentation']['open']>>,
      send: async (input: Parameters<AppWebviewApi['presentation']['send']>[0]) => { await present('send', input); },
      swap: async () => await present('swap') as boolean,
      setFullscreen: async (fullscreen: boolean) => { await present('setFullscreen', { fullscreen }); },
      close: async () => { await present('close'); },
      subscribe(listener: Parameters<AppWebviewApi['presentation']['subscribe']>[0]) {
        if (closed || typeof listener !== 'function') throw new Error(text('invalidListener'));
        presentationListeners.add(listener); return () => { presentationListeners.delete(listener); };
      },
    }),
    async writeClipboard(input: Parameters<AppWebviewApi['writeClipboard']>[0]) {
      if (!port || !navigator.userActivation?.isActive || !document.hasFocus() || !validateClipboard(input)) throw new Error(text('invalidRequest'));
      await request({ type: 'rich-clipboard-write', request: input });
    },
    async readClipboard() {
      if (!port || !navigator.userActivation?.isActive || !document.hasFocus()) throw new Error(text('requestFailed'));
      const result = await request({ type: 'rich-clipboard-read' });
      const value = result.structuredContent;
      if (!value || Object.keys(value).length && !validateClipboard(value)) throw new Error(text('invalidResult'));
      return value as Awaited<ReturnType<AppWebviewApi['readClipboard']>>;
    },
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
    async openApplication(input: Parameters<AppWebviewApi['openApplication']>[0]) {
      if (!validateOpen(input)) throw new Error(text('invalidRequest'));
      await request({ type: 'open-application', request: input });
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
    async renderPdf(input: Parameters<AppWebviewApi['renderPdf']>[0]) {
      if (!validatePdf(input)) throw Object.assign(new Error(text('invalidRequest')), { code: 'invalid-request' });
      if (new TextEncoder().encode(JSON.stringify(input)).byteLength + 1024 > pdfMaxBytes) throw Object.assign(new Error(text('invalidRequest')), { code: 'too-large' });
      const result = await request({ type: 'render-pdf', request: input });
      const value = result.structuredContent;
      if (!value || Object.keys(value).some((key) => key !== 'data' && key !== 'mimeType') || value.mimeType !== 'application/pdf'
        || typeof value.data !== 'string' || !value.data.startsWith('JVBERi0') || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)
        || new TextEncoder().encode(JSON.stringify(result)).byteLength + 1024 > pdfMaxBytes) throw new Error(text('invalidResult'));
      return { data: value.data, mimeType: 'application/pdf' as const };
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
      for (const event of applicationOpens.splice(0)) listener(event);
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

export function buildAppDocument(pluginId: string, html: string, context: AppWebviewContext, development = false, assetBaseUrl?: string): string {
  const serialize = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c');
  const base = assetBaseUrl ? `<base href="${assetBaseUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">` : '';
  return `<!doctype html><meta charset="utf-8">${base}<script>(${installAppBridge.toString()})(${serialize(pluginId)},${serialize(context)},${validateAppComposeRequest.toString()},${validateAppWorkspaceFileRequest.toString()},${isAppRenderPdfRequest.toString()},${isAppClipboardWriteRequest.toString()},${isAppSpellcheckRequest.toString()},${isApplicationOpenRequest.toString()},${installAppDesktopMediaBridge.toString()},${APP_RENDER_PDF_MAX_BYTES},${serialize(getAppBridgeMessages())},${development ? installAppDevelopmentBridge.toString() : 'undefined'})</script>${html}`;
}
