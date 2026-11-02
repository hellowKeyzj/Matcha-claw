import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { dialog, shell, type BrowserWindow, type WebContents } from 'electron';

import type {
  IabBounds, IabDownload, IabHistoryEntry, IabOverlayCommand, IabOverlayInput, IabOverlayState,
  IabOwnerId, IabScreenshotResult, IabTabId, IabTheme, IabToolAnchor, IabUiCommand, IabUiResult,
} from '../../../src/types/desktop/iab';
import type { IabPageToolsOptions, IabUnsubscribe } from './contracts';
import { iabActionError, IabOverlay } from './overlay';
import { iabBoundsToDip } from './geometry';

const ZOOM_LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const LABELS = {
  en: { screenshot: 'Save screenshot', cacheCleared: 'Shared browser cache cleared', siteDataCleared: 'Shared cookies and site storage cleared', failed: 'Action failed. Try again.'},
  zh: { screenshot: '保存截图', cacheCleared: '已清除共享浏览器缓存', siteDataCleared: '已清除共享 Cookie 和网站存储', failed: '操作失败，请重试。' },
  ja: { screenshot: 'スクリーンショットを保存', cacheCleared: '共有ブラウザーキャッシュを消去しました', siteDataCleared: '共有 Cookie とサイトデータを消去しました', failed: '操作に失敗しました。もう一度お試しください。' },
  ru: { screenshot: 'Сохранить снимок экрана', cacheCleared: 'Общий кеш браузера очищен', siteDataCleared: 'Общие cookie и данные сайтов очищены', failed: 'Не удалось выполнить действие. Повторите попытку.' },
};

type FindState = { requestId: number; searchId: number; text: string };
type ClearRequest = { token: string; ownerId: IabOwnerId; tabId: IabTabId; contents: WebContents; window: BrowserWindow;
  data: 'cache' | 'site-storage'; bounds: IabBounds | null; running?: boolean };

function validateBounds(bounds: IabBounds): void {
  if (!bounds || !['x', 'y', 'width', 'height'].every((key) => Number.isFinite(bounds[key as keyof IabBounds])) ||
    bounds.width < 0 || bounds.height < 0) throw new Error('Invalid browser tools anchor');
}

export class IabPageTools {
  private readonly overlay: IabOverlay;
  private readonly searches = new WeakMap<WebContents, FindState>();
  private readonly attachments = new Map<WebContents, IabUnsubscribe>();
  private readonly subscriptions: IabUnsubscribe[];
  private theme: IabTheme = 'light';
  private locale = 'en';
  private presentationGeneration = 0;
  private presentation?: { tabId: IabTabId; kind: NonNullable<IabOverlayState>['kind']; anchor: IabBounds | IabToolAnchor };
  private suggestionQuery?: { tabId: IabTabId; query: string };
  private clearRequest?: ClearRequest;
  private downloadsTimer?: ReturnType<typeof setTimeout>;
  private downloadsWindow?: BrowserWindow;
  private downloadsSession?: number;
  private downloadsRefresh?: Promise<void>;
  private refreshAgain = false;
  private refreshFiles = false;
  private disposed = false;

  constructor(private readonly options: IabPageToolsOptions & { isPresentedTab(tabId: IabTabId): boolean }) {
    this.overlay = new IabOverlay({ window: options.window, emit: (event) => {
      if (event.type === 'overlay-state') {
        if (!event.state) this.cancelPresentation();
        if (event.state?.kind !== 'downloads' || event.state.sessionId !== this.downloadsSession) this.releaseDownloads();
      }
      options.emit(event);
    }, onCommand: (command, state) => this.overlayCommand(command, state) });
    this.subscriptions = [options.data.downloads.subscribe(() => {
      if (this.overlay.state?.kind === 'downloads') this.refreshDownloads(false);
    })];
  }

  attach(tabId: IabTabId, contents: WebContents): IabUnsubscribe {
    const existing = this.attachments.get(contents);
    if (existing) return existing;
    const onInput = (event: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown' || input.isComposing || input.alt || !(input.control || input.meta) ||
        input.key.toLowerCase() !== 'f' || this.options.getWebContents(tabId) !== contents) return;
      const ownerId = this.options.getOwner(tabId);
      if (!ownerId) return;
      event.preventDefault();
      this.options.emit({ type: 'find-requested', ownerId, tabId });
    };
    const onFound = (_event: Electron.Event, result: Electron.Result): void => {
      const search = this.searches.get(contents);
      const ownerId = this.options.getOwner(tabId);
      if (!search || !ownerId || search.requestId !== result.requestId || this.options.getWebContents(tabId) !== contents) return;
      this.options.emit({ type: 'find-result', result: { ownerId, tabId, searchId: search.searchId,
        requestId: result.requestId, matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal, finalUpdate: result.finalUpdate } });
    };
    const onNavigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
      if (!mainFrame || inPlace) return;
      this.closeMenu(tabId);
      const search = this.searches.get(contents);
      this.searches.delete(contents);
      const ownerId = this.options.getOwner(tabId);
      if (search && ownerId) this.options.emit({ type: 'find-result', result: { ownerId, tabId,
        searchId: search.searchId, requestId: search.requestId, matches: 0, activeMatchOrdinal: 0, finalUpdate: true } });
    };
    const onFocus = (): void => { if (this.overlay.state?.tabId === tabId) this.hideSuggestions(); };
    const release = (): void => {
      contents.removeListener('before-input-event', onInput);
      contents.removeListener('found-in-page', onFound);
      contents.removeListener('did-start-navigation', onNavigation);
      contents.removeListener('focus', onFocus);
      contents.removeListener('destroyed', release);
      this.searches.delete(contents);
      this.attachments.delete(contents);
      this.closeMenu(tabId);
      if (this.clearRequest?.contents === contents) this.clearRequest = undefined;
    };
    contents.on('before-input-event', onInput);
    contents.on('found-in-page', onFound);
    contents.on('did-start-navigation', onNavigation);
    contents.on('focus', onFocus);
    contents.once('destroyed', release);
    this.attachments.set(contents, release);
    return release;
  }

  find(tabId: IabTabId, text: string, searchId: number, forward = true): number | null {
    const contents = this.requireContents(tabId);
    if (typeof text !== 'string' || text.length > 1_000 || !Number.isSafeInteger(searchId) || typeof forward !== 'boolean') throw new Error('Invalid browser page search');
    if (!text) { this.stopFind(tabId); return null; }
    const previous = this.searches.get(contents);
    const requestId = contents.findInPage(text, { forward, findNext: previous?.text !== text });
    this.searches.set(contents, { requestId, searchId, text });
    return requestId;
  }

  stopFind(tabId: IabTabId, mode: 'clearSelection' | 'keepSelection' | 'activateSelection' = 'clearSelection'): void {
    if (!['clearSelection', 'keepSelection', 'activateSelection'].includes(mode)) throw new Error('Invalid browser find stop mode');
    const contents = this.options.getWebContents(tabId);
    if (!contents || contents.isDestroyed() || !this.searches.has(contents)) return;
    this.searches.delete(contents);
    contents.stopFindInPage(mode);
  }

  setPresentation(theme: IabTheme, locale: string): void {
    if (!['light', 'dark'].includes(theme) || typeof locale !== 'string' || locale.length > 64) throw new Error('Invalid browser presentation');
    Intl.getCanonicalLocales(locale);
    this.theme = theme;
    this.locale = locale;
    const state = this.overlay.state;
    if (state) this.overlay.update({ ...state, theme, locale }, state.sessionId);
  }

  async execute(command: IabUiCommand, ownerId: IabOwnerId): Promise<IabUiResult> {
    if (this.disposed) throw new Error('Browser page tools were released');
    if ('tabId' in command) this.requireContents(command.tabId, ownerId);
    const { history, downloads } = this.options.data;
    switch (command.action) {
      case 'find': return { resultType: 'find', requestId: this.find(command.tabId, command.text, command.searchId, command.forward) };
      case 'stop-find': this.stopFind(command.tabId, command.mode); break;
      case 'set-zoom': {
        if (!Number.isFinite(command.zoomFactor) || !ZOOM_LEVELS.includes(command.zoomFactor)) throw new Error('Invalid browser zoom level');
        this.requireContents(command.tabId).setZoomFactor(command.zoomFactor);
        break;
      }
      case 'history-query': return { resultType: 'history', page: await history.query(command.query) };
      case 'history-remove': await history.remove(command.ids); break;
      case 'history-remove-origin': await history.removeOrigin(command.url); break;
      case 'history-suggest': return { resultType: 'suggestions', entries: await this.suggest(command) };
      case 'hide-suggestions': this.hideSuggestions(); break;
      case 'downloads-list': return { resultType: 'downloads', entries: await downloads.list(command.refreshFileState) };
      case 'downloads-clear': await downloads.clear(); break;
      case 'download': await downloads.control(command.command); break;
      case 'open-internal': this.closeMenu(); this.options.openInternal(command.page); break;
      case 'show-menu': await this.showMenu(command.tabId, command.anchor); break;
      case 'show-downloads': await this.showDownloads(command.tabId, command.anchor); break;
      case 'overlay': {
        if (this.overlay.state?.ownerId !== ownerId) throw new Error('Browser overlay owner changed');
        await this.overlay.execute(command.command);
        break;
      }
      case 'clear-data': await this.clearData(command, ownerId); break;
      case 'screenshot-save': return { resultType: 'screenshot', result: await this.saveScreenshot(command.tabId) };
      default: throw new Error('Unsupported browser page tools command');
    }
    return { resultType: 'complete' };
  }

  private context(tabId: IabTabId, anchor: IabBounds | IabToolAnchor): Omit<NonNullable<IabOverlayState>, 'sessionId' | 'kind'> {
    const ownerId = this.options.getOwner(tabId);
    const window = this.options.window();
    if (!ownerId || !window || window.isDestroyed()) throw new Error('Browser tab owner is unavailable');
    const zoomFactor = window.webContents.getZoomFactor();
    const nativeAnchor = { ...anchor, ...iabBoundsToDip(anchor, zoomFactor) };
    if ('browserBounds' in anchor && anchor.browserBounds) {
      validateBounds(anchor.browserBounds);
      (nativeAnchor as IabToolAnchor).browserBounds = iabBoundsToDip(anchor.browserBounds, zoomFactor);
    }
    return { ownerId, tabId, anchor: nativeAnchor, theme: this.theme, locale: this.locale };
  }

  private beginPresentation(tabId: IabTabId, kind: NonNullable<IabOverlayState>['kind'], anchor: IabBounds | IabToolAnchor): number {
    if (kind !== 'suggestions' || this.overlay.state?.kind !== 'suggestions') this.closeMenu();
    this.presentation = { tabId, kind, anchor };
    return ++this.presentationGeneration;
  }

  private isPresentationCurrent(generation: number, tabId: IabTabId): boolean {
    return !this.disposed && generation === this.presentationGeneration && this.options.isPresentedTab(tabId);
  }

  private async showPresentation(input: IabOverlayInput, generation: number): Promise<number | undefined> {
    if (!this.isPresentationCurrent(generation, input.tabId)) return;
    const sessionId = await this.overlay.show(input);
    if (this.isPresentationCurrent(generation, input.tabId) && this.overlay.state?.sessionId === sessionId) return sessionId;
  }

  private async showMenu(tabId: IabTabId, anchor: IabToolAnchor): Promise<void> {
    validateBounds(anchor);
    const contents = this.requireContents(tabId);
    const isWebsite = /^https?:\/\//i.test(contents.getURL());
    const generation = this.beginPresentation(tabId, 'menu', anchor);
    await this.showPresentation({ ...this.context(tabId, anchor), kind: 'menu', zoomFactor: contents.getZoomFactor(),
      canOpenExternal: isWebsite, canCapturePage: isWebsite, findShortcut: process.platform === 'darwin' ? '⌘ F' : 'Ctrl F' }, generation);
  }

  private async showDownloads(tabId: IabTabId, anchor: IabToolAnchor): Promise<void> {
    validateBounds(anchor);
    const contents = this.requireContents(tabId);
    const generation = this.beginPresentation(tabId, 'downloads', anchor);
    const entries = await this.options.data.downloads.list(true);
    if (!this.isPresentationCurrent(generation, tabId) || this.options.getWebContents(tabId) !== contents) return;
    const sessionId = await this.showPresentation({ ...this.context(tabId, anchor), kind: 'downloads', entries }, generation);
    if (sessionId !== undefined) {
      this.releaseDownloads();
      this.downloadsSession = sessionId;
      this.downloadsWindow = this.options.window() ?? undefined;
      this.downloadsWindow?.on('focus', this.onDownloadsFocus);
      this.scheduleDownloadsRefresh();
    }
  }

  private releaseDownloads(): void {
    clearTimeout(this.downloadsTimer);
    this.downloadsWindow?.removeListener('focus', this.onDownloadsFocus);
    this.downloadsWindow = undefined;
    this.downloadsSession = undefined;
    this.refreshAgain = false;
    this.refreshFiles = false;
  }

  private readonly onDownloadsFocus = (): void => {
    if (this.overlay.state?.sessionId === this.downloadsSession) void this.refreshDownloads(true);
  };

  private refreshDownloads(checkFiles: boolean): Promise<void> {
    clearTimeout(this.downloadsTimer);
    this.refreshFiles ||= checkFiles;
    if (this.downloadsRefresh) { this.refreshAgain = true; return this.downloadsRefresh; }
    this.downloadsRefresh = Promise.resolve().then(async () => {
      do {
        this.refreshAgain = false;
        const state = this.overlay.state;
        const generation = this.presentationGeneration;
        if (state?.kind !== 'downloads' || !this.isPresentationCurrent(generation, state.tabId)) return;
        const refreshFiles = this.refreshFiles;
        this.refreshFiles = false;
        try {
          this.requireContents(state.tabId, state.ownerId);
          const entries = await this.options.data.downloads.list(refreshFiles);
          const current = this.overlay.state;
          if (this.refreshAgain || !this.isPresentationCurrent(generation, state.tabId) || current?.kind !== 'downloads' || current.sessionId !== state.sessionId) continue;
          if (!isDeepStrictEqual(current.entries, entries) || current.error !== undefined) {
            this.overlay.update({ ...current, entries, error: undefined }, state.sessionId);
          }
        } catch (error) {
          const current = this.overlay.state;
          const message = this.errorMessage(error);
          if (this.isPresentationCurrent(generation, state.tabId) && current?.kind === 'downloads' && current.sessionId === state.sessionId && current.error !== message) {
            this.overlay.update({ ...current, error: message }, state.sessionId);
          }
        }
      } while (this.refreshAgain);
    }).finally(() => { this.downloadsRefresh = undefined; this.scheduleDownloadsRefresh(); });
    return this.downloadsRefresh;
  }

  private scheduleDownloadsRefresh(): void {
    clearTimeout(this.downloadsTimer);
    const state = this.overlay.state;
    if (state?.kind !== 'downloads' || state.sessionId !== this.downloadsSession || !state.entries.some((entry) => entry.status === 'progressing')) return;
    this.downloadsTimer = setTimeout(() => { void this.refreshDownloads(false); }, 1_000);
    this.downloadsTimer.unref();
  }

  async notifyDownload(tabId: IabTabId, download: IabDownload): Promise<void> {
    if (this.disposed || (this.presentation && !['toast', 'download'].includes(this.presentation.kind))) return;
    const bounds = this.options.getBrowserBounds();
    if (!bounds || !this.options.isPresentedTab(tabId) || !this.options.getWebContents(tabId)) return;
    const generation = this.beginPresentation(tabId, 'download', bounds);
    await this.showPresentation({ ...this.context(tabId, bounds), kind: 'download', download }, generation);
  }

  private async suggest(command: Extract<IabUiCommand, { action: 'history-suggest' }>): Promise<IabHistoryEntry[]> {
    validateBounds(command.anchor);
    if (typeof command.query !== 'string' || command.query.length > 8_192 || !Number.isSafeInteger(command.selectedIndex) ||
      command.selectedIndex < -1 || command.selectedIndex > 7) throw new Error('Invalid browser history suggestions');
    if (this.presentation && !['suggestions', 'toast'].includes(this.presentation.kind)) return [];
    const contents = this.requireContents(command.tabId);
    const generation = this.beginPresentation(command.tabId, 'suggestions', command.anchor);
    const entries = await this.options.data.history.suggest(command.query, 8);
    if (!this.isPresentationCurrent(generation, command.tabId) || this.options.getWebContents(command.tabId) !== contents) return [];
    this.suggestionQuery = { tabId: command.tabId, query: command.query };
    if (!entries.length) { this.hideSuggestions(); return []; }
    const sessionId = await this.showPresentation({ ...this.context(command.tabId, command.anchor), kind: 'suggestions', entries, selectedIndex: command.selectedIndex }, generation);
    return sessionId === undefined ? [] : entries;
  }

  private async overlayCommand(command: IabOverlayCommand, state: NonNullable<IabOverlayState>): Promise<void> {
    const logicalAnchor = this.presentation?.anchor;
    const contents = this.requireContents(state.tabId, state.ownerId);
    if (command.action === 'refresh-downloads') { await this.refreshDownloads(true); return; }
    if (command.action === 'download') {
      await this.options.data.downloads.control(command.command);
      if (state.kind === 'downloads') await this.refreshDownloads(false);
      return;
    }
    if (command.action === 'select-suggestion' || command.action === 'remove-suggestion') {
      if (state.kind !== 'suggestions') throw new Error('History suggestions are unavailable');
      const entry = state.entries.find((item) => item.id === command.id)!;
      const parent = this.options.window();
      if (parent && !parent.isDestroyed()) parent.webContents.focus();
      if (command.action === 'select-suggestion') {
        this.hideSuggestions();
        this.options.emit({ type: 'suggestion-selected', ownerId: state.ownerId, tabId: state.tabId, entry });
      } else {
        const query = this.suggestionQuery?.query ?? '';
        this.options.emit({ type: 'suggestion-remove-started', ownerId: state.ownerId, tabId: state.tabId });
        await this.options.data.history.removeOrigin(entry.url);
        const entries = await this.options.data.history.suggest(query, 8);
        if (this.options.getWebContents(state.tabId) !== contents || this.overlay.state?.sessionId !== state.sessionId) return;
        if (!entries.length) this.hideSuggestions();
        else this.overlay.update({ ...state, entries, selectedIndex: -1 }, state.sessionId);
      }
      return;
    }
    if (command.action !== 'menu') return;
    const action = command.command;
    if (action.startsWith('zoom-')) {
      const current = contents.getZoomFactor();
      const zoomFactor = action === 'zoom-reset' ? 1 : action === 'zoom-in'
        ? ZOOM_LEVELS.find((level) => level > current + 0.001) ?? 5
        : [...ZOOM_LEVELS].reverse().find((level) => level < current - 0.001) ?? 0.25;
      contents.setZoomFactor(zoomFactor);
      if (state.kind === 'menu') this.overlay.update({ ...state, zoomFactor }, state.sessionId);
      return;
    }
    if (action === 'clear-cache' || action === 'clear-site-data') {
      const window = this.options.window();
      if (!window || window.isDestroyed()) throw new Error('Browser window is unavailable');
      const request: ClearRequest = { token: randomUUID(), ownerId: state.ownerId, tabId: state.tabId, contents, window,
        data: action === 'clear-cache' ? 'cache' : 'site-storage',
        bounds: (logicalAnchor as IabToolAnchor | undefined)?.browserBounds ?? this.options.getBrowserBounds() };
      this.clearRequest = request;
      this.closeMenu();
      this.options.emit({ type: 'clear-data-requested', ownerId: request.ownerId, tabId: request.tabId, token: request.token, data: request.data });
      return;
    }
    if (action === 'find') { this.closeMenu(); this.options.emit({ type: 'find-requested', ownerId: state.ownerId, tabId: state.tabId }); return; }
    if (action === 'history' || action === 'downloads') { this.closeMenu(); this.options.openInternal(action); return; }
    this.closeMenu();
    const generation = this.presentationGeneration;
    try {
      if (action === 'screenshot') await this.saveScreenshot(state.tabId);
      else if (action === 'open-external') {
        const url = new URL(contents.getURL());
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only websites can be opened externally');
        await shell.openExternal(url.href);
      }
    } catch (error) {
      if (logicalAnchor && !this.overlay.state && this.isPresentationCurrent(generation, state.tabId) && this.options.getWebContents(state.tabId) === contents && state.kind === 'menu') {
        const presentation = this.beginPresentation(state.tabId, 'menu', logicalAnchor);
        await this.showPresentation({ ...state, ...this.context(state.tabId, logicalAnchor), error: this.errorMessage(error) }, presentation);
      }
      throw error;
    }
  }

  private async clearData(command: Extract<IabUiCommand, { action: 'clear-data' }>, ownerId: IabOwnerId): Promise<void> {
    const request = this.clearRequest;
    const contents = this.requireContents(command.tabId, ownerId);
    if (!request || request.ownerId !== ownerId || request.tabId !== command.tabId || request.contents !== contents ||
      request.window.isDestroyed() || this.options.window() !== request.window || request.token !== command.token ||
      request.data !== command.data || request.running || command.confirmation?.scope !== 'shared-session' ||
      command.confirmation.confirmed !== true) throw new Error('Browser data confirmation is no longer available. Request confirmation again.');
    request.running = true;
    const generation = this.presentationGeneration;
    try {
      if (command.data === 'cache') await this.options.session.clearCache();
      else await this.options.data.cookies.clearSite();
      if (this.clearRequest === request) this.clearRequest = undefined;
    } finally { request.running = false; }
    if (this.isPresentationCurrent(generation, command.tabId) && !request.window.isDestroyed() && this.options.getWebContents(command.tabId) === contents) await this.notify(command.tabId,
      command.data === 'cache' ? this.labels.cacheCleared : this.labels.siteDataCleared, request.bounds);
  }

  private async saveScreenshot(tabId: IabTabId): Promise<IabScreenshotResult> {
    const contents = this.requireContents(tabId);
    const url = contents.getURL();
    if (!/^https?:\/\//i.test(url)) throw new Error('Only websites can be captured');
    let image: Electron.NativeImage;
    for (let attempt = 0; ; attempt++) {
      if (this.requireContents(tabId) !== contents || contents.getURL() !== url) throw new Error('Browser tab changed');
      try { image = await contents.capturePage(); break; }
      catch (error) {
        if (attempt >= 2 || contents.isDestroyed() || !/UnknownVizError|display surface not available/i.test(this.errorMessage(error))) throw error;
        await delay(50);
      }
    }
    if (image.isEmpty()) throw new Error('The browser screenshot is empty. Try again.');
    const parent = this.options.window();
    if (!parent || parent.isDestroyed() || this.requireContents(tabId) !== contents || contents.getURL() !== url) throw new Error('Browser tab changed');
    const result = await dialog.showSaveDialog(parent, { title: this.labels.screenshot,
      defaultPath: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`, filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (result.canceled || !result.filePath) return { resultType: 'cancelled' };
    if (parent.isDestroyed() || this.requireContents(tabId) !== contents || contents.getURL() !== url) throw new Error('Browser tab changed');
    await writeFile(result.filePath, image.toPNG());
    return { resultType: 'saved', filename: result.filePath.split(/[\\/]/).pop()! };
  }

  private async notify(tabId: IabTabId, message: string, bounds = this.options.getBrowserBounds()): Promise<void> {
    if ((this.presentation && this.presentation.kind !== 'toast') || !this.options.isPresentedTab(tabId)) return;
    if (bounds) {
      const generation = this.beginPresentation(tabId, 'toast', bounds);
      await this.showPresentation({ ...this.context(tabId, bounds), kind: 'toast', message }, generation);
    }
  }

  private get labels(): typeof LABELS.en {
    return LABELS[this.locale.split(/[-_]/)[0] as keyof typeof LABELS] ?? LABELS.en;
  }
  private errorMessage(error: unknown): string { return iabActionError(error); }
  private requireContents(tabId: IabTabId, ownerId?: IabOwnerId): WebContents {
    const contents = this.options.getWebContents(tabId);
    if (!contents || contents.isDestroyed()) throw new Error('Browser tab is no longer available');
    if (ownerId !== undefined && this.options.getOwner(tabId) !== ownerId) throw new Error('Browser tab owner changed');
    return contents;
  }

  private cancelPresentation(): void {
    this.presentationGeneration++;
    this.presentation = undefined;
    this.suggestionQuery = undefined;
  }

  closeMenu(tabId?: IabTabId): void {
    if (tabId !== undefined && this.presentation?.tabId !== tabId && this.overlay.state?.tabId !== tabId) return;
    if (this.overlay.state === null) this.cancelPresentation();
    this.overlay.dismiss();
  }
  hideSuggestions(): void {
    this.suggestionQuery = undefined;
    if (this.presentation?.kind === 'suggestions' || this.overlay.state?.kind === 'suggestions') this.closeMenu();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearRequest = undefined;
    this.releaseDownloads();
    for (const release of this.attachments.values()) release();
    for (const release of this.subscriptions) release();
    this.overlay.dispose();
  }
}
