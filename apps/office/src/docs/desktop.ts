import type { DesktopApi, DocsOpenCandidate, OpenDocxResult, OpenFileResult } from './types';
import { chooseDocument } from '../ui/choose-document';
import { chooseAction, chooseDocumentName } from '../ui/document-actions';
import { downloadFile as download, pickFiles } from '../ui/files';
import { zipSync, strToU8 } from 'fflate';
import { MARKDOWN_MEDIA_DIR_TOKEN } from '../../genoffice/apps/docs/src/shared/ipc';
import { copyImageDisplaySize } from '../../genoffice/apps/docs/src/main/copy-image-guard';
import { docsConflictLabels, docsImportLabels, docsRecoveryLabels } from './labels';
import type { DocumentRecord } from '../documents/model';
import { createDocsExports } from './export';
import { createDocsCloseGuard } from './close';
import { AI_PROVIDERS } from '../../genoffice/packages/ai-provider/src/browser';
import '../ui/dialogs.css';
import {
  appApi,
  base64ToBytes,
  bytesToBase64,
  callTool,
  libraryId,
  libraryPath,
  listDocuments,
} from '../documents/client';
import { DEFAULT_AI_PANEL_PREFS } from '../../genoffice/packages/ui/src/ai-panel-prefs';
import { officeSettings, onOfficeSettingsChanged, type OfficeSettings } from '../settings/client';
import { setLazyMediaBaseUrl } from '../../genoffice/packages/docx-engine/src/lazy-media';
import { flushBrowserStorage } from '../platform/browser-storage';
import { reportDocsClipboardError } from './clipboard';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

type Listener<T> = (value: T) => void;

function listenerSet<T>(): { add(listener: Listener<T>): () => void; emit(value: T): void } {
  const listeners = new Set<Listener<T>>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(value) {
      for (const listener of listeners) listener(value);
    }
  };
}

type Language = Awaited<ReturnType<DesktopApi['getLanguage']>>;

function currentLanguage(language = window.matchaApp?.context.language ?? 'en'): Language {
  const tag = language.toLowerCase();
  if (tag.startsWith('zh')) return 'zh';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('fr')) return 'fr';
  if (tag.startsWith('de')) return 'de';
  if (tag.startsWith('es')) return 'es';
  if (tag.startsWith('th')) return 'th';
  if (tag.startsWith('id')) return 'id';
  if (tag.startsWith('ru')) return 'ru';
  if (tag.startsWith('ar')) return 'ar';
  return 'en';
}

const pickFile = async (accept: string) => (await pickFiles(accept))[0] ?? null;

export function docsFileName(path: string | null, fallback: string): string {
  if (!path) return fallback;
  const name = path.split(/[\\/]/).pop() ?? fallback;
  return path.startsWith('matcha-office://') ? decodeURIComponent(name) : name;
}

export function openDocsExternalUrl(url: string): void {
  void (window.desktop as DesktopApi).openExternal(url).catch(error => console.warn('[office:docs:open-external]', error));
}

export function installDesktopBridge(overrides: Partial<DesktopApi> = {}, headless = false): DesktopApi {
  const existing = (window as unknown as { desktop?: DesktopApi }).desktop;
  if (existing) return existing;

  const languageChanged = listenerSet<Language>();
  let language = currentLanguage();
  let menuHandler: Parameters<DesktopApi['onMenuCommand']>[0] | undefined;
  const pendingOpenPaths: string[] = [];
  const zoteroRequests = listenerSet<Parameters<Parameters<DesktopApi['onZoteroRequest']>[0]>[0]>();
  const themeChanged = listenerSet<Awaited<ReturnType<DesktopApi['getTheme']>>>();
  const settingsChanged = listenerSet<OfficeSettings>();
  const openDocxEvents = listenerSet<OpenFileResult>();
  const renamedDocxEvents = listenerSet<{ oldPath: string; newPath: string }>();
  const teardown = listenerSet<void>();
  const aiPanelPrefsChanged = listenerSet<Awaited<ReturnType<DesktopApi['getAiPanelPrefs']>>>();
  const editorId = crypto.randomUUID();
  const invoke = async <T,>(channel: string, ...args: unknown[]): Promise<T> => {
    const response = await callTool<{ result: T }>('office_docs_ipc', { editorId, channel, arguments: args });
    return response.result;
  };
  const controller = new AbortController();
  let resourceReady: Promise<void> | undefined;
  async function resourcesReady(): Promise<void> {
    resourceReady ??= invoke<{ baseUrl: string }>('resources').then(({ baseUrl }) => setLazyMediaBaseUrl(baseUrl));
    return resourceReady;
  }
  async function upload(data: ArrayBuffer | Blob): Promise<string> {
    await resourcesReady();
    const size = data instanceof Blob ? data.size : data.byteLength;
    const target = await invoke<{ id: string; url: string }>('upload-start', size);
    const response = await fetch(target.url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: data, credentials: 'omit', signal: controller.signal });
    if (!response.ok) throw new Error(`Docs upload failed (${response.status}).`);
    return target.id;
  }
  const closeGuard = createDocsCloseGuard(async (path) => { await invoke('recovery-clear', path); });
  let blankDocument = true;
  const uiTheme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const;
  const aiPanelPrefs = { ...DEFAULT_AI_PANEL_PREFS, showAiSidebar: false };

  async function offerRecovery(result: DocsOpenCandidate): Promise<OpenDocxResult> {
    if (!result || 'needsPassword' in result) return result;
    if (!('recoveryPending' in result)) return result;
    const status = await invoke<{ available: boolean; diskNewer?: boolean }>('recovery-status', result.path);
    if (!status.available) return invoke<OpenFileResult>('recovery-original', result.path);
    const labels = docsRecoveryLabels();
    const choice = await chooseAction({
      title: labels.title,
      message: labels.body + (status.diskNewer ? `\n\n${labels.newer}` : ''),
      actions: [
        { value: 'restore', label: labels.restore },
        { value: 'discard', label: labels.discard }
      ]
    });
    if (choice === 'restore') return invoke<OpenFileResult>('recovery-restore', result.path);
    if (choice === 'discard') await invoke('recovery-clear', result.path);
    return invoke<OpenFileResult>('recovery-original', result.path);
  }

  async function importBytes(name: string, data: ArrayBuffer | Blob): Promise<OpenDocxResult> {
    return offerRecovery(await invoke<DocsOpenCandidate>('import', name, await upload(data)));
  }

  function documentPath(data: unknown): string | null {
    if (!data || typeof data !== 'object' || !('documentId' in data)) return null;
    const id = data.documentId;
    return typeof id === 'string' && /^doc_[a-f0-9]{16}$/.test(id) ? libraryPath({ id, name: '' }) : null;
  }

  async function openLibrary(path: string): Promise<OpenDocxResult> {
    await resourcesReady();
    const id = libraryId(path);
    return id ? offerRecovery(await invoke<DocsOpenCandidate>('open', id)) : null;
  }

  async function saveToLibrary(path: string, data: ArrayBuffer, auto = false) {
    let result = await invoke<Awaited<ReturnType<DesktopApi['saveDocx']>>>('save', path, await upload(data));
    if (result.ok || result.reason !== 'external-modified' || auto) return result;
    const labels = docsConflictLabels();
    const candidate = await invoke<{ revision: number }>('overwrite-candidate', path);
    let choice = await chooseAction({ title: labels.title, message: labels.body, actions: [{ value: 'overwrite', label: labels.overwrite }, { value: 'copy', label: labels.copy }] });
    if (choice === 'overwrite') {
      result = await invoke<Awaited<ReturnType<DesktopApi['saveDocx']>>>('save-overwrite', path, await upload(data), candidate.revision);
      if (result.ok || result.reason !== 'external-modified') return result;
      choice = await chooseAction({ title: labels.title, message: labels.changedAgain, actions: [{ value: 'copy', label: labels.copy }] });
    }
    if (choice !== 'copy') return result;
    const name = await chooseDocumentName(docsFileName(path, 'document.docx'));
    return name === null ? result : saveAsNew(name, data, path);
  }

  async function saveAsNew(defaultName: string, data: ArrayBuffer, sourcePath?: string | null) {
    return invoke<Awaited<ReturnType<DesktopApi['saveDocxAs']>>>(sourcePath === undefined ? 'save-new' : 'save-as', defaultName, await upload(data), sourcePath ?? null);
  }

  function unsupported(capability: string): never {
    throw new Error(`unsupported: ${capability} is not available in Matcha Office Docs.`);
  }

  const unsupportedResult = (capability: string) => ({
    ok: false as const,
    error: `unsupported: ${capability} is not available in Matcha Office Docs.`
  });
  // These native event sources do not exist in this page; subscriptions remain inert.
  const noEvents = () => () => {};
  const aiSettings: Awaited<ReturnType<DesktopApi['getAiSettings']>> = {
    provider: 'genspark',
    providers: Object.fromEntries(AI_PROVIDERS.map((provider) => [provider.id, {
      apiKey: '', model: provider.defaultModel, baseUrl: provider.needsBaseUrl ? '' : undefined
    }])) as Awaited<ReturnType<DesktopApi['getAiSettings']>>['providers'],
    gskToolsEnabled: false
  };

  const bridge: DesktopApi = {
    getLanguage: async () => headless ? 'en' : language,
    getSystemLocale: () => invoke('system-locale'),
    onLanguageChanged: (handler) => languageChanged.add(handler),
    getTheme: async () => uiTheme(),
    onThemeChanged: (handler) => themeChanged.add(handler),
    getDocumentTheme: async () => headless ? 'follow' : (await officeSettings()).documentTheme,
    onDocumentThemeChanged: (handler) => settingsChanged.add(settings => handler(settings.documentTheme)),
    getAutoSaveDefault: async () => headless ? { on: false, updatedAt: 0 } : (await officeSettings()).autoSaveDefault,
    onAutoSaveDefaultChanged: (handler) => settingsChanged.add(settings => handler(settings.autoSaveDefault)),
    getAuthorName: async () => headless ? '' : (await officeSettings()).authorName,
    openExternal: async (url) => { await invoke('open-external', url); },
    onAuthorNameChanged: (handler) => settingsChanged.add(settings => handler(settings.authorName)),
    getAiPanelPrefs: async () => aiPanelPrefs,
    setAiPanelPrefs: async (patch: Partial<typeof aiPanelPrefs>) => {
      Object.assign(aiPanelPrefs, patch);
      aiPanelPrefsChanged.emit(aiPanelPrefs);
      return aiPanelPrefs;
    },
    onAiPanelPrefsChanged: (handler) => aiPanelPrefsChanged.add(handler),
    onChromePressed: noEvents,
    zoteroCommand: (command) => invoke('zotero-command', command),
    onZoteroRequest: zoteroRequests.add,
    respondToZotero: (response) => { void invoke('zotero-response', response); },
    openDocxFile: async (file) => {
      if (!/\.(docx|doc|dot|odt|ott|hwp|hwpx)$/i.test(file.name)) throw new Error('Unsupported Word import format.');
      if (!/\.docx$/i.test(file.name)) {
        const labels = docsImportLabels();
        const kind = /\.(doc|dot)$/i.test(file.name) ? 'word97' : /\.hwpx?$/i.test(file.name) ? 'hwp' : 'odt';
        const preference = `docs-import-skip-${kind}`;
        if (localStorage.getItem(preference) !== '1') {
          const choice = await chooseAction({ title: labels.title, message: labels.body, actions: [{ value: 'import', label: labels.convert }, { value: 'remember', label: labels.remember }] });
          if (choice === null) return null;
          if (choice === 'remember') { localStorage.setItem(preference, '1'); await flushBrowserStorage(); }
        }
        const imported = await callTool<{ document: DocumentRecord; detail?: string[] }>('document_import', { name: file.name, mimeType: file.type || 'application/octet-stream', data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) });
        if (imported.detail?.length) await chooseAction({ title: labels.detail, message: imported.detail.join('\n'), actions: [{ value: 'continue', label: labels.done }] });
        blankDocument = false;
        return openLibrary(libraryPath(imported.document));
      }
      blankDocument = false;
      return importBytes(file.name, file);
    },
    openDocx: async () => {
      const selected = await chooseDocument(await listDocuments('docx'), 'docx');
      if (!selected) return null;
      if (selected !== 'import') {
        blankDocument = false;
        return openLibrary(libraryPath(selected));
      }
      const file = await pickFile('.docx,.doc,.dot,.odt,.ott,.hwp,.hwpx');
      if (!file) return null;
      return bridge.openDocxFile(file);
    },
    openDocxPath: async (path: string) => {
      if (!libraryId(path)) return unsupported('Opening paths outside the document library');
      return openLibrary(path);
    },
    confirmDocumentReplace: () => closeGuard.confirm(),
    openDocxDecrypt: async (path, password) => {
      const result = await invoke<{ ok: true; result: Exclude<DocsOpenCandidate, null> } | Extract<Awaited<ReturnType<DesktopApi['openDocxDecrypt']>>, { ok: false }>>('open-decrypt', path, password);
      if (!result.ok) return result;
      return { ok: true, result: await offerRecovery(result.result) as OpenFileResult };
    },
    convertAltChunkHtml: async (html) => {
      const result = await invoke<{ data: string }>('convert-html', html);
      return base64ToBytes(result.data);
    },
    setDocPassword: (path, password) => invoke('set-password', path, password),
    docPasswordIntentRevision: () => invoke('password-revision'),
    discardDocPasswordIntents: (revision) => invoke('discard-passwords', revision),
    consumePendingOpenDocx: async () => {
      const path = documentPath(window.matchaApp?.context.data);
      if (!blankDocument || !path) return null;
      blankDocument = false;
      return openLibrary(path);
    },
    consumeNewBlankDoc: async () => {
      const value = blankDocument;
      blankDocument = false;
      return value;
    },
    consumeAiDocContent: async () => null,
    consumeHeadlessExport: async () => null,
    headlessExportDone: () => unsupported('Headless export'),
    createDocument: async () => unsupportedResult('AI document creation'),
    onOpenDocx: (handler: Listener<OpenFileResult>) => openDocxEvents.add(handler),
    onRenamedDocx: renamedDocxEvents.add,
    saveDocx: async (path: string, data: ArrayBuffer, auto) => saveToLibrary(path, data, auto),
    writeRecoveryCopy: async (path, data) => {
      const epoch = await invoke<number>('recovery-epoch', path);
      return invoke('recovery-write', path, await upload(data), epoch);
    },
    onTeardown: (handler: Listener<void>) => teardown.add(handler),
    respellKick: () => appApi().spellcheck.respellKick(),
    spellDiag: (line) => console.debug('[office:docs:spell]', line),
    armContextMenu: () => { void appApi().spellcheck.armContextMenu().catch((error) => console.warn('[office:docs:context-menu]', error)); },
    claimContextMenu: (seq) => { void appApi().spellcheck.claimContextMenu(seq).catch((error) => console.warn('[office:docs:context-menu]', error)); },
    onContextMenuRequest: (handler) => appApi().spellcheck.onContextMenuRequest(handler),
    spellAddWord: (word) => appApi().spellcheck.addWord(word),
    spellIgnoreWord: (word) => appApi().spellcheck.ignoreWord(word),
    spellReplace: (word) => appApi().spellcheck.replace(word),
    spellLanguages: () => appApi().spellcheck.languages(),
    spellSetLanguages: (languages) => appApi().spellcheck.setLanguages(languages),
    saveDocxAs: async (defaultName, data, sourcePath) => {
      const name = await chooseDocumentName(defaultName);
      return name === null ? { ok: false } : saveAsNew(name, data, sourcePath ?? null);
    },
    saveDocxNew: async (defaultName, data) => saveAsNew(defaultName, data),
    saveDocxTo: async () => unsupportedResult('Explicit filesystem save'),
    onMcpCommand: noEvents,
    reportMcpResult: () => unsupported('GenOffice MCP'),
    // No MCP transport is advertised; this is the App's mount-time notification.
    signalMcpReady: () => {},
    getRecentFiles: async () => {
      const documents = await listDocuments('docx');
      return documents.map((document) => libraryPath(document));
    },
    pickImage: async () => {
      const file = await pickFile('image/png,image/jpeg,image/gif');
      if (!file) return null;
      const mime = file.type === 'image/jpeg' || file.type === 'image/gif' ? file.type : 'image/png';
      return { base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())), mime, name: file.name };
    },
    pickMergeDataSource: async () => {
      const file = await pickFile('.xlsx,.csv');
      if (!file) return null;
      try {
        return await invoke('merge-source', file.name, bytesToBase64(new Uint8Array(await file.arrayBuffer())));
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    writeMergeOutput: async ({ files }) => {
      if (!files.length) return { ok: false, error: 'No merged documents were produced.' };
      const entries: Record<string, Uint8Array> = {};
      for (const file of files) {
        const base = file.name.split(/[\\/]/).pop()!.replace(/[\\/:*?"<>|]/g, '_').trim() || 'document.docx';
        const name = /\.docx$/i.test(base) ? base : `${base}.docx`;
        let unique = name;
        for (let index = 2; unique in entries; index++) unique = name.replace(/\.docx$/i, `-${index}.docx`);
        const { dataUrl } = await invoke<{ dataUrl: string }>('merge-output', await upload(file.data));
        const response = await fetch(dataUrl, { credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error(`Docs merge output failed (${response.status}).`);
        entries[unique] = new Uint8Array(await response.arrayBuffer());
      }
      if (files.length === 1) {
        const name = Object.keys(entries)[0]!;
        return { ...download(name, entries[name]!, DOCX_MIME), count: 1 };
      }
      download('merged-documents.zip', zipSync(entries), 'application/zip');
      return { ok: true, folder: 'merged-documents.zip', count: files.length };
    },
    fontMetrics: (family) => invoke('font-metrics', family),
    systemFontFamilies: () => invoke('font-families'),
    getAiSettings: async () => aiSettings,
    setAiSettings: async () => unsupported('GenOffice AI settings'),
    onAiSettingsChanged: noEvents,
    openAiModelSettings: async () => unsupported('GenOffice AI settings'),
    openSkillsSettings: async () => unsupported('GenOffice skills'),
    print: async () => unsupportedResult('Native print jobs'),
    listPrinters: async () => [],
    ...createDocsExports(),
    exportMarkdown: async (defaultName, markdown, images, outPath) => {
      if (outPath) return unsupportedResult('Explicit filesystem export');
      const stem = defaultName.replace(/\.(docx|md)$/i, '');
      if (!images.length) return download(`${stem}.md`, strToU8(markdown), 'text/markdown');
      const directory = `${stem}_files`;
      const encoded = encodeURIComponent(directory).replace(/[()]/g, (character) => character === '(' ? '%28' : '%29');
      const entries: Record<string, Uint8Array> = {
        [`${stem}.md`]: strToU8(markdown.split(`${MARKDOWN_MEDIA_DIR_TOKEN}/`).join(`${encoded}/`))
      };
      let imagesDropped = 0;
      for (const image of images) {
        if (!/^image\d+\.\w+$/.test(image.name)) { imagesDropped++; continue; }
        try {
          const response = await fetch(image.src);
          if (!response.ok) { imagesDropped++; continue; }
          entries[`${directory}/${image.name}`] = new Uint8Array(await response.arrayBuffer());
        } catch { imagesDropped++; }
      }
      return { ...download(`${stem}.zip`, zipSync(entries), 'application/zip'), imagesDropped };
    },
    saveImageAs: async (src: string) => {
      const anchor = document.createElement('a');
      anchor.href = src;
      anchor.download = 'image';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      return { ok: true };
    },
    onViewImage: () => () => {},
    aiChat: async () => unsupportedResult('GenOffice AI chat'),
    aiStream: async () => unsupported('GenOffice AI streaming'),
    aiStreamCancel: async () => unsupported('GenOffice AI streaming'),
    aiGskStatus: async () => ({ loggedIn: false }),
    aiGskLogin: async () => unsupported('GenOffice AI login'),
    webSearch: async () => ({ results: [], method: 'unavailable', error: 'Use the MatchaClaw assistant for web search.' }),
    imageSearch: async () => ({ images: [], method: 'unavailable', error: 'Use the MatchaClaw assistant for image search.' }),
    analyzeMedia: async () => ({ error: 'Use the MatchaClaw assistant for media analysis.' }),
    fetchImage: (url) => invoke('fetch-image', url),
    aiGenerateImage: async () => ({ error: 'Use the MatchaClaw assistant for image generation.' }),
    pickAttachments: async () => null,
    addAttachmentPaths: async (paths) => ({ accepted: [], rejected: paths }),
    addPastedImage: async () => unsupported('GenOffice chat attachments'),
    copyImageToClipboard: async (src, metaJson) => {
      try {
        const data = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(src)?.[1];
        if (!data) throw new Error('The selected image is not decoded for copying.');
        const dimensions = copyImageDisplaySize(metaJson);
        const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const meta = metaJson && metaJson.length <= 2048 ? ` data-image-meta="${escape(metaJson)}"` : '';
        const size = `${dimensions.width ? ` width="${dimensions.width}"` : ''}${dimensions.height ? ` height="${dimensions.height}"` : ''}`;
        const html = `<img src="${src}"${size}${meta}>`;
        await appApi().writeClipboard({ html, image: { data, mimeType: 'image/png' } });
        return true;
      } catch (error) { reportDocsClipboardError(error); return false; }
    },
    readAttachment: async () => unsupportedResult('GenOffice chat attachments'),
    readAttachmentImage: async () => unsupportedResult('GenOffice chat attachments'),
    kbList: async () => [],
    kbSearch: async () => unsupported('GenOffice knowledge base'),
    kbRead: async () => unsupported('GenOffice knowledge base'),
    getPathForFile: () => unsupported('Absolute filesystem paths'),
    openNewTab: async () => unsupported('Creating host tabs'),
    openSourcePath: async () => unsupported('Opening filesystem source paths'),
    listDocsTabs: async () => [{ id: 'current-page', title: document.title, focused: true }],
    focusDocsTab: async (id) => {
      if (id !== 'current-page') return unsupported('Focusing other host tabs');
      window.focus();
    },
    onAiStream: noEvents,
    onMenuCommand: (handler) => {
      menuHandler = handler;
      for (const path of pendingOpenPaths.splice(0)) handler('open-path', path);
      return () => { if (menuHandler === handler) menuHandler = undefined; };
    },
    onCloseCheck: closeGuard.onCloseCheck,
    reportCloseCheck: closeGuard.reportCloseCheck,
    onCloseSaveRequest: closeGuard.onCloseSaveRequest,
    reportCloseSaveResult: closeGuard.reportCloseSaveResult,
    // The page owns its ribbon; there is no separate native View menu to sync.
    reportViewMenuState: () => {},
    skillsList: async () => [],
    skillText: async () => unsupported('GenOffice skills'),
    runCli: async () => ({ ...unsupportedResult('GenOffice CLI'), code: -1, stdout: '', stderr: 'unsupported' })
  };

  Object.assign(bridge, overrides);
  Object.defineProperty(window, 'desktop', { value: bridge, configurable: true, writable: false });
  if (headless) return bridge;
  const offEvents = appApi().subscribe((event) => {
    if (event.topic === 'locale.changed') {
      const next = (event.data as { language: string }).language;
      language = currentLanguage(next);
      languageChanged.emit(language);
    } else if (event.topic === 'application.open') {
      const path = documentPath((event.data as { data?: unknown }).data);
      if (!path) return;
      if (menuHandler) menuHandler('open-path', path);
      else pendingOpenPaths.push(path);
    } else if (event.topic === 'document.changed') {
      const data = event.data as { documentId?: string; revision?: number | null; type?: string };
      if (data.type !== 'docx' || !data.documentId || data.revision === null) return;
      void invoke<{ oldPath: string; newPath: string }[]>('refresh-metadata', data.documentId)
        .then(changes => changes.forEach(renamedDocxEvents.emit))
        .catch(error => console.warn('[office:docs:metadata]', error));
    } else if (event.topic === 'office.docs.zotero:request') {
      const data = event.data as unknown as { editorId?: string; payload: Parameters<Parameters<DesktopApi['onZoteroRequest']>[0]>[0] };
      if (data.editorId === editorId) zoteroRequests.emit(data.payload);
    }
  });
  const offSettings = onOfficeSettingsChanged(settingsChanged.emit);
  let lastTheme = uiTheme();
  const themeObserver = new MutationObserver(() => {
    const theme = uiTheme();
    if (theme === lastTheme) return;
    lastTheme = theme;
    themeChanged.emit(theme);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const offClose = window.matchaApp?.onCloseRequested?.(async (signal) => {
    if (!await closeGuard.confirm(signal)) return false;
    await flushBrowserStorage();
    if (signal.aborted) return false;
    await invoke('recovery-clear-all');
    return !signal.aborted;
  });
  window.addEventListener('pagehide', () => {
    controller.abort();
    themeObserver.disconnect();
    offEvents();
    pendingOpenPaths.length = 0;
    menuHandler = undefined;
    offSettings();
    offClose?.();
    closeGuard.dispose();
    teardown.emit();
    void invoke('close');
  }, { once: true });
  return bridge;
}
