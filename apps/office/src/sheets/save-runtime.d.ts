import type { WorkbookFile, WorkbookSaveRequest } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import type { FakeIpcEvent, FakeWebContents } from '../platform/electron-main';

export interface PreparedWorkbook {
  openPath: string;
  suggestSaveAs?: string;
  csvImport?: boolean;
  csvSourcePath?: string;
  emptyCsv?: boolean;
  importTempDir?: string;
  restoreTarget?: string;
  emptySource?: boolean;
  unsavedNew?: boolean;
}
export function prepareWorkbookForOpen(client: SheetsTabSession['client'], path: string, contents?: FakeWebContents, parent?: undefined, options?: {
  skipRecoveryPrompt?: boolean;
  import?: { onProgress?: (progress: { phase: 'read' | 'write'; fraction: number }) => void; signal?: AbortSignal };
}): Promise<PreparedWorkbook | null>;
export function recoveryPathFor(path: string): string;
export function pendingRecoveryFor(path: string): string | null;
export function promptRecoveryRestore(contents: FakeWebContents, path: string, recoveryPath: string, onDisk?: boolean): Promise<'restore' | 'discard' | 'dismissed'>;

export interface SessionInfo {
  readonly path: string;
  readonly snapshotPath: string;
  readonly sha256: string;
  readonly sheetNames: ReadonlyMap<string, string>;
  readonly automaticRecoveryDisabled: boolean;
  readonly password?: string;
  readonly suggestSaveAs?: string;
  readonly unsavedNew?: boolean;
  readonly csvSourcePath?: string;
  readonly importTempDir?: string;
  readonly restoreTarget?: string;
}
export interface SheetsTabSession {
  readonly webContents: FakeWebContents;
  readonly client: {
    close(sessionId: string): Promise<void>;
    listExternalLinks(input: { path: string }): Promise<unknown>;
    updateExternalLinks(input: { path: string }): Promise<unknown>;
  };
  readonly sessions: Map<string, SessionInfo>;
  currentPath: string | null;
}
export function sessionFor(event: FakeIpcEvent): SheetsTabSession;
export function resolveTransferredEdits(entry: SheetsTabSession, request: WorkbookSaveRequest): WorkbookSaveRequest;
export const workbookSaveRequestSchema: { parse(input: unknown): WorkbookSaveRequest };
export function writeWorkbookTo(client: SheetsTabSession['client'], session: SessionInfo, request: WorkbookSaveRequest, targetPath: string): Promise<{ touchedEntries: readonly string[] }>;
export function openWorkbookSession(client: SheetsTabSession['client'], path: string, sessions: Map<string, SessionInfo>, options?: { password?: string }): Promise<WorkbookFile>;
export function clearWorkbookRecovery(path: string): void;
export const recoveryPromptWaiters: Map<number, (choice: 'restore' | 'discard' | 'dismissed') => void>;
