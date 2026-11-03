import type { BrowserStorageAction } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject } from '../../../src/types/desktop/iab';
import { IabAutomationPage, type Operation } from './automation-page';

export async function storageOperation(page: IabAutomationPage, params: BrowserStorageAction, operation: Operation): Promise<IabJsonObject> {
  const action = params.operation ?? 'get';
  const storageType = params.storageType ?? 'local';
  if (storageType !== 'indexedDB') {
    const storage = storageType === 'session' ? 'sessionStorage' : 'localStorage';
    const key = JSON.stringify(params.key ?? '');
    const expression = action === 'set' ? `${storage}.setItem(${key},${JSON.stringify(params.value ?? '')});true` : action === 'remove' ? `${storage}.removeItem(${key});true` : action === 'clear' ? `${storage}.clear();true` : params.key ? `${storage}.getItem(${key})` : `Object.fromEntries(Object.entries(${storage}))`;
    const value = await page.evaluate(expression, operation) ?? null;
    return { operation: action, storageType, ...(action === 'get' ? { value } : {}) };
  }
  const input = { key: params.key, value: params.value, operation: action };
  const value = await page.evaluate(`(${indexedDbOperation})(${JSON.stringify(input)})`, operation);
  return { operation: action, storageType, ...(action === 'get' ? { value } : {}) };
}

// Runs in the page's origin. Every transaction/open/delete path closes the database.
const indexedDbOperation = `async function(input) {
  const request = (value, failure) => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error || new Error(failure)); value.onblocked = () => reject(new Error('database blocked by open connections')); });
  let value = null;
  if (typeof input.value === 'string' && input.value.trim()) {
    try { value = JSON.parse(input.value); }
    catch { throw new Error('indexedDB ' + input.operation + ': value must be a JSON object'); }
  }
  if (!input.key) {
    if (input.operation === 'get') return await (indexedDB.databases ? indexedDB.databases() : Promise.resolve([]));
    throw new Error('indexedDB ' + input.operation + ': key (database name) is required');
  }
  if (input.operation === 'set' && (!value || typeof value !== 'object' || typeof value.store !== 'string')) {
    throw new Error('indexedDB set: value must be {"store": "<name>", "data": <record|records[]>}');
  }
  if (input.operation === 'clear' || input.operation === 'remove' && !(value && typeof value === 'object' && typeof value.store === 'string')) { await request(indexedDB.deleteDatabase(input.key), 'delete failed'); return { removed: true }; }
  const database = input.operation === 'get' ? await new Promise((resolve, reject) => {
    let missing = false;
    const open = indexedDB.open(input.key);
    open.onupgradeneeded = () => { missing = true; open.transaction.abort(); };
    open.onsuccess = () => {
      if (!missing) return resolve(open.result);
      open.result.close();
      reject(new Error('database not found: ' + input.key));
    };
    open.onerror = () => reject(missing ? new Error('database not found: ' + input.key) : open.error || new Error('open failed'));
    open.onblocked = () => reject(new Error('database blocked by open connections'));
  }) : await request(indexedDB.open(input.key), 'open failed');
  try {
    if (input.operation === 'get') {
      const stores = {};
      for (const name of database.objectStoreNames) {
        const transaction = database.transaction(name, 'readonly');
        const store = transaction.objectStore(name);
        const [count, records] = await Promise.all([request(store.count()), request(store.getAll(undefined, 20))]);
        stores[name] = { keyPath: store.keyPath, autoIncrement: store.autoIncrement, count, records: records || [] };
      }
      return { name: database.name, version: database.version, stores };
    }
    if (!database.objectStoreNames.contains(value.store)) {
      throw new Error('object store not found: ' + value.store + (input.operation === 'set' ? ' (stores: ' + Array.from(database.objectStoreNames).join(', ') + ')' : ''));
    }
    const items = input.operation === 'set' ? (Array.isArray(value.data) ? value.data : [value.data]) : [];
    if (input.operation === 'set' && items.length === 0) return { written: 0 };
    const transaction = database.transaction(value.store, 'readwrite');
    const completion = new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(transaction.error || new Error('transaction aborted')); });
    try {
      const store = transaction.objectStore(value.store);
      if (input.operation === 'set') {
        for (const record of items) {
          if (record && typeof record === 'object' && !store.keyPath && 'key' in record && 'value' in record) store.put(record.value, record.key);
          else store.put(record);
        }
      } else if (input.operation === 'remove') {
        if (value.key !== undefined) store.delete(value.key);
        else store.clear();
      } else throw new Error('Unsupported IndexedDB operation');
    } catch (error) {
      try { transaction.abort(); } catch {}
      try { await completion; } catch {}
      throw error;
    }
    await completion;
    return input.operation === 'set' ? { written: items.length } : { removed: value.key !== undefined ? String(value.key) : 'store:' + value.store };
  } finally { database.close(); }
}`;
