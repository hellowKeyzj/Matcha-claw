/**
 * Type surface for the upstream GenOffice Slides main module. It is
 * typechecked by the upstream workspace tsconfig; the plugin drives only the
 * runtime configuration, the view factory and the shared IPC registry.
 */
export interface SlidesRuntimePaths {
  preloadPath: string;
  rendererDevUrl?: string | undefined;
  rendererFilePath: string;
  openGeneratedPath?: (path: string) => boolean;
}

export function configureSlidesRuntime(paths: SlidesRuntimePaths): void;
export function autosavePathFor(filePath: string): string;
export function clearSlidesRecovery(identityPath: string): Promise<void>;
export function setImageDimensions(decode: (bytes: Uint8Array) => Promise<{ width: number; height: number } | null>): void;

export function createSlidesView(openPath?: string | null): {
  webContents: {
    id: number;
    isDestroyed(): boolean;
  };
};
