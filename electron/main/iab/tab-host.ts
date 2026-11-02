import { WebContentsView, type WebContents } from 'electron';
import type { IabBounds, IabInternalPage } from '../../../src/types/desktop/iab';
import type { IabTabHandle, IabTabHost as TabHostContract, IabTabHostOptions } from './contracts';
import { bindIabNavigation, IAB_WEB_PREFERENCES, isIabUrl } from './navigation';
import { resolveIabUserAgentOverride } from './user-agent';

const OFFSCREEN = { x: -32000, y: 0, width: 1920, height: 1080 };

export class IabTabHost implements TabHostContract {
  private readonly tabs = new Map<string, IabTabHandle>();
  private readonly appliedBounds = new Map<string, IabBounds>();
  private readonly cleanup = new Map<string, () => void>();
  private active: string | null = null;
  private disposed = false;

  constructor(private readonly options: IabTabHostOptions) {}
  get session() { return this.options.session; }
  get size() { return this.tabs.size; }
  get activeTabId() { return this.active; }
  get(tabId: string) { return this.tabs.get(tabId); }
  has(tabId: string) { return this.tabs.has(tabId); }
  getWebContents(tabId: string): WebContents | null {
    const contents = this.tabs.get(tabId)?.view.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  createTab(tabId: string, url: string, options: { activate?: boolean; view?: WebContentsView; skipWarmup?: boolean } = {}): Promise<void> {
    if (this.disposed) throw new Error('IAB tab host is disposed');
    if (this.tabs.has(tabId)) throw new Error(`Duplicate IAB tab: ${tabId}`);
    if (!isIabUrl(url)) throw new Error('Invalid IAB navigation URL');
    const window = this.options.window();
    if (!window || window.isDestroyed()) throw new Error('IAB host window is unavailable');
    const view = options.view ?? new WebContentsView({ webPreferences: { ...IAB_WEB_PREFERENCES, session: this.session } });
    const contents = view.webContents;
    if (contents.isDestroyed() || contents.session !== this.session) throw new Error('IAB tab must use the shared session');
    const tab: IabTabHandle = {
      view, initialUrl: url, ready: Promise.resolve(), navigationRevision: 0,
      emptyPage: url === 'about:blank' && !options.skipWarmup,
    };
    this.tabs.set(tabId, tab);
    try {
      contents.setUserAgent(resolveIabUserAgentOverride().userAgent);
      const removeNavigation = bindIabNavigation(contents);
      const onNavigate = (_event: Electron.Event, url: string) => {
        if (this.tabs.get(tabId) !== tab) return;
        if (url === 'about:blank' && tab.returnToInternalPage) tab.internalPage = tab.returnToInternalPage;
        this.applyBounds();
      };
      const onStart = (_event: Electron.Event, url: string, _inPlace: boolean, mainFrame: boolean) => {
        if (!mainFrame || url === 'about:blank' || this.tabs.get(tabId) !== tab) return;
        if (tab.internalPage) tab.returnToInternalPage = tab.internalPage;
        tab.internalPage = undefined;
        tab.emptyPage = false;
        this.applyBounds();
      };
      const onInput = (event: Electron.Event, input: Electron.Input) => {
        if (input.type === 'keyDown' && input.key.toLowerCase() === 'p' && (input.control || input.meta)) event.preventDefault();
      };
      contents.on('did-navigate', onNavigate);
      contents.on('did-start-navigation', onStart);
      contents.on('before-input-event', onInput);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      this.cleanup.set(tabId, () => {
        removeNavigation();
        contents.removeListener('did-navigate', onNavigate);
        contents.removeListener('did-start-navigation', onStart);
        contents.removeListener('before-input-event', onInput);
        if (!contents.isDestroyed()) contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      });
      view.setBounds(OFFSCREEN);
      this.appliedBounds.set(tabId, { ...OFFSCREEN });
      window.contentView.addChildView(view);
      if (options.activate !== false) this.active = tabId;
      this.applyBounds();
      tab.ready = this.prepare(tabId, tab, options.skipWarmup === true);
      return options.skipWarmup ? tab.ready : this.initialNavigate(tabId, tab);
    } catch (error) {
      this.remove(tabId, tab, window);
      throw error;
    }
  }

  private current(tabId: string, tab: IabTabHandle): WebContents {
    const contents = !this.disposed && this.tabs.get(tabId) === tab ? this.getWebContents(tabId) : null;
    if (!contents) throw Object.assign(new Error(`IAB tab is closed: ${tabId}`), { code: 'IAB_TARGET_CLOSED' });
    return contents;
  }
  private async prepare(tabId: string, tab: IabTabHandle, skipWarmup: boolean): Promise<void> {
    try {
      await this.options.ready;
      let contents = this.current(tabId, tab);
      if (!skipWarmup) {
        await contents.loadURL('about:blank');
        contents = this.current(tabId, tab);
      }
      await this.options.prepareCdp(tabId, contents);
      this.current(tabId, tab);
    } catch (error) {
      if (this.tabs.get(tabId) === tab) this.remove(tabId, tab);
      throw error;
    }
  }
  private async initialNavigate(tabId: string, tab: IabTabHandle): Promise<void> {
    await tab.ready;
    const contents = this.current(tabId, tab);
    if (tab.navigationRevision === 0 && tab.initialUrl !== 'about:blank') {
      // Returning a tab ID/readiness is deliberately not a page-load completion receipt.
      void contents.loadURL(tab.initialUrl).catch((error: unknown) => {
        const code = (error as { code?: string }).code;
        if (code === 'ERR_ABORTED' || this.tabs.get(tabId) !== tab) return;
        if (code !== 'ERR_FAILED') this.options.onTabLoadFail?.(tabId);
      });
    }
  }

  navigate(tabId: string, url: string): void {
    if (!isIabUrl(url)) throw new Error('Invalid IAB navigation URL');
    const tab = this.tabs.get(tabId);
    if (!tab || !this.getWebContents(tabId)) return;
    if (url === 'about:blank') tab.returnToInternalPage = undefined;
    else if (tab.internalPage) tab.returnToInternalPage = tab.internalPage;
    tab.internalPage = undefined;
    tab.emptyPage = url === 'about:blank';
    tab.initialUrl = url;
    this.applyBounds();
    const revision = ++tab.navigationRevision;
    void tab.ready.then(() => {
      if (this.tabs.get(tabId) === tab && tab.navigationRevision === revision) return this.current(tabId, tab).loadURL(url);
    }).catch(() => { /* The native load event reports failures; closed/replaced navigations are inert. */ });
  }
  goBack(tabId: string): void {
    const contents = this.getWebContents(tabId);
    if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  }
  goForward(tabId: string): void {
    const contents = this.getWebContents(tabId);
    if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  }
  reload(tabId: string): void {
    const tab = this.tabs.get(tabId);
    const contents = this.getWebContents(tabId);
    if (!tab || !contents) return;
    if (contents.getURL() && contents.getURL() !== 'about:blank' || tab.initialUrl === 'about:blank') contents.reload();
    else this.navigate(tabId, tab.initialUrl);
  }
  listTabs(): { tabId: string; url: string; title: string }[] {
    return [...this.tabs].flatMap(([tabId, tab]) => {
      const contents = this.getWebContents(tabId);
      return contents ? [{ tabId, url: contents.getURL() || tab.initialUrl, title: contents.getTitle() }] : [];
    });
  }
  activateTab(tabId: string, options: { focusWindow?: boolean } = {}): void {
    if (!this.tabs.has(tabId)) return;
    this.active = tabId;
    this.applyBounds();
    if (options.focusWindow) {
      const window = this.options.window();
      if (window && !window.isDestroyed()) { window.show(); window.focus(); }
    }
  }
  deactivateAll(): void { this.active = null; this.applyBounds(); }
  showInternalPage(tabId: string, page: IabInternalPage): void {
    const tab = this.tabs.get(tabId);
    if (tab) { tab.internalPage = page; this.applyBounds(); }
  }
  applyBounds(): void {
    const bounds = this.options.getBounds();
    for (const [tabId, tab] of this.tabs) {
      const contents = this.getWebContents(tabId);
      if (!contents) continue;
      const blank = tab.emptyPage && (!contents.getURL() || contents.getURL() === 'about:blank');
      const next = tabId === this.active && !tab.internalPage && !blank ? bounds : OFFSCREEN;
      const previous = this.appliedBounds.get(tabId);
      if (previous && previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height) continue;
      tab.view.setBounds(next);
      this.appliedBounds.set(tabId, { ...next });
    }
  }
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (tab) { this.remove(tabId, tab); this.applyBounds(); }
  }
  private remove(tabId: string, tab: IabTabHandle, window = this.options.window()): void {
    if (this.tabs.get(tabId) !== tab) return;
    this.tabs.delete(tabId);
    this.appliedBounds.delete(tabId);
    if (this.active === tabId) this.active = [...this.tabs.keys()].pop() ?? null;
    this.cleanup.get(tabId)?.();
    this.cleanup.delete(tabId);
    try {
      if (window && !window.isDestroyed() && window.contentView.children.includes(tab.view)) window.contentView.removeChildView(tab.view);
    } finally {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [tabId, tab] of this.tabs) this.remove(tabId, tab);
    this.active = null;
  }
}
