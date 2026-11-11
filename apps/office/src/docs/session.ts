import type { AppJson, AppPluginContext } from '@matcha/app-plugins-sdk';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { link, mkdtemp, open as openFile, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { safeExternalUrl } from '../../genoffice/packages/electron-utils/src/safe-external-url';
import type { DocumentService } from '../documents/service';
import { decodeBase64, documentId, integer, object, text } from '../documents/validation';
import { OfficeError, errorMessage } from '../errors';
import {
  commitDocPasswordSave, currentDocPasswordIntentRevision, decryptDocx, decryptRecoveryCopy,
  discardDocPasswordIntents, DocxDecryptError, encryptDocx, forgetDocPasswords, isEncryptedDocx,
  markDiskEncrypted, prepareRecoveryDocx, rememberDocPassword, renameDocPassword, setDocPassword, snapshotDocPassword
} from '../../genoffice/apps/docs/src/main/docx-encryption';
import { readMergeDataSource } from '../../genoffice/apps/docs/src/main/merge-data-source';
import { ZoteroWireClient } from '../../genoffice/apps/docs/src/main/zotero-wire';
import { fetchRemoteImage, MAX_REMOTE_IMAGE_BYTES, readBodyCapped } from '../../genoffice/packages/electron-utils/src/remote-image';
import { configureMetricsCache, familyVerticalMetrics } from '../../genoffice/packages/font-metrics/src/metrics';
import { createDocsRecovery } from './recovery';
import { createDocsResources } from './resource';
import { createDocsMedia, docsFileHash } from './media';
import { convertHtmlDocument } from '../conversion';
import type { DocsOpenCandidate, OpenFileResult } from './types';
import { docsSystemFontFamilies } from './fonts';
import { createDocsOriginals } from './originals';

interface Snapshot {
  id: string;
  name: string;
  revision: number;
  file: string;
  hash: string;
  release?: () => Promise<void>;
  overwriteRevision?: number;
}

interface EditorSession {
  id: number;
  snapshots: Map<string, Snapshot>;
  zotero: ZoteroWireClient;
  pending: Map<string, { resolve(value: unknown): void; reject(error: Error): void }>;
  closed: boolean;
  media: ReturnType<typeof createDocsMedia>;
  resources: ReturnType<typeof createDocsResources>;
  leases: Set<() => Promise<void>>;
}

export function createDocsSession(context: AppPluginContext, documents: DocumentService) {
  configureMetricsCache(join(context.storagePath, 'docs', 'font-metrics'));
  const editors = new Map<string, EditorSession>();
  const recovery = createDocsRecovery(context.storagePath);
  const originals = createDocsOriginals(context.storagePath);
  let nextId = 1;
  let closing = false;
  let disposed = false;

  function editorFor(editorId: unknown): [string, EditorSession] {
    if (closing || disposed) throw new Error('Docs is closing.');
    const key = text(editorId, 'editorId', 36);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(key)) throw new Error('Invalid Docs editor id.');
    let editor = editors.get(key);
    if (!editor) {
      const media = createDocsMedia();
      editor = { id: nextId++, snapshots: new Map(), zotero: new ZoteroWireClient(), pending: new Map(), closed: false, media, resources: createDocsResources(context.storagePath, media.read), leases: new Set() };
      editors.set(key, editor);
    }
    if (editor.closed) throw new Error('The document was closed.');
    return [key, editor];
  }

  function passwordValue(value: unknown): string {
    if (typeof value !== 'string' || !value.length || value.length > 65536) throw new Error('Invalid document password.');
    return value;
  }

  function snapshotFor(editor: EditorSession, value: unknown): [string, Snapshot] {
    const path = text(value, 'snapshot path', 1000);
    const snapshot = editor.snapshots.get(path);
    if (!snapshot) throw new Error('The document has no open library snapshot.');
    return [path, snapshot];
  }

  async function resultFor(editor: EditorSession, path: string, snapshot: Snapshot, bytes: Buffer, encrypted: boolean, recovered = false): Promise<OpenFileResult> {
    return {
      path, name: snapshot.name, hash: snapshot.hash,
      dataUrl: await editor.resources.handoff(bytes),
      encrypted, ...(recovered ? { recovered: true } : {})
    };
  }

  async function encryptedSnapshot(snapshot: Snapshot): Promise<boolean> {
    const file = await openFile(snapshot.file, 'r');
    try {
      const bytes = Buffer.alloc(4096);
      const read = await file.read(bytes);
      return isEncryptedDocx(bytes.subarray(0, read.bytesRead));
    } finally { await file.close(); }
  }

  async function openSnapshot(editor: EditorSession, path: string, snapshot: Snapshot, password?: string): Promise<DocsOpenCandidate> {
    const encrypted = await encryptedSnapshot(snapshot);
    if (encrypted && !password) return { needsPassword: true, path, name: snapshot.name };
    const source = encrypted ? await decryptDocx(await readFile(snapshot.file), password!) : snapshot.file;
    await originals.archive(snapshot.file, snapshot.hash);
    rememberDocPassword(editor.id, path, encrypted ? password! : null);
    markDiskEncrypted(editor.id, path, encrypted);
    // Publish one-shot bytes only after the recovery choice has completed.
    if (await recovery.read(snapshot.id)) return { path, name: snapshot.name, hash: snapshot.hash, recoveryPending: true, encrypted };
    const bytes = await editor.media.slim(source, snapshot.hash);
    if (editor.closed) throw new Error('The document was closed.');
    return resultFor(editor, path, snapshot, bytes, encrypted);
  }

  async function open(editor: EditorSession, id: string, signal?: AbortSignal): Promise<DocsOpenCandidate> {
    const lease = await documents.readSnapshot(id, signal);
    if (editor.closed) { await lease.release(); throw new Error('The document was closed.'); }
    if (lease.record.type !== 'docx') { await lease.release(); throw new Error('The library document is not a Word document.'); }
    editor.leases.add(lease.release);
    const path = `matcha-office://${id}/${randomUUID()}/${encodeURIComponent(lease.record.name)}`;
    const snapshot: Snapshot = {
      id, name: lease.record.name, revision: lease.record.revision, file: lease.path,
      hash: await docsFileHash(lease.path)
    };
    editor.snapshots.set(path, snapshot);
    return openSnapshot(editor, path, snapshot);
  }

  async function save(editor: EditorSession, channel: string, args: readonly unknown[], signal?: AbortSignal) {
    const replacing = channel === 'save' || channel === 'save-overwrite';
    const source = replacing ? snapshotFor(editor, args[0])
      : channel === 'save-as' && args[2] != null ? snapshotFor(editor, args[2]) : null;
    const expectedRevision = channel === 'save-overwrite' ? source![1].overwriteRevision : source?.[1].revision;
    if (channel === 'save-overwrite') {
      if (expectedRevision === undefined || expectedRevision !== integer(args[2], 'overwrite revision', 1)) throw new Error('The overwrite candidate is no longer available.');
      source![1].overwriteRevision = undefined;
    }
    const state = snapshotDocPassword(editor.id, source?.[0] ?? null);
    return editor.resources.consume(text(args[1], 'uploadId', 36), async file => {
      const plain = await editor.media.materialize(await readFile(file));
      const bytes = state.password ? encryptDocx(plain, state.password) : plain;
      const combined = signal ? AbortSignal.any([signal, editor.resources.signal]) : editor.resources.signal;
      combined.throwIfAborted();
      const hash = createHash('sha256').update(bytes).digest('hex');
      const stable = `${file}.snapshot`;
      await link(file, stable);
      let committed = false;
      try {
        await writeFile(file, bytes);
        const record = replacing
          ? await documents.write(source![1].id, expectedRevision!, { filePath: file }, undefined, combined)
          : await documents.import(text(args[0], 'name', 200), 'docx', { filePath: file }, undefined, undefined, combined);
        const path = replacing ? source![0]
          : `matcha-office://${record.id}/${randomUUID()}/${encodeURIComponent(record.name)}`;
        committed = true;
        const release = () => rm(stable, { force: true });
        const snapshot: Snapshot = { id: record.id, name: record.name, revision: record.revision, file: stable, hash, release };
        if (!editor.closed) {
          const previous = editor.snapshots.get(path);
          editor.leases.add(release);
          editor.snapshots.set(path, snapshot);
          if (previous?.release) {
            editor.leases.delete(previous.release);
            void previous.release().catch(error => console.warn('[office:docs:snapshot-clear]', errorMessage(error)));
          }
        }
        else void rm(stable, { force: true }).catch(error => console.warn('[office:docs:snapshot-clear]', errorMessage(error)));
        const passwordIntentPending = editor.closed ? false : commitDocPasswordSave(editor.id, state, path);
        await Promise.all([...new Set([record.id, ...(source ? [source[1].id] : [])])].map(id => recovery.clear(id)))
          .catch(error => console.warn('[office:docs:recovery-clear]', errorMessage(error)));
        return { ok: true, path, passwordIntentPending };
      } catch (error) {
        if (!committed) await rm(stable, { force: true });
        return { ok: false, error: errorMessage(error), ...(error instanceof OfficeError && error.code === 'revision_conflict' ? { reason: 'external-modified' } : {}) };
      }
    });
  }

  function stopZotero(editor: EditorSession): void {
    editor.zotero.close();
    for (const waiter of editor.pending.values()) waiter.reject(new Error('The document was closed.'));
    editor.pending.clear();
  }

  function beginClose(): void {
    closing = true;
    for (const editor of editors.values()) {
      stopZotero(editor);
      void editor.resources.close();
    }
  }

  async function close(editor: EditorSession): Promise<void> {
    editor.closed = true;
    stopZotero(editor);
    await editor.resources.close();
    editor.media.clear();
    await Promise.all([...editor.leases].map(release => release()));
    editor.leases.clear();
    editor.snapshots.clear();
    forgetDocPasswords(editor.id);
  }

  async function call(input: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<unknown> {
    object(input, ['channel', 'arguments', 'editorId']);
    const [editorId, editor] = editorFor(input.editorId);
    const channel = text(input.channel, 'channel', 80);
    const args = input.arguments ?? [];
    if (!Array.isArray(args) || args.length > 8) throw new Error('Invalid Docs arguments.');
    switch (channel) {
      case 'open-external': {
        const url = safeExternalUrl(text(args[0], 'url', 8192));
        if (!url) throw new OfficeError('invalid_request', 'Only HTTP and HTTPS document links can be opened.');
        return context.desktop.openExternal({ url });
      }
      case 'system-locale': return (await context.desktop.systemLocale({})).locale;
      case 'font-families': return docsSystemFontFamilies();
      case 'font-metrics': return familyVerticalMetrics(text(args[0], 'family', 200));
      case 'resources': return { baseUrl: await editor.resources.ready };
      case 'upload-start': return editor.resources.upload(integer(args[0], 'size', 1));
      case 'refresh-metadata': {
        const id = documentId(args[0]);
        const candidates = [...editor.snapshots.entries()].filter(([, snapshot]) => snapshot.id === id);
        if (!candidates.length) return [];
        const lease = await documents.readSnapshot(id, signal);
        try {
          const hash = await docsFileHash(lease.path);
          const renamed: { oldPath: string; newPath: string }[] = [];
          for (const [path, snapshot] of candidates) {
            if (snapshot.hash !== hash) continue;
            snapshot.revision = lease.record.revision;
            if (snapshot.name === lease.record.name) continue;
            snapshot.name = lease.record.name;
            const newPath = path.slice(0, path.lastIndexOf('/') + 1) + encodeURIComponent(snapshot.name);
            renameDocPassword(editor.id, path, newPath);
            editor.snapshots.delete(path);
            editor.snapshots.set(newPath, snapshot);
            renamed.push({ oldPath: path, newPath });
          }
          return renamed;
        } finally { await lease.release(); }
      }
      case 'open': return open(editor, documentId(args[0]), signal);
      case 'import': return editor.resources.consume(text(args[1], 'uploadId', 36), async file => {
        const combined = signal ? AbortSignal.any([signal, editor.resources.signal]) : editor.resources.signal;
        const record = await documents.import(text(args[0], 'name', 200), 'docx', { filePath: file }, undefined, undefined, combined);
        return open(editor, record.id, combined);
      });
      case 'open-decrypt': {
        const [path, snapshot] = snapshotFor(editor, args[0]);
        try {
          return { ok: true, result: await openSnapshot(editor, path, snapshot, passwordValue(args[1])) };
        } catch (error) {
          return { ok: false, reason: error instanceof DocxDecryptError ? error.reason : 'error', error: errorMessage(error) };
        }
      }
      case 'set-password': {
        const path = args[0] === null ? null : snapshotFor(editor, args[0])[0];
        const password = args[1] === null ? null : passwordValue(args[1]);
        setDocPassword(editor.id, path, password);
        return { ok: true };
      }
      case 'password-revision': return currentDocPasswordIntentRevision();
      case 'discard-passwords':
        discardDocPasswordIntents(editor.id, integer(args[0], 'throughRevision'));
        return { ok: true };
      case 'overwrite-candidate': {
        const [, snapshot] = snapshotFor(editor, args[0]);
        const lease = await documents.readSnapshot(snapshot.id, signal);
        try {
          await originals.archive(lease.path, await docsFileHash(lease.path));
          snapshot.overwriteRevision = lease.record.revision;
          return { revision: lease.record.revision };
        } finally { await lease.release(); }
      }
      case 'save':
      case 'save-overwrite':
      case 'save-as':
      case 'save-new': return save(editor, channel, args, signal);
      case 'recovery-status': {
        const [, snapshot] = snapshotFor(editor, args[0]);
        const copy = await recovery.read(snapshot.id);
        return copy ? { available: true, diskNewer: snapshot.revision > copy.revision } : { available: false };
      }
      case 'recovery-original': {
        const [path, snapshot] = snapshotFor(editor, args[0]);
        const plain = await decryptRecoveryCopy(editor.id, path, await readFile(snapshot.file));
        const source = await editor.resources.retain(plain);
        const bytes = await editor.media.slim(source, snapshot.hash);
        return resultFor(editor, path, snapshot, bytes, await encryptedSnapshot(snapshot));
      }
      case 'recovery-restore': {
        const [path, snapshot] = snapshotFor(editor, args[0]);
        const copy = await recovery.read(snapshot.id);
        if (!copy) {
          const bytes = await editor.media.slim(await editor.resources.retain(await decryptRecoveryCopy(editor.id, path, await readFile(snapshot.file))), snapshot.hash);
          return resultFor(editor, path, snapshot, bytes, await encryptedSnapshot(snapshot));
        }
        let bytes: Buffer;
        let recovered = true;
        try {
          bytes = await decryptRecoveryCopy(editor.id, path, Buffer.from(copy.data, 'base64'));
        } catch {
          bytes = await decryptRecoveryCopy(editor.id, path, await readFile(snapshot.file));
          recovered = false;
        }
        const restoredPath = await editor.resources.retain(bytes);
        bytes = await editor.media.slim(restoredPath, createHash('sha256').update(bytes).digest('hex'));
        return resultFor(editor, path, snapshot, bytes, await encryptedSnapshot(snapshot), recovered);
      }
      case 'recovery-clear-all':
        await Promise.all([...new Set([...editor.snapshots.values()].map(snapshot => snapshot.id))].map(id => recovery.clear(id)));
        return { ok: true };
      case 'recovery-clear': {
        const [, snapshot] = snapshotFor(editor, args[0]);
        await recovery.clear(snapshot.id);
        return { ok: true };
      }
      case 'recovery-epoch': return recovery.epoch(snapshotFor(editor, args[0])[1].id);
      case 'recovery-write': {
        const [path, snapshot] = snapshotFor(editor, args[0]);
        const epoch = integer(args[2], 'recovery epoch');
        return editor.resources.consume(text(args[1], 'uploadId', 36), async file => {
          const plain = await editor.media.materialize(await readFile(file));
          const bytes = prepareRecoveryDocx(editor.id, path, plain);
          return { ok: bytes !== null && await recovery.write(snapshot.id, snapshot.revision, bytes, epoch) };
        });
      }
      case 'convert-html': {
        const html = text(args[0], 'html', 32 * 1024 * 1024);
        const bytes = await convertHtmlDocument(context, html, { format: 'docx', naturalTableWidth: true });
        return { data: Buffer.from(bytes).toString('base64') };
      }
      case 'merge-source': {
        const name = text(args[0], 'name', 200);
        if (!/\.(xlsx|csv)$/i.test(name)) throw new Error('Choose an .xlsx or .csv recipient list.');
        const directory = await mkdtemp(join(tmpdir(), 'matcha-office-merge-'));
        try {
          const path = join(directory, basename(name));
          await writeFile(path, decodeBase64(text(args[1], 'data', 80_000_000)), { mode: 0o600 });
          const source = await readMergeDataSource(path);
          return { ok: true, source: { ...source, path: name } };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
      case 'merge-output': return editor.resources.consume(text(args[0], 'uploadId', 36), async file => {
        const bytes = await editor.media.materialize(await readFile(file));
        return { dataUrl: await editor.resources.handoff(bytes) };
      });
      case 'fetch-image': {
        const response = await fetchRemoteImage(text(args[0], 'url', 8192));
        if (!response?.ok) return null;
        const bytes = await readBodyCapped(response, MAX_REMOTE_IMAGE_BYTES);
        const mime = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
        return { base64: Buffer.from(bytes).toString('base64'), mime };
      }
      case 'zotero-command': {
        const command = text(args[0], 'command', 40);
        if (!/^(addEditCitation|addEditBibliography|refresh|setDocPrefs|removeCodes)$/.test(command)) {
          return { ok: false, errorCode: 'unsupported-command', error: 'Unsupported Zotero command.' };
        }
        try {
          await editor.zotero.run(command, (request) => new Promise((resolve, reject) => {
            if (closing || editor.closed) { reject(new Error('Docs is closing.')); return; }
            const requestId = randomUUID();
            const timer = setTimeout(() => {
              editor.pending.delete(requestId);
              reject(new Error(`Timed out handling ${request.command}`));
            }, 600_000);
            editor.pending.set(requestId, {
              resolve(value) { clearTimeout(timer); resolve(value); },
              reject(error) { clearTimeout(timer); reject(error); }
            });
            try {
              context.publish('office.docs.zotero:request', { editorId, payload: { requestId, ...request } } as AppJson);
            } catch (error) {
              editor.pending.delete(requestId);
              clearTimeout(timer);
              reject(error);
            }
          }));
          return { ok: true };
        } catch (error) {
          const message = errorMessage(error);
          return { ok: false, errorCode: /ECONNREFUSED/.test(message) ? 'connection-refused' : 'operation-failed', error: message };
        }
      }
      case 'zotero-response': {
        const response = object(args[0], ['requestId', 'ok', 'result', 'error']);
        const requestId = text(response.requestId, 'requestId', 36);
        const pending = editor.pending.get(requestId);
        if (!pending) return;
        editor.pending.delete(requestId);
        if (response.ok === true) pending.resolve(response.result);
        else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'Zotero operation failed.'));
        return;
      }
      case 'close': await close(editor); return;
      default: throw new OfficeError('unsupported', `Unknown Docs operation: ${channel}`);
    }
  }

  return {
    call,
    beginClose,
    async dispose(): Promise<void> {
      beginClose();
      disposed = true;
      await Promise.all([...editors.values()].map(close));
      editors.clear();
    }
  };
}
