/**
 * Type surface for the upstream GenOffice Sheets main module. The module is
 * typechecked by the upstream workspace tsconfig; the plugin only needs the
 * three entry points it drives from the worker.
 */
import type { FakeWebContents } from '../platform/electron-main';

export interface SheetsRuntimeConfig {
  preloadPath: string;
  rendererUrl?: string | undefined;
  rendererFile: string;
  sidecarPath?: string | undefined;
  systemLocale?: string;
  uiLanguage?: import('@genoffice/i18n').Lang;
  openGeneratedPath?: (path: string) => boolean;
  createDocument?: (request: unknown) => Promise<unknown>;
}

export function configureSheetsRuntime(config: SheetsRuntimeConfig): void;

export function createSheetsWindow(options?: { includeAiHandlers?: boolean }): Promise<{
  webContents: FakeWebContents;
}>;

export function stopSheetsSidecar(): void;

export function queueWorkbookForView(contents: unknown, path: string): void;
