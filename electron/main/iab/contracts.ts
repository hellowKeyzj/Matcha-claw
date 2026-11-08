import type { BrowserWindow, Session, WebContents, WebContentsView } from 'electron';
import type { BrowserActionParams, BrowserInterceptRule } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { PageOwnership } from '../../../packages/openclaw-browser-relay-plugin/src/state/page-ownership';
import type { SessionIdentity } from '../../../src/types/desktop/runtime-address';
import type {
  IabBounds, IabDownload, IabDownloadCommand, IabEvent, IabFindResult, IabHistoryEntry,
  IabHistoryPage, IabHistoryQuery, IabInternalPage, IabJsonObject, IabJsonValue,
  IabOverlayCommand, IabOverlayContext, IabOverlayInput, IabOverlayState, IabOwnerId,
  IabSnapshot, IabTab, IabTabDisplay, IabTabId, IabTheme, IabUiCommand, IabUiResponse, IabViewPlacement,
} from '../../../src/types/desktop/iab';

export type IabUnsubscribe = () => void;
export interface IabLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: Error): void;
}

export interface IabSessionOptions {
  readClientHintsPolicy(contents: WebContents, expression: string, signal: AbortSignal): Promise<unknown>;
}
/** session.ts exports createIabSession(options: IabSessionOptions): IabSession; persist:agent-iab. */
export interface IabSession {
  session: Session;
  ready: Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
}

/** history.ts exports class IabHistory(root: string). Observation owns visit/title/favicon listeners. */
export interface IabHistory {
  initialize(): Promise<void>;
  observeTab(tabId: IabTabId, contents: WebContents): IabUnsubscribe;
  recordVisit(url: string, title: string, tabId?: IabTabId): Promise<void>;
  recordFavicon(url: string, faviconUrl: string, title?: string): Promise<void>;
  query(query: IabHistoryQuery): Promise<IabHistoryPage>;
  remove(ids: string[] | 'all'): Promise<void>;
  removeOrigin(url: string): Promise<void>;
  suggest(query: string, limit?: number): Promise<IabHistoryEntry[]>;
  faviconForUrl(url: string): Promise<string | undefined>;
  subscribe(listener: () => void): IabUnsubscribe;
  /** Stops tab observation and waits for its final commits before the last flush. */
  close(): Promise<void>;
  flush(): Promise<void>;
}
/** cookies.ts exports class IabCookies(root: string, session: Session). No cookie values cross IPC. */
export interface IabCookies {
  initialize(): Promise<void>;
  /** Omitted origin clears the complete shared session and its encrypted session-cookie backup. */
  clearSite(origin?: string): Promise<void>;
  flush(): Promise<void>;
  dispose(): void;
}
export type IabDownloadCaptureEvent =
  | { type: 'will-begin'; guid: string; url: string; suggestedFilename: string }
  | { type: 'progress'; guid: string; state: 'inProgress' | 'completed' | 'canceled'; receivedBytes: number; totalBytes: number };
export interface IabDownloadCaptureOptions {
  /** CDP lease ID, not the tab's ownerId. */
  owner: string;
  behavior: 'allow' | 'allowAndName' | 'deny';
  downloadPath?: string;
  requestDeadlineAt?: number;
  emit(event: IabDownloadCaptureEvent): void;
  onError(error: Error): void;
}
export interface IabDownloadsOptions {
  directory(): string;
  window(): BrowserWindow | null;
  log?: IabLog;
  onCompleted?(tabId: IabTabId, download: IabDownload): void;
}
/** downloads.ts exports class IabDownloads(root: string, session: Session, options: IabDownloadsOptions). */
export interface IabDownloads {
  initialize(): Promise<void>;
  observeTab(tabId: IabTabId, contents: WebContents): IabUnsubscribe;
  list(refreshFileState?: boolean): Promise<IabDownload[]>;
  control(command: IabDownloadCommand): Promise<void>;
  /** Removes finished records only, never active downloads or downloaded files. */
  clear(): Promise<void>;
  subscribe(listener: () => void): IabUnsubscribe;
  setDownloadBehavior(contents: WebContents, options: IabDownloadCaptureOptions): void;
  releaseDownloadCapture(contents: WebContents, owner: string): void;
  followDownloadPopup(opener: WebContents, popup: WebContents): void;
  resetPopup(contents: WebContents): void;
  reportDownloadSaved(contents: WebContents, owner: string, guid: string, finalPath: string, assertCurrent: () => void | Promise<void>): Promise<void>;
  prepareForQuit(): Promise<void>;
  cancelQuit(): void;
  flush(): Promise<void>;
  dispose(): void;
}
/** Composition only; no extra data.ts service, registry or second lifecycle owner. */
export interface IabData {
  history: IabHistory;
  cookies: IabCookies;
  downloads: IabDownloads;
}

export interface IabTabHandle {
  view: WebContentsView;
  initialUrl: string;
  ready: Promise<void>;
  navigationRevision: number;
  emptyPage: boolean;
  internalPage?: IabInternalPage;
  returnToInternalPage?: IabInternalPage;
}
export interface IabTabHostOptions {
  window(): BrowserWindow | null;
  session: Session;
  ready: Promise<void>;
  getBounds(tabId: IabTabId): IabBounds | null;
  prepareCdp(tabId: IabTabId, contents: WebContents): Promise<void>;
  log?: IabLog;
  onTabLoadFail?(tabId: IabTabId): void;
}
/** tab-host.ts owns WebContentsView creation/destruction, navigation readiness and bounds. */
export interface IabTabHost {
  readonly session: Session;
  readonly size: number;
  get(tabId: IabTabId): IabTabHandle | undefined;
  getWebContents(tabId: IabTabId): WebContents | null;
  has(tabId: IabTabId): boolean;
  createTab(tabId: IabTabId, url: string, options?: { view?: WebContentsView; skipWarmup?: boolean }): Promise<void>;
  closeTab(tabId: IabTabId): void;
  listTabs(): { tabId: IabTabId; url: string; title: string }[];
  showInternalPage(tabId: IabTabId, page: IabInternalPage): void;
  navigate(tabId: IabTabId, url: string): void;
  goBack(tabId: IabTabId): void;
  goForward(tabId: IabTabId): void;
  reload(tabId: IabTabId): void;
  applyBounds(): void;
  dispose(): void;
}

export interface IabManagerOptions {
  window(): BrowserWindow | null;
  session: Session;
  data: IabData;
  /** Initial loads wait for the session guard and the cookie-restore attempt. */
  ready: Promise<void>;
  prepareCdp(tabId: IabTabId, ownerId: IabOwnerId, contents: WebContents): Promise<void>;
  releaseClaim(tabId: IabTabId, executorId: string): Promise<void>;
  log?: IabLog;
  emit?(event: IabEvent): void;
}
export type IabOpenOptions = { background?: boolean; retain?: boolean } & (
  | { creator: Pick<IabTrustedContext, 'principalId' | 'executorId'>; display?: never }
  | { creator?: never; display: IabTabDisplay }
);
/** manager.ts exports class IabManager(options). Main is the sole tab/owner/snapshot authority. */
export interface IabManager {
  readonly session: Session;
  readonly data: IabData;
  readonly pageTools: IabPageTools;
  readonly ownerId: IabOwnerId;
  /** Caller awaits native currency before synchronous page admission; Main checks page ownership. */
  agentAccess(tabId: IabTabId, identity: Pick<IabTrustedContext, 'executorId' | 'principalId'>, claim?: boolean): AbortSignal;
  getPageOwnership(tabId: IabTabId): Readonly<PageOwnership> | null;
  releaseSessionClaims(executorId: string): Promise<void>;
  cleanupSession(executorId: string, sessionGroupId: string, scope: 'executor' | 'group'): Promise<void>;
  getOwner(tabId: IabTabId): IabOwnerId | null;
  getActiveOwner(): IabOwnerId | null;
  getActiveTabId(ownerId: IabOwnerId): IabTabId | null;
  getWebContents(tabId: IabTabId): WebContents | null;
  getView(tabId: IabTabId): WebContentsView | null;
  resolveBrokerTarget(tabId: IabTabId, expectedOwnerId: IabOwnerId): WebContents;
  open(url: string, options: IabOpenOptions): IabTabId;
  switch(tabId: IabTabId): void;
  close(tabId: IabTabId, expectedOwnerId?: IabOwnerId, agent?: Pick<IabTrustedContext, 'principalId' | 'executorId'>): void;
  navigate(tabId: IabTabId, url: string): void;
  goBack(tabId: IabTabId): void;
  goForward(tabId: IabTabId): void;
  reload(tabId: IabTabId): void;
  setViews(views: readonly IabViewPlacement[]): void;
  listAllTabs(): IabTab[];
  snapshot(): IabSnapshot;
  execute(command: IabUiCommand): Promise<IabUiResponse>;
  requestShow(ownerId: IabOwnerId, tabId: IabTabId): void;
  onEvent(listener: (event: IabEvent) => void): IabUnsubscribe;
  flush(): Promise<void>;
  dispose(): void;
}

export interface IabPageToolsOptions {
  window(): BrowserWindow | null;
  session: Session;
  data: IabData;
  getOwner(tabId: IabTabId): IabOwnerId | null;
  /** Active-owner-only lookup for privileged user actions; broker uses resolveBrokerTarget instead. */
  getWebContents(tabId: IabTabId): WebContents | null;
  getBrowserBounds(tabId: IabTabId): IabBounds | null;
  isPresentedTab(tabId: IabTabId): boolean;
  openInternal(page: IabInternalPage, sourceTabId: IabTabId): void;
  emit(event: IabEvent): void;
  log?: IabLog;
}
export interface IabPageTools {
  attach(tabId: IabTabId, contents: WebContents): IabUnsubscribe;
  find(tabId: IabTabId, text: string, searchId: number, forward?: boolean): number | null;
  stopFind(tabId: IabTabId, mode?: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  setPresentation(theme: IabTheme, locale: string): void;
  execute(command: IabUiCommand, ownerId: IabOwnerId): Promise<IabUiResponse['result']>;
  notifyDownload(tabId: IabTabId, download: IabDownload): Promise<void>;
  closeMenu(tabId?: IabTabId): void;
  hideSuggestions(tabId?: IabTabId): void;
  dispose(): void;
}
/** Transient transparent native menus/page-tools overlay; never an independent IAB toolbar/right renderer.
 * Clear-data confirmation belongs to the existing React UI; Main hides the page for that confirmation.
 */
export interface IabOverlayOptions {
  window(): BrowserWindow | null;
  emit(event: IabEvent): void;
  onCommand(command: IabOverlayCommand, state: NonNullable<IabOverlayState>): Promise<void>;
}
export interface IabOverlay {
  readonly state: IabOverlayState;
  show(state: IabOverlayInput): Promise<number>;
  execute(command: IabOverlayCommand): Promise<void>;
  dismiss(): void;
  dispose(): void;
}

/** Built only by the private bridge from verified native invocation context.
 * The principal is not the browser resource owner; page access is separately checked in Main.
 */
export interface IabTrustedContext {
  /** Verified root group; never used as the executor's exclusive claim. */
  readonly principalId: string;
  readonly executorId: string;
  readonly sessionKey: string;
  readonly identity?: SessionIdentity;
  readonly generation?: number;
  readonly workspaceDir?: string;
  assertCurrent(): void | Promise<void>;
}
export interface IabCdpEvent { method: string; params: IabJsonObject; sessionId?: string }
export type IabFetchResolution = { method: 'Fetch.continueRequest' | 'Fetch.failRequest' | 'Fetch.fulfillRequest'; params: IabJsonObject };
export interface IabCdpExecutor {
  send<T extends IabJsonValue = IabJsonObject>(method: string, params?: IabJsonObject, options?: {
    sessionId?: string; timeoutMs?: number; signal?: AbortSignal; assertCurrent?: () => void | Promise<void>;
  }): Promise<T>;
  setScreenshotViewport(options: { signal: AbortSignal; timeoutMs: number; assertCurrent?: () => void | Promise<void> }): Promise<void>;
  restoreScreenshotViewport(signal: AbortSignal): Promise<void>;
  onEvent(listener: (event: IabCdpEvent) => void): IabUnsubscribe;
  setInterceptPolicy(rules: readonly BrowserInterceptRule[], options: { signal: AbortSignal; assertCurrent?: () => void | Promise<void> }): Promise<void>;
  listChildFrames(options?: { signal?: AbortSignal; assertCurrent?: () => void | Promise<void>; timeoutMs?: number }): Promise<readonly { sessionId: string; frameId: string }[]>;
}
export interface IabCdpLease {
  readonly id: string;
  readonly tabId: IabTabId;
  readonly ownerId: IabOwnerId;
  readonly generation: number;
  readonly executor: IabCdpExecutor;
  /** Request cancellation invalidates its target epoch, including waits between CDP commands. */
  cancel(signal?: AbortSignal): void;
  cleanup(method: string, params: IabJsonObject | undefined, signal: AbortSignal): Promise<IabJsonValue>;
  drain(signal: AbortSignal): Promise<void>;
  release(): void;
}
export interface IabBrokerOptions {
  resolveTarget(tabId: IabTabId, ownerId: IabOwnerId): WebContents;
  resolveUserAgentOverride?(tabId: IabTabId, ownerId: IabOwnerId): {
    userAgent: string; platform?: string; userAgentMetadata?: IabJsonObject;
  } | null;
  downloads: IabDownloads;
  log?: IabLog;
}
export interface IabBroker {
  /** Pins the target lifecycle at Main admission, before any Worker continuation can dispatch. */
  bindTarget(tabId: IabTabId, ownerId: IabOwnerId, signal: AbortSignal): void;
  drain(signal: AbortSignal): Promise<void>;
  prepareTarget(tabId: IabTabId, ownerId: IabOwnerId, contents: WebContents): Promise<void>;
  readClientHintsPolicy(contents: WebContents, expression: string, signal?: AbortSignal): Promise<IabJsonValue | undefined>;
  acquire(tabId: IabTabId, ownerId: IabOwnerId, signal: AbortSignal, generation?: number, assertCurrent?: () => void | Promise<void>): Promise<IabCdpLease>;
  /** Revokes synchronously, then waits for all physical work belonging to affected controllers. */
  revokeGeneration(generation: number): Promise<void>;
  revokeTarget(tabId: IabTabId, ownerId: IabOwnerId): Promise<void>;
  dispose(): void;
}
export interface IabAutomationOptions { manager: IabManager; broker: IabBroker; log?: IabLog }
export interface IabAutomation {
  handleRequest(params: BrowserActionParams, trustedContext: IabTrustedContext, signal: AbortSignal): Promise<IabJsonValue>;
  releaseClaim(tabId: IabTabId, executorId: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface IabAutomationScreenshot { imageBase64: string; imageType: 'png' | 'jpeg'; savedTo?: string }
export interface IabAutomationPdf { pdfBase64: string; savedTo?: string }

export type { IabFindResult, IabOverlayContext };
