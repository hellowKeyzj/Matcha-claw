/**
 * Electron API Type Declarations
 * Types for the APIs exposed via contextBridge
 */

export interface IpcRenderer {
  /**
   * Includes gateway/openclaw plus app-specific channels such as:
   * `teamfs:initLayout`, `teamfs:prepareTask`, `teamfs:publishTask`, `teamfs:publishShared`.
   */
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (...args: unknown[]) => void): (() => void) | void;
  once(channel: string, callback: (...args: unknown[]) => void): void;
  off(channel: string, callback?: (...args: unknown[]) => void): void;
}

export interface ElectronAPI {
  ipcRenderer: IpcRenderer;
  openExternal: (url: string) => Promise<void>;
  platform: NodeJS.Platform;
  isDev: boolean;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
