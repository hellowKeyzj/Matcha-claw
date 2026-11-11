import type { HtmlApi, SaveHtmlRequest, ImageData, ExportFormat } from '../../genoffice/apps/html/src/shared/ipc';
import { normalizeLang, type Lang } from '../../genoffice/packages/i18n/src';
import type { DocumentResource } from '../documents/model';
import { appApi, sha256Hex } from '../documents/client';
import { officeSettings, onOfficeSettingsChanged, type OfficeSettings } from '../settings/client';
import { flushBrowserStorage } from '../platform/browser-storage';
import { chooseDocument } from '../ui/choose-document';
import { chooseDocumentName, chooseUnsavedAction } from '../ui/document-actions';
import { pickFiles, downloadFile } from '../ui/files';
import { preview } from './preview';
import { decodeBytes, encodeBytes, documentSnapshot, documentResourceBase, DOCUMENT_RESOURCE_ORIGIN } from './resources';
import { editableImageMime } from '../../genoffice/apps/html/src/main/asset-mime';
import { zipSync } from 'fflate';

interface WireDocument {
  documentId: string; name: string; path: string; revision: number; data: string;
  resources: { path: string; data: string; ownedSha256?: string }[];
}
function event<T>() {
  const handlers = new Set<(value: T) => void>();
  return { on(handler: (value: T) => void) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    emit(value: T) { for (const handler of handlers) handler(value); }, clear() { handlers.clear(); },
    hasHandlers() { return handlers.size > 0; } };
}
export function installHtmlBridge() {
  const app = appApi();
  const editorId = crypto.randomUUID();
  let current: WireDocument | null = null;
  let observed: WireDocument | null = null;
  let acknowledgeNext = false;
  let dirty = false;
  let disposed = false;
  let saving = false;
  let resources: DocumentResource[] = [];
  let stagedResources: DocumentResource[] = [];
  const saveRequest = event<'save' | 'saveAs'>();
  const closeRequest = event<void>();
  const readRequest = event<void>();
  const changed = event<string>();
  const renamed = event<string>();
  const exports = event<ExportFormat>();
  const language = event<Lang>();
  let currentLanguage = normalizeLang(app.context.language);
  const opened = event<void>();
  const actionRequest = event<{ action: string; input: Record<string, unknown>; resolve(value: unknown): void; reject(error: unknown): void }>();
  let opening: Promise<unknown> = Promise.resolve();
  let navigationReady = false;
  const queuedOpens: string[] = [];
  const theme = event<'light' | 'dark'>();
  const autoSaveDefault = event<OfficeSettings['autoSaveDefault']>();
  const stopSettings = onOfficeSettingsChanged((settings) => autoSaveDefault.emit(settings.autoSaveDefault));
  let previousTheme = document.documentElement.dataset.theme;
  const themeObserver = new MutationObserver(() => {
    const value = document.documentElement.dataset.theme;
    if (value === previousTheme || (value !== 'light' && value !== 'dark')) return;
    previousTheme = value;
    theme.emit(value);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  let finishClose: ((ok: boolean) => void) | null = null;
  let finishRead: ((result: { text: string } | { error: string }) => void) | null = null;
  async function invoke<T>(channel: string, request?: unknown): Promise<T> {
    const response = await app.call('office_html_ipc', { editorId, channel, arguments: request === undefined ? [] : [request] });
    const structured = response.structuredContent as { result?: T; code?: string; error?: string; currentRevision?: number } | undefined;
    if (response.isError) throw Object.assign(new Error(structured?.error ?? 'HTML operation failed.'), structured);
    return structured?.result as T;
  }
  function adopt(document: WireDocument, staged: DocumentResource[] = [], acceptedExternalResources = false) {
    current = document;
    observed = null;
    const baseline = document.resources.map(({ path, data, ownedSha256 }) => ({ path, bytes: decodeBytes(data), ...(ownedSha256 ? { ownedSha256 } : {}) }));
    stagedResources = staged.filter((resource) => !baseline.some((entry) => entry.path === resource.path));
    resources = [...baseline, ...stagedResources];
    preview.name(document.name);
    if (acceptedExternalResources) preview.acceptResources(resources);
    else preview.resources(resources);
  }
  function adoptObserved(document: WireDocument) {
    const previousPath = current?.path;
    adopt(document, stagedResources, true);
    if (previousPath !== document.path) renamed.emit(document.path);
  }
  const resourceWire = (entries: readonly DocumentResource[] = resources) => entries.map(({ path, bytes, ownedSha256 }) => ({ path, data: encodeBytes(bytes), ...(ownedSha256 ? { ownedSha256 } : {}) }));
  async function reconciled(html: string) {
    const wire = await invoke<WireDocument['resources']>('html:reconcile', { html, resources: resourceWire() });
    return wire.map(({ path, data, ownedSha256 }) => ({ path, bytes: decodeBytes(data), ...(ownedSha256 ? { ownedSha256 } : {}) }));
  }
  function decodeText(data: string): string { return new TextDecoder('utf-8', { ignoreBOM: true }).decode(decodeBytes(data)); }
  function ack() {
    if (observed && current) {
      const document = observed;
      void invoke('html:ack', { revision: document.revision }).catch(console.error);
      adoptObserved(document);
    }
    else acknowledgeNext = true;
  }
  async function save(request: SaveHtmlRequest) {
    let name = current?.name;
    if (!current || request.mode === 'saveAs') {
      const choice = await chooseDocumentName(request.defaultName ?? request.suggestedName ?? name ?? 'Untitled.html');
      if (!choice) return { ok: true as const, canceled: true as const };
      name = /\.html?$/i.test(choice) ? choice : `${choice}.html`;
    }
    saving = true;
    try {
      if (request.overwrite && current && observed) {
        const document = observed;
        await invoke('html:ack', { revision: document.revision });
        adoptObserved(document);
      }
      const document = await invoke<WireDocument>('html:save', { data: encodeBytes(new TextEncoder().encode(request.text)),
        mode: request.mode, name, expectedRevision: current?.revision, resources: resourceWire() });
      // Generated bytes omitted from this save stay session-local for undo and in-flight edits.
      adopt(document, resources.filter((resource) => resource.ownedSha256));
      return { ok: true as const, path: document.path };
    } catch (error) {
      const conflict = (error as { code?: string }).code === 'revision_conflict';
      if (conflict && current) observed = await invoke<WireDocument>('html:read').catch(() => null);
      return { ok: false as const, error: error instanceof Error ? error.message : String(error),
        ...(conflict ? { conflict: true as const } : {}) };
    } finally { saving = false; }
  }
  async function saveImage(data: { base64: string; ext: string }) {
    if (!current) return null;
    const binding = current;
    const ext = data.ext.replace(/^\./, '').toLowerCase();
    if (!['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'].includes(ext)) throw new Error('Unsupported image type.');
    const path = `assets/${crypto.randomUUID()}.${ext}`;
    const bytes = decodeBytes(data.base64);
    if (!bytes.length || bytes.length > 50 * 1024 * 1024 || !editableImageMime(bytes)) throw new Error('Invalid image bytes.');
    const base = documentResourceBase(await getText(), current.name);
    if (base.origin !== DOCUMENT_RESOURCE_ORIGIN) throw new Error('Local image editing is not supported with an external document base URL.');
    const resource = { path, bytes, ownedSha256: await sha256Hex(bytes) };
    if (current !== binding || disposed) return null;
    stagedResources = [...stagedResources, resource];
    resources = [...resources, resource];
    preview.resources(resources);
    return `${'../'.repeat(base.pathname.split('/').length - 2)}${path}`;
  }
  async function readImage(source: string): Promise<ImageData | null> {
    const inline = /^data:image\/[\w.+-]+(?:;[^,]*)?;base64,(.*)$/is.exec(source);
    let resource = inline ? { bytes: decodeBytes(inline[1]) } : undefined;
    if (!inline && current) {
      const base = documentResourceBase(await getText(), current.name);
      try {
        const url = new URL(source, base);
        if (url.origin !== DOCUMENT_RESOURCE_ORIGIN) return null;
        const path = decodeURIComponent(url.pathname.slice(1));
        resource = resources.find((entry) => entry.path === path);
      } catch { return null; }
    }
    if (!resource) return null;
    const mime = editableImageMime(resource.bytes);
    return mime ? { base64: encodeBytes(resource.bytes), mime } : null;
  }
  async function confirm(signal?: AbortSignal): Promise<boolean> {
    if (!dirty) return true;
    const choice = await chooseUnsavedAction(signal);
    if (signal?.aborted || choice === 'cancel') return false;
    if (choice === 'discard') return true;
    if (finishClose || !closeRequest.hasHandlers()) return false;
    return new Promise<boolean>((resolve) => {
      const abort = () => settle(false);
      const settle = (ok: boolean) => { signal?.removeEventListener('abort', abort); finishClose = null; resolve(ok); };
      finishClose = settle;
      signal?.addEventListener('abort', abort, { once: true });
      closeRequest.emit();
    });
  }
  async function getText(): Promise<string> {
    if (!readRequest.hasHandlers()) throw new Error('The HTML editor is not ready.');
    if (finishRead) throw new Error('HTML source serialization is already active.');
    return new Promise((resolve, reject) => {
      finishRead = (result) => { finishRead = null; if ('text' in result) resolve(result.text); else reject(new Error(result.error)); };
      readRequest.emit();
    });
  }
  async function exportHtml(request: { html: string; suggestedName: string; outPath?: string }) {
    if (request.outPath) return { ok: false as const, error: 'Native output paths are not permitted.' };
    const name = current?.name ?? `${request.suggestedName}.html`;
    const entries = await reconciled(request.html);
    if (!entries.length) return { ...downloadFile(name, new TextEncoder().encode(request.html), 'text/html'), skipped: [] };
    const archive: Record<string, Uint8Array> = Object.create(null);
    for (const resource of entries) archive[resource.path] = resource.bytes;
    if (name in archive) throw new Error(`A document resource conflicts with the HTML filename: ${name}`);
    archive[name] = new TextEncoder().encode(request.html);
    return { ...downloadFile(`${request.suggestedName}.zip`, zipSync(archive), 'application/zip'), skipped: [] };
  }
  async function exportPdf(request: { html: string; suggestedName: string; outPath?: string }) {
    if (request.outPath) return { ok: false as const, error: 'Native output paths are not permitted.' };
    try {
      const result = await invoke<{ data: string; mimeType: string }>('html:convert', {
        html: request.html, name: current?.name ?? 'index.html', resources: resourceWire(), format: 'pdf'
      });
      return downloadFile(`${request.suggestedName}.pdf`, decodeBytes(result.data), result.mimeType);
    } catch (error) { return { ok: false as const, error: String(error) }; }
  }
  const noEvent = () => () => {};
  let presentationOpen = false;
  let presentationFull = false;
  async function present(fullscreen: boolean) {
    const html = await getText();
    const resource = await app.documentResources.create(documentSnapshot(html, resources, current?.name ?? 'index.html'));
    try { await app.presentation.open({ content: { kind: 'document', documentResourcesId: resource.id }, fullscreen }); }
    finally { await app.documentResources.release({ id: resource.id }); }
    presentationOpen = true;
    presentationFull = fullscreen;
  }
  const api = {
    consumePending: async () => current?.path ?? null,
    readFile: async (path: string) => {
      if (!current || path !== current.path) throw new Error('This document is not open in the HTML editor.');
      const document = await invoke<WireDocument>('html:read');
      observed = document;
      if (acknowledgeNext) {
        acknowledgeNext = false;
        await invoke('html:ack', { revision: document.revision });
        adoptObserved(document);
      }
      return decodeText(document.data);
    },
    updatePreview: preview.update,
    getPreviewInfo: async () => ({ url: 'about:blank' }),
    save,
    setDirty(value: boolean) { dirty = value; },
    onSaveRequest: saveRequest.on,
    sendSaveRequestAck() {},
    onReadTextRequest: readRequest.on,
    sendReadTextResult(result: { text: string } | { error: string }) { finishRead?.(result); },
    onCloseSaveRequest: closeRequest.on,
    sendCloseSaveResult(ok: boolean) { finishClose?.(ok); },
    onFileRenamed: renamed.on,
    onFileChangedOnDisk: changed.on,
    ackFileChangedOnDisk: ack,
    setProvisionalTitle(title: string) { document.title = title; },
    async pickImage() {
      if (!current) return null;
      const [file] = await pickFiles('.png,.jpg,.jpeg,.gif,.webp,.bmp,.avif,.ico');
      return file ? saveImage({ base64: encodeBytes(new Uint8Array(await file.arrayBuffer())), ext: file.name.split('.').pop() ?? 'png' }) : null;
    },
    saveImage, readImage,
    async fetchImage(url: string): Promise<ImageData | null> {
      if (!/^https?:\/\//i.test(url)) return null;
      return invoke<ImageData | null>('html:fetch-image', { url });
    },
    onExportRequest: exports.on, exportHtml, exportPdf,
    async exportDocx(request: { html: string; suggestedName: string; outPath?: string }) {
      if (request.outPath) return { ok: false as const, error: 'Native output paths are not permitted.' };
      try {
        const result = await invoke<{ data: string; mimeType: string }>('html:convert', {
          html: request.html, name: current?.name ?? 'index.html', resources: resourceWire(), format: 'docx'
        });
        return downloadFile(`${request.suggestedName}.docx`, decodeBytes(result.data), result.mimeType);
      } catch (error) { return { ok: false as const, error: String(error) }; }
    },
    async setPresentFullScreen(on: boolean) {
      if (on) await present(true);
      else if (presentationOpen && presentationFull) {
        await app.presentation.close(); presentationOpen = false; presentationFull = false;
      }
    },
    async presentInNewTab(_title: string) { await present(false); return true; },
    getLanguage: async () => currentLanguage,
    onLanguageChanged(handler: (value: Lang) => void) { handler(currentLanguage); return language.on(handler); },
    getTheme: async () => document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const,
    onThemeChanged: theme.on,
    getAutoSaveDefault: async () => (await officeSettings()).autoSaveDefault,
    onAutoSaveDefaultChanged: autoSaveDefault.on,
    onChromePressed: noEvent
  };
  Object.defineProperty(window, 'htmlApi', { value: api as unknown as HtmlApi, configurable: true });
  async function openDocument(documentId: string) {
    if (current?.documentId === documentId || !await confirm() || disposed) return false;
    adopt(await invoke<WireDocument>('html:open', { documentId }));
    dirty = false; opened.emit(); return true;
  }
  const stopChanged = app.subscribe(({ topic, data }) => {
    if (topic === 'locale.changed' && data && typeof data === 'object' && 'language' in data && typeof data.language === 'string') {
      const next = normalizeLang(data.language);
      if (next !== currentLanguage) { currentLanguage = next; language.emit(next); }
      return;
    }
    if (topic === 'application.open') {
      const id = (data as { data?: { documentId?: unknown } } | null)?.data?.documentId;
      if (typeof id === 'string' && /^doc_[a-f0-9]{16}$/.test(id)) {
        if (!navigationReady) queuedOpens.push(id);
        else opening = opening.then(() => openDocument(id)).catch(console.error);
      }
      return;
    }
    if (topic === 'office.html.action') {
      const request = data as { editorId?: string; documentId?: string; requestId: string; action: string; input: Record<string, unknown> };
      const documentId = current?.documentId;
      if (!documentId || request.editorId !== editorId || request.documentId !== documentId) return;
      const reply = (result?: unknown, error?: string) => invoke('html:action-result', { documentId, requestId: request.requestId, result, error });
      if (!actionRequest.hasHandlers()) { void reply(undefined, 'The HTML editor is not ready.'); return; }
      actionRequest.emit({ action: request.action, input: request.input, resolve(result) { void reply(result); }, reject(error) { void reply(undefined, String(error)); } });
      return;
    }
    if (topic !== 'document.changed') return;
    const value = data as { documentId?: string; revision?: number; name?: string };
    if (!current || current.documentId !== value.documentId || value.revision === current.revision || saving) return;
    changed.emit(current.path);
  });
  const stopClose = app.onCloseRequested?.(async (signal) => {
    if (!await confirm(signal)) return false;
    await flushBrowserStorage();
    return !signal.aborted;
  });
  const stopPresentation = app.presentation.subscribe((event) => {
    if (event.type === 'closed') {
      if (presentationFull) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      presentationOpen = false; presentationFull = false;
    }
  });
  window.addEventListener('pagehide', () => {
    disposed = true; stopChanged(); stopClose?.(); stopPresentation(); stopSettings(); themeObserver.disconnect(); finishClose?.(false); finishRead?.({ error: 'The HTML editor closed.' });
    if (presentationOpen) void app.presentation.close().catch(console.error);
    saveRequest.clear(); closeRequest.clear(); readRequest.clear();
    void invoke('office:close-editor');
  }, { once: true });
  return {
    api,
    onOpened: opened.on,
    ready() {
      navigationReady = true;
      for (const id of queuedOpens.splice(0)) opening = opening.then(() => openDocument(id)).catch(console.error);
    },
    onAction: actionRequest.on,
    async exportSingleFile() {
      const html = await getText();
      const result = await invoke<{ html: string; inlined: number; skipped: string[] }>('html:single-file', { html, resources: resourceWire() });
      downloadFile(`${(current?.name.replace(/\.html?$/i, '') ?? 'Untitled').replace(/\.single$/i, '')}.single.html`, new TextEncoder().encode(result.html), 'text/html');
      return result;
    },
    async openExternal(url: string) { await invoke('html:open-external', url); },
    async initialize() {
      await invoke('office:open-editor');
      const id = (app.context.data as { documentId?: unknown } | undefined)?.documentId ?? new URLSearchParams(location.search).get('documentId');
      if (typeof id === 'string' && /^doc_[a-f0-9]{16}$/.test(id)) adopt(await invoke<WireDocument>('html:open', { documentId: id }));
    },
    async open() {
      if (!await confirm() || disposed) return false;
      const documents = await invoke<{ id: string; name: string }[]>('html:list');
      const selected = await chooseDocument(documents, 'html');
      if (!selected) return false;
      if (selected === 'import') {
        const files = await pickFiles('.html,.htm,.css,.js,.mjs,image/*,.woff,.woff2,.ttf,.otf,.mp4,.webm,.mp3,.ogg,.wav', true);
        const file = files.find((entry) => /\.html?$/i.test(entry.name));
        if (!file) return false;
        const assets = await Promise.all(files.filter((entry) => entry !== file).map(async (entry) => ({
          path: entry.webkitRelativePath || entry.name, data: encodeBytes(new Uint8Array(await entry.arrayBuffer()))
        })));
        adopt(await invoke<WireDocument>('html:import', { name: file.name, data: encodeBytes(new Uint8Array(await file.arrayBuffer())), resources: assets }));
      } else adopt(await invoke<WireDocument>('html:open', { documentId: selected.id }));
      dirty = false;
      return true;
    },
    async importFolder() {
      if (!await confirm() || disposed) return false;
      const input = document.createElement('input');
      input.type = 'file'; input.webkitdirectory = true; input.multiple = true;
      const files = await new Promise<File[]>((resolve) => {
        input.onchange = () => resolve([...input.files ?? []]); input.oncancel = () => resolve([]); input.click();
      });
      const candidates = files.filter((file) => /\.html?$/i.test(file.name));
      if (!candidates.length) return false;
      const selected = candidates.length === 1 ? candidates[0] : await chooseDocument(candidates.map((file) => ({ id: file.webkitRelativePath, name: file.webkitRelativePath, file })), 'html');
      if (!selected || selected === 'import') return false;
      const file = selected instanceof File ? selected : selected.file;
      const path = file.webkitRelativePath;
      const directory = path.slice(0, path.lastIndexOf('/') + 1);
      const assets = await Promise.all(files.filter((entry) => entry !== file && entry.webkitRelativePath.startsWith(directory)).map(async (entry) => ({
        path: entry.webkitRelativePath.slice(directory.length), data: encodeBytes(new Uint8Array(await entry.arrayBuffer()))
      })));
      adopt(await invoke<WireDocument>('html:import', { name: file.name, data: encodeBytes(new Uint8Array(await file.arrayBuffer())), resources: assets }));
      dirty = false;
      return true;
    },
    async newDocument() {
      if (!await confirm() || disposed) return false;
      await invoke('html:new'); current = null; observed = null; resources = []; stagedResources = []; preview.name('index.html'); preview.resources(resources); dirty = false;
      return true;
    },
    export(format: ExportFormat) { exports.emit(format); },
    async downloadSource() { const text = await getText(); return exportHtml({ html: text, suggestedName: current?.name.replace(/\.html?$/i, '') ?? 'Untitled' }); },
    async exportImage() {
      const html = await getText();
      const result = await invoke<{ data: string; mimeType: string }>('html:convert', {
        html, name: current?.name ?? 'index.html', resources: resourceWire(), format: 'png'
      });
      downloadFile(`${current?.name.replace(/\.html?$/i, '') ?? 'Untitled'}.png`, decodeBytes(result.data), result.mimeType);
      return false;
    },
    getText,
    resources: () => resources,
    title: () => current?.name ?? 'Untitled.html'
  };
}
