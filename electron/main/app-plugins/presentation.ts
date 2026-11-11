import { BrowserWindow, ipcMain, screen, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AppPluginCatalog, AppPluginManifest } from '../../../src/types/desktop/app-plugin';
import type { AppJson, AppRuntimeEvent, AppWebviewContext } from '../../../sdk/app-plugins/src/api';
import type { ApplicationPluginOwner } from './owner';
import type { AppPluginHost } from './host';
import { isJson } from './protocol';
import { requireDigest, requireObject, requirePluginId } from './package';
import type { AppDocumentResourcesOwner, AppDocumentResourcesReference } from './document-resources';

const MAX_BYTES = 8 * 1024 * 1024;
const CHANNELS = ['app-plugins:presentation-owner', 'app-plugins:presentation-request', 'app-plugins:presentation-release', 'app-plugins:presentation-bootstrap', 'app-plugins:presentation-call'] as const;
type Content = { kind: 'application'; applicationId: string } | { kind: 'html'; html: string } | { kind: 'document'; documentResourcesId: string };
type PresentationEvent = { type: 'message'; topic: string; data: AppJson } | { type: 'closed' };
type Frame = {
  frameId: string;
  pluginId: string;
  digest: string;
  applicationId: string;
  context: { language: string; theme: 'light' | 'dark' };
  presentation?: Presentation;
};
type Presentation = {
  id: string;
  source: Frame;
  applicationId: string;
  entry: string;
  title: string;
  content: { kind: 'application' | 'html'; html: string } | { kind: 'document'; url: string };
  documentResources?: AppDocumentResourcesReference;
  context: AppWebviewContext;
  manifest: AppPluginManifest;
  controller: AbortController;
  window?: BrowserWindow;
  webContentsId?: number;
  frameId?: string;
  closed: boolean;
};

/** Owns only screen facts and windows; document state and presentation messages stay with the plugin. */
export function registerAppPluginPresentationHandlers(options: {
  window: BrowserWindow;
  owner: ApplicationPluginOwner;
  host: AppPluginHost;
  documentResources: Pick<AppDocumentResourcesOwner, 'get'>;
  shutdownSignal: AbortSignal;
}): { reconcile(catalog: AppPluginCatalog): void; publishRuntime(event: AppRuntimeEvent): void; close(): void } {
  const mainContents = options.window.webContents;
  const frames = new Map<string, Frame>();
  const registering = new Map<string, Frame>();
  const presentations = new Map<number, Presentation>();
  let closed = false;
  let generation = 0;

  const assertMain = (event: IpcMainInvokeEvent) => {
    if (closed || options.shutdownSignal.aborted || options.window.isDestroyed() || event.sender !== mainContents
      || event.senderFrame !== mainContents.mainFrame) throw new Error('Presentation requires the trusted application main frame.');
  };
  const requireId = (value: unknown): string => {
    if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) throw new Error('Invalid presentation frame.');
    return value;
  };
  const application = async (frame: Pick<Frame, 'pluginId' | 'digest'>, applicationId: string) => {
    const catalog = await options.owner.list();
    const plugin = catalog.plugins.find(item => item.enabled && item.manifest.id === frame.pluginId && item.digest === frame.digest);
    const entry = plugin?.manifest.contributes.applications?.find(item => item.id === applicationId);
    if (!entry) throw new Error('The presentation application is unavailable.');
    return { ...entry, manifest: plugin!.manifest };
  };
  const publish = (frameId: string, event: PresentationEvent, target = mainContents) => {
    if (!target.isDestroyed()) target.send('app-plugins:presentation-event', { frameId, event });
  };
  const end = (presentation: Presentation) => {
    if (presentation.closed) return;
    presentation.closed = true;
    presentation.controller.abort();
    if (presentation.source.presentation === presentation) presentation.source.presentation = undefined;
    const win = presentation.window;
    if (presentation.webContentsId !== undefined) presentations.delete(presentation.webContentsId);
    if (win) {
      if (!win.isDestroyed()) win.destroy();
    }
    presentation.documentResources?.release();
    publish(presentation.source.frameId, { type: 'closed' });
  };
  const release = (frame: Frame) => {
    frames.delete(frame.frameId);
    if (frame.presentation) end(frame.presentation);
  };
  const clear = () => {
    generation++;
    registering.clear();
    for (const frame of frames.values()) release(frame);
  };
  const isSourceCurrent = (frame: Frame) => !closed && !options.shutdownSignal.aborted && frames.get(frame.frameId) === frame
    && !options.window.isDestroyed();
  const currentPresentation = (event: IpcMainInvokeEvent) => {
    const presentation = presentations.get(event.sender.id);
    if (closed || options.shutdownSignal.aborted || !presentation || presentation.closed || event.senderFrame !== event.sender.mainFrame
      || !isSourceCurrent(presentation.source)) throw new Error('The presentation window is unavailable.');
    return presentation;
  };
  const participant = (event: IpcMainInvokeEvent, frameId: string) => {
    if (event.sender === mainContents) {
      assertMain(event);
      const frame = frames.get(frameId);
      if (!frame) throw new Error('The presentation frame is unavailable.');
      return { source: frame, role: 'editor' as const, presentation: frame.presentation };
    }
    const presentation = currentPresentation(event);
    if (presentation.frameId !== frameId) throw new Error('The presentation frame is unavailable.');
    return { source: presentation.source, role: 'presentation' as const, presentation };
  };
  const fullScreenOnDisplay = (win: BrowserWindow, bounds: Electron.Rectangle) => {
    if (process.platform === 'darwin') {
      if (win.isSimpleFullScreen()) win.setSimpleFullScreen(false);
      win.setBounds(bounds);
      win.setSimpleFullScreen(true);
    } else {
      if (win.isFullScreen()) win.setFullScreen(false);
      win.setBounds(bounds);
      win.setFullScreen(true);
    }
  };

  ipcMain.handle('app-plugins:presentation-owner', async (event, value: unknown) => {
    const input = requireObject(value, ['frameId', 'pluginId', 'digest', 'applicationId', 'context']);
    const frameId = requireId(input.frameId);
    if (event.sender !== mainContents) {
      const presentation = currentPresentation(event);
      if (frameId !== presentation.id || input.pluginId !== presentation.source.pluginId || input.digest !== presentation.source.digest
        || input.applicationId !== presentation.applicationId || presentation.content.kind !== 'application') throw new Error('Invalid presentation owner.');
      presentation.frameId = frameId;
      return;
    }
    assertMain(event);
    requirePluginId(input.pluginId);
    requireDigest(input.digest);
    if (typeof input.applicationId !== 'string') throw new Error('Invalid presentation application.');
    const context = requireObject(input.context, ['language', 'theme']);
    if (typeof context.language !== 'string' || !context.language.length || context.language.length > 32
      || context.theme !== 'light' && context.theme !== 'dark') throw new Error('Invalid presentation context.');
    const sourceGeneration = generation;
    const frame: Frame = { frameId, pluginId: input.pluginId, digest: input.digest, applicationId: input.applicationId,
      context: { language: context.language, theme: context.theme } };
    if (frames.has(frameId) || registering.has(frameId)) throw new Error('The presentation frame is already registered.');
    registering.set(frameId, frame);
    try {
      await application(frame, frame.applicationId);
      assertMain(event);
      if (sourceGeneration !== generation || registering.get(frameId) !== frame) throw new Error('The source document changed.');
      frames.set(frameId, frame);
    } finally {
      if (registering.get(frameId) === frame) registering.delete(frameId);
    }
  });

  ipcMain.handle('app-plugins:presentation-bootstrap', (event) => {
    const presentation = currentPresentation(event);
    return { presentationId: presentation.id, pluginId: presentation.source.pluginId, digest: presentation.source.digest,
      applicationId: presentation.applicationId, entry: presentation.entry, title: presentation.title,
      context: presentation.context, content: presentation.content, manifest: presentation.manifest };
  });

  ipcMain.handle('app-plugins:presentation-call', async (event, value: unknown) => {
    const input = requireObject(value, ['frameId', 'name', 'arguments']);
    const presentation = currentPresentation(event);
    if (requireId(input.frameId) !== presentation.frameId || presentation.content.kind !== 'application'
      || typeof input.name !== 'string' || !input.arguments || typeof input.arguments !== 'object' || Array.isArray(input.arguments)
      || !isJson(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('Invalid presentation tool call.');
    const page = await application(presentation.source, presentation.applicationId);
    if (!page.manifest.contributes.tools?.some(tool => tool.name === input.name)) throw new Error('The presentation tool is not declared.');
    currentPresentation(event);
    return options.host.call({ id: presentation.source.pluginId, digest: presentation.source.digest,
      name: input.name, arguments: input.arguments as Record<string, unknown> }, presentation.controller.signal);
  });

  ipcMain.handle('app-plugins:presentation-release', (event, value: unknown) => {
    const input = requireObject(value, ['frameId']);
    const frameId = requireId(input.frameId);
    if (event.sender === mainContents) {
      assertMain(event);
      registering.delete(frameId);
      const frame = frames.get(frameId);
      if (frame) release(frame);
    } else {
      const presentation = currentPresentation(event);
      if (presentation.frameId !== frameId) throw new Error('Invalid presentation frame.');
      end(presentation);
    }
  });

  ipcMain.handle('app-plugins:presentation-request', async (event, value: unknown) => {
    const input = requireObject(value, ['frameId', 'request']);
    const frameId = requireId(input.frameId);
    const request = requireObject(input.request, ['operation', 'input']);
    if (!isJson(value) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) throw new Error('Invalid presentation request.');
    const actor = participant(event, frameId);
    const frame = actor.source;
    const sourcePage = await application(frame, frame.applicationId);
    const current = participant(event, frameId);
    if (current.source !== frame) throw new Error('The presentation frame changed.');
    const win = actor.role === 'editor' ? options.window : actor.presentation!.window!;
    if (request.operation === 'displays') {
      if (request.input !== undefined) requireObject(request.input, []);
      const currentId = screen.getDisplayMatching(win.getBounds()).id;
      const primaryId = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map(display => ({ id: display.id, label: display.label, bounds: display.bounds, workArea: display.workArea,
        scaleFactor: display.scaleFactor, primary: display.id === primaryId, current: display.id === currentId }));
    }
    if (request.operation === 'setFullscreen') {
      const fullscreen = requireObject(request.input, ['fullscreen']);
      if (typeof fullscreen.fullscreen !== 'boolean' || !win.isVisible() || !win.isFocused()) throw new Error('Fullscreen requires the foreground presentation view.');
      if (process.platform === 'darwin') win.setSimpleFullScreen(fullscreen.fullscreen);
      else win.setFullScreen(fullscreen.fullscreen);
      return;
    }
    if (request.operation === 'send') {
      const message = requireObject(request.input, ['topic', 'data']);
      if (typeof message.topic !== 'string' || !message.topic.length || message.topic.length > 128 || !isJson(message.data)) throw new Error('Invalid presentation message.');
      const presentation = frame.presentation;
      if (!presentation || presentation.closed) throw new Error('The presentation window is unavailable.');
      const messageEvent = { type: 'message' as const, topic: message.topic, data: message.data };
      if (actor.role === 'presentation') publish(frame.frameId, messageEvent);
      else if (presentation.frameId && presentation.window && !presentation.window.isDestroyed()) publish(presentation.frameId, messageEvent, presentation.window.webContents);
      return;
    }
    if (actor.role !== 'editor') throw new Error('Only the source frame may manage its presentation window.');
    if (request.operation === 'close') {
      if (request.input !== undefined) requireObject(request.input, []);
      if (frame.presentation) end(frame.presentation);
      return;
    }
    if (request.operation === 'swap') {
      if (request.input !== undefined) requireObject(request.input, []);
      const audience = frame.presentation?.window;
      if (!audience || audience.isDestroyed()) return false;
      const audienceDisplay = screen.getDisplayMatching(audience.getBounds());
      const hostDisplay = screen.getDisplayMatching(options.window.getBounds());
      if (audienceDisplay.id === hostDisplay.id) return false;
      fullScreenOnDisplay(audience, hostDisplay.bounds);
      if (options.window.isFullScreen()) {
        options.window.once('leave-full-screen', () => {
          if (!isSourceCurrent(frame) || frame.presentation?.window !== audience || options.window.isDestroyed()) return;
          options.window.setBounds(audienceDisplay.workArea);
          options.window.setFullScreen(true);
        });
        options.window.setFullScreen(false);
      } else if (options.window.isSimpleFullScreen()) {
        options.window.setSimpleFullScreen(false);
        options.window.setBounds(audienceDisplay.workArea);
        options.window.setSimpleFullScreen(true);
      } else options.window.setBounds(audienceDisplay.workArea);
      return true;
    }
    if (request.operation !== 'open') throw new Error('Invalid presentation operation.');
    const open = requireObject(request.input, ['content', 'displayId', 'fullscreen', 'data']);
    const content = requireObject(open.content, ['kind', 'applicationId', 'html', 'documentResourcesId']);
    if (open.displayId !== undefined && (typeof open.displayId !== 'number' || !Number.isSafeInteger(open.displayId))
      || open.fullscreen !== undefined && typeof open.fullscreen !== 'boolean'
      || open.data !== undefined && !isJson(open.data)) throw new Error('Invalid presentation options.');
    if (content.kind === 'application') {
      if (typeof content.applicationId !== 'string' || content.html !== undefined || content.documentResourcesId !== undefined) throw new Error('Invalid presentation content.');
    } else if (content.kind === 'html') {
      if (typeof content.html !== 'string' || !content.html.length || content.applicationId !== undefined || content.documentResourcesId !== undefined) throw new Error('Invalid presentation content.');
    } else if (content.kind === 'document') {
      if (typeof content.documentResourcesId !== 'string' || content.html !== undefined || content.applicationId !== undefined) throw new Error('Invalid presentation content.');
    } else throw new Error('Invalid presentation content.');
    if (frame.presentation) throw new Error('This source frame already owns a presentation window.');
    const display = open.displayId === undefined ? screen.getDisplayMatching(options.window.getBounds())
      : screen.getAllDisplays().find(item => item.id === open.displayId);
    if (!display) throw new Error('The requested display is unavailable.');
    const source = content as Content;
    const presentationId = randomUUID();
    const presentation: Presentation = { id: presentationId, source: frame, applicationId: source.kind === 'application' ? source.applicationId : frame.applicationId,
      entry: '', title: '', content: source.kind === 'document' ? { kind: 'document', url: '' } : { kind: source.kind, html: source.kind === 'html' ? source.html : '' },
      context: { ...frame.context, presentation: { id: presentationId, ...(open.data !== undefined ? { data: open.data as AppJson } : {}) } },
      manifest: sourcePage.manifest, controller: new AbortController(), closed: false };
    frame.presentation = presentation;
    try {
      const page = await application(frame, presentation.applicationId);
      presentation.entry = page.entry;
      presentation.title = page.name;
      if (source.kind === 'application' && presentation.content.kind === 'application') presentation.content.html = (await options.owner.bundle(frame.pluginId, frame.digest, page.entry)).html;
      if (source.kind === 'document') {
        const resource = await options.documentResources.get(frameId, source.documentResourcesId);
        if (presentation.closed || !isSourceCurrent(frame) || frame.presentation !== presentation) { resource.release(); throw new Error('The source frame is unavailable.'); }
        presentation.documentResources = resource;
        presentation.content = { kind: 'document', url: resource.url };
      }
      await application(frame, frame.applicationId);
      if (!isSourceCurrent(frame) || frame.presentation !== presentation || presentation.closed) throw new Error('The source frame is unavailable.');
      const audience = new BrowserWindow({ ...display.bounds, show: false, frame: false, backgroundColor: '#000000',
        webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false,
          webSecurity: true, navigateOnDragDrop: false, webviewTag: false } });
      presentation.window = audience;
      presentation.webContentsId = audience.webContents.id;
      presentations.set(presentation.webContentsId, presentation);
      const url = new URL(mainContents.getURL());
      url.search = '';
      url.hash = '';
      url.searchParams.set('app-view', presentation.id);
      audience.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      audience.webContents.on('will-navigate', event => event.preventDefault());
      audience.webContents.on('will-frame-navigate', event => {
        if (!event.isMainFrame && presentation.content.kind === 'document' && event.url === presentation.content.url) return;
        event.preventDefault();
      });
      audience.webContents.on('will-redirect', event => event.preventDefault());
      audience.webContents.on('will-attach-webview', event => event.preventDefault());
      if (source.kind !== 'application') audience.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') { event.preventDefault(); end(presentation); }
      });
      audience.webContents.once('render-process-gone', () => end(presentation));
      audience.once('closed', () => end(presentation));
      await audience.loadURL(url.href);
      if (presentation.closed || !isSourceCurrent(frame)) throw new Error('The presentation window is unavailable.');
      audience.show();
      if (open.fullscreen !== false) fullScreenOnDisplay(audience, display.bounds);
      return { presentationId: presentation.id, displayId: display.id };
    } catch (error) {
      end(presentation);
      throw error;
    }
  });

  const navigation = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !isInPlace) clear();
  };
  mainContents.on('did-start-navigation', navigation);
  mainContents.on('render-process-gone', clear);
  mainContents.on('destroyed', clear);
  const close = () => {
    if (closed) return;
    closed = true;
    clear();
    options.shutdownSignal.removeEventListener('abort', close);
    mainContents.removeListener('did-start-navigation', navigation);
    mainContents.removeListener('render-process-gone', clear);
    mainContents.removeListener('destroyed', clear);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
  options.shutdownSignal.addEventListener('abort', close, { once: true });
  if (options.shutdownSignal.aborted) close();
  return {
    publishRuntime(event) {
      for (const presentation of presentations.values()) {
        if (!presentation.closed && presentation.frameId && presentation.content.kind === 'application'
          && presentation.source.pluginId === event.pluginId && presentation.source.digest === event.digest
          && presentation.window && !presentation.window.isDestroyed()) {
          presentation.window.webContents.send('app-plugins:presentation-runtime', { frameId: presentation.frameId, event });
        }
      }
    },
    reconcile(catalog) {
      for (const frame of registering.values()) {
        if (!catalog.plugins.some(item => item.enabled && item.manifest.id === frame.pluginId && item.digest === frame.digest)) registering.delete(frame.frameId);
      }
      for (const frame of frames.values()) {
        const plugin = catalog.plugins.find(item => item.enabled && item.manifest.id === frame.pluginId && item.digest === frame.digest);
        const applications = plugin?.manifest.contributes.applications;
        if (!applications?.some(item => item.id === frame.applicationId)) release(frame);
        else if (frame.presentation && !applications.some(item => item.id === frame.presentation!.applicationId)) end(frame.presentation);
      }
    },
    close,
  };
}
