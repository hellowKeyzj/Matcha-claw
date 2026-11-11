import { flushBrowserStorage } from '../platform/browser-storage';
import type { ExportFormat, MarkdownApi, SaveMode, SaveMarkdownResult } from '../../genoffice/apps/markdown/src/shared/ipc';
import { normalizeLang, type Lang } from '../../genoffice/packages/i18n/src';
import type { MarkdownTheme } from '../../genoffice/apps/markdown/src/shared/markdown-theme';
import { setImageResourceResolver } from '../../genoffice/apps/markdown/src/renderer/editor/localImage';
import { showToast } from '../../genoffice/apps/markdown/src/renderer/components/toast-bus';
import { base64ToBytes, bytesToBase64, callTool, importDocument, listDocuments } from '../documents/client';
import { officeSettings, type OfficeSettings } from '../settings/client';
import { chooseAction, chooseDocumentName, chooseUnsavedAction } from '../ui/document-actions';
import { downloadFile, pickFiles } from '../ui/files';
import { imageMime, renderPdf, selfContainedHtml } from './export';
import { labels } from './labels';
import { executeMarkdownAction } from './editor-actions';

type Resource = { path: string; data: string };
type OpenDocument = { documentId: string; type: 'md' | 'txt' | 'json'; revision: number; path: string; name: string; text: string; resources: Resource[] };
const textDocuments = async () => (await listDocuments()).filter((record) => record.type === 'md' || record.type === 'txt' || record.type === 'json');
function event<T>() {
  const handlers = new Set<(value: T) => void>();
  return { on(handler: (value: T) => void) { handlers.add(handler); return () => { handlers.delete(handler); }; }, emit(value: T) { for (const handler of handlers) handler(value); } };
}
function absolute(source: string, directory: string | null): string {
  let path: string;
  try { path = decodeURIComponent(source); } catch { path = source; }
  const parts: string[] = [];
  for (const part of (path.startsWith('/') ? path : `${directory ?? ''}/${path}`).replaceAll('\\', '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return '/' + parts.join('/');
}

export async function installMarkdownBridge(onOpen: () => void) {
  const editorId = crypto.randomUUID();
  const saveRequest = event<SaveMode>();
  const exportHandlers = new Set<(format: ExportFormat) => unknown>();
  const readRequest = event<void>();
  const diskChanged = event<string>();
  const renamed = event<string>();
  const viewImage = event<string>();
  const themeChanged = event<'light' | 'dark'>();
  const settingsChanged = event<OfficeSettings>();
  const languageChanged = event<Lang>();
  let language = normalizeLang(window.matchaApp?.context.language);
  const incoming = event<{ topic: string; data: unknown }>();
  const queuedOpens: { topic: string; data: unknown }[] = [];
  let navigationReady = false;
  // One SDK subscriber owns queued navigation before any asynchronous initialization.
  const unsubscribe = window.matchaApp?.subscribe((value) => {
    if (value.topic === 'office.settings.changed') settingsChanged.emit(value.data as OfficeSettings);
    if (value.topic === 'application.open' && !navigationReady) queuedOpens.push(value);
    else incoming.emit(value);
  });
  let previousTheme = document.documentElement.dataset.theme;
  const themeObserver = new MutationObserver(() => {
    const theme = document.documentElement.dataset.theme;
    if (theme === previousTheme || (theme !== 'light' && theme !== 'dark')) return;
    previousTheme = theme;
    themeChanged.emit(theme);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const display = new Map<string, string>();
  const reverse = new Map<string, string>();
  const fragments = new Map<string, string>();
  let active: OpenDocument | null = null;
  let dirty = false;
  let pending: string | null = null;
  let saveWaiter: ((ok: boolean) => void) | undefined;
  let textWaiter: ((result: { text: string } | { error: string }) => void) | undefined;
  let leavePromise: Promise<boolean> | undefined;
  let closed = false;
  const imageExports = new Map<string, { name: string; pages: Map<number, Uint8Array> }>();
  const deliver = (name: string, bytes: Uint8Array, mime: string) => {
    const result = downloadFile(name, bytes, mime);
    showToast(labels().downloadStarted);
    return result;
  };
  const ipc = async <T>(channel: string, ...args: unknown[]): Promise<T> => (await callTool<{ result: T }>('office_markdown_ipc', { editorId, channel, arguments: args })).result;
  await ipc('office:open-editor');
  let markdownTheme = await ipc<MarkdownTheme>('markdown:get-theme');
  function applyMarkdownTheme(theme: MarkdownTheme) {
    markdownTheme = theme;
    if (theme === 'default') document.documentElement.removeAttribute('data-markdown-theme');
    else document.documentElement.setAttribute('data-markdown-theme', theme);
  }
  applyMarkdownTheme(markdownTheme);
  const openExternal = (event: MouseEvent) => {
    if (event.button !== 0 && event.button !== 1) return;
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.tiptap a[href]') : null;
    if (!anchor || anchor.closest('[data-wiki-target]')) return;
    const href = anchor.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    event.preventDefault();
    void ipc('markdown:open-external', href).catch((error) => {
      console.error('[markdown] external link failed:', error);
      showToast(`${labels().failed}: ${error instanceof Error ? error.message : String(error)}`, 'error');
    });
  };
  document.addEventListener('click', openExternal);
  document.addEventListener('auxclick', openExternal);

  function mapResources(path: string, resources: Resource[]) {
    const dir = path.slice(0, path.lastIndexOf('/'));
    for (const resource of resources) {
      const key = absolute(resource.path, dir);
      const url = `data:${imageMime(resource.path)};base64,${resource.data}`;
      display.set(key, url);
      if (!reverse.has(url)) reverse.set(url, key);
    }
  }
  setImageResourceResolver((source: string, base: string | null) => {
    if (/^(data:|blob:|https?:)/i.test(source)) return source;
    return display.get(absolute(source, base)) ?? source;
  }, (source: string, base: string | null) => {
    const key = reverse.get(source);
    if (!key) return source;
    const prefix = `${base?.replace(/\/$/, '') ?? ''}/`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  });

  async function save(mode: SaveMode): Promise<boolean> {
    if (saveWaiter) throw new Error('A save request is already pending.');
    return new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => { saveWaiter = undefined; resolve(false); }, 120_000);
      saveWaiter = (ok) => { clearTimeout(timeout); saveWaiter = undefined; resolve(ok); };
      saveRequest.emit(mode);
    });
  }
  async function confirmLeave(signal?: AbortSignal): Promise<boolean> {
    if (leavePromise) return leavePromise;
    leavePromise = (async () => {
      if (signal?.aborted) return false;
      if (!dirty) return true;
      const choice = await chooseUnsavedAction(signal);
      if (choice === 'cancel' || signal?.aborted) return false;
      if (choice === 'discard') return true;
      return await save('save') && !dirty && !signal?.aborted;
    })();
    try { return await leavePromise; } finally { leavePromise = undefined; }
  }
  async function openId(documentId: string) {
    const result = await callTool<{ document: OpenDocument }>('office_markdown_open', { editorId, documentId });
    active = result.document;
    pending = active.path;
    dirty = false;
    display.clear(); reverse.clear();
    mapResources(active.path, active.resources);
    onOpen();
  }
  async function textSnapshot(): Promise<string> {
    if (textWaiter) throw new Error('A text request is already pending.');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { textWaiter = undefined; reject(new Error('The editor did not respond.')); }, 10_000);
      textWaiter = (result) => {
        clearTimeout(timeout); textWaiter = undefined;
        if ('error' in result) reject(new Error(result.error)); else resolve(result.text);
      };
      readRequest.emit();
    });
  }
  const noEvents = () => () => {};
  const api = {
    consumePending: async () => { const path = pending; pending = null; return path; },
    readFile: async (path: string) => {
      const loaded = await ipc<{ text: string; resources: Resource[] }>('markdown:read-document', path);
      mapResources(path, loaded.resources);
      if (active?.path === path) { active.resources = loaded.resources; active.text = loaded.text; }
      return loaded.text;
    },
    async openSourcePath(path: string) {
      const image = display.get(absolute(path, null));
      if (image) { viewImage.emit(image); return; }
      if (active?.path === path) return;
      if (!await confirmLeave()) return;
      const { documentId } = await ipc<{ documentId: string }>('markdown:find-document', path);
      await openId(documentId);
    },
    async resolveWikiLinks(request: Parameters<MarkdownApi['resolveWikiLinks']>[0]) {
      const answers = await ipc<Awaited<ReturnType<MarkdownApi['resolveWikiLinks']>>>('markdown:resolve-wiki-links', request);
      const notes = (await listDocuments('md')).map((record) => `/library/${record.libraryPath ?? `${record.id}/${record.name}`}`);
      for (const path of new Set(Object.values(answers).filter((answer) => answer.found).map((answer) => answer.path))) {
        const note = notes.includes(path) ? path : notes.filter((note) => path.startsWith(note.slice(0, note.lastIndexOf('/')) + '/')).sort((a, b) => b.lastIndexOf('/') - a.lastIndexOf('/'))[0];
        if (note) mapResources(note, await ipc<Resource[]>('markdown:resources', note));
      }
      return answers;
    },
    rememberWikiFragment: async (path: string, fragment: string) => { fragments.set(path, fragment); },
    takeWikiFragment: async (path: string) => { const fragment = fragments.get(path) ?? ''; fragments.delete(path); return fragment; },
    listWikiNotes: () => ipc('markdown:list-wiki-notes'),
    createWikiNote: (request: unknown) => ipc('markdown:create-wiki-note', request),
    wikiHeads: (request: unknown) => ipc('markdown:wiki-heads', request),
    wikiBacklinks: (path: string) => ipc('markdown:wiki-backlinks', path),
    wikiTags: () => ipc('markdown:wiki-tags'),
    wikiGraph: () => ipc('markdown:wiki-graph'),
    async save(request: Parameters<MarkdownApi['save']>[0]): Promise<SaveMarkdownResult> {
      let libraryName: string | undefined;
      if (!active || request.mode === 'saveAs') {
        const extension = active?.name.match(/\.(md|markdown|txt|json)$/i)?.[0] ?? '.md';
        const name = await chooseDocumentName(request.defaultName ?? active?.name ?? `Untitled${extension}`);
        if (name === null) return { ok: true, canceled: true };
        libraryName = /\.(md|markdown|txt|json)$/i.test(name) ? name : `${name}${extension}`;
      }
      try {
        const result = await ipc<SaveMarkdownResult & { documentId: string; type: OpenDocument['type']; revision: number; resources?: Resource[] }>('markdown:save', { ...request, libraryName });
        if (result.ok && 'path' in result) {
          active = { documentId: result.documentId, type: result.type, path: result.path, name: result.path.split('/').pop()!, text: result.writtenText ?? request.text, resources: result.resources ?? [], revision: result.revision };
          mapResources(result.path, result.resources ?? []);
        }
        return result;
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    },
    setDirty(value: boolean) { dirty = value; },
    onSaveRequest: saveRequest.on,
    sendSaveRequestAck(ok: boolean) { saveWaiter?.(ok); },
    onReadTextRequest: readRequest.on,
    sendReadTextResult(result: { text: string } | { error: string }) { textWaiter?.(result); },
    onCloseSaveRequest: noEvents,
    sendCloseSaveResult() { throw new Error('Close saves use the editor save acknowledgement.'); },
    onFileRenamed: renamed.on,
    onFileChangedOnDisk: diskChanged.on,
    ackFileChangedOnDisk() { void ipc('markdown:ack-file-changed-on-disk').catch(console.error); },
    async pickImage() {
      if (!active) return null;
      const [file] = await pickFiles('image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/bmp,image/avif');
      if (!file) return null;
      return api.saveImage({ base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())), ext: file.name.split('.').pop() ?? 'png' });
    },
    async saveImage(data: { base64: string; ext: string }) {
      const result = await ipc<{ path: string; data: string } | null>('markdown:save-image', data);
      if (!result || !active) return null;
      mapResources(active.path, [result]);
      return result.path;
    },
    async readImage(source: string) {
      if (/^https?:\/\//i.test(source)) return ipc<{ base64: string; mime: string }>('markdown:read-remote-image', source);
      const url = /^(data:|blob:)/i.test(source) ? source : display.get(absolute(source, active?.path.slice(0, active.path.lastIndexOf('/')) ?? null));
      if (!url) throw new Error(`Missing document resource: ${source}`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not read image: ${source}`);
      return { base64: bytesToBase64(new Uint8Array(await response.arrayBuffer())), mime: response.headers.get('content-type')?.split(';')[0] ?? imageMime(source) };
    },
    async saveImageAs(source: string) {
      const image = await api.readImage(source);
      return deliver(`image.${image.mime.split('/')[1]?.replace('svg+xml', 'svg') ?? 'png'}`, base64ToBytes(image.base64), image.mime);
    },
    onViewImage: viewImage.on,
    onExportRequest(handler: (format: ExportFormat) => unknown) { exportHandlers.add(handler); return () => { exportHandlers.delete(handler); }; },
    exportDocx: async (request: Parameters<MarkdownApi['exportDocx']>[0]) => {
      const bytes = base64ToBytes(request.base64);
      const name = `${request.suggestedName}.docx`;
      const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      if (request.mode === 'dialog') return deliver(name, bytes, mime);
      const document = await importDocument(name, mime, bytes);
      await window.matchaApp!.openApplication({ applicationId: 'docs', data: { documentId: document.id } });
      return { ok: true, path: document.id };
    },
    exportPdf: async (request: Parameters<MarkdownApi['exportPdf']>[0]) => {
      const bytes = await renderPdf(request.html, api.readImage);
      const name = `${request.suggestedName}.pdf`;
      const document = await importDocument(name, 'application/pdf', bytes);
      const result = deliver(name, bytes, 'application/pdf');
      await window.matchaApp!.openApplication({ applicationId: 'pdf', data: { documentId: document.id } });
      return result;
    },
    async prepareImageExport(request: { html: string; suggestedName: string }) {
      const bytes = await renderPdf(request.html, api.readImage);
      const id = crypto.randomUUID();
      imageExports.set(id, { name: request.suggestedName, pages: new Map() });
      return { ok: true, id, pdfBase64: bytesToBase64(bytes) };
    },
    async writeExportImage(id: string, page: number, data: string) {
      const batch = imageExports.get(id);
      const bytes = base64ToBytes(data);
      if (!batch || page !== batch.pages.size + 1 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) throw new Error('Invalid image export page.');
      batch.pages.set(page, bytes);
      return { ok: true };
    },
    async finishImageExport(id: string, success: boolean) {
      const batch = imageExports.get(id);
      imageExports.delete(id);
      if (!batch) throw new Error('The image export session does not exist.');
      if (!success) return { ok: false, error: 'Image export failed.' };
      if (!batch.pages.size) throw new Error('No image pages were generated.');
      const { default: JSZip } = await import('jszip');
      const archive = new JSZip();
      for (const [page, bytes] of batch.pages) archive.file(`${batch.name}-${page}.png`, bytes);
      return deliver(`${batch.name}.zip`, await archive.generateAsync({ type: 'uint8array' }), 'application/zip');
    },
    getLanguage: async () => language,
    onLanguageChanged: languageChanged.on,
    getTheme: async () => document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const,
    onThemeChanged: themeChanged.on,
    getDocumentTheme: async () => (await officeSettings()).documentTheme,
    onDocumentThemeChanged: (handler: Parameters<MarkdownApi['onDocumentThemeChanged']>[0]) => settingsChanged.on((settings) => handler(settings.documentTheme)),
    getAutoSaveDefault: async () => (await officeSettings()).autoSaveDefault,
    onAutoSaveDefaultChanged: (handler: Parameters<MarkdownApi['onAutoSaveDefaultChanged']>[0]) => settingsChanged.on((settings) => handler(settings.autoSaveDefault)),
    getMarkdownTheme: async () => markdownTheme,
    async setMarkdownTheme(theme: MarkdownTheme) {
      const saved = await ipc<MarkdownTheme>('markdown:set-theme', theme);
      applyMarkdownTheme(saved);
      return saved;
    },
    onChromePressed: noEvents
  };
  Object.defineProperty(window, 'markdownApi', { value: api as unknown as MarkdownApi, configurable: true });
  const receive = ({ topic, data }: { topic: string; data: unknown }) => {
    if (topic === 'office.markdown.action') {
      const request = data as { editorId: string; documentId: string; requestId: string; action: string; input: Record<string, unknown> };
      if (request.editorId !== editorId || request.documentId !== active?.documentId || closed) return;
      void (async () => {
        try {
          const result = await executeMarkdownAction(request.action, request.input);
          if (request.documentId !== active?.documentId || closed) throw new Error('The Markdown document editor changed or closed.');
          await ipc('markdown:action-result', { requestId: request.requestId, documentId: request.documentId, result });
        } catch (error) {
          await ipc('markdown:action-result', { requestId: request.requestId, documentId: request.documentId, error: error instanceof Error ? error.message : String(error) });
        }
      })().catch(console.error);
      return;
    }
    if (topic === 'locale.changed') {
      language = normalizeLang((data as { language?: string })?.language);
      languageChanged.emit(language);
      return;
    }
    if (topic === 'application.open') {
      const documentId = (data as { data?: { documentId?: unknown } })?.data?.documentId;
      if (typeof documentId === 'string' && documentId !== active?.documentId) {
        void (async () => { if (await confirmLeave()) await openId(documentId); })().catch((error) => {
          console.error('[markdown] application open failed:', error);
          showToast(`${labels().failed}: ${error instanceof Error ? error.message : String(error)}`, 'error');
        });
      }
      return;
    }
    if (topic !== 'document.changed' || !active) return;
    const change = data as { documentId?: string };
    if (change.documentId !== active.documentId) return;
    const documentId = active.documentId;
    void (async () => {
      const record = (await textDocuments()).find((record) => record.id === documentId);
      if (!record || active?.documentId !== documentId) return;
      const path = `/library/${record.libraryPath ?? `${record.id}/${record.name}`}`;
      if (path !== active.path) {
        active.path = path; active.name = record.name;
        mapResources(path, active.resources);
        renamed.emit(path);
      }
      diskChanged.emit(path);
    })().catch(console.error);
  };
  const stopIncoming = incoming.on(receive);
  const offClose = window.matchaApp?.onCloseRequested?.(async (signal) => {
    if (!await confirmLeave(signal)) return false;
    await flushBrowserStorage();
    return !signal.aborted;
  });
  window.addEventListener('pagehide', () => {
    closed = true;
    document.removeEventListener('click', openExternal);
    document.removeEventListener('auxclick', openExternal);
    unsubscribe?.(); offClose?.(); stopIncoming(); themeObserver.disconnect();
    saveWaiter?.(false);
    textWaiter?.({ error: 'The editor closed.' });
    void ipc('office:close-editor').catch(console.error);
  }, { once: true });
  const initialDocumentId = (window.matchaApp?.context.data as { documentId?: unknown } | undefined)?.documentId;
  if (typeof initialDocumentId === 'string') await openId(initialDocumentId);
  navigationReady = true;
  for (const value of queuedOpens) receive(value);
  queuedOpens.length = 0;
  return {
    get language() { return language; },
    async openLibrary() {
      const documents = await textDocuments();
      const id = await chooseAction({ title: labels().open, actions: documents.map((record) => ({ value: record.id, label: record.libraryPath ?? record.name })) });
      if (id && await confirmLeave()) await openId(id);
    },
    async importFile(filesForImport?: readonly File[]) {
      const [file] = filesForImport ?? await pickFiles('.md,.markdown,.txt,.json,.zip');
      if (!file || !await confirmLeave()) return;
      let name = file.name;
      let data: Uint8Array = new Uint8Array(await file.arrayBuffer());
      let resources: Resource[];
      if (/\.zip$/i.test(name)) {
        const [{ default: JSZip }, { assertZipInflatesWithinLimits }] = await Promise.all([
          import('jszip'), import('../../genoffice/packages/zip-gate/src')
        ]);
        await assertZipInflatesWithinLimits(data, { maxParts: 1000, maxPartBytes: 50 * 1024 * 1024, maxTotalBytes: 200 * 1024 * 1024 });
        const archive = await JSZip.loadAsync(data);
        const entries = Object.values(archive.files).filter((entry) => !entry.dir);
        const notes = entries.filter((entry) => /\.(md|markdown)$/i.test(entry.name));
        if (notes.length !== 1) throw new Error('A Markdown archive must contain exactly one document.');
        const note = notes[0]!;
        const prefix = note.name.slice(0, note.name.lastIndexOf('/') + 1);
        name = note.name.slice(prefix.length);
        data = await note.async('uint8array');
        resources = await Promise.all(entries.filter((entry) => entry !== note).map(async (entry) => {
          if (!entry.name.startsWith(prefix) || entry.name.includes('..')) throw new Error('The archive contains an unsafe resource path.');
          return { path: entry.name.slice(prefix.length), data: bytesToBase64(await entry.async('uint8array')) };
        }));
      } else if (/\.(md|markdown)$/i.test(name)) {
        const files = filesForImport ?? await pickFiles('image/*', true);
        resources = (await Promise.all(files.map(async (resource) => {
          const data = bytesToBase64(new Uint8Array(await resource.arrayBuffer()));
          return [{ path: resource.name, data }, { path: `assets/${resource.name}`, data }];
        }))).flat();
      } else resources = [];
      const imported = await ipc<{ documentId: string }>('markdown:import', { name, data: bytesToBase64(data), resources });
      await openId(imported.documentId);
    },
    save,
    async export(format: ExportFormat | 'html' | 'md') {
      if (format === 'md') {
        const source = await textSnapshot();
        const text = new TextEncoder().encode(source);
        const mime = active?.type === 'json' ? 'application/json' : active?.type === 'txt' ? 'text/plain' : 'text/markdown';
        if (!active) { deliver('Untitled.md', text, mime); return; }
        if (active.type !== 'md') { deliver(active.name, text, mime); return; }
        const prepared = await ipc<{ text: string; resources: Resource[] }>('markdown:archive', source);
        const resources = prepared.resources;
        if (!resources.length) { deliver(active.name, new TextEncoder().encode(prepared.text), 'text/markdown'); return; }
        const { default: JSZip } = await import('jszip');
        const archive = new JSZip();
        archive.file(active.name, prepared.text);
        for (const resource of resources) archive.file(resource.path, base64ToBytes(resource.data));
        deliver(`${active.name.replace(/\.(md|markdown)$/i, '')}.zip`, await archive.generateAsync({ type: 'uint8array' }), 'application/zip');
      }
      else if (format === 'html') {
        await textSnapshot();
        const { buildPrintHtml } = await import('../../genoffice/apps/markdown/src/renderer/export/printHtml');
        if (active?.type === 'txt' || active?.type === 'json') throw new Error('Text and JSON documents can only be downloaded in their original format.');
        const root = document.querySelector<HTMLElement>('.tiptap');
        if (!root) throw new Error('The Markdown editor is not ready.');
        deliver(`${active?.name.replace(/\.(md|markdown)$/i, '') ?? 'Untitled'}.html`, new TextEncoder().encode(await selfContainedHtml(buildPrintHtml(root, active?.name ?? 'Untitled'), true, api.readImage)), 'text/html');
      } else {
        if (!exportHandlers.size) throw new Error('The Markdown editor is not ready.');
        for (const handler of exportHandlers) if (!await handler(format)) throw new Error('The document could not be exported.');
      }
    },
    async move() {
      if (!active || !await save('save')) return;
      const path = await chooseDocumentName(active.path.slice('/library/'.length));
      if (!path) return;
      const result = await ipc<{ path: string; revision: number }>('markdown:move', path);
      active.path = result.path;
      active.name = result.path.split('/').pop()!;
      active.revision = result.revision;
      display.clear(); reverse.clear();
      mapResources(active.path, active.resources);
      renamed.emit(result.path);
    },
    get closed() { return closed; }
  };
}
