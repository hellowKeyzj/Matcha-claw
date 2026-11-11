import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { safeExternalUrl } from '../../genoffice/packages/electron-utils/src/safe-external-url';
import type { DocumentService } from '../documents/service';
import { decodeBase64 } from '../documents/validation';
import { createIpcEvent, destroyWebContents, invokeIpc, onWebContentsSend } from '../platform/electron-main';
import { dispatchIpc } from '../platform/electron-main';
import { PDF_CHANNELS as C } from '../../genoffice/apps/pdf/src/shared/ipc';
import type { SavePdfRequest } from '../../genoffice/apps/pdf/src/shared/ipc';
import { withPdfDialogs, type PdfDialogs } from './dialog';
import { configurePdfOcr } from './ocr';
import { convertPdf } from './engine';
import { exportDocsDocument } from '../docs/headless';
import { validatePdfEdits } from './validation';
import { atomicWriteFile } from '../../genoffice/packages/electron-utils/src/atomic-write';
import { normalizeLang, type Lang } from '../../genoffice/packages/i18n/src';

type Main = typeof import('@matcha/pdf-main');
type View = ReturnType<Main['createPdfView']>;
interface Binding { documentId: string; revision: number; name: string; path: string }
type Delivery = 'document' | 'download';
interface Product { documentId: string; name: string }
interface Editor {
  view: View; directory: string; binding?: Binding; redacted?: string; language: Lang;
  saveAs?: { path: string; name: string; product?: Product }; outputs: Map<string, Delivery>;
  requests: Map<string, { resolve(value: unknown): void; timer: ReturnType<typeof setTimeout> }>;
  outputDirectories: Map<string, Delivery>;
  generatedPaths: Set<string>;
  saveAsInFlight?: boolean;
  flush?: Promise<boolean>;
}
const sends = new Set<string>([C.dirtyChanged, C.closeSaveResult, C.saveAsResult, C.releaseCertificate]);
const denied = new Set<string>([C.print, C.printFile, C.printers, C.printerOptions, C.generateImage, C.createDocument]);
const mutations = new Set<string>([C.insertPdf, C.insertBlankPage, C.replacePages, C.restoreFile, C.setPageSize, C.cropPages]);
const generatedOutputs = new Set<string>([C.extractPages, C.splitPdf, C.mergePdf, C.mergePages, C.splitPages, C.exportImages]);
const channels = new Set<string>(Object.values(C));

export function createPdfSession(context: AppPluginContext, documents: DocumentService) {
  const hooks = documents.editorHooks('pdf');
  configurePdfOcr(context.packagePath);
  const editors = new Map<string, Editor>();
  const tails = new Map<string, Promise<unknown>>();
  let disposed = false;
  let closing = false;
  let loaded: Promise<Main> | undefined;
  const runtime = () => loaded ??= (async () => {
    const main = await import('@matcha/pdf-main');
    main.configurePdfRuntime({ preloadPath: '', rendererFile: join(context.packagePath, 'pdf.html'),
      documentName: (wcId) => {
        for (const editor of editors.values()) if (editor.view.webContents.id === wcId && editor.binding) return editor.binding.name;
        throw new Error('The PDF editor has no library document.');
      },
      openGeneratedPath: (path) => {
        for (const editor of editors.values()) if (editor.outputDirectories.has(dirname(path))) {
          editor.generatedPaths.add(path);
          return true;
        }
        return false;
      } });
    return main;
  })();
  function serial<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (tails.get(id) ?? Promise.resolve()).then(run, run);
    const settled = next.then(() => {}, () => {});
    tails.set(id, settled);
    void settled.then(() => { if (tails.get(id) === settled) tails.delete(id); });
    return next;
  }
  function publish(id: string, channel: string, payload: unknown): void {
    context.publish(`office.pdf.${channel}`, { editorId: id, payload: payload ?? null } as AppJson);
  }
  const stopEvents = onWebContentsSend((channel, payload, sender) => {
    for (const [id, editor] of editors) if (editor.view.webContents.id === sender) { publish(id, channel, payload); break; }
  });
  async function ask(id: string, editor: Editor, kind: string, options: unknown): Promise<unknown> {
    if (closing || disposed) return null;
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { editor.requests.delete(requestId); reject(new Error('PDF file interaction timed out.')); }, 120_000);
      editor.requests.set(requestId, { resolve, timer });
      try { publish(id, 'office:dialog', { requestId, kind, options }); }
      catch (error) { clearTimeout(timer); editor.requests.delete(requestId); reject(error); }
    });
  }
  function dialogs(id: string, editor: Editor, directory: string, delivery: Delivery): PdfDialogs {
    return {
      directory, language: editor.language,
      async showOpenDialog(options) {
        if ((options.properties as string[] | undefined)?.includes('openDirectory')) return { canceled: false, filePaths: [directory] };
        const selected = await ask(id, editor, 'open', options) as { files?: { name: string; data: string }[] } | null;
        if (!selected?.files?.length) return { canceled: true, filePaths: [] };
        if (selected.files.length > 30) throw new Error('Too many PDF input files.');
        const paths: string[] = [];
        for (const file of selected.files) {
          if (typeof file.name !== 'string' || typeof file.data !== 'string') throw new Error('Invalid PDF input file.');
          const dir = await mkdtemp(join(editor.directory, 'input-'));
          const path = join(dir, basename(file.name));
          await writeFile(path, decodeBase64(file.data));
          paths.push(path);
        }
        return { canceled: false, filePaths: paths };
      },
      async showSaveDialog(options) {
        const name = await ask(id, editor, 'save', options);
        if (typeof name !== 'string' || !name.trim()) return { canceled: true };
        const dir = await mkdtemp(join(editor.directory, 'output-'));
        const path = join(dir, basename(name));
        editor.outputs.set(path, delivery);
        return { canceled: false, filePath: path };
      },
      async showMessageBox(options) {
        const response = await ask(id, editor, 'message', options);
        return { response: typeof response === 'number' ? response : (typeof options.cancelId === 'number' ? options.cancelId : 1), checkboxChecked: false };
      }
    };
  }
  async function createEditor(id: string, path?: string): Promise<Editor> {
    const main = await runtime();
    const directory = await mkdtemp(join(tmpdir(), 'matcha-office-pdf-'));
    await mkdir(join(directory, 'outputs'));
    try {
      const editor: Editor = { view: main.createPdfView(path), directory, language: 'en', outputs: new Map(), requests: new Map(), outputDirectories: new Map(), generatedPaths: new Set() };
      editors.set(id, editor);
      return editor;
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async function close(id: string): Promise<void> {
    const editor = editors.get(id);
    if (!editor) return;
    for (const request of editor.requests.values()) { clearTimeout(request.timer); request.resolve(null); }
    editor.requests.clear();
    destroyWebContents(editor.view.webContents.id);
    editors.delete(id);
    await rm(editor.directory, { recursive: true, force: true });
  }
  async function commitOutputs(id: string, editor: Editor): Promise<void> {
    for (const [directory, delivery] of editor.outputDirectories) {
      for (const file of await readdir(directory)) editor.outputs.set(join(directory, file), delivery);
      editor.outputDirectories.delete(directory);
    }
    for (const [path, delivery] of editor.outputs) {
      if (!(await stat(path).catch(() => null))?.isFile()) { editor.outputs.delete(path); continue; }
      const bytes = new Uint8Array(await readFile(path));
      if (delivery === 'document') {
        const record = await hooks.createDocument(basename(path), async () => bytes);
        editor.outputs.delete(path);
        try { publish(id, 'office:products', { documents: [{ documentId: record.documentId, name: record.name }] }); }
        catch (error) { context.log.error(`PDF was saved, but its product notification failed: ${String(error)}`); }
        try {
          const consumed = await invokeIpc(C.consumePending, [], createIpcEvent(editor.view.webContents as never));
          if (consumed === path) editor.binding = { ...record, path };
        } catch (error) { context.log.error(`PDF was saved, but editor binding refresh failed: ${String(error)}`); }
        if (editor.generatedPaths.delete(path)) {
          try { publish(id, 'office:open-document', { documentId: record.documentId }); }
          catch (error) { context.log.error(`PDF was saved, but opening it failed: ${String(error)}`); }
        }
      } else {
        const delivered = await ask(id, editor, 'download', { name: basename(path), data: Buffer.from(bytes).toString('base64') }) as { initiated?: boolean } | null;
        if (!delivered?.initiated) throw new Error('PDF export download was not initiated.');
        try { publish(id, 'office:products', { downloads: [basename(path)] }); }
        catch (error) { context.log.error(`PDF download was initiated, but its notification failed: ${String(error)}`); }
        await rm(path);
      }
      editor.outputs.delete(path);
    }
  }
  async function native(id: string, editor: Editor, channel: string, args: unknown[]) {
    const directory = generatedOutputs.has(channel)
      ? await mkdtemp(join(editor.directory, 'outputs', 'operation-'))
      : join(editor.directory, 'outputs');
    const delivery: Delivery = channel === C.exportAttachment || channel === C.exportImages ? 'download' : 'document';
    if (generatedOutputs.has(channel)) editor.outputDirectories.set(directory, delivery);
    return withPdfDialogs(dialogs(id, editor, directory, delivery), () => invokeIpc(channel, args, createIpcEvent(editor.view.webContents as never)));
  }
  async function save(editor: Editor, request: SavePdfRequest) {
    validatePdfEdits(request);
    const binding = editor.binding;
    if (!binding || request.path !== binding.path) throw new Error('This PDF does not belong to the editor.');
    const copy = request.targetPath !== undefined && request.targetPath !== binding.path;
    if (copy && request.targetPath !== editor.saveAs?.path) throw new Error('PDF copy target was not authorized.');
    if (request.redactions !== undefined) {
      if (!copy && (editor.redacted !== binding.path || editor.saveAs?.path !== binding.path)) throw new Error('Permanent redaction requires a separate copy.');
    }
    const { savePdfToPath } = await import('../../genoffice/apps/pdf/src/main/save-pdf');
    const dir = await mkdtemp(join(editor.directory, 'save-'));
    const target = join(dir, 'document.pdf');
    let result: Awaited<ReturnType<typeof savePdfToPath>>;
    const previous = copy ? undefined : await readFile(binding.path);
    const copyTarget = editor.saveAs;
    const main = await runtime();
    let mirrored = false;
    const produce = async () => {
      result = await savePdfToPath(binding.path, target, request);
      const bytes = await readFile(target);
      if (!copy) {
        mirrored = true;
        await atomicWriteFile(binding.path, bytes);
      } else if (request.redactions !== undefined) await atomicWriteFile(copyTarget!.path, bytes);
      return new Uint8Array(bytes);
    };
    try {
      if (copy) {
        const created = await hooks.createDocument(copyTarget!.name, produce);
        copyTarget!.product = { documentId: created.documentId, name: created.name };
        if (request.redactions !== undefined) {
          const path = copyTarget!.path;
          editor.binding = { ...created, path };
          editor.redacted = path;
          main.rebindPdfView(editor.view.webContents as never, path, true);
        }
      } else {
        binding.revision = await hooks.saveDocument(binding.documentId, binding.revision, produce);
      }
      return { ok: true, ...result! };
    } catch (error) {
      if (mirrored && previous) await atomicWriteFile(binding.path, previous);
      throw error;
    } finally { await rm(dir, { recursive: true, force: true }).catch((error) => console.error('PDF temporary save cleanup failed', error)); }
  }
  async function run(id: string, channel: string, args: unknown[]): Promise<unknown> {
    if (disposed) throw new Error('The PDF session is closed.');
    if (channel === 'office:close-editor') { await close(id); return null; }
    if (channel === 'office:open-editor') { if (!editors.has(id)) await createEditor(id); return null; }
    const editor = editors.get(id);
    if (!editor) throw new Error('The PDF editor is not open.');
    if (channel === 'office:dialog-reply') {
      const reply = args[0] as { requestId?: string; value?: unknown };
      const pending = reply && editor.requests.get(reply.requestId!);
      if (!pending) throw new Error('Unknown PDF file interaction.');
      clearTimeout(pending.timer); editor.requests.delete(reply.requestId!); pending.resolve(reply.value); return null;
    }
    if (sends.has(channel)) {
      if (channel === C.releaseCertificate && typeof args[0] !== 'string') throw new Error('Invalid PDF certificate id.');
      if (channel !== C.releaseCertificate && typeof args[0] !== 'boolean') throw new Error('Invalid PDF event.');
      return dispatchIpc(channel, args, createIpcEvent(editor.view.webContents as never));
    }
    if (channel === 'office:flush') {
      if (!editor.flush) {
        const main = await runtime();
        editor.flush ??= main.flushPdfSave(editor.view.webContents as never, true).finally(() => { editor.flush = undefined; });
      }
      return editor.flush;
    }
    if (channel === 'office:language') { editor.language = normalizeLang(typeof args[0] === 'string' ? args[0] : undefined); return null; }
    if (channel === 'office:dirty') return (await runtime()).pdfIsDirty(editor.view.webContents.id);
    if (channel === 'office:document') {
      const binding = editor.binding;
      if (!binding || args[0] !== binding.path) throw new Error('PDF path is not granted.');
      return { id: binding.documentId, name: binding.name };
    }
    if (channel === 'office:open-external') {
      const url = safeExternalUrl(args[0], { allowedProtocols: ['http:', 'https:', 'mailto:'] });
      if (!url) throw new Error('Invalid PDF external URL.');
      return context.desktop.openExternal({ url });
    }
    if (channel === 'office:save-as') {
      if (!editor.binding || editor.saveAsInFlight) return false;
      editor.saveAsInFlight = true;
      const main = await runtime();
      main.setPdfSaveAsInFlight(editor.view.webContents as never, true);
      try {
        const picked = await ask(id, editor, 'save', { defaultPath: editor.binding.name });
        if (typeof picked !== 'string' || !picked.trim()) return false;
        const name = /\.pdf$/i.test(picked) ? picked : `${picked}.pdf`;
        const dir = await mkdtemp(join(editor.directory, 'copy-'));
        editor.saveAs = { name: basename(name), path: join(dir, basename(name)) };
        if (main.pdfIsDirty(editor.view.webContents.id)) {
          if (!await main.requestPdfSaveAs(editor.view.webContents as never, editor.saveAs.path)) return false;
          return editor.saveAs.product;
        }
        const bytes = new Uint8Array(await readFile(editor.binding.path));
        const record = await hooks.createDocument(editor.saveAs.name, async () => bytes);
        return { documentId: record.documentId, name: record.name };
      } finally {
        editor.saveAs = undefined;
        editor.saveAsInFlight = false;
        main.setPdfSaveAsInFlight(editor.view.webContents as never, false);
      }
    }
    if (!channels.has(channel) || denied.has(channel) || channel.startsWith('ai:') || channel.startsWith('skills:')) throw new Error('This PDF channel is not available.');
    if (channel === C.isUntitled || channel === C.autoRename) {
      const binding = editor.binding;
      if (!binding || args[0] !== binding.path) return channel === C.isUntitled ? false : { renamed: false };
      if (channel === C.isUntitled) return (await hooks.readDocument(binding.documentId)).record.autoNamePending === true;
      if (typeof args[1] !== 'string') return { renamed: false };
      const base = (await runtime()).sanitizeAutoRenameBase(args[1]);
      if (!base) return { renamed: false };
      const renamed = await hooks.autoNameDocument(binding.documentId, binding.revision, base);
      if (!renamed) return { renamed: false };
      binding.name = renamed.name;
      binding.revision = renamed.revision;
      return { renamed: true, path: binding.path, name: binding.name };
    }
    if (channel === C.save) {
      try { return await save(editor, args[0] as SavePdfRequest); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    if (channel === C.requestRedactionCopy) {
      if (!editor.binding || args[0] !== editor.binding.path) throw new Error('PDF path is not granted.');
      if (editor.saveAsInFlight) return false;
      editor.saveAsInFlight = true;
      const main = await runtime();
      main.setPdfSaveAsInFlight(editor.view.webContents as never, true);
      try {
        if (editor.redacted === editor.binding.path) editor.saveAs = { path: editor.binding.path, name: editor.binding.name };
        else {
          const picked = await ask(id, editor, 'save', { defaultPath: editor.binding.name.replace(/\.pdf$/i, '-redacted.pdf') });
          if (typeof picked !== 'string' || !picked.trim()) return false;
          const name = /\.pdf$/i.test(picked) ? picked : `${picked}.pdf`;
          const dir = await mkdtemp(join(editor.directory, 'redacted-'));
          editor.saveAs = { name: basename(name), path: join(dir, basename(name)) };
        }
        return await main.requestPdfSaveAs(editor.view.webContents as never, editor.saveAs.path);
      } finally {
        editor.saveAs = undefined;
        editor.saveAsInFlight = false;
        main.setPdfSaveAsInFlight(editor.view.webContents as never, false);
      }
    }
    if (channel === C.ocrPage) {
      const png = args[0];
      if (typeof png !== 'string' || png.length === 0 || png.length > 64 * 1024 * 1024) return [];
      const { getPdfOcrEngine } = await import('./ocr');
      const engine = getPdfOcrEngine();
      if (!engine) return null;
      let bytes: Uint8Array;
      try { bytes = decodeBase64(png); } catch { return []; }
      const result = engine(bytes, { widthPt: 0, heightPt: 0 });
      return result?.lines.map((line) => ({ ...line, box: [line.box.x0, line.box.y0, line.box.x1, line.box.y1], chars: line.chars?.map((char) => ({ text: char.text, box: [char.box.x0, char.box.y0, char.box.x1, char.box.y1] })) })) ?? [];
    }
    if (channel === C.convertOffice) {
      const binding = editor.binding;
      const format = args[0];
      if (!binding || !['docx', 'pptx', 'xlsx', 'md', 'html'].includes(String(format))) throw new Error('Invalid PDF conversion.');
      const picked = await ask(id, editor, 'save', { defaultPath: binding.name.replace(/\.pdf$/i, `.${format}`) });
      if (typeof picked !== 'string' || !picked.trim()) return null;
      const name = picked.toLowerCase().endsWith(`.${format}`) ? picked : `${picked}.${format}`;
      publish(id, 'office:conversion', { page: 0, total: 0 });
      try {
        const { bytes, ...result } = await convertPdf(new Uint8Array(await readFile(binding.path)), format as Parameters<typeof convertPdf>[1], {
          password: typeof args[1] === 'string' ? args[1] : undefined,
          onProgress: (page, total) => publish(id, 'office:conversion', { page, total }),
          exportDocument: (bytes, format) => exportDocsDocument(context, bytes, format)
        });
        const record = await documents.import(basename(name), format as Parameters<typeof documents.import>[1], bytes);
        return { ...result, documentId: record.id, name: record.name };
      } finally { publish(id, 'office:conversion', null); }
    }
    if (mutations.has(channel)) {
      const binding = editor.binding;
      if (!binding || (args[0] as { path?: unknown })?.path !== binding.path) throw new Error('PDF path is not granted.');
      const previous = new Uint8Array(await readFile(binding.path));
      let output: unknown;
      const canceled = new Error('PDF page operation was canceled.');
      try {
        const revision = await hooks.saveDocument(binding.documentId, binding.revision, async () => {
          output = await native(id, editor, channel, args);
          if ((output as { canceled?: boolean })?.canceled) throw canceled;
          if (!(output as { ok?: boolean })?.ok) throw new Error((output as { error?: string })?.error ?? 'PDF page operation failed.');
          return new Uint8Array(await readFile(binding.path));
        });
        binding.revision = revision;
        return output;
      } catch (error) {
        await atomicWriteFile(binding.path, Buffer.from(previous));
        if (error === canceled) return output;
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    const original = editor.binding;
    try {
      const output = await native(id, editor, channel, args);
      await commitOutputs(id, editor);
      return output;
    } catch (error) {
      if (original) (await runtime()).rebindPdfView(editor.view.webContents as never, original.path, editor.redacted === original.path);
      throw error;
    }
  }
  return {
    open(documentId: string, name: string, bytes: Uint8Array, revision: number, editorId = 'default') {
      return serial(editorId, async () => {
        if (disposed || closing) throw new Error('The PDF session is closed.');
        await close(editorId);
        const editor = await createEditor(editorId);
        const path = join(editor.directory, basename(name));
        await writeFile(path, bytes);
        editor.binding = { documentId, name, revision, path };
        (await runtime()).rebindPdfView(editor.view.webContents as never, path);
        return { path, name, documentId, revision };
      });
    },
    call(input: Readonly<Record<string, unknown>>) {
      const id = typeof input.editorId === 'string' ? input.editorId : 'default';
      const channel = String(input.channel ?? '');
      if (closing && !sends.has(channel) && channel !== 'office:dialog-reply' && channel !== C.save) return Promise.reject(new Error('The PDF session is closing.'));
      const args = Array.isArray(input.arguments) ? input.arguments : [];
      if (sends.has(channel) || ['office:dialog-reply', 'office:flush', 'office:save-as', C.requestRedactionCopy].includes(channel) || channel === C.readFileChunk) return run(id, channel, args);
      return serial(id, () => run(id, channel, args));
    },
    async beginClose() {
      closing = true;
      for (const editor of editors.values()) {
        for (const request of editor.requests.values()) { clearTimeout(request.timer); request.resolve(null); }
        editor.requests.clear();
        const event = createIpcEvent(editor.view.webContents as never);
        await dispatchIpc(C.closeSaveResult, [false], event);
        await dispatchIpc(C.saveAsResult, [false], event);
      }
    },
    async dispose() {
      disposed = true;
      for (const editor of editors.values()) {
        for (const request of editor.requests.values()) { clearTimeout(request.timer); request.resolve(null); }
        destroyWebContents(editor.view.webContents.id);
      }
      await Promise.allSettled(tails.values());
      stopEvents();
      await Promise.all([...editors.keys()].map(close));
    }
  };
}
