import '../platform/browser-storage';
import '../../genoffice/apps/sheets/src/preload/index';
import { normalizeLang } from '../../genoffice/packages/i18n/src';
import type { MenuAction } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import { base64ToBytes, bytesToBase64, callTool, listDocuments } from '../documents/client';
import { editorId, ipcRenderer, onApplicationOpen } from '../platform/electron-preload';
import { chooseDocument } from '../ui/choose-document';
import { chooseAction, chooseDocumentName } from '../ui/document-actions';
import { downloadFile, pickFiles } from '../ui/files';
import { showToast } from '../../genoffice/apps/sheets/src/renderer/toast-bus';
import { sheetsLabels } from './labels';
import { installSheetsClose } from './close';
import { selectLinkedRange } from './selection';
import { renderSheetsPdf } from './pdf';
import { officeSettings, onOfficeSettingsChanged, type OfficeSettings } from '../settings/client';

export function installSheetsBridge() {
  const desktop = window.desktopApi;
  const app = window.matchaApp;
  if (!app) throw new Error('Sheets must run inside the MatchaClaw app frame.');
  if (!window.nativeSpell) throw new Error('Sheets spelling preload is missing.');
  Object.assign(window.nativeSpell, {
    checkWord: (word: string) => app.spellcheck.checkWord(word),
    learnWord: (word: string) => app.spellcheck.addWord(word)
  });
  desktop.captureScreenSources = async () => {
    const result = await app.captureScreenSources();
    return { ...result, sources: [...result.sources] };
  };
  desktop.captureScreenSource = (request) => app.captureScreenSource(request);
  const canLeaveWorkbook = installSheetsClose(desktop);
  const nativeSave = desktop.saveWorkbookEdits.bind(desktop);
  const spreadsheetTypes = '.xlsx,.xlsm,.xls,.csv,.tsv,.ods,.ots';
  const ipc = async <T,>(channel: string, args: unknown[] = []) => (await callTool<{ result: T }>('office_sheets_ipc', { channel, arguments: args, editorId })).result;
  const filePayload = async (file: File) => {
    if (file.size > 50 * 1024 * 1024) throw new Error('Choose a workbook of at most 50 MiB.');
    return { name: file.name, data: bytesToBase64(new Uint8Array(await file.arrayBuffer())) };
  };
  let nextOpen: { documentId: string } | { files: File[] } | undefined;
  const workbookDocuments = async () => (await listDocuments()).filter(record => record.type === 'xlsx' || record.type === 'csv');
  async function confirmConversion(name: string): Promise<boolean> {
    if (!/\.(ods|ots)$/i.test(name)) return true;
    const labels = sheetsLabels();
    return (await chooseAction({ title: labels.odfTitle, message: labels.odfLoss, actions: [{ value: 'convert', label: labels.convert }] })) === 'convert';
  }
  async function pickWorkbook() {
    const file = await ipc<{ token: string; name: string } | null>('office:pick-workbook');
    if (!file) return null;
    if (!await confirmConversion(file.name)) return null;
    return ipc<Awaited<ReturnType<typeof desktop.selectWorkbook>>>('office:import-workbook', [file.token]);
  }
  desktop.selectExternalLinkSource = async () => {
    const chosen = await chooseDocument(await listDocuments('xlsx'), 'xlsx');
    if (!chosen) return null;
    return ipc<string | null>('workbook:select-external-link-source', chosen === 'import' ? [] : [{ documentId: chosen.id }]);
  };
  async function csvChoice() {
    const labels = sheetsLabels();
    return await chooseAction({ title: labels.csvTitle, message: labels.csvLoss, actions: [
      { value: 'xlsx', label: labels.keepXlsx }, { value: 'csv', label: labels.keepCsv }
    ] }) ?? 'cancel';
  }
  Object.assign(desktop, {
    replyRecoveryPrompt(restore: boolean) {
      void callTool('office_sheets_ipc', {
        channel: 'workbook:recovery-prompt-reply', arguments: [restore], editorId
      }).catch((error) => console.error('Could not reply to Sheets recovery prompt.', error));
    },
    async saveWorkbookEdits(request: Parameters<typeof nativeSave>[0]) {
      if (request.mode !== 'save-as') return nativeSave(request);
      const name = await chooseDocumentName(request.defaultName ?? 'Workbook');
      if (!name) return { canceled: true };
      // Native session identity determines the format, not the optional proposed name.
      return nativeSave({ ...request, libraryName: name } as Parameters<typeof nativeSave>[0]);
    }
  });

  let language = normalizeLang(app.context.language);
  desktop.getLanguage = async () => language;
  const languageListeners = new Set<Parameters<typeof desktop.onLanguageChanged>[0]>();
  desktop.onLanguageChanged = handler => { languageListeners.add(handler); handler(language); return () => languageListeners.delete(handler); };
  const offLanguage = app.subscribe(event => {
    if (event.topic !== 'locale.changed') return;
    const next = normalizeLang((event.data as { language?: string })?.language);
    if (next === language) return;
    language = next;
    for (const listener of languageListeners) listener(language);
    void ipc('office:language', [language]).catch(console.error);
  });
  const settingsListeners = new Set<(settings: OfficeSettings) => void>();
  const offSettings = onOfficeSettingsChanged(settings => {
    for (const listener of settingsListeners) listener(settings);
  });
  desktop.getTheme = async () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  desktop.getDocumentTheme = async () => (await officeSettings()).documentTheme;
  desktop.getAutoSaveDefault = async () => (await officeSettings()).autoSaveDefault;
  desktop.getUserDisplayName = async () => (await officeSettings()).authorName;
  desktop.onDocumentThemeChanged = handler => {
    const listener = (settings: OfficeSettings) => handler(settings.documentTheme);
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  };
  desktop.onAutoSaveDefaultChanged = handler => {
    const listener = (settings: OfficeSettings) => handler(settings.autoSaveDefault);
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  };
  desktop.onUserDisplayNameChanged = handler => {
    const listener = (settings: OfficeSettings) => handler(settings.authorName);
    settingsListeners.add(listener);
    return () => settingsListeners.delete(listener);
  };
  const themeListeners = new Set<Parameters<typeof desktop.onThemeChanged>[0]>();
  let lastTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const;
  const themeObserver = new MutationObserver(() => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    if (theme === lastTheme) return;
    lastTheme = theme;
    for (const listener of themeListeners) listener(theme);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  desktop.onThemeChanged = handler => {
    themeListeners.add(handler);
    return () => themeListeners.delete(handler);
  };
  window.addEventListener('pagehide', () => {
    themeObserver.disconnect();
    offSettings();
    offLanguage();
    languageListeners.clear();
    settingsListeners.clear();
    themeListeners.clear();
  }, { once: true });
  let afterAction: (() => Promise<void>) | undefined;
  desktop.createDocument = async request => {
    const navigate = async (path: string) => {
      const documentId = /^\/office-workbooks\/(doc_[a-f0-9]{16})$/.exec(path)?.[1];
      if (!documentId) throw new Error('The created document identity is missing.');
      const applicationId = request.type === 'xlsx' || request.type === 'csv' ? 'sheets' : request.type === 'docx' ? 'docs' : request.type === 'md' ? 'markdown' : request.type;
      // Run navigation only after the creating action's committed result is delivered.
      afterAction = async () => {
        try { await app.openApplication({ applicationId, data: { documentId } }); }
        catch (error) {
          console.error(`Created ${documentId}; opening was not accepted.`, error);
          showToast(`${sheetsLabels().createdNotOpened} (${documentId})`, 'error');
        }
      };
      return { ok: true, path };
    };
    const name = `${request.title}.${request.type}`;
    if (request.type === 'csv' || request.type === 'xlsx') {
      const created = await ipc<{ ok: boolean; path: string }>('office:create-sheet-document', [request]);
      return navigate(created.path);
    }
    if (request.type === 'pdf') {
      const rendered = await app.renderPdf({ html: request.content });
      const { document } = await callTool<{ document: { id: string } }>('document_import', { name, mimeType: 'application/pdf', data: rendered.data });
      return navigate(`/office-workbooks/${document.id}`);
    }
    const { document } = await callTool<{ document: { id: string } }>('document_create', {
      type: request.type, name, source: request.content,
      ...(request.type === 'docx' ? { sourceFormat: 'html' } : {})
    });
    return navigate(`/office-workbooks/${document.id}`);
  };
  desktop.revealLinkSource = (request) => {
    void ipc('shell:reveal-link-source', [request]).catch(error => console.error('Could not locate workbook link source.', error));
  };
  desktop.selectWorkbooksForMerge = async () => {
    const files = await pickFiles(spreadsheetTypes, true);
    if (!files.length) return null;
    if (files.length > 20 || files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) throw new Error('Choose up to 20 workbooks totaling at most 50 MiB.');
    return ipc<Awaited<ReturnType<typeof desktop.selectWorkbooksForMerge>>>('office:merge-workbooks', [await Promise.all(files.map(filePayload))]);
  };
  desktop.confirmCsvSave = csvChoice as typeof desktop.confirmCsvSave;
  desktop.exportCsv = async (request) => {
    if (request.hasFormulas) {
      const choice = await csvChoice();
      if (choice !== 'csv') return { canceled: true, ...(choice === 'xlsx' ? { saveAsXlsxInstead: true } : {}) };
    }
    const result = await ipc<{ data: string }>('workbook:export-csv', [request]);
    const output = downloadFile(/\.csv$/i.test(request.fileName) ? request.fileName : `${request.fileName}.csv`, base64ToBytes(result.data), 'text/csv;charset=utf-8');
    return { canceled: false, path: output.path };
  };
  desktop.exportPdf = async (request) => {
    const bytes = await renderSheetsPdf(request, (input) => app.renderPdf(input));
    const output = downloadFile(/\.pdf$/i.test(request.fileName) ? request.fileName : `${request.fileName}.pdf`, bytes, 'application/pdf');
    return { canceled: false, path: output.path };
  };
  desktop.selectWorkbook = async () => {
    const pending = nextOpen;
    nextOpen = undefined;
    if (!(await canLeaveWorkbook())) return null;
    if (pending && 'files' in pending) {
      const file = pending.files[0];
      if (!file || !await confirmConversion(file.name)) return null;
      return ipc<Awaited<ReturnType<typeof desktop.selectWorkbook>>>('office:import-files', [[await filePayload(file)]]);
    }
    const chosen = pending && 'documentId' in pending ? { id: pending.documentId } : await chooseDocument(await workbookDocuments(), 'xlsx');
    if (!chosen) return null;
    if (chosen === 'import') return pickWorkbook();
    const opened = await callTool<{ workbook: Awaited<ReturnType<typeof desktop.selectWorkbook>> }>('office_sheets_open', { documentId: chosen.id, editorId });
    return opened.workbook;
  };
  const onMenuAction = desktop.onMenuAction.bind(desktop);
  const menuListeners = new Set<(action: MenuAction) => void>();
  Object.assign(desktop, {
    getAiSettings: async () => null,
    onAiSettingsChanged: () => () => {},
    onMenuAction(callback: (action: MenuAction) => void) {
      menuListeners.add(callback);
      const unsubscribe = onMenuAction(callback);
      if (nextOpen) queueMicrotask(() => callback('open'));
      return () => {
        menuListeners.delete(callback);
        unsubscribe();
      };
    }
  });

  function dispatchMenuAction(action: MenuAction): void {
    for (const listener of menuListeners) listener(action);
  }
  const keyboard = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat || event.altKey || !(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key !== 'o' && key !== 's') return;
    event.preventDefault();
    if (document.querySelector('[role="dialog"], dialog[open]')) return;
    dispatchMenuAction(key === 'o' ? 'open' : event.shiftKey ? 'save-as' : 'save');
  };
  const drop = (event: DragEvent) => {
    const files = Array.from(event.dataTransfer?.files ?? []).filter(file => /\.(xlsx|xlsm|xls|csv|tsv|ods|ots)$/i.test(file.name));
    if (!files.length || nextOpen) return;
    // The upstream singleton opens one document at a time; choose the first in OS order.
    // Media-only drops stay with the original picture consumer.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (document.querySelector('[role="dialog"], dialog[open]')) return;
    nextOpen = { files: files.slice(0, 1) };
    dispatchMenuAction('open');
  };
  document.addEventListener('keydown', keyboard, true);
  // Capture precedes the upstream preload's browser-inapplicable path resolver.
  window.addEventListener('drop', drop, true);
  const pickRange = (event: Event) => {
    const request = (event as CustomEvent).detail as { sessionId: string; index: number; requestId: string; pick(selection: unknown): void; cancel(): void };
    const release = () => ipc('office:selection-close', [request.requestId]);
    const dispose = selectLinkedRange(request.requestId, async () => {
      const opened = await ipc<{ requestId: string; file: import('../../genoffice/apps/sheets/src/shared/desktop-api').WorkbookFile }>('office:selection-open', [{ sessionId: request.sessionId, index: request.index, requestId: request.requestId }]);
      if (opened.requestId !== request.requestId) throw new Error('The range selection expired.');
      return opened.file;
    }, release, request.pick);
    request.cancel = dispose;
  };
  window.addEventListener('office:sheets-pick-range', pickRange);
  let actionTail = Promise.resolve();
  const offAction = ipcRenderer.on('office:action', (_event, payload) => {
    const request = payload as { requestId: string; documentId: string; sessionId: string; path: string; action: string; input: Record<string, unknown>; revision: number };
    actionTail = actionTail.then(() => new Promise<void>(finish => {
      const reply = (result?: unknown, error?: unknown) => {
        const navigate = afterAction;
        afterAction = undefined;
        void ipc('office:action-result', [{ requestId: request.requestId, documentId: request.documentId, sessionId: request.sessionId,
          ...(error === undefined ? { result: { result, revision: request.revision } } : { error: String(error) }) }])
          .then(() => navigate?.()).catch(console.error).finally(finish);
      };
      window.dispatchEvent(new CustomEvent('office:sheets-action', { detail: {
        ...request, resolve: (result: unknown) => reply(result), reject: (error: unknown) => reply(undefined, error)
      } }));
    }));
  });
  function requestOpen(data: unknown): void {
    const documentId = (data as { documentId?: unknown } | undefined)?.documentId;
    if (typeof documentId !== 'string' || !/^doc_[a-f0-9]{16}$/.test(documentId)) return;
    nextOpen = { documentId };
    dispatchMenuAction('open');
  }
  const offOpen = onApplicationOpen(data => requestOpen((data as { data?: unknown })?.data));
  window.addEventListener('pagehide', () => {
    document.removeEventListener('keydown', keyboard, true);
    window.removeEventListener('drop', drop, true);
    window.removeEventListener('office:sheets-pick-range', pickRange);
    offAction(); offOpen();
  }, { once: true });
  return {
    openEditor: async () => {
      await callTool('office_sheets_ipc', { channel: 'office:open-editor', editorId });
      await ipc('office:language', [await desktop.getLanguage()]);
    },
    openInitial: () => { if (!nextOpen) requestOpen(app.context.data); },
    dispatchMenuAction
  };
}
