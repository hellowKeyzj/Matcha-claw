/** Runs the upstream Slides editor against library-owned documents. */
import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { commitSaved, savePptxToFile } from '@genoffice/pptx-engine';
import { atomicWriteVia } from '@genoffice/electron-utils/atomic-write';
import { safeExternalUrl } from '@genoffice/electron-utils/safe-external-url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeLang, setUiLang } from '@genoffice/i18n';
import { activeProvider, defaultAiSettings, resolveAiSettings } from '../../genoffice/packages/ai-provider/src/providers';
import { hasGskAuth, gskLoginInfo } from '../../genoffice/packages/ai-search/src/gsk';
import { OfficeError, errorMessage } from '../errors';
import { decodeBase64, text } from '../documents/validation';
import { tiffToPng } from '../../genoffice/apps/slides/src/main/tiff-decode';
import { imageSize } from '../../genoffice/packages/cli/src/formats/image-size';
import {
  createIpcEvent,
  destroyWebContents,
  dispatchIpc,
  invokeIpc,
  ipcMain,
  onWebContentsSend
} from '../platform/electron-main';

type SlidesMain = typeof import('@matcha/slides-main');
type SessionState = typeof import('@matcha/slides-session-state');
type SlidesView = ReturnType<SlidesMain['createSlidesView']>;
type LibraryDeck = { directory: string; path: string; documentId: string; revision: number; name: string };

function jsonSettings(value: unknown): AppJson {
  return JSON.parse(JSON.stringify(value)) as AppJson;
}

const SLIDES_AI_CHANNELS = [
  'ai:generate-image',
  'ai:analyze-media',
  'ai:save-sidecar',
  'ai:save-style-template',
  'ai:list-style-templates',
  'ai:load-style-template'
];

export interface SlidesSessionHooks {
  saveDocument(documentId: string, expectedRevision: number, produce: () => Promise<Uint8Array>): Promise<number>;
  createDocument(name: string, produce: () => Promise<Uint8Array>): Promise<{ documentId: string; revision: number; name: string }>;
  readDocument(documentId: string): Promise<{ record: { name: string; revision: number } }>;
}

export interface SlidesSession {
  call(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  action(documentId: string, action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  open(documentId: string, name: string, bytes: Uint8Array, revision: number, editorId?: string): Promise<unknown>;
  beginClose(): void;
  dispose(): Promise<void>;
}

export function createSlidesSession(context: AppPluginContext, hooks: SlidesSessionHooks): SlidesSession {
  setUiLang(normalizeLang(process.env.LANG ?? process.env.LC_ALL));

  const moduleIntervals = new Set<unknown>();
  let ready: Promise<{ module: SlidesMain; sessions: SessionState['sessions'] }> | undefined;
  function load() {
    return ready ??= (async () => {
      // Capture upstream's recovery interval only when Slides is first used.
      const nativeSetInterval = globalThis.setInterval;
      globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
        const timer = nativeSetInterval(callback, delay, ...args);
        (timer as unknown as { unref?: () => void }).unref?.();
        moduleIntervals.add(timer);
        return timer;
      }) as typeof setInterval;
      let module: SlidesMain;
      let state: SessionState;
      try {
        module = await import('@matcha/slides-main');
        state = await import('@matcha/slides-session-state');
      } finally {
        globalThis.setInterval = nativeSetInterval;
      }
      const { registerSlidesImageIpc } = await import('../../genoffice/apps/slides/src/main/ai-ipc');
      registerSlidesImageIpc(async (bytes, png) => {
        const image = sharp(bytes, { limitInputPixels: 48_000_000 });
        const size = await image.metadata();
        if (!size.width || !size.height) throw new Error('Unsupported image dimensions.');
        return { bytes: png ? new Uint8Array(await image.png().toBuffer()) : bytes, width: size.width, height: size.height };
      });
      module.setImageDimensions(async bytes => {
        try {
          const size = await sharp(bytes, { limitInputPixels: 48_000_000 }).metadata();
          return size.width && size.height ? { width: size.width, height: size.height } : null;
        } catch { return null; }
      });
      const { setWidthMeasurer } = await import('../../genoffice/apps/slides/src/main/shaped-metrics');
      setWidthMeasurer(async (wcId, items) => {
        const entry = [...editors].find(([, editor]) => editor.view.webContents.id === wcId);
        if (!entry || entry[0] === 'headless') throw new Error('Renderer font measurement is unavailable.');
        const [editorId] = entry;
        const { listPrivateFontFaces, getPrivateFontData } = await import('../../genoffice/apps/slides/src/main/fonts');
        const needed = new Set(items.map(item => item.family));
        const fonts = listPrivateFontFaces().filter(font => needed.has(font.family)).map(font => {
          const bytes = getPrivateFontData(font.id);
          return { ...font, data: bytes ? Buffer.from(bytes).toString('base64') : null };
        });
        const requestId = randomUUID();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            widthWaiters.delete(requestId);
            reject(new Error('Renderer font measurement timed out.'));
          }, 15_000);
          widthWaiters.set(requestId, { editorId, items, finish: widths => { clearTimeout(timer); resolve(widths); } });
          try { context.publish('office.slides.office:measure-widths', { editorId, payload: { requestId, items, fonts } } as unknown as AppJson); }
          catch (error) { clearTimeout(timer); widthWaiters.delete(requestId); reject(error); }
        });
      });
      module.configureSlidesRuntime({
        preloadPath: join(context.packagePath, 'slides.html'),
        rendererDevUrl: undefined,
        rendererFilePath: join(context.packagePath, 'slides.html')
      });
      return { module, sessions: state.sessions };
    })();
  }

  const identityFor = (documentId: string) => join(context.storagePath, 'slides', 'decks', `${documentId}.pptx`);
  const widthWaiters = new Map<string, { editorId: string; items: { key: string }[]; finish: (widths: Record<string, number | null>) => void }>();
  const pendingActions = new Map<string, { editorId: string; documentId: string; path: string; finish(error?: unknown, result?: unknown): void }>();
  function rejectActions(editorId?: string): void {
    for (const pending of pendingActions.values()) if (editorId === undefined || pending.editorId === editorId) pending.finish(new Error('The presentation changed or closed during the action.'));
  }
  const recoveryWaiters = new Map<string, (choice: 'restore' | 'discard' | null) => void>();
  const cancelledOpens = new Set<string>();
  async function clearRecovery(documentId: string): Promise<void> {
    const { module } = await load();
    await module.clearSlidesRecovery(identityFor(documentId)).catch((error) => {
      context.log.error(`Could not remove Slides recovery for ${documentId}: ${String(error)}`);
    });
  }
  function beginClose(): void {
    disposed = true;
    rejectActions();
    for (const resolve of recoveryWaiters.values()) resolve(null);
    recoveryWaiters.clear();
    for (const waiter of widthWaiters.values()) waiter.finish({});
    widthWaiters.clear();
  }
  const editors = new Map<string, { view: SlidesView; document?: LibraryDeck; pendingDiscard?: boolean }>();
  const closedEditors = new Set<string>();
  const audienceSources = new Map<string, string>();
  const audienceGrants = new Map<string, string>();
  const editorTails = new Map<string, Promise<unknown>>();
  function inEditor<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const run = (editorTails.get(id) ?? Promise.resolve()).then(operation, operation);
    const tail = run.then(() => undefined, () => undefined);
    editorTails.set(id, tail);
    void tail.then(() => { if (editorTails.get(id) === tail) editorTails.delete(id); });
    return run;
  }
  async function editorWindow(id: string) {
    if (closedEditors.has(id)) throw new Error('The Slides editor is closed.');
    let editor = editors.get(id);
    if (!editor) {
      const { module } = await load();
      if (closedEditors.has(id)) throw new Error('The Slides editor is closed.');
      editor = { view: module.createSlidesView(null) };
      editors.set(id, editor);
      for (const channel of SLIDES_AI_CHANNELS) ipcMain.removeHandler(channel);
    }
    return editor;
  }
  async function release(directory: string): Promise<void> {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      context.log.error(`Could not remove Slides work directory ${directory}: ${String(error)}`);
    }
  }
  async function closeEditor(id: string): Promise<void> {
    rejectActions(id);
    closedEditors.add(id);
    for (const [requestId, waiter] of widthWaiters) if (waiter.editorId === id) { waiter.finish({}); widthWaiters.delete(requestId); }
    const editor = editors.get(id);
    if (!editor) return;
    for (const [audienceId, sourceId] of audienceSources) if (sourceId === id) await closeEditor(audienceId);
    const { viewerWcIds } = await import('@matcha/slides-session-state');
    viewerWcIds.delete(editor.view.webContents.id);
    audienceSources.delete(id);
    for (const [grant, sourceId] of audienceGrants) if (sourceId === id) audienceGrants.delete(grant);
    await invokeIpc('slides:cancel-copy', [], createIpcEvent(editor.view.webContents as never));
    destroyWebContents(editor.view.webContents.id);
    editors.delete(id);
    if (editor.document) {
      if (editor.pendingDiscard) await clearRecovery(editor.document.documentId);
      await release(editor.document.directory);
    }
  }
  const stopEvents = onWebContentsSend((channel, payload, senderId) => {
    for (const [editorId, { view }] of editors) {
      if (view.webContents.id !== senderId) continue;
      try {
        context.publish(`office.slides.${channel}`, { payload: payload ?? null, editorId } as AppJson);
      } catch (error) {
        context.log.error(`Could not publish Slides event ${channel} for ${editorId}: ${String(error)}`);
      }
    }
  });
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  return {
    async action(documentId, action, input, signal) {
      signal?.throwIfAborted();
      if (disposed) throw new Error('The Slides session is closed.');
      const matches = [...editors].filter(([id, editor]) => id !== 'headless' && !audienceSources.has(id) && editor.document?.documentId === documentId);
      if (matches.length !== 1) throw new Error('unavailable: open this presentation in one Slides page before calling its live actions.');
      const [editorId, editor] = matches[0]!;
      if ([...pendingActions.values()].some(pending => pending.editorId === editorId)) throw new Error('The presentation already has an action in progress.');
      const entry = editor.document!;
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => finish(new Error('Slides action observation cancelled; applied edits are not rolled back.'));
        const finish = (error?: unknown, result?: unknown) => {
          clearTimeout(timer); pendingActions.delete(requestId); signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error('Slides action response timed out; do not automatically retry edits.')), 120_000);
        pendingActions.set(requestId, { editorId, documentId, path: entry.path, finish });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { context.publish('office.slides.office:action', { editorId, payload: { requestId, documentId, action, input, revision: entry.revision } } as unknown as AppJson); }
        catch (error) { finish(error); }
      });
    },
    async open(documentId, name, bytes, revision, editorId = 'headless') {
      rejectActions(editorId);
      cancelledOpens.delete(editorId);
      return inEditor(editorId, async () => {
        if (disposed) throw new Error('The Slides session is closed.');
        if (audienceSources.has(editorId)) throw new Error('Audience presentation is read-only.');
        const editor = await editorWindow(editorId);
        const { module, sessions } = await load();
        const previousSession = sessions.get(editor.view.webContents.id);
        const previous = editor.document;
        const identityPath = identityFor(documentId);
        let recovered = false;
        const recoveryPath = module.autosavePathFor(identityPath);
        let recovery: Uint8Array | undefined;
        try { recovery = new Uint8Array(await readFile(recoveryPath)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (disposed || cancelledOpens.has(editorId)) return null;
        if (recovery) {
          if (editorId === 'headless') throw new Error('Open this presentation in the editor to choose whether to restore its recovery copy.');
          const choice = await new Promise<'restore' | 'discard' | null>((resolve) => {
            recoveryWaiters.set(editorId, resolve);
            try { context.publish('office.slides.office:recovery-prompt', { editorId, payload: null }); }
            catch (error) { recoveryWaiters.delete(editorId); throw error; }
          });
          recoveryWaiters.delete(editorId);
          if (choice === null || disposed) return null;
          if (choice === 'restore') { bytes = recovery; recovered = true; }
          else await clearRecovery(documentId);
        }
        const directory = await mkdtemp(join(tmpdir(), 'matcha-office-slide-'));
        const path = join(directory, `${randomUUID()}.pptx`);
        try {
          await writeFile(path, bytes);
          const opened = await invokeIpc('slides:open-path', [path, 1280, { recoveryIdentityPath: identityPath, recovered }], createIpcEvent(editor.view.webContents as never));
          if (!opened) throw new Error('GenOffice Slides could not parse this presentation.');
          if (disposed || cancelledOpens.has(editorId)) {
            if (previousSession) sessions.set(editor.view.webContents.id, previousSession);
            else sessions.delete(editor.view.webContents.id);
            await release(directory);
            return null;
          }
          editor.document = { directory, path, documentId, revision, name };
          if (previous) {
            if (editor.pendingDiscard) await clearRecovery(previous.documentId);
            await release(previous.directory);
          }
          editor.pendingDiscard = false;
          return { ...opened as Record<string, unknown>, path: documentId, name };
        } catch (error) {
          if (previousSession) sessions.set(editor.view.webContents.id, previousSession);
          else sessions.delete(editor.view.webContents.id);
          await release(directory);
          throw error;
        }
      });
    },
    async call(input) {
      const editorId = typeof input.editorId === 'string' ? input.editorId : 'headless';
      if (input.channel === 'office:action-result' || input.channel === 'office:action-begin') {
        const request = (input.arguments as unknown[] | undefined)?.[0] as { requestId?: string; documentId?: string; result?: unknown; error?: string } | undefined;
        const pending = request?.requestId ? pendingActions.get(request.requestId) : undefined;
        const entry = editors.get(editorId)?.document;
        if (!pending || pending.editorId !== editorId || pending.documentId !== request?.documentId || entry?.documentId !== pending.documentId || entry.path !== pending.path) throw new Error('The Slides action generation is no longer active.');
        if (input.channel === 'office:action-begin') return true;
        pending.finish(request.error ? new Error(request.error) : undefined, request.result);
        return null;
      }
      if (['office:cancel-open', 'office:close-editor', 'office:new-blank', 'slides:save-as', 'slides:land-generated-pages'].includes(String(input.channel))) rejectActions(editorId);
      if (input.channel === 'office:widths-reply') {
        const [requestId, widths] = Array.isArray(input.arguments) ? input.arguments : [];
        const waiter = typeof requestId === 'string' ? widthWaiters.get(requestId) : undefined;
        if (!waiter || waiter.editorId !== editorId) throw new Error('Unknown font measurement request.');
        if (!widths || typeof widths !== 'object' || Array.isArray(widths)) throw new Error('Invalid font measurement response.');
        const result: Record<string, number | null> = {};
        for (const item of waiter.items) {
          const width = (widths as Record<string, unknown>)[item.key];
          result[item.key] = typeof width === 'number' && Number.isFinite(width) && width >= 0 ? width : null;
        }
        widthWaiters.delete(requestId as string);
        waiter.finish(result);
        return null;
      }
      if (input.channel === 'office:recovery-reply') {
        const choice = (input.arguments as unknown[] | undefined)?.[0];
        if (choice !== 'restore' && choice !== 'discard' && choice !== null) throw new Error('Invalid Slides recovery choice.');
        recoveryWaiters.get(editorId)?.(choice);
        return null;
      }
      if (input.channel === 'office:cancel-open' || input.channel === 'office:close-editor') {
        cancelledOpens.add(editorId);
        recoveryWaiters.get(editorId)?.(null);
        for (const [requestId, waiter] of widthWaiters) if (waiter.editorId === editorId) { waiter.finish({}); widthWaiters.delete(requestId); }
        if (input.channel === 'office:cancel-open') return null;
      }
      return inEditor(editorId, async () => {
        if (disposed) throw new Error('The Slides session is closed.');
        const channel = input.channel;
        if (typeof channel !== 'string' || !channel) throw new Error('Slides IPC requires a channel.');
        const args = Array.isArray(input.arguments) ? input.arguments : [];
        if (channel === 'office:close-audience') {
          for (const [audienceId, sourceId] of audienceSources) if (sourceId === editorId) await closeEditor(audienceId);
          for (const [token, sourceId] of audienceGrants) if (sourceId === editorId) audienceGrants.delete(token);
          return null;
        }
        if (channel === 'office:share-audience') {
          const source = editors.get(editorId);
          if (!source || audienceSources.has(editorId)) throw new Error('The presenter editor is closed.');
          const token = randomUUID();
          audienceGrants.set(token, editorId);
          return token;
        }
        if (channel === 'office:attach-audience') {
          if (editors.has(editorId)) throw new Error('The audience editor is already attached.');
          const token = text(args[0], 'audience token');
          const sourceId = audienceGrants.get(token);
          audienceGrants.delete(token);
          const source = sourceId ? editors.get(sourceId) : undefined;
          if (!source) throw new Error('The presenter editor is closed.');
          const { sessions } = await load();
          const session = sessions.get(source.view.webContents.id);
          if (!session) throw new Error('No presentation is open.');
          const audience = await editorWindow(editorId);
          sessions.set(audience.view.webContents.id, session);
          const { viewerWcIds } = await import('@matcha/slides-session-state');
          viewerWcIds.add(audience.view.webContents.id);
          audienceSources.set(editorId, sourceId!);
          return null;
        }
        if (channel === 'office:open-external') {
          if (!editors.has(editorId)) throw new Error('The Slides editor is closed.');
          const url = safeExternalUrl(args[0]);
          if (!url) throw new Error('Blocked external URL.');
          await context.desktop.openExternal({ url });
          return null;
        }
        if (audienceSources.has(editorId) && !['office:close-editor', 'slides:get-render-slides', 'slides:get-transition', 'slides:get-animations', 'slides:get-shape-keys', 'slides:media-data', 'slides:model3d-data', 'slides:private-font-faces', 'slides:private-font-data'].includes(channel)) throw new Error('Audience presentation is read-only.');
        if (channel === 'office:open-editor') {
          await editorWindow(editorId);
          return null;
        }
        if (channel === 'office:close-editor') {
          await closeEditor(editorId);
          return null;
        }
        const editor = editors.get(editorId);
        if (!editor) throw new Error('The Slides editor is closed.');
        if (channel === 'office:discard' || channel === 'office:cancel-discard') {
          editor.pendingDiscard = channel === 'office:discard';
          return null;
        }
        const event = createIpcEvent(editor.view.webContents as never);
        if (channel === 'office:action-ipc') {
          const request = args[0] as { requestId?: string; documentId?: string; channel?: string; input?: unknown };
          const pending = request?.requestId ? pendingActions.get(request.requestId) : undefined;
          if (!pending || pending.editorId !== editorId || pending.documentId !== request.documentId || editor.document?.path !== pending.path || !['slides:apply-edit-script', 'ai:insert-image-url', 'ai:replace-picture-url'].includes(request.channel ?? '')) throw new Error('The Slides action generation is no longer active.');
          return invokeIpc(request.channel!, [request.input], event);
        }
        // The original shell registers these shared read-only handlers; this editor has no shell.
        if (channel === 'ai:get-settings') {
          let stored: unknown = {};
          try { stored = JSON.parse(await readFile(join(context.storagePath, 'ai-settings.json'), 'utf8')); }
          catch { /* The original reader uses defaults for missing or corrupt settings. */ }
          const settings = resolveAiSettings(stored, defaultAiSettings());
          settings.provider = activeProvider(settings);
          return jsonSettings(settings);
        }
        if (channel === 'ai:gsk-status') {
          if (!hasGskAuth()) return { loggedIn: false };
          if (!args[0]) return { loggedIn: true };
          const info = await gskLoginInfo();
          return jsonSettings(info?.email ? { loggedIn: true, email: info.email } : { loggedIn: true });
        }
        if (channel === 'slides:autosave-pref') {
          await dispatchIpc(channel, args, event);
          return null;
        }
        if (channel === 'office:new-blank') {
          const { sessions } = await load();
          const previousSession = sessions.get(editor.view.webContents.id);
          const previous = editor.document;
          const directory = await mkdtemp(join(tmpdir(), 'matcha-office-slide-'));
          const path = join(directory, `${randomUUID()}.pptx`);
          try {
            const opened = await invokeIpc('slides:new-blank', args, event) as Record<string, unknown>;
            const session = sessions.get(editor.view.webContents.id)!;
            const created = await hooks.createDocument(`Untitled ${new Date().toISOString().slice(0, 10)}.pptx`, async () => {
              await savePptxToFile(session.opened, path);
              return new Uint8Array(await readFile(path));
            });
            commitSaved(session.opened);
            session.metaDirty = false;
            session.path = path;
            session.recoveryIdentityPath = identityFor(created.documentId);
            editor.document = { ...created, directory, path };
            if (previous) {
              if (editor.pendingDiscard) await clearRecovery(previous.documentId);
              await release(previous.directory);
            }
            editor.pendingDiscard = false;
            return { ...opened, path: created.documentId, name: created.name };
          } catch (error) {
            if (previousSession) sessions.set(editor.view.webContents.id, previousSession);
            else sessions.delete(editor.view.webContents.id);
            await release(directory);
            throw error;
          }
        }
        if (channel === 'office:insert-image-bytes') {
          const op = args[0] as Record<string, unknown>;
          const base64 = text(op.base64, 'base64', 70 * 1024 * 1024);
          const ext = text(op.ext, 'ext').toLowerCase();
          const bytes = decodeBase64(base64);
          const naturalPx = op.naturalPx ?? ((ext === 'tif' || ext === 'tiff') ? tiffToPng(bytes) : imageSize(bytes));
          if (!naturalPx) return { error: 'unsupported', ext };
          return invokeIpc('slides:add-image-bytes', [{ ...op, base64, ext, naturalPx }], event);
        }
        if (channel === 'office:install-font-bytes') {
          const directory = await mkdtemp(join(tmpdir(), 'matcha-office-slide-fonts-'));
          try {
            const files = args[0];
            if (!Array.isArray(files)) throw new Error('Font files are required.');
            const paths: string[] = [];
            for (const [index, file] of files.entries()) {
              const name = text(file.name, 'name');
              if (!/\.(ttf|otf|ttc|otc)$/i.test(name)) throw new Error('Unsupported font file.');
              const path = join(directory, `${index}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
              await writeFile(path, decodeBase64(text(file.base64, 'base64', 70 * 1024 * 1024)));
              paths.push(path);
            }
            return await invokeIpc('slides:font-install-local', [paths], event);
          } finally { await release(directory); }
        }
        if (channel === 'slides:font-install-local') throw new Error('Font installation requires file bytes.');
        if (channel === 'slides:add-model3d') {
          const op = args[0] as Record<string, unknown>;
          if (!Array.isArray(op.bytes) || !op.bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) throw new Error('Invalid 3D model bytes.');
          return invokeIpc(channel, [{ ...op, bytes: Uint8Array.from(op.bytes) }], event);
        }
        if (channel === 'slides:model3d-data' || channel === 'slides:private-font-data') {
          const bytes = await invokeIpc(channel, args, event) as Uint8Array | ArrayBuffer | null;
          return bytes ? Array.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes) : null;
        }
        if (channel === 'slides:add-media-bytes') {
          const op = args[0] as Record<string, unknown> | null;
          if (typeof op !== 'object' || op === null || 'path' in op) throw new Error('Media insertion requires file bytes.');
          if (op.posterBase64 !== undefined) {
            const poster = decodeBase64(text(op.posterBase64, 'posterBase64', 3 * 1024 * 1024));
            const size = imageSize(poster);
            if (op.kind !== 'video' || size?.mime !== 'image/png' || size.width > 960 || size.height > 540) throw new Error('Video poster must be a PNG frame up to 960 × 540.');
          }
        }
        if (['slides:open', 'slides:open-path', 'slides:new-blank', 'slides:insert-image', 'slides:insert-media', 'slides:pick-picture-file', 'slides:pick-model3d', 'slides:pick-export-dir', 'slides:pick-export-pdf-path', 'slides:export-images', 'slides:export-pdf', 'slides:save-picture'].includes(channel)) throw new Error('Use the Slides file-byte or library operation.');
        if (channel === 'slides:consume-pending-open') {
          const result = await invokeIpc(channel, args, event);
          return result && editor.document ? { ...result as object, path: editor.document.documentId, name: editor.document.name } : result;
        }
        let landed: Record<string, unknown> | undefined;
        if (channel === 'slides:land-generated-pages') {
          if (!editor.document) throw new Error('No library presentation is open.');
          const result = await invokeIpc(channel, args, event) as Record<string, unknown>;
          if (!result || 'error' in result) return result;
          landed = result;
        } else if (channel !== 'slides:save' && channel !== 'slides:save-as') return invokeIpc(channel, args, event);
        const { sessions } = await load();
        const session = sessions.get(editor.view.webContents.id);
        const entry = editor.document;
        if (!session || !entry) return { ok: false, error: 'No library presentation is open.' };
        let stagedDirectory: string | undefined;
        let committed = false;
        try {
          const metaRev = session.metaRev ?? 0;
          if (channel === 'slides:save-as') {
            const name = text(args[0], 'name');
            stagedDirectory = await mkdtemp(join(tmpdir(), 'matcha-office-slide-'));
            const path = join(stagedDirectory, `${randomUUID()}.pptx`);
            const created = await hooks.createDocument(name, async () => {
              await savePptxToFile(session.opened, path);
              return new Uint8Array(await readFile(path));
            });
            // Only the successful library commit changes this editor's identity.
            session.path = path;
            session.recoveryIdentityPath = identityFor(created.documentId);
            editor.document = { ...created, directory: stagedDirectory, path };
            stagedDirectory = undefined;
          } else {
            entry.name = (await hooks.readDocument(entry.documentId)).record.name;
            entry.revision = await hooks.saveDocument(entry.documentId, entry.revision, async () => {
              await atomicWriteVia(session.path, (temporary) => savePptxToFile(session.opened, temporary));
              return new Uint8Array(await readFile(session.path));
            });
          }
          committed = true;
          commitSaved(session.opened);
          if ((session.metaRev ?? 0) === metaRev) session.metaDirty = false;
          await clearRecovery(entry.documentId);
          if (editor.document !== entry) await release(entry.directory);
          const path = editor.document!.documentId;
          const name = editor.document!.name;
          try {
            const slides = await invokeIpc('slides:get-render-slides', [], event);
            return landed ? { ...landed, path, name, slides } : { ok: true, path, name, slides };
          } catch (error) {
            context.log.error(`Saved ${editor.document!.documentId}, but render refresh failed: ${String(error)}`);
            return landed ? { ...landed, path, name } : { ok: true, path, name };
          }
        } catch (error) {
          if (stagedDirectory) await release(stagedDirectory);
          if (committed) {
            context.log.error(`Saved ${editor.document!.documentId}, but post-save refresh failed: ${String(error)}`);
            return landed ? { ...landed, path: editor.document!.documentId, name: editor.document!.name } : { ok: true, path: editor.document!.documentId, name: editor.document!.name };
          }
          return {
            ...(landed ? {} : { ok: false }),
            error: errorMessage(error),
            ...(error instanceof OfficeError ? { code: error.code, ...error.detail } : undefined)
          };
        }
      });
    },
    beginClose,
    dispose() {
      return disposePromise ??= (async () => {
        beginClose();
        await Promise.allSettled([...editorTails.values()]);
        stopEvents();
        if (ready) await ready.catch(() => undefined);
        for (const timer of moduleIntervals) clearInterval(timer as ReturnType<typeof setInterval>);
        moduleIntervals.clear();
        await Promise.all([...editors.keys()].map(closeEditor));
        editorTails.clear();
      })();
    }
  };
}
