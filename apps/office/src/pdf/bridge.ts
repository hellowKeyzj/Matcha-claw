import '../platform/browser-storage';
import '../../genoffice/apps/pdf/src/preload';
import { ipcRenderer, editorId, onApplicationOpen } from '../platform/electron-preload';
import { appApi, base64ToBytes, bytesToBase64, callTool, importDocument, listDocuments } from '../documents/client';
import { normalizeLang, type Lang } from '../../genoffice/packages/i18n/src';
import { chooseDocument, libraryLabels } from '../ui/choose-document';
import { chooseAction, chooseDocumentName } from '../ui/document-actions';
import { pickFiles, downloadFile } from '../ui/files';
import { DEFAULT_AI_PANEL_PREFS } from '../../genoffice/packages/ui/src';
import { installPdfClose } from './close';
import { officeSettings, onOfficeSettingsChanged } from '../settings/client';
import { encodePdfValue, decodePdfValue } from './wire';
import { pdfLabels } from './labels';

export interface PdfProducts { documents: { documentId: string; name: string }[]; downloads: string[] }
export type PdfProgress = { page: number; total: number } | null;
const applications = { docx: 'docs', xlsx: 'sheets', pptx: 'slides', md: 'markdown', html: 'html' } as const;
function documentIdOf(data: unknown): string | null {
  if (!data || typeof data !== 'object' || !('documentId' in data)) return null;
  return typeof data.documentId === 'string' && /^doc_[a-f0-9]{16}$/.test(data.documentId) ? data.documentId : null;
}

export function installPdfBridge(onOpened: () => void) {
  const invoke = ipcRenderer.invoke;
  ipcRenderer.invoke = async (channel: string, ...args: unknown[]) => decodePdfValue(await invoke(channel, ...args.map(encodePdfValue)));
  const canLeave = installPdfClose();
  const api = window.pdfApi;
  const pendingDialogs = new Set<AbortController>();
  const themeObservers = new Set<MutationObserver>();
  const usernameHandlers = new Set<Parameters<typeof api.onUsernameChanged>[0]>();
  const languageHandlers = new Set<(language: Lang) => void>();
  let language = normalizeLang(appApi().context.language);
  let ready = false;
  let opening = false;
  let queuedDocumentId: string | null = null;
  let products: PdfProducts = { documents: [], downloads: [] };
  let progress: PdfProgress = null;
  const productHandlers = new Set<(products: PdfProducts) => void>();
  const progressHandlers = new Set<(progress: PdfProgress) => void>();
  const stopApplicationOpen = onApplicationOpen((data) => {
    const id = documentIdOf(data && typeof data === 'object' && 'data' in data ? data.data : null);
    if (id) { if (!ready) queuedDocumentId = id; else void replaceDocument(id).catch(report); }
  });
  const stopLocale = appApi().subscribe(({ topic, data }) => {
    if (topic !== 'locale.changed' || !data || typeof data !== 'object' || !('language' in data) || typeof data.language !== 'string') return;
    const next = normalizeLang(data.language);
    if (next === language) return;
    language = next;
    if (ready) void ipcRenderer.invoke('office:language', language).catch(report);
    for (const handler of languageHandlers) handler(language);
  });
  const stopSettings = onOfficeSettingsChanged((settings) => {
    for (const handler of usernameHandlers) handler(settings.authorName);
  });
  const report = (error: unknown) => window.dispatchEvent(new ErrorEvent('error', { message: error instanceof Error ? error.message : String(error), error }));
  const stopOpening = ipcRenderer.on('office:open-document', (_event, value) => {
    const { documentId } = value as { documentId: string };
    void replaceDocument(documentId).catch(report);
  });
  const stopProducts = ipcRenderer.on('office:products', (_event, value) => {
    const receipt = value as Partial<PdfProducts>;
    products = { documents: [...products.documents, ...(receipt.documents ?? [])], downloads: [...products.downloads, ...(receipt.downloads ?? [])] };
    for (const handler of productHandlers) handler(products);
  });
  const stopProgress = ipcRenderer.on('office:conversion', (_event, value) => {
    progress = value as PdfProgress;
    for (const handler of progressHandlers) handler(progress);
  });
  const stopDialogs = ipcRenderer.on('office:dialog', (_event, value) => {
    const request = value as { requestId: string; kind: string; options: Record<string, unknown> };
    const controller = new AbortController();
    pendingDialogs.add(controller);
    void (async () => {
      const options = request.options;
      if (request.kind === 'open') {
        const filters = options.filters as { extensions?: string[] }[] | undefined;
        const accept = filters?.flatMap((filter) => filter.extensions?.map((ext) => `.${ext}`) ?? []).join(',') ?? '';
        const files = await pickFiles(accept, (options.properties as string[] | undefined)?.includes('multiSelections'));
        return { files: await Promise.all(files.map(async (file) => ({ name: file.name, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) }))) };
      }
      if (request.kind === 'save') return chooseDocumentName(String(options.defaultPath ?? 'Document.pdf').split(/[\\/]/).at(-1)!);
      if (request.kind === 'download') {
        downloadFile(String(options.name), base64ToBytes(String(options.data)), 'application/octet-stream');
        return { initiated: true };
      }
      const buttons = options.buttons as string[] | undefined;
      const answer = await chooseAction({ title: String(options.message ?? options.title ?? 'PDF'), message: typeof options.detail === 'string' ? options.detail : undefined,
        actions: (buttons ?? [pdfLabels(language).ok]).map((label, index) => ({ value: String(index), label })) }, controller.signal);
      return answer === null ? null : Number(answer);
    })().then((value) => ipcRenderer.invoke('office:dialog-reply', { requestId: request.requestId, value }), (error) => {
      console.error(error);
      return ipcRenderer.invoke('office:dialog-reply', { requestId: request.requestId, value: null });
    }).finally(() => pendingDialogs.delete(controller));
  });
  Object.assign(api, {
    getLanguage: async () => language,
    onLanguageChanged(handler: (language: Lang) => void) {
      languageHandlers.add(handler);
      handler(language);
      return () => { languageHandlers.delete(handler); };
    },
    getTheme: async () => document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const,
    getUsername: async () => (await officeSettings()).authorName,
    onUsernameChanged(handler: Parameters<typeof api.onUsernameChanged>[0]) {
      usernameHandlers.add(handler);
      return () => { usernameHandlers.delete(handler); };
    },
    onThemeChanged(handler: Parameters<typeof api.onThemeChanged>[0]) {
      let previous = document.documentElement.dataset.theme;
      const observer = new MutationObserver(() => {
        const theme = document.documentElement.dataset.theme;
        if (theme === previous || (theme !== 'light' && theme !== 'dark')) return;
        previous = theme;
        handler(theme);
      });
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      themeObservers.add(observer);
      return () => { observer.disconnect(); themeObservers.delete(observer); };
    },
    getAiPanelPrefs: async () => ({ ...DEFAULT_AI_PANEL_PREFS, showAiSidebar: false }),
    async openSourcePath() { await openLibrary(); },
    async convertOffice(format: string, password?: string) {
      if (!Object.hasOwn(applications, format)) throw new Error(pdfLabels(language).invalidFormat);
      if (!await ipcRenderer.invoke('office:flush')) throw new Error(pdfLabels(language).saveFailed);
      const result = await ipcRenderer.invoke('pdf:convert-office', format, password) as { documentId: string; warnings?: string[]; pageResults?: { page: number; status: string }[] } | null;
      if (!result) return;
      const text = pdfLabels(language);
      const ocr = result.pageResults?.filter((page) => page.status === 'ocr').map((page) => page.page) ?? [];
      const images = result.pageResults?.filter((page) => page.status !== 'ok' && page.status !== 'ocr').map((page) => page.page) ?? [];
      const messages = [
        ...(images.length ? [`${format === 'md' ? text.missing : text.images} ${images.join(', ')}`] : []),
        ...(ocr.length ? [`${text.ocr} ${ocr.join(', ')}`] : []),
        ...(result.warnings ?? [])
      ];
      if (messages.length) await chooseAction({ title: text.warnings, message: messages.join('\n\n'), actions: [{ value: 'ok', label: text.ok }] });
      await appApi().openApplication({ applicationId: applications[format as keyof typeof applications], data: { documentId: result.documentId } });
    }
  });
  async function openId(documentId: string) {
    await callTool('office_pdf_open', { documentId, editorId });
    await ipcRenderer.invoke('office:language', language);
    onOpened();
  }
  async function replaceDocument(documentId: string) {
    if (opening) return;
    opening = true;
    try { if (await canLeave()) await openId(documentId); }
    finally { opening = false; }
  }
  async function openLibrary() {
    if (!await canLeave()) return;
    const selected = await chooseDocument(await listDocuments('pdf'), 'pdf');
    if (selected === 'import') await importPdf();
    else if (selected) await openId(selected.id);
  }
  async function importFile(file: File) {
    const record = await importDocument(file.name, 'application/pdf', new Uint8Array(await file.arrayBuffer()));
    await openId(record.id);
  }
  async function importPdf() {
    if (!await canLeave()) return;
    const [file] = await pickFiles('.pdf');
    if (file) await importFile(file);
  }
  async function saveCopy() {
    (document.activeElement as HTMLElement | null)?.blur?.();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const product = await ipcRenderer.invoke('office:save-as') as { documentId: string; name: string } | false;
    if (!product) return;
    products = { ...products, documents: [...products.documents, product] };
    for (const handler of productHandlers) handler(products);
  }
  const onKey = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    if (key !== 'o' && !(key === 's' && event.shiftKey)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void (key === 'o' ? openLibrary() : saveCopy()).catch(report);
  };
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const file = [...event.dataTransfer.files].find((file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf');
    if (file) void (async () => { if (!opening && await canLeave()) await importFile(file); })().catch(report);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('dragover', onDragOver, true);
  window.addEventListener('drop', onDrop, true);
  return { openLibrary, importPdf, saveCopy, openProduct: replaceDocument, libraryLabel: () => libraryLabels().pdf,
    onProducts(handler: (value: PdfProducts) => void) { productHandlers.add(handler); handler(products); return () => { productHandlers.delete(handler); }; },
    onProgress(handler: (value: PdfProgress) => void) { progressHandlers.add(handler); handler(progress); return () => { progressHandlers.delete(handler); }; },
    async bootstrap() {
      await ipcRenderer.invoke('office:open-editor');
      await ipcRenderer.invoke('office:language', language);
      let documentId = queuedDocumentId ?? documentIdOf(appApi().context.data) ?? new URLSearchParams(location.search).get('documentId');
      do {
        queuedDocumentId = null;
        if (documentId) await replaceDocument(documentId);
        documentId = queuedDocumentId;
      } while (documentId);
      ready = true;
      await ipcRenderer.invoke('office:language', language);
    },
    dispose() {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('dragover', onDragOver, true);
      window.removeEventListener('drop', onDrop, true);
      stopApplicationOpen(); stopOpening(); stopProducts(); stopProgress(); stopDialogs(); stopSettings(); stopLocale(); usernameHandlers.clear(); languageHandlers.clear(); productHandlers.clear(); progressHandlers.clear();
      for (const observer of themeObservers) observer.disconnect();
      themeObservers.clear();
      for (const controller of pendingDialogs) controller.abort();
    }
  };
}
