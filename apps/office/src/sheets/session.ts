/** The upstream sidecar owns workbook parsing, streamed reads and native export. */
import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { sheetsCsvCharset, sheetsRuntime } from './runtime';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { basename, dirname, join } from 'node:path';
import {
  createIpcEvent, destroyWebContents, invokeIpc, onWebContentsSend
} from '../platform/electron-main';
import type { LibraryWorkbook } from './save';
import { decodeBase64 } from '../documents/validation';
import { externalLinkOpsSchema, externalLinkRevealRequestSchema, externalLinksRequestSchema, externalLinksResultSchema, externalLinksUpdateResultSchema, workbookExportCsvRequestSchema, workbookTabsResultSchema } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import type { EditorDocumentHooks } from '../documents/model';
import { bindLibrarySource, libraryTarget, publicExternalLinks, resolveLinkSource, workbookIdentity, writeExternalLinkView } from './external-links';

type SheetsMain = typeof import('@matcha/sheets-main');
type SheetsWindow = Awaited<ReturnType<SheetsMain['createSheetsWindow']>>;

export type SheetsSessionHooks = EditorDocumentHooks;

export interface SheetsSession {
  call(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  open(documentId: string, name: string, bytes: Uint8Array, revision: number, editorId?: string, sourcePath?: string): Promise<unknown>;
  action(documentId: string, action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  beginClose(): Promise<void>;
  dispose(): Promise<void>;
}

interface Editor {
  window: SheetsWindow;
  directory: string;
  documents: Map<string, LibraryWorkbook>;
  sourcePaths: Map<string, string>;
  closing: boolean;
  importController?: AbortController;
  selections: Map<string, { sessionId: string; directory: string }>;
}

export function createSheetsSession(context: AppPluginContext, hooks: SheetsSessionHooks): SheetsSession {
  const identityFor = workbookIdentity;
  const editors = new Map<string, Editor>();
  const tails = new Map<string, Promise<unknown>>();
  const pendingActions = new Map<string, { editorId: string; documentId: string; sessionId: string; finish(error?: unknown, result?: unknown): void }>();
  function rejectActions(editorId?: string): void {
    for (const pending of pendingActions.values()) {
      if (editorId === undefined || pending.editorId === editorId) pending.finish(new Error('The workbook action was interrupted by closing or opening another document.'));
    }
  }
  let runtimePromise: Promise<SheetsMain> | undefined;
  const runtime = () => runtimePromise ??= sheetsRuntime();
  let disposed = false;
  let beginClosePromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;

  function beginClose(): Promise<void> {
    disposed = true;
    rejectActions();
    return beginClosePromise ??= (async () => {
      for (const editor of editors.values()) {
        editor.closing = true;
        editor.importController?.abort();
        await settleRecovery(editor, 'dismissed');
      }
    })();
  }

  function exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const run = (tails.get(id) ?? Promise.resolve()).then(operation, operation);
    const tail = run.then(() => {}, () => {});
    tails.set(id, tail);
    void tail.then(() => { if (tails.get(id) === tail) tails.delete(id); });
    return run;
  }

  async function editorFor(id: string): Promise<Editor> {
    let editor = editors.get(id);
    if (!editor) {
      const module = await runtime();
      const directory = await mkdtemp(join(tmpdir(), 'matcha-office-sheet-'));
      try {
        const window = await module.createSheetsWindow({ includeAiHandlers: false });
        editor = { window, directory, documents: new Map(), sourcePaths: new Map(), selections: new Map(), closing: disposed };
        editors.set(id, editor);
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    return editor;
  }

  async function settleRecovery(editor: Editor, choice: 'restore' | 'discard' | 'dismissed'): Promise<void> {
    const { recoveryPromptWaiters } = await import('@matcha/sheets-save-runtime');
    recoveryPromptWaiters.get(editor.window.webContents.id)?.(choice);
  }

  const stopEvents = onWebContentsSend((channel, payload, senderId) => {
    for (const [editorId, editor] of editors) {
      if (editor.window.webContents.id === senderId) {
        if (channel === 'workbook:recovery-prompt' && (editor.closing || disposed)) {
          void settleRecovery(editor, 'dismissed').catch((error) => {
            context.log.error(`Could not dismiss Sheets recovery prompt: ${String(error)}`);
          });
          break;
        }
        try {
          context.publish(`office.sheets.${channel}`, { editorId, payload: payload ?? null } as AppJson);
        } catch (error) {
          context.log.error(`Could not publish Sheets event ${channel}: ${String(error)}`);
        }
        break;
      }
    }
  });

  async function closeEditor(id: string): Promise<void> {
    const editor = editors.get(id);
    if (!editor) return;
    const { sessionFor } = await import('@matcha/sheets-save-runtime');
    const event = createIpcEvent(editor.window.webContents as never);
    for (const sessionId of sessionFor(event).sessions.keys()) {
      await invokeIpc('workbook:close', [sessionId], event);
    }
    destroyWebContents(editor.window.webContents.id);
    editors.delete(id);
    editor.documents.clear();
    editor.sourcePaths.clear();
    await rm(editor.directory, { recursive: true, force: true });
  }

  async function pruneDocuments(editor: Editor): Promise<void> {
    const { sessionFor } = await import('@matcha/sheets-save-runtime');
    const activePaths = new Set([...sessionFor(createIpcEvent(editor.window.webContents as never)).sessions.values()]
      .map((session) => session.restoreTarget ?? session.path));
    const active = new Set([...activePaths].map((path) => editor.documents.get(path)));
    for (const [path, binding] of editor.documents) {
      if (path === binding.identityPath || path === binding.path || activePaths.has(path)) continue;
      editor.documents.delete(path);
      await rm(dirname(path), { recursive: true, force: true }).catch(() => {});
    }
    for (const binding of new Set(editor.documents.values())) {
      if (active.has(binding)) continue;
      for (const [path, current] of editor.documents) {
        if (current === binding) editor.documents.delete(path);
      }
      await rm(dirname(binding.path), { recursive: true, force: true }).catch(() => {});
    }
  }

  async function openBinding(editor: Editor, binding: LibraryWorkbook, password?: string): Promise<unknown> {
    const native = await import('@matcha/sheets-save-runtime');
    const entry = native.sessionFor(createIpcEvent(editor.window.webContents as never));
    const recovery = native.pendingRecoveryFor(binding.identityPath);
    let path = binding.path;
    let restored = false;
    if (recovery) {
      const choice = await native.promptRecoveryRestore(editor.window.webContents as never, binding.name, recovery, false);
      if (editor.closing || disposed) return null;
      if (choice === 'restore') {
        const directory = await mkdtemp(join(editor.directory, 'restore-'));
        path = join(directory, basename(binding.name));
        try {
          await writeFile(path, await readFile(recovery));
          restored = true;
        } catch (error) {
          await rm(directory, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      } else if (choice === 'discard') native.clearWorkbookRecovery(binding.identityPath);
    }
    try {
      const file = await native.openWorkbookSession(entry.client, path, entry.sessions, { password });
      editor.documents.set(path, binding);
      entry.currentPath = path;
      return { ...file, path: binding.identityPath, name: binding.name, ...(binding.type === 'csv' ? { csvPath: binding.identityPath } : {}), restoredFromRecovery: restored, backingIsRecovery: false };
    } catch (error) {
      if (restored) await rm(dirname(path), { recursive: true, force: true }).catch(() => {});
      if (String(error).includes('PASSWORD_REQUIRED') && password === undefined) {
        return { passwordRequired: true, path: binding.identityPath };
      }
      throw error;
    }
  }

  async function stageFiles(editor: Editor, input: unknown): Promise<string[]> {
    if (!Array.isArray(input) || input.length === 0 || input.length > 20) throw new Error('Choose 1–20 workbooks.');
    let totalBytes = 0;
    const files = input.map((value: unknown) => {
      const file = value as { name?: unknown; data?: unknown };
      if (!file || typeof file.name !== 'string' || typeof file.data !== 'string' ||
        !/\.(xlsx|xlsm|xls|csv|tsv|ods|ots)$/i.test(file.name) || file.name.length > 255) {
        throw new Error('Choose a supported spreadsheet file.');
      }
      const bytes = file.data === '' && /\.(xlsx|csv|tsv)$/i.test(file.name) ? new Uint8Array() : decodeBase64(file.data);
      totalBytes += bytes.byteLength;
      if (totalBytes > 50 * 1024 * 1024) throw new Error('The selected workbooks exceed 50 MiB.');
      return { name: basename(file.name), bytes };
    });
    const paths: string[] = [];
    try {
      for (const file of files) {
        const directory = await mkdtemp(join(editor.directory, 'import-'));
        const path = join(directory, file.name);
        paths.push(path);
        await writeFile(path, file.bytes);
      }
      return paths;
    } catch (error) {
      await Promise.all(paths.map((path) => rm(dirname(path), { recursive: true, force: true })));
      throw error;
    }
  }

  async function linkSources(editor: Editor, sessionId: string) {
    const { sessionFor } = await import('@matcha/sheets-save-runtime');
    const entry = sessionFor(createIpcEvent(editor.window.webContents as never));
    const session = entry.sessions.get(sessionId);
    const binding = session && editor.documents.get(session.restoreTarget ?? session.path);
    if (!session || !binding) throw new Error('Unknown library workbook session.');
    const listing = externalLinksResultSchema.parse(await entry.client.listExternalLinks({ path: session.snapshotPath }));
    const opened = [...editors.values()].flatMap(editor => [...new Set(editor.documents.values())]);
    return { entry, session, binding, listing, sources: new Map(listing.links.map(link => [link.index,
      bindLibrarySource(resolveLinkSource(link.rawTarget, link.source, binding.originPath), opened)])) };
  }

  async function publicLinks(state: Awaited<ReturnType<typeof linkSources>>) {
    const library = await hooks.listDocuments();
    const opened = [...editors.values()].flatMap(editor => [...new Set(editor.documents.values())]);
    return publicExternalLinks(state.listing, state.sources, state.binding.documentId, opened, library);
  }

  function resolveSourceOperations(editor: Editor, request: Record<string, unknown>): void {
    const operations = request.externalLinkOps == null ? null : externalLinkOpsSchema.parse(request.externalLinkOps);
    if (!operations?.retargets) return;
    request.externalLinkOps = { ...operations, retargets: operations.retargets.map(retarget => {
      const target = editor.sourcePaths.get(retarget.target);
      if (!target) throw new Error('Choose the external workbook source again.');
      return { ...retarget, target };
    }) };
  }

  async function call(id: string, channel: string, args: unknown[]): Promise<unknown> {
    if (disposed) throw new Error('The Sheets session is closed.');
    if (channel === 'office:close-editor') { await closeEditor(id); return null; }
    if (channel === 'office:open-editor') { await editorFor(id); return null; }
    const editor = editors.get(id);
    if (!editor || editor.closing) throw new Error('The Sheets editor is not open.');
    const { sessionFor } = await import('@matcha/sheets-save-runtime');
    const event = createIpcEvent(editor.window.webContents as never);
    const entry = sessionFor(event);
    if (channel === 'office:create-sheet-document') {
      const { workbookCreateDocumentRequestSchema } = await import('../../genoffice/apps/sheets/src/shared/desktop-api');
      const request = workbookCreateDocumentRequestSchema.parse(args[0]);
      if (request.type !== 'xlsx' && request.type !== 'csv') throw new Error('A spreadsheet document is required.');
      const { sheetCsvToXlsxBuffer } = await import('../../genoffice/packages/xlsx-gateway/src/gateway/csv-import-xlsx');
      const name = `${request.title.replace(/[\\/:*?"<>|]/g, '_')}.${request.type}`;
      const created = await hooks.createDocument(name, async () => request.type === 'csv'
        ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(request.content, 'utf8')])
        : sheetCsvToXlsxBuffer(request.content, request.sheetName), undefined, undefined, request.type === 'csv' ? 'csv' : undefined);
      return { ok: true, path: identityFor(created.documentId) };
    }
    if (channel === 'office:selection-close') {
      const requestId = args[0];
      const selected = typeof requestId === 'string' ? editor.selections.get(requestId) : undefined;
      if (selected) {
        editor.selections.delete(requestId as string);
        await invokeIpc('workbook:close', [selected.sessionId], event);
        await rm(selected.directory, { recursive: true, force: true });
      }
      return null;
    }
    if (channel === 'office:selection-open') {
      const request = args[0] as { sessionId?: unknown; index?: unknown; requestId?: unknown };
      if (!request || typeof request.sessionId !== 'string' || !Number.isSafeInteger(request.index) || typeof request.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(request.requestId)) throw new Error('Invalid workbook selection request.');
      const state = await linkSources(editor, request.sessionId);
      const source = state.sources.get(request.index as number);
      if (!source || !('documentId' in source)) throw new Error('Choose an exact library source in External Links before selecting its range.');
      if (source.documentId === state.binding.documentId) throw new Error('Select this workbook directly in its own grid.');
      const directory = await mkdtemp(join(editor.directory, 'selection-'));
      const path = join(directory, 'selection.xlsx');
      const native = await import('@matcha/sheets-save-runtime');
      let opened: Awaited<ReturnType<typeof native.openWorkbookSession>> | undefined;
      try {
        const owners = [...editors.values()].filter(item => !item.closing && [...item.documents.values()].some(binding => binding.documentId === source.documentId));
        if (owners.length) {
          const response = await snapshotAction(source.documentId) as { result?: { snapshotPayload?: unknown; snapshotSecondPayload?: unknown } };
          const owner = owners[0]!;
          const ownerEntry = sessionFor(createIpcEvent(owner.window.webContents as never));
          const payload = native.resolveTransferredEdits(ownerEntry, native.workbookSaveRequestSchema.parse(response.result?.snapshotPayload));
          const session = ownerEntry.sessions.get(payload.sessionId);
          if (!session) throw new Error('The source workbook closed while taking its snapshot.');
          resolveSourceOperations(owner, payload as unknown as Record<string, unknown>);
          await native.writeWorkbookTo(ownerEntry.client, session, payload, path);
          if (response.result?.snapshotSecondPayload) {
            const temporarySessions = new Map<string, import('@matcha/sheets-save-runtime').SessionInfo>();
            const firstFile = await native.openWorkbookSession(ownerEntry.client, path, temporarySessions);
            try {
              const second = native.workbookSaveRequestSchema.parse({ ...(response.result.snapshotSecondPayload as object), sessionId: firstFile.sessionId });
              const finalPath = join(directory, 'selection-final.xlsx');
              await native.writeWorkbookTo(ownerEntry.client, temporarySessions.get(firstFile.sessionId)!, second, finalPath);
              await rename(finalPath, path);
            } finally {
              for (const [sessionId, session] of temporarySessions) {
                await ownerEntry.client.close(sessionId).catch(() => {});
                await rm(session.snapshotPath, { force: true }).catch(() => {});
              }
            }
          }
        } else {
          const { record, bytes } = await hooks.readDocument(source.documentId);
          if (record.type !== 'xlsx' && record.type !== 'csv') throw new Error('The linked source is not a workbook.');
          await writeFile(path, record.type === 'csv' ? await (await import('./engine')).openCsvWorkbook(bytes) : bytes);
        }
        opened = await native.openWorkbookSession(entry.client, path, entry.sessions);
        editor.selections.set(request.requestId, { sessionId: opened.sessionId, directory });
        return { requestId: request.requestId, file: { ...opened, path: identityFor(source.documentId) } };
      } catch (error) {
        if (opened) await invokeIpc('workbook:close', [opened.sessionId], event).catch(() => {});
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    }
    if (channel === 'office:language') {
      if (typeof args[0] !== 'string') throw new Error('A UI language is required.');
      await sheetsRuntime(args[0]);
      return null;
    }
    if (channel === 'office:action-result') {
      const reply = args[0] as { requestId?: string; documentId?: string; sessionId?: string; result?: unknown; error?: string };
      const pending = reply && typeof reply.requestId === 'string' ? pendingActions.get(reply.requestId) : undefined;
      if (pending?.editorId === id && pending.documentId === reply.documentId && pending.sessionId === reply.sessionId) pending.finish(reply.error ? new Error(reply.error) : undefined, reply.result);
      return null;
    }
    const sessionId = (args[0] as { sessionId?: unknown } | undefined)?.sessionId;
    if (channel === 'shell:open-external') {
      if (typeof args[0] !== 'string') throw new Error('An external URL is required.');
      await context.desktop.openExternal({ url: args[0] });
      return null;
    }
    if (channel === 'workbook:list-tabs') {
      const result = workbookTabsResultSchema.parse(await invokeIpc(channel, args, event));
      return { tabs: result.tabs.flatMap(tab => {
        const owner = [...editors.values()].find(item => item.window.webContents.id === tab.wcId);
        const binding = owner?.documents.get(tab.path);
        return binding ? [{ ...tab, path: binding.identityPath, name: binding.name }] : [];
      }) };
    }
    if (channel === 'workbook:list-external-links' || channel === 'workbook:update-external-links') {
      const request = externalLinksRequestSchema.parse(args[0]);
      const state = await linkSources(editor, request.sessionId);
      if (channel === 'workbook:list-external-links') return { links: await publicLinks(state) };
      const directory = await mkdtemp(join(editor.directory, 'links-'));
      try {
        const targets = new Map<number, string>();
        const libraryFiles = new Map<string, string>();
        for (const [index, source] of state.sources) {
          if (!source) continue;
          if ('path' in source) { targets.set(index, source.path); continue; }
          let path = libraryFiles.get(source.documentId);
          if (!path) {
            const { record, bytes } = await hooks.readDocument(source.documentId);
            if (record.type !== 'xlsx') throw new Error('The linked library document is not a workbook.');
            path = join(directory, `${source.documentId}.xlsx`);
            await writeFile(path, bytes);
            libraryFiles.set(source.documentId, path);
          }
          targets.set(index, path);
        }
        const path = await writeExternalLinkView(new Uint8Array(await readFile(state.session.snapshotPath)), state.listing, targets, directory);
        const result = externalLinksUpdateResultSchema.parse(await entry.client.updateExternalLinks({ path }));
        const visible = await publicLinks(state);
        return { ...result, links: result.links.map(link => ({ ...visible.find(item => item.index === link.index)!, reachable: link.reachable })) };
      } catch (error) {
        context.log.error(`Could not update Sheets external sources: ${String(error)}`);
        throw new Error('Could not update the linked workbook. Check its source or choose another source.', { cause: error });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    if (channel === 'workbook:select-external-link-source') {
      const documentId = (args[0] as { documentId?: unknown } | undefined)?.documentId;
      let target: string;
      editor.sourcePaths.clear();
      if (documentId !== undefined) {
        if (typeof documentId !== 'string' || !/^doc_[a-f0-9]{16}$/.test(documentId)) throw new Error('Choose a library workbook.');
        const { record } = await hooks.readDocument(documentId);
        if (record.type !== 'xlsx') throw new Error('The linked library document is not a workbook.');
        target = libraryTarget(documentId);
      } else {
        const { path } = await context.desktop.pickFile({ extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'] });
        if (!path) return null;
        target = pathToFileURL(path).href;
      }
      const token = `/office-link-source/${randomUUID()}`;
      editor.sourcePaths.set(`file://${token}`, target);
      return token;
    }
    if (channel === 'shell:reveal-link-source') {
      const request = externalLinkRevealRequestSchema.parse(args[0]);
      const state = await linkSources(editor, request.sessionId);
      const source = state.sources.get(request.index);
      if (!source) throw new Error('Choose the external workbook source first.');
      const path = 'path' in source ? source.path : (await hooks.readDocument(source.documentId)).sourcePath;
      if (!path) throw new Error('This library workbook has no original file to locate.');
      await context.desktop.revealFile({ path }).catch(error => {
        context.log.error(`Could not locate Sheets link source: ${String(error)}`);
        throw new Error('Could not locate the linked workbook source.');
      });
      return null;
    }
    if (channel === 'office:pick-workbook') {
      const { path } = await context.desktop.pickFile({ extensions: ['xlsx', 'xlsm', 'xls', 'csv', 'tsv', 'ods', 'ots'] });
      if (!path) return null;
      if ((await stat(path)).size > 50 * 1024 * 1024) throw new Error('Choose a workbook of at most 50 MiB.');
      const token = `/office-import/${randomUUID()}`;
      editor.sourcePaths.clear();
      editor.sourcePaths.set(token, pathToFileURL(path).href);
      return { token, name: basename(path) };
    }
    if (channel === 'office:import-workbook' || channel === 'office:import-files') {
      let staged: string[] = [];
      let sourcePath: string;
      if (channel === 'office:import-files') {
        staged = await stageFiles(editor, args[0]);
        if (staged.length !== 1) { await Promise.all(staged.map(path => rm(dirname(path), { recursive: true, force: true }))); throw new Error('Open one workbook at a time.'); }
        sourcePath = staged[0]!;
      } else {
        const token = args[0];
        const source = typeof token === 'string' ? editor.sourcePaths.get(token) : undefined;
        if (!source || !token || !(token as string).startsWith('/office-import/')) throw new Error('Choose the workbook to import again.');
        editor.sourcePaths.delete(token as string);
        sourcePath = fileURLToPath(source);
      }
      const paths = [sourcePath];
      const native = await import('@matcha/sheets-save-runtime');
      const controller = new AbortController();
      editor.importController = controller;
      let prepared: Awaited<ReturnType<typeof native.prepareWorkbookForOpen>> = null;
      try {
        prepared = await native.prepareWorkbookForOpen(entry.client, paths[0]!, event.sender, undefined, {
          skipRecoveryPrompt: true,
          import: { signal: controller.signal, onProgress: (progress) => event.sender.send('workbook:import-progress', progress) }
        });
        if (!prepared || controller.signal.aborted || editor.closing || disposed) return null;
        const name = basename(prepared.openPath);
        const directory = await mkdtemp(join(editor.directory, 'open-'));
        const path = join(directory, name);
        const sessions = new Map<string, import('@matcha/sheets-save-runtime').SessionInfo>();
        let adopted = false;
        try {
          const bytes = new Uint8Array(await readFile(prepared.openPath));
          await writeFile(path, bytes);
          let file: Awaited<ReturnType<typeof native.openWorkbookSession>> | undefined;
          try {
            file = await native.openWorkbookSession(entry.client, path, sessions);
          } catch (error) {
            if (!String(error).includes('PASSWORD_REQUIRED')) throw error;
          }
          if (controller.signal.aborted || editor.closing || disposed) return null;
          const csv = prepared.csvImport === true;
          const nameForLibrary = csv ? basename(sourcePath) : name;
          const originPath = staged.length ? undefined : sourcePath;
          const created = await hooks.createDocument(nameForLibrary, async () => ({ bytes: csv ? new Uint8Array(await readFile(sourcePath)) : bytes, sourcePath: originPath }), undefined, undefined, csv ? 'csv' : undefined);
          const binding: LibraryWorkbook = { ...created, type: csv ? 'csv' : 'xlsx', path, identityPath: identityFor(created.documentId), originPath };
          editor.documents.set(path, binding);
          editor.documents.set(binding.identityPath, binding);
          for (const [sessionId, session] of sessions) entry.sessions.set(sessionId, session);
          entry.currentPath = path;
          adopted = true;
          return file ? { ...file, name: created.name, path: binding.identityPath,
            ...(csv ? { csvPath: binding.identityPath, emptyCsv: prepared.emptyCsv === true } : {}) } : { passwordRequired: true, path: binding.identityPath };
        } finally {
          if (!adopted) {
            for (const [sessionId, session] of sessions) {
              await entry.client.close(sessionId).catch(() => {});
              await rm(session.snapshotPath, { force: true }).catch(() => {});
            }
            await rm(directory, { recursive: true, force: true });
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return null;
        context.log.error(`Could not import Sheets workbook: ${String(error)}`);
        throw new Error('Could not import the selected workbook.', { cause: error });
      } finally {
        editor.importController = undefined;
        event.sender.send('workbook:import-progress', null);
        if (prepared?.importTempDir) await rm(prepared.importTempDir, { recursive: true, force: true });
        await Promise.all(staged.map(path => rm(dirname(path), { recursive: true, force: true })));
      }
    }
    if (channel === 'office:merge-workbooks') {
      const paths = await stageFiles(editor, args[0]);
      try {
        return await invokeIpc('workbook:open-for-merge', [paths], event);
      } finally {
        await Promise.all(paths.map((path) => rm(dirname(path), { recursive: true, force: true })));
      }
    }
    if (channel === 'workbook:cancel-import' && editor.importController) {
      editor.importController.abort();
      return null;
    }
    if (channel === 'workbook:export-csv') {
      const request = workbookExportCsvRequestSchema.parse(args[0]);
      return { data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(request.content, 'utf8')]).toString('base64') };
    }
    if (channel === 'workbook:write-recovery') {
      const native = await import('@matcha/sheets-save-runtime');
      const input = { ...args[0] as Record<string, unknown> };
      resolveSourceOperations(editor, input);
      const request = native.resolveTransferredEdits(entry, native.workbookSaveRequestSchema.parse(input));
      const session = entry.sessions.get(request.sessionId);
      const binding = session ? editor.documents.get(session.path) : undefined;
      if (!session || !binding || session.automaticRecoveryDisabled) return { ok: false };
      const target = native.recoveryPathFor(binding.identityPath);
      const temporary = `${target}.${event.sender.id}.tmp`;
      try {
        await mkdir(dirname(target), { recursive: true });
        await native.writeWorkbookTo(entry.client, session, request, temporary);
        await rename(temporary, target);
        return { ok: true };
      } catch (error) {
        context.log.error(`Could not write Sheets recovery: ${String(error)}`);
        return { ok: false };
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }
    if (channel === 'workbook:save' || channel === 'workbook:update-password') {
      const session = typeof sessionId === 'string' ? entry.sessions.get(sessionId) : undefined;
      const binding = session ? editor.documents.get(session.restoreTarget ?? session.path) : undefined;
      if (!binding) throw new Error('This workbook does not belong to the document library.');
      const { changeLibraryPassword, saveLibraryWorkbook } = await import('./save');
      const priorPath = binding.path;
      if (channel === 'workbook:update-password') {
        const password = (args[0] as { newPassword?: unknown }).newPassword;
        if (typeof password !== 'string') throw new Error('Invalid workbook password.');
        const result = await changeLibraryPassword(event, sessionId as string, password, binding, hooks, editor.directory);
        Object.assign(binding, result.binding);
        editor.documents.set(binding.path, binding);
        if (priorPath !== binding.identityPath) editor.documents.delete(priorPath);
        await rm(dirname(priorPath), { recursive: true, force: true }).catch(() => {});
        await pruneDocuments(editor);
        return { sha256: result.sha256, fileBytes: result.fileBytes, passwordProtected: true };
      }
      const { libraryName, ...nativeRequest } = args[0] as Record<string, unknown>;
      resolveSourceOperations(editor, nativeRequest);
      const copyName = typeof libraryName === 'string' ? basename(libraryName) : undefined;
      const result = await saveLibraryWorkbook(event, nativeRequest, binding, hooks, editor.directory, copyName);
      const saved = nativeRequest.mode === 'save-as' ? result.binding : Object.assign(binding, result.binding);
      editor.documents.set(saved.path, saved);
      editor.documents.set(saved.identityPath, saved);
      if (nativeRequest.mode !== 'save-as') {
        if (priorPath !== binding.identityPath) editor.documents.delete(priorPath);
        await rm(dirname(priorPath), { recursive: true, force: true }).catch(() => {});
      }
      await pruneDocuments(editor);
      return { canceled: false, file: result.file, touchedEntries: result.touchedEntries };
    }
    if (channel === 'workbook:reopen' || channel === 'workbook:open-encrypted') {
      const path = channel === 'workbook:reopen' ? args[0] : (args[0] as { path?: unknown })?.path;
      const binding = typeof path === 'string' ? editor.documents.get(path) : undefined;
      if (!binding) throw new Error('This workbook does not belong to the document library.');
      // Recovery follows the document's committed generation, never a dead session id.
      const previous = [...entry.sessions].filter(([, session]) => editor.documents.get(session.restoreTarget ?? session.path) === binding);
      const password = channel === 'workbook:open-encrypted' ? (args[0] as { password?: unknown }).password : previous[0]?.[1].password;
      if (password !== undefined && (typeof password !== 'string' || !password || password.length > 1024)) throw new Error('Invalid workbook password.');
      const result = await openBinding(editor, binding, password as string | undefined);
      if (result && typeof result === 'object' && 'sessionId' in result) {
        for (const [oldId] of previous) await invokeIpc('workbook:close', [oldId], event);
        await pruneDocuments(editor);
      }
      return result && typeof result === 'object' && 'sessionId' in result
        ? { ...result, path: binding.identityPath } : result;
    }
    const result = await invokeIpc(channel, args, event);
    if (channel === 'workbook:close') await pruneDocuments(editor);
    return result;
  }

  async function snapshotAction(documentId: string): Promise<unknown> {
    return api.action(documentId, '__snapshot', {});
  }
  const api: SheetsSession = {
    async action(documentId, action, input, signal) {
      signal?.throwIfAborted();
      if (disposed) throw new Error('The Sheets session is closed.');
      const candidates = [...editors].filter(([, editor]) => !editor.closing &&
        [...editor.documents.values()].some(binding => binding.documentId === documentId));
      if (candidates.length !== 1) throw new Error('unavailable: open this workbook in one Sheets page before calling its live actions.');
      const [editorId, editor] = candidates[0]!;
      const { sessionFor } = await import('@matcha/sheets-save-runtime');
      const entry = sessionFor(createIpcEvent(editor.window.webContents as never));
      const binding = entry.currentPath ? editor.documents.get(entry.currentPath) : undefined;
      if (binding?.documentId !== documentId) throw new Error('unavailable: the requested workbook is not active.');
      if ([...pendingActions.values()].some(pending => pending.editorId === editorId)) throw new Error('The workbook already has an action in progress.');
      const sessionId = [...entry.sessions].find(([, session]) => session.path === entry.currentPath)?.[0];
      if (!sessionId) throw new Error('The workbook generation is no longer available.');
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => finish(new Error('Workbook action observation cancelled; applied edits are not rolled back.'));
        const finish = (error?: unknown, result?: unknown) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          pendingActions.delete(requestId);
          if (error) reject(error);
          else resolve(result);
        };
        const timer = setTimeout(() => finish(new Error('Workbook action response timed out; do not automatically retry edits.')), 120_000);
        pendingActions.set(requestId, { editorId, documentId, sessionId, finish });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        editor.window.webContents.send('office:action', { requestId, documentId, sessionId, path: binding.identityPath, action, input, revision: binding.revision });
      });
    },
    open(documentId, name, bytes, revision, editorId = 'default', sourcePath) {
      return exclusive(editorId, async () => {
        if (disposed) throw new Error('The Sheets session is closed.');
        rejectActions(editorId);
        const editor = await editorFor(editorId);
        if (disposed || editor.closing) throw new Error('The Sheets editor is not open.');
        const directory = await mkdtemp(join(editor.directory, 'open-'));
        const record = (await hooks.readDocument(documentId)).record;
        const csv = record.type === 'csv';
        const path = join(directory, basename(name || 'Workbook.xlsx').replace(/\.csv$/i, '.xlsx'));
        let emptyCsv = false;
        if (csv) {
          const [{ decodeCsvBuffer }, { csvToXlsxBufferForOpen }] = await Promise.all([
            import('../../genoffice/packages/xlsx-gateway/src/gateway/csv-import'),
            import('../../genoffice/packages/xlsx-gateway/src/gateway/csv-import-xlsx')
          ]);
          const converted = await csvToXlsxBufferForOpen(decodeCsvBuffer(bytes, sheetsCsvCharset()));
          await writeFile(path, converted.buffer);
          emptyCsv = converted.empty;
        } else await writeFile(path, bytes);
        const binding: LibraryWorkbook = { documentId, type: csv ? 'csv' : 'xlsx', path, identityPath: identityFor(documentId), revision, name: basename(name || 'Workbook.xlsx'), originPath: sourcePath };
        editor.documents.set(path, binding);
        editor.documents.set(binding.identityPath, binding);
        const file = await openBinding(editor, binding);
        return file && typeof file === 'object' && 'sessionId' in file && csv ? { ...file, emptyCsv } : file;
      });
    },
    call(input) {
      if (disposed) return Promise.reject(new Error('The Sheets session is closed.'));
      const channel = input.channel;
      if (typeof channel !== 'string' || !channel) return Promise.reject(new Error('Sheets IPC requires a channel.'));
      // No external MCP caller exists; one-way notifications need no native editor.
      if (channel === 'sheets:mcp-ready' || channel === 'sheets:mcp-result') return Promise.resolve(null);
      const id = typeof input.editorId === 'string' && input.editorId ? input.editorId : 'default';
      const args = Array.isArray(input.arguments) ? input.arguments : [];
      if (['office:close-editor', 'office:import-workbook', 'office:import-files'].includes(channel)) rejectActions(id);
      if (channel === 'workbook:recovery-prompt-reply') {
        const editor = editors.get(id);
        if (!editor || editor.closing) return Promise.reject(new Error('The Sheets editor is not open.'));
        if (typeof args[0] !== 'boolean') return Promise.reject(new Error('Invalid Sheets recovery choice.'));
        return settleRecovery(editor, args[0] ? 'restore' : 'discard').then(() => null);
      }
      if (channel === 'office:close-editor') {
        const editor = editors.get(id);
        if (editor) { editor.closing = true; editor.importController?.abort(); }
        // Reply before entering the lifecycle gate: a pending native open
        // holds that gate while it waits for this renderer's recovery choice.
        return (editor ? settleRecovery(editor, 'dismissed') : Promise.resolve())
          .then(() => exclusive(id, () => call(id, channel, args)));
      }
      // Stream reads bypass the lifecycle gate: no head-of-line blocking behind a save.
      const mutates = !editors.has(id) || ['office:open-editor', 'office:close-editor', 'workbook:save', 'workbook:update-password', 'workbook:reopen', 'workbook:open-encrypted', 'workbook:close', 'workbook:select', 'workbook:write-recovery', 'office:import-workbook', 'office:import-files', 'office:selection-close', 'office:merge-workbooks'].includes(channel);
      return mutates ? exclusive(id, () => call(id, channel, args)) : call(id, channel, args);
    },
    beginClose,
    dispose() {
      return disposePromise ??= (async () => {
        await beginClose();
        await Promise.allSettled(tails.values());
        stopEvents();
        try {
          await Promise.all([...editors.keys()].map(closeEditor));
        } finally {
          if (runtimePromise) (await runtimePromise).stopSheetsSidecar();
        }
      })();
    }
  };
  return api;
}
