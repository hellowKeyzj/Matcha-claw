import { app, nativeTheme, WebContentsView, type BrowserWindow, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import type { IabBounds, IabEvent, IabInternalPage, IabSnapshot, IabTab, IabUiCommand, IabUiResponse } from '../../../src/types/desktop/iab';
import { canAccessPage, canClosePage, claimPage, releasePage, type PageOwnership } from '../../../packages/openclaw-browser-relay-plugin/src/state/page-ownership';
import type { IabManager as ManagerContract, IabManagerOptions, IabTrustedContext } from './contracts';
import { iabError } from './error';
import { IabTabHost } from './tab-host';
import { iabBoundsToDip } from './geometry';
import { getZoomShortcutAction } from '../desktop/zoom-shortcuts';
import { IabPageTools } from './page-tools';
import { iabActionError } from './overlay';
import { IAB_WEB_PREFERENCES, isIabUrl, normalizeIabUrl, watchDownloadPopup } from './navigation';

const EMPTY_BOUNDS = { x: 0, y: 0, width: 0, height: 0 };
const OFFSCREEN = { x: -32000, y: 0, width: 1920, height: 1080 };

type PageClaim = { controller: AbortController; releasing?: Promise<void> };
type TabAccess = PageOwnership & { claim?: PageClaim };

export class IabManager implements ManagerContract {
  readonly ownerId = randomUUID();
  readonly pageTools: IabPageTools;
  private readonly host: IabTabHost;
  private readonly tabs = new Map<string, TabAccess>();
  private activeTabId: string | null = null;
  private readonly favicons = new Map<string, string>();
  private readonly crashes = new Map<string, IabTab['crash']>();
  private readonly cleanup = new Map<string, () => void>();
  private readonly listeners = new Set<(event: IabEvent) => void>();
  private bounds: IabBounds = { ...EMPTY_BOUNDS };
  private visible = false;
  private revision = 0;
  private nextTab = 0;
  private disposed = false;
  private boundWindow: BrowserWindow | null = null;
  private removeWindowListeners?: () => void;

  constructor(private readonly options: IabManagerOptions) {
    this.host = new IabTabHost({
      window: () => this.window(), session: options.session, ready: options.ready,
      getBounds: () => this.isVisible() ? this.nativeBounds() : OFFSCREEN,
      prepareCdp: (tabId, contents) => {
        if (!this.tabs.has(tabId)) throw new Error(`IAB tab owner is missing: ${tabId}`);
        return options.prepareCdp(tabId, this.ownerId, contents);
      },
      onTabLoadFail: (tabId) => this.close(tabId), log: options.log,
    });
    this.pageTools = new IabPageTools({
      window: () => this.window(), session: options.session, data: options.data,
      getOwner: (tabId) => this.getOwner(tabId),
      getWebContents: (tabId) => this.tabs.has(tabId) ? this.host.getWebContents(tabId) : null,
      getBrowserBounds: () => this.isVisible() ? { ...this.bounds } : null,
      isPresentedTab: (tabId) => this.activeTabId === tabId
        && this.tabs.has(tabId) && !!this.boundWindow?.isVisible() && this.boundWindow.isFocused(),
      openInternal: (page) => this.openInternal(page), emit: (event) => {
        this.emit(event);
        if (event.type === 'overlay-state') this.changed();
        if (event.type === 'find-requested') this.window()?.webContents.focus();
      }, log: options.log,
    });
    nativeTheme.on('updated', this.updateTheme);
    app.on('certificate-error', this.onCertificateError);
    this.window();
  }
  get session() { return this.options.session; }
  get data() { return this.options.data; }
  getOwner(tabId: string) { return this.tabs.has(tabId) ? this.ownerId : null; }
  getActiveOwner() { return this.ownerId; }
  getActiveTabId(ownerId: string) { return ownerId === this.ownerId ? this.activeTabId : null; }
  getWebContents(tabId: string) { return this.host.getWebContents(tabId); }
  getView(tabId: string) { return this.host.get(tabId)?.view ?? null; }
  agentAccess(tabId: string, context: IabTrustedContext, claim = true): AbortSignal {
    context.assertCurrent();
    const tab = this.tabs.get(tabId);
    if (this.disposed || !tab || !canAccessPage(tab, context.executorId, context.principalId)
      || tab.claim?.controller.signal.aborted || (!claim && (!tab.claim || tab.claimedBy !== context.executorId))) {
      throw iabError('IAB_AGENT_ACCESS_DENIED', 'The browser tab belongs to another session group or its claim is unavailable');
    }
    if (!tab.claim) {
      Object.assign(tab, claimPage(tab, context.executorId, context.principalId));
      tab.claim = { controller: new AbortController() };
      this.changed();
    }
    return tab.claim.controller.signal;
  }
  getPageOwnership(tabId: string): Readonly<PageOwnership> | null {
    const tab = this.tabs.get(tabId);
    return tab ? { createdBy: tab.createdBy, retained: tab.retained, claimedBy: tab.claimedBy, sessionGroupId: tab.sessionGroupId } : null;
  }
  async releaseSessionClaims(executorId: string, claims?: ReadonlyMap<string, PageClaim>): Promise<void> {
    const releases: Promise<void>[] = [];
    for (const [tabId, tab] of this.tabs) {
      if (tab.claimedBy !== executorId || (claims && claims.get(tabId) !== tab.claim)) continue;
      const claim = tab.claim!;
      claim.controller.abort(iabError('IAB_ACCESS_REVOKED', 'The browser page claim was released'));
      claim.releasing ??= Promise.resolve().then(() => this.options.releaseClaim(tabId, executorId)).then(() => {
        if (this.tabs.get(tabId) !== tab || tab.claim !== claim) return;
        Object.assign(tab, releasePage(tab, executorId));
        tab.claim = undefined;
        this.changed();
      }).finally(() => { claim.releasing = undefined; });
      releases.push(claim.releasing);
    }
    const failures = (await Promise.allSettled(releases)).filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason);
    if (failures.length) throw new AggregateError(failures, 'Browser page claims did not physically drain');
  }
  async cleanupSession(executorId: string, sessionGroupId: string, scope: 'executor' | 'group'): Promise<void> {
    if (scope === 'executor') return this.releaseSessionClaims(executorId);
    const pages = new Map<string, TabAccess>();
    const claims = new Map<string, PageClaim>();
    const failures: unknown[] = [];
    for (;;) {
      const executors = new Set<string>();
      for (const [tabId, tab] of this.tabs) {
        if (tab.sessionGroupId !== sessionGroupId || pages.has(tabId)) continue;
        pages.set(tabId, tab);
        if (!tab.claim || !tab.claimedBy) continue;
        claims.set(tabId, tab.claim);
        executors.add(tab.claimedBy);
        tab.claim.controller.abort(iabError('IAB_ACCESS_REVOKED', 'The browser session group ended'));
      }
      if (!executors.size) break;
      const releases = await Promise.allSettled([...executors].map((executor) => this.releaseSessionClaims(executor, claims)));
      for (const result of releases) if (result.status === 'rejected') failures.push(result.reason);
      // Popup registration can finish during physical drain; collect those pages before closing.
    }
    for (const [tabId, tab] of pages) {
      if (this.tabs.get(tabId) !== tab || tab.sessionGroupId !== sessionGroupId || tab.claim || !tab.createdBy || tab.retained) continue;
      try { this.close(tabId, this.ownerId); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'Browser session group cleanup did not complete');
  }
  resolveBrokerTarget(tabId: string, expectedOwnerId: string): WebContents {
    if (expectedOwnerId !== this.ownerId) {
      throw Object.assign(new Error(`IAB owner mismatch for tab ${tabId}`), { code: 'IAB_OWNER_MISMATCH' });
    }
    const contents = this.tabs.has(tabId) ? this.host.getWebContents(tabId) : null;
    if (!contents) throw Object.assign(new Error(`IAB tab is unavailable: ${tabId}`), { code: 'IAB_TARGET_CLOSED' });
    return contents;
  }
  private assertLive(): void { if (this.disposed) throw new Error('IAB manager is disposed'); }
  private window(): BrowserWindow | null {
    const candidate = this.options.window();
    const window = candidate && !candidate.isDestroyed() ? candidate : null;
    if (this.boundWindow !== window) this.bindWindow(window);
    return window;
  }
  private bindWindow(window: BrowserWindow | null): void {
    this.removeWindowListeners?.();
    this.boundWindow = window;
    this.bounds = { ...EMPTY_BOUNDS };
    this.visible = false;
    this.pageTools.closeMenu();
    if (!window) { this.removeWindowListeners = undefined; return; }
    const invalidate = () => this.invalidateBounds();
    const closeTools = () => this.pageTools.closeMenu();
    let zoomFactor = window.webContents.getZoomFactor();
    const zoomChanged = () => {
      setImmediate(() => {
        if (this.disposed || this.boundWindow !== window || window.isDestroyed()) return;
        const next = window.webContents.getZoomFactor();
        if (next === zoomFactor) return;
        zoomFactor = next;
        closeTools();
        this.host.applyBounds();
        this.changed();
      });
    };
    const zoomInput = (_event: Electron.Event, input: Electron.Input) => {
      if (getZoomShortcutAction(input)) zoomChanged();
    };
    const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) invalidate();
    };
    const contents = window.webContents;
    window.on('hide', invalidate);
    window.on('close', invalidate);
    window.on('resize', closeTools);
    window.on('blur', closeTools);
    contents.on('before-input-event', zoomInput);
    contents.on('zoom-changed', zoomChanged);
    contents.on('did-start-navigation', navigate);
    contents.on('render-process-gone', invalidate);
    this.removeWindowListeners = () => {
      window.removeListener('hide', invalidate);
      window.removeListener('close', invalidate);
      window.removeListener('resize', closeTools);
      window.removeListener('blur', closeTools);
      contents.removeListener('before-input-event', zoomInput);
      contents.removeListener('zoom-changed', zoomChanged);
      contents.removeListener('did-start-navigation', navigate);
      contents.removeListener('render-process-gone', invalidate);
    };
  }
  private invalidateBounds(): void {
    this.visible = false;
    this.bounds = { ...EMPTY_BOUNDS };
    this.pageTools.closeMenu();
    this.pageTools.hideSuggestions();
    this.host.applyBounds();
    this.changed();
  }
  private isVisible(): boolean {
    const window = this.boundWindow;
    return this.visible && this.bounds.width > 0 && this.bounds.height > 0 && !!window && !window.isDestroyed() && window.isVisible();
  }
  open(url: string, options: { background?: boolean; creator?: IabTrustedContext; retain?: boolean } = {}): string {
    this.assertLive();
    options.creator?.assertCurrent();
    const tabId = `iab-${++this.nextTab}`;
    const access: TabAccess = {
      createdBy: options.creator?.executorId ?? null, retained: !!options.creator && options.retain === true, claimedBy: null,
      sessionGroupId: options.creator?.principalId ?? null,
    };
    if (options.creator) {
      Object.assign(access, claimPage(access, options.creator.executorId, options.creator.principalId));
      access.claim = { controller: new AbortController() };
    }
    const ready = this.create(tabId, normalizeIabUrl(url), !options.creator && !options.background, access);
    void ready.catch(() => this.close(tabId));
    if (options.creator && !options.background) this.requestShow(this.ownerId, tabId);
    return tabId;
  }
  private create(tabId: string, url: string, activate: boolean, access: TabAccess, contents?: WebContents): Promise<void> {
    if (activate) this.pageTools.closeMenu();
    // Register the resource and claim before any ready/CDP callback can observe this tab.
    this.tabs.set(tabId, access);
    let ready: Promise<void>;
    try {
      ready = this.host.createTab(tabId, url, {
        activate: false, ...(contents ? { view: new WebContentsView({ webContents: contents }), skipWarmup: true } : {}),
      });
    } catch (error) { this.tabs.delete(tabId); throw error; }
    const native = this.host.getWebContents(tabId);
    if (!native) { void ready.catch(() => {}); this.close(tabId); throw new Error('IAB tab creation failed'); }
    const cleanups: (() => void)[] = [];
    this.cleanup.set(tabId, () => { for (const cleanup of cleanups.reverse()) cleanup(); });
    try {
      cleanups.push(this.data.history.observeTab(tabId, native));
      cleanups.push(this.data.downloads.observeTab(tabId, native));
      cleanups.push(this.pageTools.attach(tabId, native));
      cleanups.push(this.bindTab(tabId, native));
    } catch (error) { void ready.catch(() => {}); this.close(tabId); throw error; }
    if (activate) this.activeTabId = tabId;
    this.applyTheme(tabId);
    this.activateTab();
    this.changed();
    return ready;
  }
  switch(tabId: string): void {
    if (!this.tabs.has(tabId) || !this.host.has(tabId)) return;
    this.pageTools.closeMenu(); this.pageTools.hideSuggestions();
    this.activeTabId = tabId;
    this.activateTab();
    this.changed();
  }
  close(tabId: string, expectedOwnerId?: string, agent?: IabTrustedContext): void {
    if (agent) {
      agent.assertCurrent();
      this.agentAccess(tabId, agent);
      if (!canClosePage(this.tabs.get(tabId)!, agent.executorId)) {
        throw iabError('IAB_AGENT_CLOSE_DENIED', 'Only this agent session\'s non-retained browser tabs can be closed');
      }
    }
    if (!this.tabs.has(tabId) && !this.host.has(tabId)) return;
    if (expectedOwnerId !== undefined || agent) this.resolveBrokerTarget(tabId, expectedOwnerId ?? this.ownerId);
    this.pageTools.closeMenu(tabId);
    const tab = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    tab?.claim?.controller.abort(iabError('IAB_TARGET_CLOSED', 'The browser tab is closed'));
    this.cleanup.get(tabId)?.(); this.cleanup.delete(tabId);
    this.favicons.delete(tabId); this.crashes.delete(tabId);
    if (this.activeTabId === tabId) this.activeTabId = [...this.tabs].reverse().find(([, candidate]) => candidate.createdBy === null || candidate.sessionGroupId === null
      || tab?.createdBy != null && candidate.sessionGroupId === tab.sessionGroupId)?.[0] ?? null;
    this.activateTab();
    this.host.closeTab(tabId);
    if (!this.disposed) this.changed();
  }
  private activateTab(): void {
    if (this.activeTabId && this.host.has(this.activeTabId)) this.host.activateTab(this.activeTabId); else this.host.deactivateAll();
  }
  navigate(tabId: string, url: string): void {
    const contents = this.host.getWebContents(tabId);
    if (contents) this.data.downloads.resetPopup(contents);
    this.host.navigate(tabId, normalizeIabUrl(url)); this.changed();
  }
  goBack(tabId: string): void { this.host.goBack(tabId); }
  goForward(tabId: string): void { this.host.goForward(tabId); }
  reload(tabId: string): void {
    const contents = this.host.getWebContents(tabId);
    if (contents) this.data.downloads.resetPopup(contents);
    this.host.reload(tabId);
  }
  private nativeBounds(): IabBounds {
    return iabBoundsToDip(this.bounds, this.boundWindow!.webContents.getZoomFactor());
  }
  setBounds(bounds: IabBounds): void {
    this.assertLive(); this.window();
    if (!Object.values(bounds).every(Number.isFinite)) throw new Error('Invalid IAB bounds');
    const next = { ...bounds, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) };
    if (next.x === this.bounds.x && next.y === this.bounds.y && next.width === this.bounds.width && next.height === this.bounds.height) return;
    this.bounds = next;
    this.pageTools.closeMenu(); this.pageTools.hideSuggestions();
    this.host.applyBounds(); this.changed();
  }
  setVisible(visible: boolean): void {
    this.assertLive(); this.window();
    this.visible = visible && this.bounds.width > 0 && this.bounds.height > 0;
    if (!visible) { this.pageTools.closeMenu(); this.pageTools.hideSuggestions(); }
    this.host.applyBounds(); this.changed();
  }
  private tabSnapshot(tabId: string): IabTab {
    const tab = this.host.get(tabId);
    const contents = this.host.getWebContents(tabId);
    const url = contents?.getURL() || tab?.initialUrl || 'about:blank';
    return {
      id: tabId, ownerId: this.ownerId, url,
      createdBy: this.tabs.get(tabId)!.createdBy, retained: this.tabs.get(tabId)!.retained,
      claimedBy: this.tabs.get(tabId)!.claimedBy, sessionGroupId: this.tabs.get(tabId)!.sessionGroupId,
      title: url === 'about:blank' ? '' : contents?.getTitle() || url,
      ...(this.favicons.has(tabId) && url !== 'about:blank' ? { faviconUrl: this.favicons.get(tabId) } : {}),
      loading: contents?.isLoadingMainFrame() ?? false,
      canGoBack: contents?.navigationHistory.canGoBack() ?? false,
      canGoForward: contents?.navigationHistory.canGoForward() ?? false,
      zoomFactor: contents?.getZoomFactor() ?? 1, crash: this.crashes.get(tabId) ?? null,
      ...(tab?.internalPage ? { internalPage: tab.internalPage } : {}),
    };
  }
  listAllTabs(): IabTab[] { return [...this.tabs.keys()].map((tabId) => this.tabSnapshot(tabId)); }
  snapshot(): IabSnapshot {
    return {
      ownerId: this.ownerId, revision: this.revision,
      tabs: this.listAllTabs(), activeTabId: this.activeTabId,
      bounds: { ...this.bounds }, visible: this.isVisible(),
    };
  }
  async execute(command: IabUiCommand): Promise<IabUiResponse> {
    this.assertLive();
    const ownerId = this.ownerId;
    try {
      if ('tabId' in command) this.resolveBrokerTarget(command.tabId, ownerId);
      let result: IabUiResponse['result'] = { resultType: 'complete' };
      switch (command.action) {
        case 'snapshot': result = { resultType: 'snapshot', snapshot: this.snapshot() }; break;
        case 'list-all': result = { resultType: 'tabs', tabs: this.listAllTabs() }; break;
        case 'open': result = { resultType: 'opened', tabId: this.open(command.url, command) }; break;
        case 'switch': this.switch(command.tabId); break;
        case 'close': this.close(command.tabId, ownerId); break;
        case 'navigate': this.navigate(command.tabId, command.url); break;
        case 'back': this.goBack(command.tabId); break;
        case 'forward': this.goForward(command.tabId); break;
        case 'reload': this.reload(command.tabId); break;
        case 'set-bounds': this.setBounds(command.bounds); break;
        case 'set-visible': this.setVisible(command.visible); break;
        case 'set-presentation': this.pageTools.setPresentation(command.theme, command.locale); break;
        default:
          result = await this.pageTools.execute(command, ownerId);
          if (command.action === 'set-zoom') this.changed();
      }
      return { ownerId, revision: this.revision, result };
    } catch (error) {
      const code = (error as { code?: string }).code;
      return { ownerId, revision: this.revision, result: {
        resultType: 'error', code: code === 'IAB_OWNER_MISMATCH' ? 'owner-mismatch' : code === 'IAB_TARGET_CLOSED' ? 'tab-closed' : 'action-failed',
        message: code === 'IAB_OWNER_MISMATCH' ? 'The browser tab belongs to another browser.' : code === 'IAB_TARGET_CLOSED' ? 'The browser tab is closed.' : iabActionError(error),
      } };
    }
  }
  requestShow(ownerId: string, tabId: string): void {
    if (this.getOwner(tabId) === ownerId) this.emit({ type: 'show-requested', ownerId, tabId });
  }
  onEvent(listener: (event: IabEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(event: IabEvent): void {
    if (this.disposed) return;
    this.options.emit?.(event);
    for (const listener of this.listeners) listener(event);
  }
  private changed(): void { this.revision++; this.emit({ type: 'tabs-changed', snapshot: this.snapshot() }); }
  private openInternal(page: IabInternalPage): void {
    const existing = [...this.tabs.keys()].find((id) => this.host.get(id)?.internalPage === page);
    const tabId = existing ?? this.open('about:blank');
    this.host.showInternalPage(tabId, page); this.switch(tabId);
  }
  private bindTab(tabId: string, contents: WebContents): () => void {
    const bindings: (() => void)[] = [];
    const bind = (name: string, listener: (...args: never[]) => void) => {
      contents.on(name as 'destroyed', listener);
      bindings.push(() => contents.removeListener(name as 'destroyed', listener));
    };
    const changed = () => { if (this.tabs.has(tabId)) this.changed(); };
    for (const name of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'did-fail-load', 'focus', 'blur', 'zoom-changed']) bind(name, changed);
    const refreshFavicon = () => {
      const url = contents.getURL();
      if (!url || url === 'about:blank' || this.favicons.get(tabId)?.startsWith('data:')) return;
      void this.data.history.faviconForUrl(url).then((favicon) => {
        if (favicon && this.host.getWebContents(tabId) === contents && contents.getURL() === url && !this.favicons.get(tabId)?.startsWith('data:')) {
          this.favicons.set(tabId, favicon); changed();
        }
      }).catch(() => {});
    };
    bindings.push(this.data.history.subscribe(refreshFavicon));
    const favicon = (_event: Electron.Event, urls: string[]) => {
      const url = urls.find((value) => {
        if (value.startsWith('data:')) return value.length < 100_000 && /^data:image\/(png|jpeg|webp|gif|x-icon|vnd.microsoft.icon|svg\+xml);base64,/i.test(value);
        if (value.length > 2_048) return false;
        try {
          const parsed = new URL(value);
          return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
        } catch { return false; }
      });
      if (url) this.favicons.set(tabId, url); else this.favicons.delete(tabId);
      changed();
    };
    contents.on('page-favicon-updated', favicon); bindings.push(() => contents.removeListener('page-favicon-updated', favicon));
    const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => {
      if (mainFrame && !inPlace) { this.favicons.delete(tabId); this.crashes.delete(tabId); changed(); }
    };
    contents.on('did-start-navigation', navigation); bindings.push(() => contents.removeListener('did-start-navigation', navigation));
    const finished = () => { this.applyTheme(tabId); refreshFavicon(); changed(); };
    contents.on('did-finish-load', finished); bindings.push(() => contents.removeListener('did-finish-load', finished));
    const crashed = (_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
      this.crashes.set(tabId, { reason: details.reason, exitCode: details.exitCode }); changed();
    };
    contents.on('render-process-gone', crashed); bindings.push(() => contents.removeListener('render-process-gone', crashed));
    const destroyed = () => this.close(tabId);
    contents.once('destroyed', destroyed); bindings.push(() => contents.removeListener('destroyed', destroyed));
    contents.setWindowOpenHandler((details) => {
      if (!isIabUrl(details.url) || this.disposed || !this.window()) return { action: 'deny' };
      return {
        action: 'allow', outlivesOpener: true,
        overrideBrowserWindowOptions: { webPreferences: { ...IAB_WEB_PREFERENCES, preload: undefined, session: this.session, partition: undefined } },
        createWindow: (options) => {
          const tabIdPopup = `iab-${++this.nextTab}`;
          const popupOptions = options as Electron.BrowserWindowConstructorOptions & { webContents?: WebContents };
          if (!popupOptions.webContents || popupOptions.webContents.session !== contents.session) throw new Error('IAB native popup target is unavailable');
          const opener = this.tabs.get(tabId);
          if (!opener) throw iabError('IAB_TARGET_CLOSED', 'The browser popup opener is closed');
          const nativeOpener = this.host.getWebContents(tabId) === contents && popupOptions.webContents.opener?.top === contents.mainFrame;
          const createdBy = nativeOpener && opener.claim && !opener.claim.controller.signal.aborted ? opener.claimedBy : null;
          const access: TabAccess = { createdBy, retained: false, claimedBy: null, sessionGroupId: nativeOpener ? opener.sessionGroupId : null };
          if (createdBy) {
            Object.assign(access, claimPage(access, createdBy, opener.sessionGroupId!));
            access.claim = { controller: new AbortController() };
          }
          const foreground = this.host.getWebContents(tabId) === contents && this.activeTabId === tabId && details.disposition !== 'background-tab';
          const ready = this.create(tabIdPopup, details.url, foreground && !createdBy, access, popupOptions.webContents);
          if (foreground && createdBy) this.requestShow(this.ownerId, tabIdPopup);
          const popup = this.resolveBrokerTarget(tabIdPopup, this.ownerId);
          void ready.catch(() => this.close(tabIdPopup));
          if (popup.session !== contents.session) { this.close(tabIdPopup); throw new Error('IAB popup session mismatch'); }
          this.data.downloads.followDownloadPopup(contents, popup);
          const disposeDownload = watchDownloadPopup(popup, details.url, () => {
            if (this.host.getWebContents(tabIdPopup) !== popup) return;
            this.close(tabIdPopup, this.ownerId);
          });
          const remove = this.cleanup.get(tabIdPopup)!;
          this.cleanup.set(tabIdPopup, () => { disposeDownload(); remove(); });
          setImmediate(() => { if (this.host.has(tabIdPopup)) { this.host.applyBounds(); this.changed(); } });
          return popup;
        },
      };
    });
    bindings.push(() => { if (!contents.isDestroyed()) contents.setWindowOpenHandler(() => ({ action: 'deny' })); });
    return () => { for (const remove of bindings.reverse()) remove(); };
  }
  private applyTheme(tabId: string): void {
    const view = this.getView(tabId);
    if (view) view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#18181b' : '#ffffff');
  }
  private readonly updateTheme = () => { for (const tabId of this.tabs.keys()) this.applyTheme(tabId); };
  private readonly onCertificateError = (_event: Electron.Event, contents: WebContents, _url: string, error: string) => {
    if ([...this.tabs.keys()].some((tabId) => this.host.getWebContents(tabId) === contents)) this.options.log?.warn(`[iab] certificate rejected: ${error}`);
    // Deliberately do not preventDefault or invoke the acceptance callback.
  };
  async flush(): Promise<void> {
    await this.options.ready;
    await Promise.all([this.data.history.flush(), this.data.downloads.flush(), this.data.cookies.flush()]);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removeWindowListeners?.(); this.removeWindowListeners = undefined;
    nativeTheme.removeListener('updated', this.updateTheme);
    app.removeListener('certificate-error', this.onCertificateError);
    this.pageTools.dispose();
    for (const tabId of [...this.tabs.keys()]) this.close(tabId);
    this.host.dispose();
    this.activeTabId = null; this.listeners.clear();
  }
}
