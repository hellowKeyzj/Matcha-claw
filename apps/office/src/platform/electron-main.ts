/**
 * Minimal Electron main-process surface used when the upstream GenOffice
 * Sheets main module runs inside a MatchaClaw app-plugin worker. Only the
 * pieces its workbook pipeline touches are implemented; window, menu and
 * native-dialog features that belong to the GenOffice desktop shell are
 * inert and never reached by the plugin page.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type IpcHandler = (event: FakeIpcEvent, ...args: unknown[]) => unknown;
type Listener = (...args: unknown[]) => void;

const paths: Record<string, string> = {
  userData: join(tmpdir(), 'matcha-office-sheets'),
  temp: tmpdir(),
  documents: tmpdir(),
  home: tmpdir(),
  appData: tmpdir()
};

export function configureAppPaths(next: Readonly<Record<string, string>>): void {
  Object.assign(paths, next);
}

const handlers = new Map<string, IpcHandler>();
const ipcListeners = new Map<string, Set<IpcHandler>>();
const sendListeners = new Set<(channel: string, payload: unknown, senderId: number) => void>();

export function onWebContentsSend(listener: (channel: string, payload: unknown, senderId: number) => void): () => void {
  sendListeners.add(listener);
  return () => sendListeners.delete(listener);
}

export function hasIpcHandler(channel: string): boolean {
  return handlers.has(channel);
}

export interface FakeWebContents {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: Listener): FakeWebContents;
  once(channel: string, listener: Listener): FakeWebContents;
  removeListener(channel: string, listener: Listener): FakeWebContents;
  setWindowOpenHandler(handler: unknown): void;
  openDevTools(): void;
  closeDevTools(): void;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  loadFile(file: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  readonly session: Record<string, unknown>;
  readonly navigationHistory: Record<string, unknown>;
  readonly mainFrame: Record<string, unknown>;
}

let nextWebContentsId = 1;
const allWebContents = new Map<number, FakeWebContents>();
const destroyContents = new Map<number, () => void>();

export function destroyWebContents(id: number): void {
  destroyContents.get(id)?.();
}

export function createWebContents(): FakeWebContents {
  const id = nextWebContentsId++;
  const listeners = new Map<string, Set<Listener>>();
  let destroyed = false;
  const contents: FakeWebContents = {
    id,
    isDestroyed: () => destroyed,
    send(channel, ...args) {
      for (const listener of sendListeners) listener(channel, args[0], id);
    },
    on(channel, listener) {
      let set = listeners.get(channel);
      if (!set) listeners.set(channel, (set = new Set()));
      set.add(listener);
      return contents;
    },
    once(channel, listener) {
      const wrapped: Listener = (...args) => {
        listeners.get(channel)?.delete(wrapped);
        listener(...args);
      };
      return contents.on(channel, wrapped);
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
      return contents;
    },
    setWindowOpenHandler() {},
    openDevTools() {},
    closeDevTools() {},
    getURL: () => 'about:blank',
    loadURL: async () => {},
    loadFile: async () => {},
    executeJavaScript: async () => ({}),
    session: {},
    navigationHistory: {},
    mainFrame: {}
  };
  allWebContents.set(id, contents);
  destroyContents.set(id, () => {
    if (destroyed) return;
    destroyed = true;
    for (const listener of listeners.get('destroyed') ?? []) listener();
    listeners.clear();
    allWebContents.delete(id);
    destroyContents.delete(id);
  });
  return contents;
}

export interface FakeIpcEvent {
  readonly sender: FakeWebContents;
  readonly senderFrame: Record<string, unknown>;
  reply(channel: string, ...args: unknown[]): void;
}

export function createIpcEvent(sender: FakeWebContents = createWebContents()): FakeIpcEvent {
  return {
    sender,
    senderFrame: {},
    reply(channel, ...args) {
      sender.send(channel, ...args);
    }
  };
}

export async function invokeIpc(channel: string, args: readonly unknown[], event: FakeIpcEvent): Promise<unknown> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No Sheets IPC handler is registered for ${channel}.`);
  return handler(event, ...args);
}

export async function dispatchIpc(channel: string, args: readonly unknown[], event: FakeIpcEvent): Promise<void> {
  const registered = ipcListeners.get(channel);
  if (!registered?.size) throw new Error(`No Office IPC listener is registered for ${channel}.`);
  for (const listener of [...registered]) await listener(event, ...args);
}

export const ipcMain = {
  handle(channel: string, handler: IpcHandler): void {
    handlers.set(channel, handler);
  },
  handleOnce(channel: string, handler: IpcHandler): void {
    handlers.set(channel, handler);
  },
  removeHandler(channel: string): void {
    handlers.delete(channel);
  },
  on(channel: string, listener: IpcHandler): void {
    let registered = ipcListeners.get(channel);
    if (!registered) ipcListeners.set(channel, (registered = new Set()));
    registered.add(listener);
  },
  once(channel: string, listener: IpcHandler): void {
    const wrapped: IpcHandler = (event, ...args) => {
      ipcListeners.get(channel)?.delete(wrapped);
      return listener(event, ...args);
    };
    ipcMain.on(channel, wrapped);
  },
  removeListener(channel: string, listener: IpcHandler): void {
    ipcListeners.get(channel)?.delete(listener);
  }
};

export const contextBridge = {
  exposeInMainWorld(_key: string, _value: unknown): void {}
};

export const ipcRenderer = {
  invoke: async (): Promise<unknown> => undefined,
  send(): void {},
  on(): void {},
  once(): void {},
  removeListener(): void {}
};

export const webFrame = {};
export const webUtils = { getPathForFile: (): string => '' };

export const app = {
  isPackaged: false,
  name: 'Matcha Office',
  commandLine: { appendSwitch(): void {} },
  getPath(name: string): string {
    return paths[name] ?? paths.userData!;
  },
  setPath(name: string, value: string): void {
    paths[name] = value;
  },
  getAppPath: (): string => paths.userData!,
  getName: (): string => 'Matcha Office',
  getVersion: (): string => '0.1.0',
  getLocale: (): string => 'en-US',
  getSystemLocale: (): string => 'en-US',
  getPreferredSystemLanguages: (): string[] => ['en-US'],
  getLocaleCountryCode: (): string => 'US',
  isReady: (): boolean => true,
  whenReady: async (): Promise<void> => {},
  on(): void {},
  once(): void {},
  off(): void {},
  quit(): void {},
  exit(): void {},
  setAccessibilitySupportEnabled(): void {},
  setAppUserModelId(): void {},
  requestSingleInstanceLock: (): boolean => true,
  releaseSingleInstanceLock(): void {},
  dock: { setIcon(): void {}, show(): void {}, hide(): void {} }
};

export const screen = {
  getPrimaryDisplay: () => ({
    id: 1,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 0, width: 1440, height: 900 }
  }),
  getAllDisplays: () => [screen.getPrimaryDisplay()],
  getDisplayNearestPoint: () => screen.getPrimaryDisplay()
};

export const session = {
  defaultSession: {
    protocol: {
      handle(): void {},
      unhandle(): void {}
    },
    resolveProxy: async (): Promise<string> => 'DIRECT',
    setPermissionRequestHandler(): void {},
    setDisplayMediaRequestHandler(): void {},
    webRequest: { onHeadersReceived(): void {}, onBeforeRequest(): void {} }
  }
};

export const protocol = {
  registerSchemesAsPrivileged(): void {},
  handle(): void {},
  unhandle(): void {},
  isProtocolHandled: async (): Promise<boolean> => false
};

export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showOpenDialogSync: () => undefined,
  showSaveDialog: async () => ({ canceled: true, filePath: undefined }),
  showSaveDialogSync: () => undefined,
  showMessageBox: async () => ({ response: 0, checkboxChecked: false, checkboxLabel: '' }),
  showMessageBoxSync: () => 0,
  showErrorBox(): void {},
  createMessageBox: () => ({ showMessageBox: async () => ({ response: 0 }) })
};

export class BrowserWindow {
  readonly webContents: FakeWebContents;
  readonly contentView = { addChildView(): void {}, removeChildView(): void {} };
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(_options?: unknown) {
    this.webContents = createWebContents();
  }

  static fromWebContents(): undefined {
    return undefined;
  }

  static getAllWindows(): BrowserWindow[] {
    return [];
  }

  static getFocusedWindow(): null {
    return null;
  }

  loadURL(_url: string): Promise<void> {
    return Promise.resolve();
  }

  loadFile(_file: string): Promise<void> {
    return Promise.resolve();
  }

  show(): void {}
  hide(): void {}
  focus(): void {}
  blur(): void {}
  close(): void {}
  destroy(): void {}
  isDestroyed(): boolean {
    return false;
  }
  isVisible(): boolean {
    return false;
  }
  maximize(): void {}
  unmaximize(): void {}
  minimize(): void {}
  restore(): void {}
  setTitle(): void {}
  setBounds(): void {}
  getBounds() {
    return { x: 0, y: 0, width: 1440, height: 900 };
  }
  setMenu(): void {}
  setMenuBarVisibility(): void {}
  removeMenu(): void {}
  on(channel: string, listener: Listener): this {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
    return this;
  }
  once(channel: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.listeners.get(channel)?.delete(wrapped);
      listener(...args);
    };
    return this.on(channel, wrapped);
  }
  off(channel: string, listener: Listener): this {
    this.listeners.get(channel)?.delete(listener);
    return this;
  }
  static getContentBounds(): Record<string, number> {
    return { x: 0, y: 0, width: 1440, height: 900 };
  }
}

export class WebContentsView {
  readonly webContents: FakeWebContents;
  constructor(_options?: unknown) {
    this.webContents = createWebContents();
  }
  setBounds(): void {}
  setBackgroundColor(): void {}
  setVisible(): void {}
}

export class Menu {
  static buildFromTemplate(): { popup(): void; items: unknown[] } {
    return { popup(): void {}, items: [] };
  }
  static setApplicationMenu(): void {}
  static getApplicationMenu(): null {
    return null;
  }
}

export class MenuItem {
  constructor(_options?: unknown) {}
}

export const net = {
  fetch: (input: string | URL, init?: RequestInit): Promise<Response> => fetch(input, init)
};

export const shell = {
  openExternal: async (): Promise<void> => {},
  openPath: async (): Promise<string> => '',
  showItemInFolder(): void {},
  beep(): void {}
};

export const systemPreferences = {
  getMediaAccessStatus: (): string => 'granted',
  askForMediaAccess: async (): Promise<boolean> => true
};

export const desktopCapturer = {
  getSources: async (): Promise<unknown[]> => []
};

export const webContents = {
  getAllWebContents: (): FakeWebContents[] => [...allWebContents.values()],
  fromId: (id: number): FakeWebContents | undefined => allWebContents.get(id),
  getFocusedWebContents: (): undefined => undefined
};

export const clipboard = {
  availableFormats: (): string[] => [],
  readText: (): string => '',
  readBuffer: (): null => null,
  writeText(): void {},
  writeBuffer(): void {},
  write(): void {},
  readImage: () => ({ isEmpty: () => true }),
  writeImage(): void {}
};

export const nativeImage = {
  createFromBuffer: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0), resize: () => nativeImage.createFromBuffer() }),
  createFromPath: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
  createThumbnailFromPath: async () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) })
};

export const globalShortcut = {
  register: (): boolean => false,
  unregister(): void {},
  unregisterAll(): void {}
};
