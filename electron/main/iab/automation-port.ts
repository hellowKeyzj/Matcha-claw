import type { BrowserActionParams, BrowserInterceptRule } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject, IabTab } from '../../../src/types/desktop/iab';
import type { IabCdpEvent, IabCdpLease, IabTrustedContext } from './contracts';
import type { PageOwnership } from '../../../packages/openclaw-browser-relay-plugin/src/state/page-ownership';

export type AutomationIdentity = Pick<IabTrustedContext, 'principalId' | 'executorId' | 'sessionKey' | 'workspaceDir'>;
export type AutomationError = { message: string; code?: string; errors?: AutomationError[] };
export type AutomationReply = { id: number } & ({ ok: true; value: unknown } | { ok: false; error: AutomationError });
export type DownloadFile = { guid: string; filename: string; directory: string; savePath?: string; bytes: number };
export type AutomationEffect =
  | { kind: 'tabs' }
  | { kind: 'check-target'; tabId: string; operation?: 'close' }
  | { kind: 'open'; url: string; retain?: boolean }
  | { kind: 'close-tab'; tabId: string }
  | { kind: 'release-claims' }
  | { kind: 'show'; tabId: string }
  | { kind: 'acquire'; tabId: string }
  | { kind: 'command'; leaseId: string; method: string; params?: IabJsonObject; sessionId?: string; timeoutMs?: number }
  | { kind: 'screenshot-viewport'; leaseId: string; timeoutMs: number }
  | { kind: 'restore-screenshot-viewport'; leaseId: string }
  | { kind: 'frames'; leaseId: string; timeoutMs?: number }
  | { kind: 'intercept'; leaseId: string; rules: readonly BrowserInterceptRule[] }
  | { kind: 'drain' }
  | { kind: 'read-script'; path: string }
  | { kind: 'resolve-files'; paths: string[] }
  | { kind: 'save-file'; path: string; bytes: Uint8Array; atomic: boolean }
  | { kind: 'prepare-download'; dir?: string; savePath?: string }
  | { kind: 'finish-download'; leaseId: string; file: DownloadFile };
export type AutomationToMain =
  | { type: 'effect'; id: number; invocation: number; effect: AutomationEffect }
  | { type: 'abort'; invocation: number; error: AutomationError }
  | { type: 'cancel-lease'; invocation: number; leaseId: string }
  | { type: 'release-lease' | 'release-download'; leaseId: string }
  | { type: 'teardown'; id: number; leaseId: string; method?: string; params?: IabJsonObject }
  | { type: 'result'; reply: AutomationReply }
  | { type: 'closed' };
export type AutomationToWorker =
  | { type: 'request'; id: number; params: BrowserActionParams; context: AutomationIdentity }
  | { type: 'cancel'; id: number; error: AutomationError }
  | { type: 'reply'; reply: AutomationReply }
  | { type: 'events'; events: { leaseId: string; event: IabCdpEvent }[] }
  | { type: 'tabs'; tabs: Pick<IabTab, 'id' | 'ownerId'>[] }
  | { type: 'close' };

/** Worker projections are not authority. Every effect re-enters the original Main invocation. */
export interface AutomationContext extends IabTrustedContext {
  readonly invocation: number;
  readScript(path: string, signal: AbortSignal): Promise<string>;
  resolveFiles(paths: string[], signal: AbortSignal): Promise<string[]>;
  saveFile(path: string, bytes: Uint8Array, signal: AbortSignal, atomic?: boolean): Promise<string>;
  prepareDownload(dir: string | undefined, savePath: string | undefined, signal: AbortSignal): Promise<string>;
  finishDownload(leaseId: string, file: DownloadFile, signal: AbortSignal): Promise<string>;
  releaseDownload(leaseId: string): void;
}
export interface AutomationServices {
  tabs(context: AutomationContext): Promise<{ tabs: (IabTab & PageOwnership)[]; activeTabId: string | null }>;
  checkTarget(tabId: string, context: AutomationContext, operation?: 'close'): Promise<boolean>;
  open(url: string, context: AutomationContext, retain?: boolean): Promise<string>;
  closeTab(tabId: string, context: AutomationContext): Promise<void>;
  releaseSessionClaims(context: AutomationContext): Promise<void>;
  show(tabId: string, context: AutomationContext): Promise<void>;
  acquire(tabId: string, context: AutomationContext, signal: AbortSignal): Promise<IabCdpLease>;
  bindOperation(context: AutomationContext, signal: AbortSignal): () => void;
  drain(context: AutomationContext): Promise<void>;
  teardown(lease: IabCdpLease, signal: AbortSignal, cleanup: () => Promise<void>): Promise<void>;
  onTabsChanged(listener: (tabs: Pick<IabTab, 'id' | 'ownerId'>[]) => void): () => void;
}

export function serializeAutomationError(error: unknown): AutomationError {
  return {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && 'code' in error && typeof error.code === 'string' ? { code: error.code } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(serializeAutomationError) } : {}),
  };
}
export function deserializeAutomationError(error: AutomationError): Error {
  const result = error.errors
    ? new AggregateError(error.errors.map(deserializeAutomationError), error.message)
    : new Error(error.message);
  return Object.assign(result, error.code ? { code: error.code } : {});
}

