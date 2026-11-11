import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { APP_SERVICE_MAX_BYTES } from '../../../sdk/app-plugins/src/services';
import { MAX_APP_PLUGIN_FILES } from '../../../sdk/app-plugins/src/limits';
import { isAppDocumentResourcesRequest, type AppDocumentResourcesResult } from '../../../sdk/app-plugins/src/document-resources';
import type { AppPluginCatalog } from '../../../src/types/desktop/app-plugin';
import type { ApplicationPluginOwner } from './owner';
import { AppPluginError, requireDigest, requireObject, requirePluginId } from './package';

type Owner = { id: string; pluginId: string; digest: string; entry: string; frame: WebFrameMain };
type Resource = { bytes: Uint8Array; mimeType: string };
type Snapshot = AppDocumentResourcesResult & { owner: Owner; files: Map<string, Resource>; bytes: number; leased: boolean; references: number };
export interface AppDocumentResourcesReference extends AppDocumentResourcesResult { release(): void }
export type AppDocumentResourcesOwner = ReturnType<typeof registerAppDocumentResourcesHandlers>;
const CHANNELS = ['app-plugins:document-resources-owner', 'app-plugins:document-resources-create', 'app-plugins:document-resources-release', 'app-plugins:document-resources-release-owner'] as const;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new AppPluginError('invalid_package', 'Invalid document resource identity.');
  return value;
}
function path(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:]/.test(value)
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new AppPluginError('invalid_package', 'Invalid document-relative resource path.');
  return value;
}

/** Read-only in-memory document bytes, never package assets or native file paths. */
export function registerAppDocumentResourcesHandlers(options: {
  window: BrowserWindow;
  plugins: Pick<ApplicationPluginOwner, 'list'>;
  signal: AbortSignal;
}) {
  const contents = options.window.webContents;
  const owners = new Map<string, Owner>();
  const snapshots = new Map<string, Snapshot>();
  // One bridge envelope of decoded content across all leases/live references. The package
  // file-count limit also bounds metadata nodes (owners, leases, files and retained handles).
  let bytes = 0;
  let nodes = 0;
  let closed = false;
  const fail = (message: string): never => { throw new AppPluginError('invalid_package', message); };
  const budget = (additionalNodes: number, additionalBytes = 0) => {
    if (nodes + additionalNodes > MAX_APP_PLUGIN_FILES || bytes + additionalBytes > APP_SERVICE_MAX_BYTES) fail('Document resource budget exceeded. Release unused snapshots.');
  };
  const assertMain = (event: IpcMainInvokeEvent) => {
    if (closed || options.signal.aborted || options.window.isDestroyed() || contents.isDestroyed()
      || event.sender !== contents || event.senderFrame !== contents.mainFrame) fail('Document resources require the trusted application main frame.');
  };
  const hasFrame = (owner: Owner) => !contents.isDestroyed() && !owner.frame.isDestroyed() && !owner.frame.detached
    && owner.frame.parent === contents.mainFrame && owner.frame.url === 'about:srcdoc' && owner.frame.origin === 'null';
  const drop = (snapshot: Snapshot) => {
    if (!snapshots.delete(snapshot.id)) return;
    nodes -= 1 + snapshot.files.size + snapshot.references;
    bytes -= snapshot.bytes;
  };
  const releaseOwner = (owner: Owner) => {
    if (owners.get(owner.id) !== owner) return;
    owners.delete(owner.id);
    nodes--;
    for (const snapshot of snapshots.values()) if (snapshot.owner === owner) drop(snapshot);
  };
  const current = (catalog: AppPluginCatalog, owner: Owner) => catalog.plugins.some(plugin => plugin.enabled
    && plugin.manifest.id === owner.pluginId && plugin.digest === owner.digest
    && plugin.manifest.contributes.applications?.some(application => application.entry === owner.entry));
  const authorize = async (owner: Owner) => {
    const catalog = await options.plugins.list();
    if (closed || options.signal.aborted || owners.get(owner.id) !== owner || !hasFrame(owner) || !current(catalog, owner)) {
      releaseOwner(owner);
      throw new AppPluginError('not_found', 'The document resource owner is unavailable.');
    }
  };
  const ownerFor = (value: unknown) => {
    const owner = owners.get(id(value));
    if (!owner) throw new AppPluginError('not_found', 'The document resource owner is unavailable.');
    return owner;
  };
  const snapshotFor = (owner: Owner, value: unknown) => {
    const snapshot = snapshots.get(id(value));
    if (!snapshot || snapshot.owner !== owner) throw new AppPluginError('not_found', 'The document resource snapshot is unavailable.');
    return snapshot;
  };
  ipcMain.handle(CHANNELS[0], async (event, value: unknown) => {
    assertMain(event);
    const input = requireObject(value, ['ownerId', 'pluginId', 'digest', 'entry']);
    const ownerId = id(input.ownerId);
    requirePluginId(input.pluginId);
    requireDigest(input.digest);
    if (typeof input.entry !== 'string' || !input.entry || input.entry.length > 200) fail('Invalid document resource application entry.');
    const frames = contents.mainFrame.frames.filter(frame => frame.name === `matcha-app-${ownerId}`
      && frame.url === 'about:srcdoc' && frame.origin === 'null' && !frame.detached && !frame.isDestroyed());
    if (frames.length !== 1) fail('The document resource application frame is unavailable.');
    const previous = owners.get(ownerId);
    if (previous) {
      if (previous.pluginId !== input.pluginId || previous.digest !== input.digest || previous.entry !== input.entry || previous.frame !== frames[0]) fail('The document resource owner is already registered.');
      await authorize(previous);
      return;
    }
    budget(1);
    const owner: Owner = { id: ownerId, pluginId: input.pluginId, digest: input.digest, entry: input.entry as string, frame: frames[0] };
    owners.set(ownerId, owner);
    nodes++;
    try { await authorize(owner); assertMain(event); } catch (error) { releaseOwner(owner); throw error; }
  });
  ipcMain.handle(CHANNELS[1], async (event, ownerId: unknown, value: unknown) => {
    assertMain(event);
    const owner = ownerFor(ownerId);
    if (Buffer.byteLength(JSON.stringify([ownerId, value])) + 1024 > APP_SERVICE_MAX_BYTES) fail('Document resource request exceeds the bridge envelope.');
    if (!isAppDocumentResourcesRequest(value)) fail('Invalid document resource snapshot.');
    const input = value as import('../../../sdk/app-plugins/src/document-resources').AppDocumentResourcesRequest;
    await authorize(owner);
    assertMain(event);
    const files = new Map<string, Resource>();
    let size = 0;
    const entry = input.entry.path;
    for (const file of [input.entry, ...input.resources]) {
      const content = Buffer.from(file.data, 'base64');
      size += content.byteLength;
      budget(1 + files.size + 1, size);
      files.set(file.path, { bytes: content, mimeType: file.mimeType });
    }
    const snapshotId = randomUUID();
    const rootUrl = `matcha-app://document-${snapshotId}.invalid/`;
    const snapshot: Snapshot = { id: snapshotId, rootUrl, url: rootUrl + entry.split('/').map(encodeURIComponent).join('/'),
      owner, files, bytes: size, leased: true, references: 0 };
    snapshots.set(snapshotId, snapshot);
    nodes += 1 + files.size;
    bytes += size;
    return { id: snapshot.id, url: snapshot.url, rootUrl };
  });
  ipcMain.handle(CHANNELS[2], (event, ownerId: unknown, value: unknown) => {
    assertMain(event);
    const input = requireObject(value, ['id']);
    const snapshot = snapshotFor(ownerFor(ownerId), input.id);
    snapshot.leased = false;
    if (!snapshot.references) drop(snapshot);
  });
  ipcMain.handle(CHANNELS[3], (event, value: unknown) => {
    assertMain(event);
    const input = requireObject(value, ['ownerId']);
    const owner = owners.get(id(input.ownerId));
    if (owner) releaseOwner(owner);
  });
  const clear = () => {
    for (const owner of owners.values()) releaseOwner(owner);
  };
  const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) clear(); };
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', clear);
  contents.on('destroyed', clear);
  const close = () => {
    if (closed) return;
    closed = true;
    clear();
    options.signal.removeEventListener('abort', close);
    contents.removeListener('did-start-navigation', navigation);
    contents.removeListener('render-process-gone', clear);
    contents.removeListener('destroyed', clear);
    for (const channel of CHANNELS) ipcMain.removeHandler(channel);
  };
  options.signal.addEventListener('abort', close, { once: true });
  if (options.signal.aborted) close();
  return {
    async get(ownerId: string, snapshotId: string): Promise<AppDocumentResourcesReference> {
      const owner = ownerFor(ownerId);
      const snapshot = snapshotFor(owner, snapshotId);
      if (!snapshot.leased) throw new AppPluginError('not_found', 'The document resource lease was released.');
      await authorize(owner);
      if (snapshots.get(snapshot.id) !== snapshot || !snapshot.leased) throw new AppPluginError('not_found', 'The document resource lease was released.');
      budget(1);
      snapshot.references++;
      nodes++;
      let released = false;
      return { id: snapshot.id, url: snapshot.url, rootUrl: snapshot.rootUrl, release() {
        if (released) return;
        released = true;
        if (snapshots.get(snapshot.id) !== snapshot) return;
        snapshot.references--;
        nodes--;
        if (!snapshot.leased && !snapshot.references) drop(snapshot);
      } };
    },
    async read(value: string): Promise<Resource> {
      const target = new URL(value);
      const match = /^document-([a-f0-9-]{36})\.invalid$/.exec(target.hostname);
      if (target.protocol !== 'matcha-app:' || !match || target.username || target.password || target.port) throw new AppPluginError('invalid_package', 'Invalid document resource URL.');
      const snapshot = snapshots.get(id(match[1]));
      if (!snapshot) throw new AppPluginError('not_found', 'The document resource snapshot is unavailable.');
      const segments = target.pathname.slice(1).split('/').map(segment => {
        const decoded = decodeURIComponent(segment);
        if (decoded.includes('/')) fail('Invalid document resource URL segment.');
        return decoded;
      });
      const name = path(segments.join('/'));
      await authorize(snapshot.owner);
      const file = snapshots.get(snapshot.id) === snapshot ? snapshot.files.get(name) : undefined;
      if (!file) throw new AppPluginError('not_found', 'The document resource is unavailable.');
      return file;
    },
    reconcile(catalog: AppPluginCatalog) {
      for (const owner of owners.values()) if (!current(catalog, owner)) releaseOwner(owner);
    },
    close,
  };
}
