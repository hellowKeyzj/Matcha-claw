import { ipcMain, type BrowserWindow, type ContextMenuParams, type IpcMainEvent, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { isAppSpellcheckRequest, type AppSpellcheckLanguages, type AppSpellcheckRequest, type AppSpellcheckWord } from '../../../sdk/app-plugins/src/api';
import { requireDigest, requireObject, requirePluginId } from './package';
import type { ApplicationPluginOwner } from './owner';
import { logger } from '../../utils/logger';

type Owner = {
  id: string; pluginId: string; digest: string; entry: string; frame: WebFrameMain;
  armed: boolean; lastSeq: number; nativeSeq: number; epoch: string;
  claims: Map<number, { seq: number; at: number; x: number; y: number; source: 'pointer' | 'keyboard' }>;
  menus: Map<number, { at: number; word: string; suggestions: string[]; x: number; y: number; source: string }>;
  replacement?: { at: number; word: string; suggestions: string[] };
};
const UUID = /^[a-f0-9-]{36}$/;
const CLAIM_AGE_MS = 2000;

export function registerAppSpellcheckHandlers(options: {
  window: BrowserWindow;
  plugins: Pick<ApplicationPluginOwner, 'list'>;
  signal: AbortSignal;
}): () => Promise<void> {
  const { window, plugins, signal } = options;
  const contents = window.webContents;
  const native = contents.session;
  const owners = new Map<string, Owner>();
  const ignored = new Map<string, Set<string>>();
  const wordRequests = new Map<string, { owner: Owner; finish(error?: Error, result?: AppSpellcheckWord): void }>();
  let closed = false;
  let pending = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T> | T): Promise<T> => {
    if (closed || signal.aborted) return Promise.reject(new Error('Spelling is unavailable.'));
    if (pending >= 64) return Promise.reject(new Error('Too many spelling requests.'));
    pending++;
    const result = tail.then(operation);
    tail = result.then(() => { pending--; }, () => { pending--; });
    return result;
  };
  const assertSender = (event: IpcMainInvokeEvent | IpcMainEvent) => {
    if (closed || signal.aborted || window.isDestroyed() || contents.isDestroyed()
      || event.sender !== contents || event.senderFrame !== contents.mainFrame) throw new Error('Spelling requires the trusted application main frame.');
  };
  const hasFrame = (owner: Owner) => !contents.isDestroyed() && !owner.frame.isDestroyed() && !owner.frame.detached
    && owner.frame.parent === contents.mainFrame && owner.frame.url === 'about:srcdoc' && owner.frame.origin === 'null';
  const removeOwner = (owner: Owner) => {
    owners.delete(owner.id);
    owner.claims.clear(); owner.menus.clear();
    owner.replacement = undefined;
    for (const request of wordRequests.values()) if (request.owner === owner) request.finish(new Error('The spelling application closed.'));
    for (const [word, holders] of ignored) {
      if (!holders.delete(owner.id) || holders.size) continue;
      ignored.delete(word);
      native.removeWordFromSpellCheckerDictionary(word);
    }
  };
  const authorize = async (owner: Owner) => {
    const catalog = await plugins.list();
    if (closed || signal.aborted || owners.get(owner.id) !== owner || !hasFrame(owner)) throw new Error('The spelling application changed.');
    const plugin = catalog.plugins.find((item) => item.manifest.id === owner.pluginId && item.digest === owner.digest && item.enabled);
    if (!plugin?.manifest.contributes.applications?.some((application) => application.entry === owner.entry)) {
      removeOwner(owner);
      throw new Error('The spelling application is unavailable.');
    }
  };
  const requireFocused = (owner: Owner) => {
    if (!hasFrame(owner) || !window.isVisible() || !window.isFocused() || contents.focusedFrame !== owner.frame) {
      throw new Error('Focus the spelling application before retrying.');
    }
  };
  const languages = (): AppSpellcheckLanguages => ({ active: native.getSpellCheckerLanguages(), available: native.availableSpellCheckerLanguages });
  const pairMenus = (owner: Owner) => {
    const now = Date.now();
    for (const [nativeSeq, claim] of owner.claims) {
      if (now - claim.at > CLAIM_AGE_MS) { owner.claims.delete(nativeSeq); continue; }
      const menu = owner.menus.get(nativeSeq);
      if (!menu || now - menu.at > CLAIM_AGE_MS) continue;
      owner.claims.delete(nativeSeq);
      owner.menus.delete(nativeSeq);
      if ((claim.source === 'keyboard') !== (menu.source === 'keyboard')
        || claim.source === 'pointer' && (Math.abs(claim.x - menu.x) > 2 || Math.abs(claim.y - menu.y) > 2)) {
        owner.armed = false;
        owner.claims.clear(); owner.menus.clear(); owner.replacement = undefined;
        throw new Error('The native spelling menu sequence changed. Reopen the application to retry.');
      }
      owner.replacement = menu;
      contents.mainFrame.send('app-plugins:spellcheck-context-menu', {
        ownerId: owner.id, seq: claim.seq, misspelledWord: menu.word, suggestions: menu.suggestions,
      });
    }
    for (const [nativeSeq, menu] of owner.menus) if (now - menu.at > CLAIM_AGE_MS) owner.menus.delete(nativeSeq);
  };
  ipcMain.handle('app-plugins:spellcheck-owner', (event, value: unknown) => {
    assertSender(event);
    const input = requireObject(value, ['ownerId', 'pluginId', 'digest', 'entry', 'active']);
    if (typeof input.ownerId !== 'string' || !UUID.test(input.ownerId) || typeof input.active !== 'boolean') throw new Error('Invalid spelling owner.');
    requirePluginId(input.pluginId);
    requireDigest(input.digest);
    if (typeof input.entry !== 'string' || !input.entry || input.entry.length > 200) throw new Error('Invalid spelling application entry.');
    return enqueue(async () => {
      assertSender(event);
      const previous = owners.get(input.ownerId as string);
      if (!input.active) { if (previous) removeOwner(previous); return; }
      const frames = contents.mainFrame.frames.filter((frame) => frame.name === `matcha-app-${input.ownerId}`
        && frame.url === 'about:srcdoc' && frame.origin === 'null' && !frame.detached && !frame.isDestroyed());
      if (frames.length !== 1 || owners.size >= 128 && !previous) throw new Error('The spelling application frame is unavailable.');
      if (previous && previous.frame === frames[0] && previous.pluginId === input.pluginId && previous.digest === input.digest && previous.entry === input.entry) {
        await authorize(previous);
        return;
      }
      if (previous) removeOwner(previous);
      const owner: Owner = { id: input.ownerId as string, pluginId: input.pluginId as string, digest: input.digest as string,
        entry: input.entry as string, frame: frames[0], armed: false, lastSeq: 0, nativeSeq: 0, epoch: '', claims: new Map(), menus: new Map() };
      owners.set(owner.id, owner);
      try { await authorize(owner); } catch (error) { removeOwner(owner); throw error; }
    });
  });
  const checkWord = (owner: Owner, word: string): Promise<AppSpellcheckWord> => {
    if (wordRequests.size >= 8) return Promise.reject(new Error('Too many spelling dictionary requests.'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('The spelling dictionary did not respond.')), 5000);
      const finish = (error?: Error, result?: AppSpellcheckWord) => {
        if (!wordRequests.delete(id)) return;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result!);
      };
      wordRequests.set(id, { owner, finish });
      try { contents.mainFrame.send('app-plugins:spellcheck-check-word', { id, word }); }
      catch { finish(new Error('The spelling dictionary is unavailable.')); }
    });
  };
  const wordResult = (event: IpcMainEvent, value: unknown) => {
    try {
      assertSender(event);
      const input = requireObject(value, ['id', 'misspelled', 'suggestions']);
      if (typeof input.id !== 'string' || typeof input.misspelled !== 'boolean' || !Array.isArray(input.suggestions)
        || input.suggestions.length > 64 || !input.suggestions.every((word) => typeof word === 'string' && word.length <= 256)) return;
      const request = wordRequests.get(input.id);
      if (!request) return;
      if (owners.get(request.owner.id) !== request.owner || !hasFrame(request.owner)) request.finish(new Error('The spelling application changed.'));
      else request.finish(undefined, { misspelled: input.misspelled, suggestions: input.suggestions as string[] });
    } catch { /* Untrusted or retired responses do not settle native requests. */ }
  };
  ipcMain.on('app-plugins:spellcheck-word-result', wordResult);
  ipcMain.handle('app-plugins:spellcheck-call', (event, ownerId: unknown, value: unknown) => {
    assertSender(event);
    if (typeof ownerId !== 'string' || !UUID.test(ownerId)) throw new Error('Invalid spelling owner.');
    const input = requireObject(value, ['operation', 'seq', 'word', 'languages', 'nativeSeq', 'epoch', 'x', 'y', 'source']);
    const isReady = input.operation === 'contextMenuReady' && Object.keys(input).length === 2 && typeof input.epoch === 'string' && UUID.test(input.epoch);
    const isClaim = input.operation === 'claimContextMenu' && Object.keys(input).length === 7
      && Number.isSafeInteger(input.seq) && Number(input.seq) > 0 && Number.isSafeInteger(input.nativeSeq) && Number(input.nativeSeq) > 0
      && typeof input.epoch === 'string' && UUID.test(input.epoch) && typeof input.x === 'number' && Number.isFinite(input.x)
      && typeof input.y === 'number' && Number.isFinite(input.y) && (input.source === 'pointer' || input.source === 'keyboard');
    if (!isReady && !isClaim && (!isAppSpellcheckRequest(value) || input.operation === 'claimContextMenu')) throw new Error('Invalid spelling operation.');
    const request = value as Exclude<AppSpellcheckRequest, { operation: 'claimContextMenu' }>
      | { operation: 'contextMenuReady'; epoch: string }
      | { operation: 'claimContextMenu'; seq: number; nativeSeq: number; epoch: string; x: number; y: number; source: 'pointer' | 'keyboard' };
    return enqueue(async () => {
      assertSender(event);
      const owner = owners.get(ownerId);
      if (!owner) throw new Error('The spelling application is unavailable.');
      await authorize(owner);
      switch (request.operation) {
        case 'armContextMenu':
          owner.armed = false;
          owner.epoch = randomUUID();
          owner.claims.clear(); owner.menus.clear(); owner.replacement = undefined;
          return { epoch: owner.epoch };
        case 'contextMenuReady':
          if (request.epoch !== owner.epoch || owner.armed) throw new Error('The spelling menu handshake is stale.');
          owner.nativeSeq = 0;
          owner.lastSeq = 0;
          owner.armed = true;
          return;
        case 'claimContextMenu':
          if (!owner.armed || request.epoch !== owner.epoch || request.seq <= owner.lastSeq) throw new Error('The spelling menu claim is stale.');
          owner.lastSeq = request.seq;
          owner.claims.set(request.nativeSeq, { seq: request.seq, at: Date.now(), x: request.x, y: request.y, source: request.source });
          if (owner.claims.size > 8) owner.claims.delete(owner.claims.keys().next().value!);
          pairMenus(owner);
          return;
        case 'languages': return languages();
        case 'setLanguages': {
          const available = new Set(native.availableSpellCheckerLanguages);
          if (!request.languages.length || request.languages.some((language) => !available.has(language))) throw new Error('The spelling language is unavailable.');
          native.setSpellCheckerLanguages([...new Set(request.languages)]);
          return languages();
        }
        case 'addWord': {
          const word = request.word.trim();
          const added = native.addWordToSpellCheckerDictionary(word);
          if (added) ignored.delete(word);
          return added;
        }
        case 'ignoreWord': {
          const word = request.word.trim();
          const holders = ignored.get(word);
          if (holders) { holders.add(owner.id); return true; }
          // Never remove a word that was already in the user's permanent dictionary.
          if (ignored.size >= 2048) throw new Error('The temporary spelling dictionary is full.');
          const existing = await native.listWordsInSpellCheckerDictionary();
          await authorize(owner);
          if (existing.includes(word)) return true;
          const added = native.addWordToSpellCheckerDictionary(word);
          if (added) ignored.set(word, new Set([owner.id]));
          return added;
        }
        case 'replace':
          requireFocused(owner);
          if (!owner.replacement?.word || Date.now() - owner.replacement.at > 30_000
            || !owner.replacement.suggestions.includes(request.word)) throw new Error('The spelling suggestion is stale.');
          // Electron's editing command targets the focused frame, not params.frame.
          contents.replaceMisspelling(request.word);
          owner.replacement = undefined;
          return;
        case 'respellKick':
          requireFocused(owner);
          contents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
          contents.sendInputEvent({ type: 'char', keyCode: ' ' });
          contents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
          // The caller pauses PM's observer and scrubs this space after delivery.
          await new Promise((resolve) => setTimeout(resolve, 120));
          return;
        case 'checkWord': {
          const result = await checkWord(owner, request.word);
          await authorize(owner);
          return result;
        }
      }
    });
  });
  const contextMenu = (_event: Electron.Event, params: ContextMenuParams) => {
    const frame = params.frame;
    if (!frame || closed || signal.aborted) return;
    const owner = [...owners.values()].find((item) => item.frame === frame && item.armed);
    if (!owner) return;
    const at = Date.now();
    const nativeSeq = ++owner.nativeSeq;
    const epoch = owner.epoch;
    // Exact sequence pairing tolerates either pipe arriving first; expiry only discards.
    void enqueue(async () => {
      await authorize(owner);
      if (!owner.armed || owner.epoch !== epoch) return;
      owner.replacement = undefined;
      owner.menus.set(nativeSeq, { at, word: params.misspelledWord, suggestions: [...params.dictionarySuggestions],
        x: params.x, y: params.y, source: params.menuSourceType });
      if (owner.menus.size > 8) owner.menus.delete(owner.menus.keys().next().value!);
      pairMenus(owner);
    }).catch(() => {});
  };
  const clearMenus = () => {
    for (const owner of owners.values()) { owner.claims.clear(); owner.menus.clear(); owner.replacement = undefined; }
  };
  const clearOwners = () => { for (const owner of owners.values()) removeOwner(owner); };
  const navigating = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (details.isSameDocument) return;
    if (details.isMainFrame) clearOwners();
    else for (const owner of owners.values()) if (owner.frame === details.frame) removeOwner(owner);
  };
  contents.on('context-menu', contextMenu);
  contents.on('did-start-navigation', navigating);
  contents.on('render-process-gone', clearOwners);
  contents.on('destroyed', clearOwners);
  window.on('blur', clearMenus);
  window.on('hide', clearMenus);
  const close = async () => {
    if (closed) { await tail; return; }
    closed = true;
    clearOwners();
    ipcMain.removeHandler('app-plugins:spellcheck-owner');
    ipcMain.removeHandler('app-plugins:spellcheck-call');
    ipcMain.removeListener('app-plugins:spellcheck-word-result', wordResult);
    contents.removeListener('context-menu', contextMenu);
    contents.removeListener('did-start-navigation', navigating);
    contents.removeListener('render-process-gone', clearOwners);
    contents.removeListener('destroyed', clearOwners);
    window.removeListener('blur', clearMenus);
    window.removeListener('hide', clearMenus);
    signal.removeEventListener('abort', abort);
    await tail;
  };
  const abort = () => { void close().catch(() => logger.warn('[AppPlugins] Could not close native spelling.')); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  return close;
}
