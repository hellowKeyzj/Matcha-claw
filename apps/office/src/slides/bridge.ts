import JSZip from 'jszip';
import { normalizeLang } from '../../genoffice/packages/i18n/src';
import type { AppClipboardWriteRequest } from '@matcha/app-plugins-sdk';
import '../platform/browser-storage';
import '@matcha/slides-preload';
import { buildPdfExportHtml, exportPageWidthIn, PDF_EXPORT_HEIGHT_IN } from '@matcha/slides-pdf-export';
import { editorId, ipcRenderer, onApplicationOpen } from '../platform/electron-preload';
import { appApi, base64ToBytes, bytesToBase64, callTool, importDocument, listDocuments } from '../documents/client';
import { chooseDocument } from '../ui/choose-document';
import { chooseAction, chooseDocumentName } from '../ui/document-actions';
import { downloadFile, pickFiles } from '../ui/files';
import { DEFAULT_AI_PANEL_PREFS } from '../../genoffice/packages/ui/src';
import type { Lang } from '../../genoffice/packages/i18n/src';
import type { OpenResult, SlidesApi } from '../../genoffice/apps/slides/src/shared/ipc';
import { createSlidesClose } from './close';
import { videoPosterBase64 } from './video-poster';
import { textClipboard } from './text-clipboard';
import { officeSettings, onOfficeSettingsChanged } from '../settings/client';
import { flushBrowserStorage } from '../platform/browser-storage';

async function openLibraryDeck(documentId: string): Promise<OpenResult | null> {
  const opened = await callTool<{ presentation: OpenResult | null }>('office_slides_open', { documentId, editorId });
  return opened.presentation;
}

const importLabels = {
  zh: { title: '导入演示文稿', message: '将创建 PPTX 副本，部分格式或内容可能无法保留，原文件不会修改', action: '转换并导入' },
  en: { title: 'Import presentation', message: 'Create a PPTX copy. Some formatting or content may not be preserved. The original file stays unchanged.', action: 'Convert and import' },
  ja: { title: 'プレゼンテーションをインポート', message: 'PPTX のコピーを作成します。一部の書式や内容は保持されない場合があります。元のファイルは変更されません。', action: '変換してインポート' },
  ru: { title: 'Импорт презентации', message: 'Будет создана копия PPTX. Часть оформления или содержимого может не сохраниться. Исходный файл не изменится.', action: 'Преобразовать и импортировать' },
  ko: { title: '프레젠테이션 가져오기', message: 'PPTX 사본을 만듭니다. 일부 서식이나 내용이 유지되지 않을 수 있으며 원본 파일은 변경되지 않습니다.', action: '변환하여 가져오기' }
};

async function pictureFile() {
  const [file] = await pickFiles('.png,.jpg,.jpeg,.gif,.bmp,.webp,.tif,.tiff');
  if (!file) return null;
  return { file, base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())), ext: file.name.split('.').pop()!.toLowerCase() };
}

export async function installSlidesBridge(language: Lang): Promise<void> {
  const bridge = window.slidesApi;
  const native = appApi();
  const presentation = native.context.presentation;
  const audience = presentation?.data as { mode?: string; token?: string } | undefined;
  if (audience?.mode === 'audience') {
    await ipcRenderer.invoke('office:attach-audience', audience.token);
    native.onCloseRequested?.(async () => {
      await flushBrowserStorage();
      await ipcRenderer.invoke('office:close-editor');
      return true;
    });
  } else {
    await ipcRenderer.invoke('office:open-editor');
  }

  const uiText = (key: 'documentId' | 'canvas') => {
    const labels = {
      zh: { documentId: '需要文库文档标识', canvas: '无法使用画布测量文本' },
      en: { documentId: 'A library document id is required.', canvas: 'Canvas text measurement is unavailable.' },
      ja: { documentId: 'ライブラリのドキュメント ID が必要です', canvas: 'キャンバスでテキストを測定できません' },
      ru: { documentId: 'Требуется идентификатор документа библиотеки.', canvas: 'Измерение текста на холсте недоступно.' }
    };
    return (labels[language as keyof typeof labels] ?? labels.en)[key];
  };
  bridge.getLanguage = async () => language;
  const languageListeners = new Set<Parameters<SlidesApi['onLanguageChanged']>[0]>();
  const queuedNavigation: unknown[] = [];
  let navigate: ((data: unknown) => void) | undefined;
  const offNavigation = onApplicationOpen(data => {
    if (navigate) navigate(data); else queuedNavigation.push(data);
  });
  const offLanguage = native.subscribe(event => {
    if (event.topic !== 'locale.changed') return;
    language = normalizeLang((event.data as { language?: string })?.language);
    for (const listener of languageListeners) listener(language);
  });
  bridge.onLanguageChanged = handler => { languageListeners.add(handler); return () => languageListeners.delete(handler); };
  bridge.getTheme = async () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const themeListeners = new Set<Parameters<SlidesApi['onThemeChanged']>[0]>();
  let lastTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const;
  const themeObserver = new MutationObserver(() => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    if (theme === lastTheme) return;
    lastTheme = theme;
    for (const listener of themeListeners) listener(theme);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  bridge.onThemeChanged = handler => {
    themeListeners.add(handler);
    return () => themeListeners.delete(handler);
  };
  bridge.getAutoSaveDefault = async () => (await officeSettings()).autoSaveDefault;
  const autoSaveListeners = new Set<Parameters<SlidesApi['onAutoSaveDefaultChanged']>[0]>();
  const offSettings = onOfficeSettingsChanged(settings => {
    for (const listener of autoSaveListeners) listener(settings.autoSaveDefault);
  });
  bridge.onAutoSaveDefaultChanged = handler => {
    autoSaveListeners.add(handler);
    return () => autoSaveListeners.delete(handler);
  };
  window.addEventListener('pagehide', () => {
    themeObserver.disconnect();
    offSettings();
    offLanguage();
    offNavigation();
    languageListeners.clear();
    themeListeners.clear();
    autoSaveListeners.clear();
  }, { once: true });
  bridge.getAiPanelPrefs = async () => ({ ...DEFAULT_AI_PANEL_PREFS, showAiSidebar: false });
  bridge.onAiPanelPrefsChanged = () => () => {};

  let lastSync: Parameters<SlidesApi['presenterSync']>[0] | null = null;
  const showListeners = new Map<string, Set<(data: unknown) => void>>();
  const onShow = <T,>(topic: string, handler: (data: T) => void) => {
    let listeners = showListeners.get(topic);
    if (!listeners) showListeners.set(topic, listeners = new Set());
    const listener = (data: unknown) => handler(data as T);
    listeners.add(listener);
    return () => { listeners?.delete(listener); };
  };
  let presenterReady = false;
  let presenterEpoch = 0;
  let presenterWork: Promise<unknown> = Promise.resolve();
  let reporting = false;
  const reportBridgeError = async (error: unknown) => {
    console.error('Slides operation failed:', error);
    if (reporting) return;
    reporting = true;
    try {
      const [{ t }, { tMain }] = await Promise.all([import('../../genoffice/apps/slides/src/renderer/i18n/locale'), import('../../genoffice/apps/slides/src/main/i18n-main')]);
      await chooseAction({ title: t('appUnknownError'), message: error instanceof Error ? error.message : String(error), actions: [{ value: 'ok', label: tMain(language, 'legacyPptOk') }] });
    } finally { reporting = false; }
  };
  const report = (error: unknown) => { void reportBridgeError(error).catch(console.error); };
  const send = (topic: string, data: unknown) => native.presentation.send({ topic, data: data as import('@matcha/app-plugins-sdk').AppJson });
  native.presentation.subscribe(event => {
    if (event.type === 'closed') {
      presenterReady = false;
      lastSync = null;
      if (!audience) void ipcRenderer.invoke('office:close-audience').catch(report);
      for (const listener of showListeners.get('nav') ?? []) listener('exit');
      return;
    }
    if (event.topic === 'ready') { if (presenterReady && lastSync) void send('sync', lastSync).catch(report); return; }
    if (event.topic === 'sync') lastSync = event.data as unknown as typeof lastSync;
    for (const listener of showListeners.get(event.topic) ?? []) listener(event.data);
  });
  bridge.setShowFullScreen = async on => {
    // Upstream fires this without a catch. Exiting a show asks for windowed mode
    // after the presentation view may already be gone, and the Host then rejects;
    // that request's outcome is already satisfied, so it must not surface as a
    // page error (it would tear the editor down) nor as a failed-operation dialog.
    try { await native.presentation.setFullscreen(on); }
    catch (error) { console.warn('Slides fullscreen request was not applied:', error); }
  };
  bridge.presenterStart = () => {
    const epoch = ++presenterEpoch;
    presenterReady = false;
    const start = presenterWork.then(async () => {
      if (epoch !== presenterEpoch) return { audience: false };
      const displays = await native.presentation.displays();
      const display = displays.find(display => !display.current);
      if (!display || epoch !== presenterEpoch) return { audience: false };
      const token = await ipcRenderer.invoke('office:share-audience') as string;
      if (epoch !== presenterEpoch) return { audience: false };
      await native.presentation.open({ content: { kind: 'application', applicationId: 'slides' }, displayId: display.id, fullscreen: true, data: { mode: 'audience', token } });
      if (epoch !== presenterEpoch) return { audience: false };
      presenterReady = true;
      if (lastSync) await send('sync', lastSync);
      return { audience: true };
    }).catch(error => { presenterReady = false; report(error); return { audience: false }; });
    presenterWork = start;
    return start;
  };
  bridge.presenterSync = state => { lastSync = state; if (presenterReady) void send('sync', state).catch(report); };
  bridge.presenterInk = ink => { if (presenterReady) void send('ink', ink).catch(report); };
  bridge.presenterSwap = () => native.presentation.swap();
  bridge.presenterEnd = () => {
    ++presenterEpoch;
    presenterReady = false;
    lastSync = null;
    const end = presenterWork.then(async () => {
      try { await native.presentation.close(); }
      finally { await ipcRenderer.invoke('office:close-audience'); }
    }).catch(report);
    presenterWork = end;
    return end;
  };
  bridge.audienceReady = async () => { try { await send('ready', null); } catch (error) { report(error); } return lastSync; };
  bridge.audienceNav = action => { void send('nav', action).catch(report); };
  bridge.onShowSync = handler => onShow('sync', handler);
  bridge.onShowInk = handler => onShow('ink', handler);
  bridge.onAudienceNav = handler => onShow('nav', handler);
  bridge.openExternal = async url => { try { await ipcRenderer.invoke('office:open-external', url); } catch (error) { report(error); } };
  bridge.privateFontData = async (id) => {
    const bytes = await ipcRenderer.invoke('slides:private-font-data', id) as number[] | null;
    return bytes ? Uint8Array.from(bytes).buffer : null;
  };
  bridge.getModel3dData = async (slideIndex, sourceId) => {
    const bytes = await ipcRenderer.invoke('slides:model3d-data', slideIndex, sourceId) as number[] | null;
    return bytes ? Uint8Array.from(bytes) : null;
  };
  if (audience?.mode === 'audience') return;
  let actionTail = Promise.resolve();
  const offAction = ipcRenderer.on('office:action', (_event, value) => {
    const request = value as { requestId: string; documentId: string; action: string; input: Record<string, unknown>; revision: number };
    actionTail = actionTail.then(() => new Promise<void>(finish => {
      const invokeEdit = (channel: string, input: unknown) => ipcRenderer.invoke('office:action-ipc', {
        requestId: request.requestId, documentId: request.documentId, channel, input
      });
      const edits: Pick<SlidesApi, 'applyEditScript' | 'insertImageUrl' | 'replacePictureUrl'> = {
        applyEditScript: input => invokeEdit('slides:apply-edit-script', input) as ReturnType<SlidesApi['applyEditScript']>,
        insertImageUrl: input => invokeEdit('ai:insert-image-url', input) as ReturnType<SlidesApi['insertImageUrl']>,
        replacePictureUrl: input => invokeEdit('ai:replace-picture-url', input) as ReturnType<SlidesApi['replacePictureUrl']>
      };
      const reply = (result?: unknown, error?: unknown) => {
        void ipcRenderer.invoke('office:action-result', { requestId: request.requestId, documentId: request.documentId,
          ...(error === undefined ? { result: { result, revision: request.revision } } : { error: String(error) }) })
          .catch(console.error).finally(finish);
      };
      window.dispatchEvent(new CustomEvent('office:slides-action', { detail: {
        ...request, edits, begin: () => ipcRenderer.invoke('office:action-begin', { requestId: request.requestId, documentId: request.documentId }),
        resolve: (result: unknown) => reply(result), reject: (error: unknown) => reply(undefined, error),
      } }));
    }));
  });
  window.addEventListener('pagehide', offAction, { once: true });
  const offWidths = ipcRenderer.on('office:measure-widths', (_event, value) => {
    const request = value as {
      requestId: string;
      items: { key: string; family: string; text: string; bold: boolean; italic: boolean }[];
      fonts: { family: string; bold: boolean; italic: boolean; data: string | null }[];
    };
    void (async () => {
      const privateFamilies = new Set(request.fonts.map(font => font.family));
      for (const font of request.fonts) {
        if (!font.data) continue;
        const weight = font.bold ? '700' : '400';
        const style = font.italic ? 'italic' : 'normal';
        let registered = false;
        document.fonts.forEach(face => { if (face.family === font.family && face.weight === weight && face.style === style) registered = true; });
        if (registered) continue;
        try {
          const face = new FontFace(font.family, base64ToBytes(font.data).buffer as ArrayBuffer, { weight, style });
          await face.load();
          document.fonts.add(face);
        } catch { /* Missing faces remain pending in the native metrics cache. */ }
      }
      const registered = new Set<string>();
      document.fonts.forEach(face => registered.add(face.family));
      const canvas = document.createElement('canvas').getContext('2d');
      if (!canvas) throw new Error(uiText('canvas'));
      const displayFamily = (window as unknown as { __genofficeDisplayFontFamily?: (family: string) => string }).__genofficeDisplayFontFamily;
      const widths: Record<string, number | null> = {};
      for (const item of request.items) {
        if (privateFamilies.has(item.family) && !registered.has(item.family)) { widths[item.key] = null; continue; }
        const stack = displayFamily?.(item.family) ?? `${JSON.stringify(item.family)}, 'PingFang SC', 'Microsoft YaHei', 'Yu Gothic', 'Malgun Gothic', sans-serif`;
        const font = `${item.italic ? 'italic ' : ''}${item.bold ? 'bold ' : ''}100px ${stack}`;
        await document.fonts.load(font, item.text);
        canvas.font = font;
        widths[item.key] = canvas.measureText(item.text).width;
      }
      await ipcRenderer.invoke('office:widths-reply', request.requestId, widths);
    })().catch(error => {
      console.error('Slides text measurement failed:', error);
      void ipcRenderer.invoke('office:widths-reply', request.requestId, {}).catch(console.error);
    });
  });
  window.addEventListener('pagehide', offWidths, { once: true });

  async function clipboardCall<T>(channel: string, ...args: unknown[]): Promise<T> {
    const reply = await ipcRenderer.invoke(channel, ...args) as T | { result: T; clipboard: AppClipboardWriteRequest; copyToken?: string };
    if (reply && typeof reply === 'object' && 'clipboard' in reply) {
      try {
        await native.writeClipboard(reply.clipboard);
        if (reply.copyToken && !await ipcRenderer.invoke('slides:finish-copy', reply.copyToken, await native.readClipboard())) throw new Error('The clipboard changed before the copy completed.');
        return reply.result;
      } catch (error) {
        if (reply.copyToken) await ipcRenderer.invoke('slides:finish-copy', reply.copyToken, null);
        throw error;
      }
    }
    return reply as T;
  }
  bridge.nativeClipboard = async operation => { try { await textClipboard(native, operation); } catch (error) { report(error); } };
  bridge.copySlides = async op => { try { return await clipboardCall<boolean>('slides:copy-slides', op); } catch (error) { report(error); return false; } };
  bridge.copyElements = async op => { try { return await clipboardCall<number>('slides:copy-elements', op); } catch (error) { report(error); return 0; } };
  bridge.copyElementsImage = async (token, png) => clipboardCall<boolean>('slides:copy-elements-image', token, png, await native.readClipboard());
  bridge.clipboardExternal = async () => ipcRenderer.invoke('slides:clipboard-external', await native.readClipboard()) as ReturnType<SlidesApi['clipboardExternal']>;
  // Availability is unknown without a user gesture; copy/paste reads the real clipboard.
  bridge.clipboardProbe = async () => null;

  let recoveryDialog: AbortController | undefined;
  const offRecovery = ipcRenderer.on('office:recovery-prompt', () => {
    const controller = new AbortController();
    recoveryDialog = controller;
    void (async () => {
      const { tMain } = await import('../../genoffice/apps/slides/src/main/i18n-main');
      return chooseAction({ title: tMain(language, 'autosaveFoundTitle'), message: tMain(language, 'autosaveFoundBody'), actions: [
        { value: 'restore', label: tMain(language, 'autosaveRestore') },
        { value: 'discard', label: tMain(language, 'autosaveDiscard') }
      ] }, controller.signal);
    })().then(choice => ipcRenderer.invoke('office:recovery-reply', choice), error => {
      report(error);
      return ipcRenderer.invoke('office:recovery-reply', null);
    }).catch(report).finally(() => { if (recoveryDialog === controller) recoveryDialog = undefined; });
  });
  window.addEventListener('pagehide', () => { recoveryDialog?.abort(); offRecovery(); }, { once: true });
  let activeDocument: { path: string; name: string } | undefined;
  const renamedListeners = new Set<Parameters<SlidesApi['onRenamed']>[0]>();
  bridge.onRenamed = handler => { renamedListeners.add(handler); return () => renamedListeners.delete(handler); };
  const offDocumentChanged = native.subscribe(event => {
    if (event.topic !== 'document.changed') return;
    const data = event.data as { documentId?: string; name?: string };
    if (!activeDocument || data.documentId !== activeDocument.path || typeof data.name !== 'string' || data.name === activeDocument.name) return;
    activeDocument = { path: activeDocument.path, name: data.name };
    for (const listener of renamedListeners) listener(activeDocument);
  });
  const adoptIdentity = <T extends { path?: string; name?: string } | null>(result: T): T => {
    if (result?.path && result.name) activeDocument = { path: result.path, name: result.name };
    return result;
  };
  const nativeSave = bridge.save;
  bridge.save = async () => adoptIdentity(await nativeSave());
  const close = createSlidesClose(bridge, () => recoveryDialog?.abort());
  bridge.saveAs = async (defaultName) => {
    const name = await chooseDocumentName(defaultName);
    if (name === null) return { ok: false };
    return adoptIdentity(await close.save(() => ipcRenderer.invoke('slides:save-as', name) as ReturnType<typeof bridge.save>));
  };
  const openedListeners = new Set<Parameters<SlidesApi['onOpened']>[0]>();
  const nativeOnOpened = bridge.onOpened;
  bridge.onOpened = handler => {
    openedListeners.add(handler);
    const off = nativeOnOpened(handler);
    return () => { openedListeners.delete(handler); off(); };
  };
  const notifyOpened = (result: OpenResult | null) => { if (result) for (const listener of openedListeners) listener(result); };
  let bootReady = false;
  const importDeck = async (file: File): Promise<OpenResult | null> => {
    if (/\.(ppt|odp|otp)$/i.test(file.name)) {
      const labels = importLabels[language as keyof typeof importLabels] ?? importLabels.en;
      if (await chooseAction({ title: labels.title, message: labels.message, actions: [{ value: 'import', label: labels.action }] }) !== 'import') return null;
    }
    const imported = await importDocument(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
    return adoptIdentity(await openLibraryDeck(imported.id));
  };
  bridge.openPptx = async () => {
    const chosen = await chooseDocument(await listDocuments('pptx'), 'pptx');
    if (!chosen) return null;
    return close.open(async () => {
      if (chosen !== 'import') return adoptIdentity(await openLibraryDeck(chosen.id));
      const [file] = await pickFiles('.pptx,.ppt,.odp,.otp');
      return file ? importDeck(file) : null;
    });
  };
  bridge.openPptxPath = documentId => close.open(async () => adoptIdentity(await openLibraryDeck(documentId)));
  let initialData = native.context.data;
  bridge.consumePendingOpen = async () => {
    const data = initialData;
    initialData = undefined;
    const documentId = (data as { documentId?: unknown } | undefined)?.documentId;
    if (documentId === undefined) return null;
    if (typeof documentId !== 'string') throw new Error(uiText('documentId'));
    return bridge.openPptxPath(documentId, 1280);
  };
  navigate = value => {
    if (!bootReady) { queuedNavigation.push(value); return; }
    const data = (value as { data?: { documentId?: unknown } } | undefined)?.data;
    if (typeof data?.documentId !== 'string') { report(new Error(uiText('documentId'))); return; }
    void bridge.openPptxPath(data.documentId, 1280).then(notifyOpened).catch(report);
  };
  const completeBoot = () => {
    bootReady = true;
    for (const data of queuedNavigation.splice(0)) navigate?.(data);
  };
  const consumePendingOpen = bridge.consumePendingOpen;
  bridge.consumePendingOpen = async width => {
    const result = await consumePendingOpen(width);
    if (result) completeBoot();
    return result;
  };
  const dropDeck = (event: DragEvent) => {
    const files = [...event.dataTransfer?.files ?? []].filter(file => /\.(pptx|ppt|odp|otp)$/i.test(file.name));
    if (!files.length) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void (async () => {
      for (const file of files.slice(0, 20)) {
        const result = await close.open(() => importDeck(file));
        if (!result) break;
        notifyOpened(result);
      }
    })().catch(report);
  };
  window.addEventListener('drop', dropDeck, true);
  window.addEventListener('pagehide', () => { offDocumentChanged(); window.removeEventListener('drop', dropDeck, true); }, { once: true });
  bridge.newBlank = async (fitWidthPx, size) => {
    const result = await close.open(() => ipcRenderer.invoke('office:new-blank', fitWidthPx, size)) as Awaited<ReturnType<SlidesApi['newBlank']>>;
    if (result) { adoptIdentity(result); completeBoot(); }
    return result;
  };
  bridge.getRecentFiles = async () => [];

  bridge.fontInstallLocal = async () => {
    const files = await pickFiles('.ttf,.otf,.ttc,.otc', true);
    if (!files.length) return { families: [] };
    return ipcRenderer.invoke('office:install-font-bytes', await Promise.all(files.map(async file => ({ name: file.name, base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())) })))) as ReturnType<SlidesApi['fontInstallLocal']>;
  };
  bridge.editChart = async (op) => {
    const result = await ipcRenderer.invoke('slides:edit-chart', op) as Awaited<ReturnType<SlidesApi['editChart']>> | { warning: 'chart-edit-lossy' };
    if (!result || !('warning' in result)) return result;
    const { tMain } = await import('../../genoffice/apps/slides/src/main/i18n-main');
    if (await chooseAction({ title: tMain(language, 'chartSimplifyTitle'), message: tMain(language, 'chartSimplifyBody'), actions: [{ value: 'continue', label: tMain(language, 'chartSimplifyOk') }] }) !== 'continue') return null;
    return ipcRenderer.invoke('slides:edit-chart', { ...op, confirmedLossy: true }) as ReturnType<SlidesApi['editChart']>;
  };
  bridge.pickPictureFile = async () => {
    const picture = await pictureFile();
    return picture ? { base64: picture.base64, ext: picture.ext } : null;
  };
  bridge.insertImage = async (slideIndex, fitWidthPx) => {
    const picture = await pictureFile();
    if (!picture) return null;
    let naturalPx: { width: number; height: number } | null = null;
    try {
      const bitmap = await createImageBitmap(picture.file);
      naturalPx = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
    } catch { /* TIFF dimensions are decoded by the engine, retaining the original bytes. */ }
    return ipcRenderer.invoke('office:insert-image-bytes', {
      slideIndex, fitWidthPx, base64: picture.base64, ext: picture.ext, naturalPx, name: picture.file.name
    }) as ReturnType<SlidesApi['insertImage']>;
  };
  const addMediaBytes = bridge.addMediaBytes;
  bridge.addMediaBytes = async op => {
    const result = await addMediaBytes(op);
    if (result?.warning) {
      const { tMain } = await import('../../genoffice/apps/slides/src/main/i18n-main');
      await chooseAction({ title: tMain(language, 'mediaUnsupportedTitle'), message: result.warning, actions: [{ value: 'ok', label: tMain(language, 'legacyPptOk') }] });
    }
    return result;
  };
  bridge.insertMedia = async (slideIndex, kind, fitWidthPx) => {
    const [file] = await pickFiles(kind === 'video' ? '.mp4,.m4v,.mov,.webm,.avi' : '.mp3,.wav,.m4a,.aac,.ogg');
    if (!file) return null;
    const ext = file.name.split('.').pop()!.toLowerCase();
    const posterBase64 = kind === 'video' ? await videoPosterBase64(file, ext) : undefined;
    return bridge.addMediaBytes({ slideIndex, kind, fitWidthPx, ext, name: file.name, base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())), ...(posterBase64 ? { posterBase64 } : {}) });
  };
  bridge.pickModel3d = async () => {
    const [file] = await pickFiles('.glb');
    return file ? { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
  };
  bridge.addModel3d = (op) => ipcRenderer.invoke('slides:add-model3d', { ...op, bytes: Array.from(op.bytes) }) as ReturnType<SlidesApi['addModel3d']>;
  bridge.pickExportDir = async () => 'download';
  bridge.exportImages = async (op) => {
    const format = op.format === 'jpg' ? 'jpg' : 'png';
    const pad = op.pngsBase64.length >= 100 ? 3 : 2;
    const files = op.pngsBase64.map((base64, index) => ({
      name: `${op.baseName}-${String(index + 1).padStart(pad, '0')}.${format}`, bytes: base64ToBytes(base64)
    }));
    if (files.length === 1) {
      const result = downloadFile(files[0]!.name, files[0]!.bytes, format === 'jpg' ? 'image/jpeg' : 'image/png');
      return { ok: true, paths: [result.path] };
    }
    const zip = new JSZip();
    for (const file of files) zip.file(file.name, file.bytes);
    const result = downloadFile(`${op.baseName}.zip`, await zip.generateAsync({ type: 'uint8array' }), 'application/zip');
    return { ok: true, paths: [result.path] };
  };
  bridge.savePicture = async (op) => downloadFile(`${op.defaultName.replace(/\.png$/i, '')}.png`, base64ToBytes(op.pngBase64), 'image/png');
  bridge.pickExportPdfPath = async (defaultName) => defaultName;
  bridge.exportPdf = async (op) => {
    try {
      const width = exportPageWidthIn(op.widthPx, op.heightPx);
      const height = PDF_EXPORT_HEIGHT_IN;
      const result = await native.renderPdf({
        html: buildPdfExportHtml(op.pages, width, height, op.links, op.fontCss),
        options: { landscape: false, printBackground: true, pageSize: { width, height }, margins: { top: 0, bottom: 0, left: 0, right: 0 }, preferCSSPageSize: false }
      });
      return downloadFile(op.filePath, base64ToBytes(result.data), result.mimeType);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const editImageFill = bridge.editImageFill;
  bridge.editImageFill = async (op) => {
    if (op.source) return editImageFill(op);
    const picture = await pictureFile();
    return picture ? editImageFill({ ...op, source: { base64: picture.base64, ext: picture.ext } }) : null;
  };
  const editBackground = bridge.editBackground;
  bridge.editBackground = async (op) => {
    if (op.kind !== 'image' || op.pick === false) return editBackground(op);
    const picture = await pictureFile();
    return picture ? ipcRenderer.invoke('slides:edit-background', { ...op, source: { base64: picture.base64, ext: picture.ext } }) as ReturnType<SlidesApi['editBackground']> : null;
  };
}
