/** Stable opaque tab namespace; resolved by Main, never a model-supplied owner or visible-chat alias. */
export type IabOwnerId = string;
export type IabTabId = string;
export type IabBrowserMode = 'iab' | 'native' | 'relay' | 'off';
export type IabJsonValue = null | boolean | number | string | IabJsonValue[] | IabJsonObject;
export type IabJsonObject = { [key: string]: IabJsonValue };
export type IabBounds = { x: number; y: number; width: number; height: number };
export type IabToolAnchor = IabBounds & { keyboard: boolean; browserBounds?: IabBounds };
export type IabTheme = 'light' | 'dark';
export type IabInternalPage = 'history' | 'downloads';

export interface IabTab {
  id: IabTabId;
  ownerId: IabOwnerId;
  /** Session grouping and executor claims are independent of native resource ownership. */
  sessionGroupId: string | null;
  createdBy: string | null;
  claimedBy: string | null;
  retained: boolean;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  crash: { reason: string; exitCode: number } | null;
  internalPage?: IabInternalPage;
}

/** Main-global monotonic revision; consumers reject another owner and older revisions. */
export interface IabSnapshot {
  ownerId: IabOwnerId | null;
  revision: number;
  tabs: IabTab[];
  activeTabId: IabTabId | null;
  bounds: IabBounds;
  visible: boolean;
}

export interface IabHistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: number;
  faviconUrl?: string;
}
export interface IabHistoryQuery {
  query?: string;
  offset?: number;
  limit?: number;
  from?: number;
  to?: number;
}
export interface IabHistoryPage {
  entries: IabHistoryEntry[];
  total: number;
  nextOffset: number | null;
}

/** The native save path and recovery data stay in Main. Timestamps are epoch milliseconds. */
export interface IabDownload {
  id: string;
  filename: string;
  status: 'progressing' | 'paused' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  updatedAt: number;
  canResume?: boolean;
  fileMissing?: boolean;
}
export type IabDownloadCommand =
  | { action: 'open-directory' }
  | { action: 'open' | 'show-in-folder' | 'cancel' | 'pause' | 'resume' | 'remove'; id: string };
export type IabScreenshotResult =
  | { resultType: 'saved'; filename: string }
  | { resultType: 'cancelled' };

export interface IabFindResult {
  ownerId: IabOwnerId;
  tabId: IabTabId;
  searchId: number;
  requestId: number;
  activeMatchOrdinal: number;
  matches: number;
  finalUpdate: boolean;
}
export type IabMenuAction = 'find' | 'history' | 'downloads' | 'open-external' | 'screenshot'
  | 'clear-cache' | 'clear-site-data' | 'zoom-in' | 'zoom-out' | 'zoom-reset';

export interface IabOverlayContext {
  sessionId: number;
  ownerId: IabOwnerId;
  tabId: IabTabId;
  anchor: IabBounds | IabToolAnchor;
  theme: IabTheme;
  locale: string;
  error?: string;
}
export type IabOverlayState = (IabOverlayContext & (
  | { kind: 'menu'; zoomFactor: number; canOpenExternal: boolean; canCapturePage: boolean; findShortcut: string }
  | { kind: 'toast'; message: string }
  | { kind: 'download'; download: IabDownload }
  | { kind: 'downloads'; entries: IabDownload[] }
  | { kind: 'suggestions'; entries: IabHistoryEntry[]; selectedIndex: number }
)) | null;
export type IabOverlayInput = Exclude<IabOverlayState, null> extends infer State
  ? State extends IabOverlayContext ? Omit<State, 'sessionId'> : never
  : never;
export type IabOverlayCommand = { sessionId: number } & (
  | { action: 'dismiss' }
  | { action: 'refresh-downloads' }
  | { action: 'menu'; command: IabMenuAction }
  | { action: 'download'; command: IabDownloadCommand }
  | { action: 'select-suggestion' | 'remove-suggestion'; id: string }
);

/** Both actions affect persist:agent-iab, not just this owner/tab. UI must show an app confirmation.
 * Cache preserves logins. Site storage clears ALL shared cookies/storage and encrypted cookie backup.
 * This acknowledgement is not authority: Main still verifies the privileged UI sender; agents cannot clear it.
 */
export interface IabClearDataConfirmation {
  scope: 'shared-session';
  confirmed: true;
}

export type IabUiCommand =
  | { action: 'snapshot' | 'list-all' }
  | { action: 'open'; url: string; background?: boolean }
  | { action: 'switch' | 'close' | 'back' | 'forward' | 'reload'; tabId: IabTabId }
  | { action: 'navigate'; tabId: IabTabId; url: string }
  | { action: 'set-bounds'; bounds: IabBounds }
  | { action: 'set-visible'; visible: boolean }
  | { action: 'set-presentation'; theme: IabTheme; locale: string }
  | { action: 'find'; tabId: IabTabId; text: string; searchId: number; forward?: boolean }
  | { action: 'stop-find'; tabId: IabTabId; mode?: 'clearSelection' | 'keepSelection' | 'activateSelection' }
  | { action: 'set-zoom'; tabId: IabTabId; zoomFactor: number }
  | { action: 'open-internal'; page: IabInternalPage }
  | { action: 'history-query'; query: IabHistoryQuery }
  | { action: 'history-remove'; ids: string[] | 'all' }
  | { action: 'history-remove-origin'; url: string }
  | { action: 'history-suggest'; tabId: IabTabId; query: string; selectedIndex: number; anchor: IabBounds }
  | { action: 'hide-suggestions' }
  | { action: 'downloads-list'; refreshFileState?: boolean }
  | { action: 'downloads-clear' }
  | { action: 'download'; command: IabDownloadCommand }
  | { action: 'show-menu' | 'show-downloads'; tabId: IabTabId; anchor: IabToolAnchor }
  | { action: 'overlay'; command: IabOverlayCommand }
  | { action: 'clear-data'; tabId: IabTabId; token: string; data: 'cache' | 'site-storage'; confirmation: IabClearDataConfirmation }
  | { action: 'screenshot-save'; tabId: IabTabId };

/** Manual browser commands require the trusted application frame, not an Agent session. */
export interface IabUiRequest {
  command: IabUiCommand;
}
export type IabUiResult =
  | { resultType: 'complete' }
  | { resultType: 'snapshot'; snapshot: IabSnapshot }
  | { resultType: 'opened'; tabId: IabTabId }
  | { resultType: 'tabs'; tabs: IabTab[] }
  | { resultType: 'find'; requestId: number | null }
  | { resultType: 'history'; page: IabHistoryPage }
  | { resultType: 'suggestions'; entries: IabHistoryEntry[] }
  | { resultType: 'downloads'; entries: IabDownload[] }
  | { resultType: 'screenshot'; result: IabScreenshotResult }
  | { resultType: 'error'; code: 'owner-mismatch' | 'tab-closed' | 'invalid-command' | 'not-ready' | 'action-failed'; message: string };
export interface IabUiResponse {
  ownerId: IabOwnerId | null;
  revision: number;
  result: IabUiResult;
}
export type IabEvent =
  | { type: 'quit-blocked' }
  | { type: 'tabs-changed'; snapshot: IabSnapshot }
  | { type: 'show-requested'; ownerId: IabOwnerId; tabId: IabTabId }
  | { type: 'find-requested'; ownerId: IabOwnerId; tabId: IabTabId }
  | { type: 'find-result'; result: IabFindResult }
  | { type: 'history-changed' | 'downloads-changed' }
  | { type: 'download-completed'; ownerId: IabOwnerId; tabId: IabTabId; download: IabDownload }
  | { type: 'overlay-state'; state: IabOverlayState }
  | { type: 'clear-data-requested'; ownerId: IabOwnerId; tabId: IabTabId; token: string; data: 'cache' | 'site-storage' }
  | { type: 'suggestion-selected'; ownerId: IabOwnerId; tabId: IabTabId; entry: IabHistoryEntry }
  | { type: 'suggestion-remove-started'; ownerId: IabOwnerId; tabId: IabTabId };
