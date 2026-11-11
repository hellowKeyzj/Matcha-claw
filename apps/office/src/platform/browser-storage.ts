import { callTool } from '../documents/client';
import type { BrowserStorageChange } from './browser-preferences';

const stores = { localStorage: new Map<string, string>(), sessionStorage: new Map<string, string>() };
const app = document.documentElement.dataset.officeApp;
const persistent = !!window.matchaApp;
if (persistent && (!app || !['docs', 'sheets', 'slides', 'pdf', 'markdown', 'html'].includes(app))) throw new Error('Office editor identity is missing.');
const tool = `office_${app}_ipc`;
let writes: Promise<unknown> = Promise.resolve();
const failedWrites = new Map<string | null, unknown>();

function reportError(error: unknown): void {
  window.dispatchEvent(new ErrorEvent('error', { message: error instanceof Error ? error.message : String(error), error }));
}

function persist(change: BrowserStorageChange): void {
  const send = async () => {
    try {
      await callTool(tool, { channel: 'office:browser-storage:set', arguments: [change] });
      if (change.key === null) failedWrites.clear();
      else failedWrites.delete(change.key);
    } catch (error) {
      failedWrites.set(change.key, error);
      throw error;
    }
  };
  writes = writes.then(send, send);
  void writes.catch(reportError);
}

export async function flushBrowserStorage(): Promise<void> {
  await writes;
  if (failedWrites.size) throw failedWrites.values().next().value;
}

// Opaque frames cannot use browser storage; only editor preferences cross the plugin bridge.
for (const name of ['localStorage', 'sessionStorage'] as const) {
  const values = stores[name];
  const save = (change: BrowserStorageChange) => { if (persistent && name === 'localStorage') persist(change); };
  const storage: Storage = {
    get length() { return values.size; },
    clear() { values.clear(); save({ key: null, value: null }); },
    getItem(key) { return values.get(String(key)) ?? null; },
    key(index) { return [...values.keys()][index >>> 0] ?? null; },
    removeItem(key) { key = String(key); values.delete(key); save({ key, value: null }); },
    setItem(key, value) { key = String(key); value = String(value); values.set(key, value); save({ key, value }); }
  };
  Object.defineProperty(window, name, { value: storage, configurable: true });
}

if (persistent) {
  try {
    const { result } = await callTool<{ result: Record<string, string> }>(tool, { channel: 'office:browser-storage:get', arguments: [] });
    for (const [key, value] of Object.entries(result)) stores.localStorage.set(key, value);
  } catch (error) {
    reportError(error);
    throw error;
  }
}
