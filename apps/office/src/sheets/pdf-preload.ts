import type { AppJson } from '@matcha/app-plugins-sdk';

type Reply = { id: number; result?: AppJson; error?: string };
let read: ((channel: string, args: unknown[]) => Promise<unknown>) | undefined;

/** The headless renderer can read only through its request-bound backend callback. */
export function bindSheetsPdfPort(port: MessagePort): () => void {
  let sequence = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  port.onmessage = ({ data }: MessageEvent<Reply>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error)); else request.resolve(data.result);
  };
  port.start();
  let active = true;
  let tail = Promise.resolve();
  read = (channel, args) => {
    // One native session; serialize eager image/pivot reads before the bounded host port.
    const result = tail.then(() => new Promise((resolve, reject) => {
      if (!active) { reject(new Error('Sheets PDF rendering ended.')); return; }
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      port.postMessage({ type: 'read', id, input: { channel, arguments: args } });
    }));
    tail = result.then(() => {}, () => {});
    return result;
  };
  return () => {
    active = false;
    read = undefined;
    for (const request of pending.values()) request.reject(new Error('Sheets PDF rendering ended.'));
    pending.clear();
    port.close();
  };
}

export const contextBridge = {
  exposeInMainWorld(key: string, value: unknown): void {
    Object.defineProperty(window, key, { value, configurable: true });
  }
};
export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!read) return Promise.reject(new Error('Sheets PDF backend is not bound.'));
    return read(channel, args);
  },
  send(): void {},
  on(): void {},
  once(): void {},
  removeListener(): void {}
};
export const webFrame = {
  isWordMisspelled(): never { throw new Error('Spelling is not part of document rendering.'); },
  getWordSuggestions(): never { throw new Error('Spelling is not part of document rendering.'); }
};
export const webUtils = { getPathForFile(): never { throw new Error('File selection is not part of document rendering.'); } };
