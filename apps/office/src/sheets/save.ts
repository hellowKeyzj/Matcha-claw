import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { encryptOoxml } from '@genoffice/electron-utils';
import { basename, join } from 'node:path';
import type { WorkbookFile } from '../../genoffice/apps/sheets/src/shared/desktop-api';
import type { SessionInfo } from '@matcha/sheets-save-runtime';
import type { FakeIpcEvent } from '../platform/electron-main';
import type { SheetsSessionHooks } from './session';
import { workbookIdentity } from './external-links';

export interface LibraryWorkbook {
  documentId: string;
  revision: number;
  path: string;
  name: string;
  identityPath: string;
  originPath?: string;
  type?: 'xlsx' | 'csv';
}

/** Prepare a new native generation without touching the live session or save base. */
export async function saveLibraryWorkbook(
  event: FakeIpcEvent,
  input: unknown,
  binding: LibraryWorkbook,
  hooks: SheetsSessionHooks,
  directory: string,
  copyName?: string
): Promise<{ file: WorkbookFile; binding: LibraryWorkbook; touchedEntries: readonly string[] }> {
  const { sessionFor, resolveTransferredEdits, workbookSaveRequestSchema, writeWorkbookTo, openWorkbookSession, clearWorkbookRecovery } = await import('@matcha/sheets-save-runtime');
  const entry = sessionFor(event);
  const request = resolveTransferredEdits(entry, workbookSaveRequestSchema.parse(input));
  const session = entry.sessions.get(request.sessionId);
  if (!session) throw new Error('Unknown workbook session.');
  if (request.targetPath !== undefined) throw new Error('Library saves do not accept filesystem targets.');
  if (copyName) {
    const extension = /\.xlsm$/i.test(binding.name) ? 'xlsm' : 'xlsx';
    copyName = copyName.replace(/\.(xlsx|xlsm|csv)$/i, '') + `.${extension}`;
  }
  const csvSave = binding.type === 'csv' && request.mode === 'save';
  if (csvSave && request.csvContent === undefined) throw new Error('CSV save requires the original active-sheet serialization.');
  const outputName = request.mode === 'save-as' && binding.type === 'csv'
    ? (copyName ?? binding.name).replace(/\.(csv|xlsx)$/i, '') + '.xlsx' : copyName ?? binding.name;
  const generation = await mkdtemp(join(directory, 'save-'));
  const path = join(generation, basename(outputName).replace(/\.csv$/i, '.xlsx'));
  const prepared = new Map<string, SessionInfo>();
  let file: WorkbookFile | undefined;
  let touchedEntries: readonly string[] = [];
  let committed = false;
  try {
    const produce = async () => {
      const mutation = await writeWorkbookTo(entry.client, session, request, path);
      touchedEntries = mutation.touchedEntries;
      file = await openWorkbookSession(entry.client, path, prepared,
        session.password === undefined ? {} : { password: session.password });
      return { bytes: csvSave ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(request.csvContent!, 'utf8')])
        : new Uint8Array(await readFile(path)), sourcePath: binding.originPath };
    };
    let saved: LibraryWorkbook;
    if (request.mode === 'save-as') {
      const created = await hooks.createDocument(outputName, produce);
      saved = { ...created, type: 'xlsx', path, identityPath: workbookIdentity(created.documentId), originPath: binding.originPath };
    } else {
      const revision = await hooks.saveDocument(binding.documentId, binding.revision, produce);
      saved = { ...binding, revision, path };
    }
    committed = true;
    // All fallible export/open/I/O work finished before the library commit.
    // Publish the replacement before retiring the old session.
    entry.sessions.set(file!.sessionId, prepared.get(file!.sessionId)!);
    entry.currentPath = path;
    entry.sessions.delete(request.sessionId);
    await entry.client.close(request.sessionId).catch(() => {});
    await rm(session.snapshotPath, { force: true }).catch(() => {});
    clearWorkbookRecovery(binding.identityPath);
    return { file: { ...file!, name: saved.name, path: saved.identityPath,
      ...(saved.type === 'csv' ? { csvPath: saved.identityPath } : {}) }, binding: saved, touchedEntries };
  } finally {
    if (!committed) {
      for (const [id, session] of prepared) {
        await entry.client.close(id).catch(() => {});
        await rm(session.snapshotPath, { force: true }).catch(() => {});
      }
      await rm(generation, { recursive: true, force: true });
    }
  }
}

export async function changeLibraryPassword(
  event: FakeIpcEvent,
  sessionId: string,
  password: string,
  binding: LibraryWorkbook,
  hooks: SheetsSessionHooks,
  directory: string
): Promise<{ binding: LibraryWorkbook; sha256: string; fileBytes: number; passwordProtected: true }> {
  const { sessionFor, clearWorkbookRecovery } = await import('@matcha/sheets-save-runtime');
  const entry = sessionFor(event);
  const session = entry.sessions.get(sessionId);
  if (!session?.password) throw new Error('This workbook is not protected by an open password.');
  if (!password || password.length > 1024) throw new Error('Invalid workbook password.');
  const generation = await mkdtemp(join(directory, 'password-'));
  const path = join(generation, basename(binding.name));
  let bytes: Buffer | undefined;
  let committed = false;
  try {
    const revision = await hooks.saveDocument(binding.documentId, binding.revision, async () => {
      bytes = encryptOoxml(await readFile(session.snapshotPath), password);
      await writeFile(path, bytes);
      return new Uint8Array(bytes);
    });
    committed = true;
    const sha256 = createHash('sha256').update(bytes!).digest('hex');
    entry.sessions.set(sessionId, { ...session, path, password, sha256 });
    entry.currentPath = path;
    clearWorkbookRecovery(binding.identityPath);
    return { binding: { ...binding, revision, path }, sha256, fileBytes: bytes!.byteLength, passwordProtected: true };
  } finally {
    if (!committed) await rm(generation, { recursive: true, force: true });
  }
}
