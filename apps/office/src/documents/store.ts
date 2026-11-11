import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join, posix } from 'node:path';
import type { DocumentContent, DocumentIndex, DocumentRecord, DocumentResource, DocumentSnapshot, DocumentType } from './model';
import { OfficeError } from '../errors';

const MIME: Record<DocumentType, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  pdf: 'application/pdf',
  md: 'text/markdown',
  html: 'text/html',
  txt: 'text/plain',
  json: 'application/json'
};

const EXT: Record<DocumentType, string> = { docx: 'docx', xlsx: 'xlsx', csv: 'csv', pptx: 'pptx', pdf: 'pdf', md: 'md', html: 'html', txt: 'txt', json: 'json' };
const ALLOWED = new Set(Object.keys(EXT) as DocumentType[]);

interface StoredResource {
  readonly path: string;
  readonly file: string;
  readonly size: number;
  readonly ownedSha256?: string;
}

interface StoredDocument extends DocumentRecord {
  readonly file?: string;
  readonly resources?: readonly StoredResource[];
  readonly sourcePath?: string;
}

interface StoredIndex extends DocumentIndex {
  readonly documents: readonly StoredDocument[];
}

function publicRecord({ file: _file, resources: _resources, sourcePath: _sourcePath, ...record }: StoredDocument): DocumentRecord {
  return record;
}

export function resourcePath(value: string): string {
  if (!value || value.length > 1000 || /[\\\u0000-\u001f:*?"<>|]/.test(value) || value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
    throw new OfficeError('invalid_request', 'Resource path must be a safe document-relative path.');
  }
  return value;
}

function contentOf(value: DocumentContent): Exclude<DocumentContent, Uint8Array> {
  return value instanceof Uint8Array ? { bytes: value } : value;
}

function assertUniquePath(index: StoredIndex, record: DocumentRecord): void {
  const path = (record.libraryPath ?? `${record.id}/${record.name}`).toLowerCase();
  if (index.documents.some((entry) => entry.id !== record.id && (entry.libraryPath ?? `${entry.id}/${entry.name}`).toLowerCase() === path)) {
    throw new OfficeError('path_conflict', 'A document already exists at this library path.', { libraryPath: record.libraryPath });
  }
}

function libraryPathFor(value: string, type: DocumentType): string {
  resourcePath(value);
  const parts = value.split('/');
  const name = parts.pop()!;
  if (cleanName(name, type) !== name) throw new OfficeError('invalid_request', 'Library path must use a valid filename with the document extension.');
  return value;
}

function now(): string {
  return new Date().toISOString();
}

function cleanName(value: string, type: DocumentType): string {
  const sanitized = [...value].map((character) => character.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(character) ? ' ' : character).join('');
  const name = sanitized.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Untitled';
  const extension = extname(name).slice(1).toLowerCase();
  if (extension === EXT[type] || (type === 'md' && extension === 'markdown') || (type === 'xlsx' && extension === 'xlsm')) return name;
  const stem = extension && (ALLOWED.has(extension as DocumentType) || extension === 'markdown')
    ? name.slice(0, -(extension.length + 1))
    : name;
  return `${stem}.${EXT[type]}`;
}

export function createStore(storagePath: string) {
  const root = join(storagePath, 'office');
  const files = join(root, 'files');
  const indexPath = join(root, 'documents.json');
  let indexTail: Promise<unknown> = Promise.resolve();
  const documentTails = new Map<string, Promise<void>>();

  async function ensure(): Promise<void> {
    await mkdir(files, { recursive: true, mode: 0o700 });
  }

  function serializeIndex<T>(operation: () => Promise<T>): Promise<T> {
    const run = indexTail.then(operation, operation);
    indexTail = run.then(() => undefined, () => undefined);
    return run;
  }

  function serializeDocument<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const run = (documentTails.get(id) ?? Promise.resolve()).then(operation);
    const tail = run.then(() => undefined, () => undefined);
    documentTails.set(id, tail);
    void tail.then(() => {
      if (documentTails.get(id) === tail) documentTails.delete(id);
    });
    return run;
  }

  async function cleanup(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch (error) {
      console.warn('[office] Failed to clean up store file.', { path, error });
    }
  }

  function contentPath(record: StoredDocument): string {
    return join(files, record.file ?? `${record.id}.${EXT[record.type]}`);
  }

  async function readIndex(): Promise<StoredIndex> {
    await ensure();
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as StoredIndex;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.documents)) throw new Error('Invalid index.');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, documents: [] };
      throw error;
    }
  }

  async function writeIndex(index: StoredIndex, signal?: AbortSignal): Promise<void> {
    const temporary = join(root, `.documents-${randomUUID()}.json`);
    try {
      await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
      // The index rename is the only commit point; content files are never overwritten.
      signal?.throwIfAborted();
      await rename(temporary, indexPath);
    } catch (error) {
      await cleanup(temporary);
      throw error;
    }
  }

  async function list(): Promise<readonly DocumentRecord[]> {
    const index = await readIndex();
    return index.documents.map(publicRecord).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function getStored(id: string): Promise<StoredDocument> {
    const record = (await readIndex()).documents.find((entry) => entry.id === id);
    if (!record) throw new OfficeError('not_found', 'Document not found.');
    return record;
  }

  async function get(id: string): Promise<DocumentRecord> {
    return publicRecord(await getStored(id));
  }

  async function read(id: string): Promise<{ record: DocumentRecord; bytes: Uint8Array; resources: readonly DocumentResource[]; sourcePath?: string }> {
    return serializeDocument(id, async () => {
      const record = await getStored(id);
      const resources = await Promise.all((record.resources ?? []).map(async (resource) => ({
        path: resource.path, bytes: new Uint8Array(await readFile(join(files, resource.file))),
        ...(resource.ownedSha256 === undefined ? {} : { ownedSha256: resource.ownedSha256 })
      })));
      return { record: publicRecord(record), bytes: new Uint8Array(await readFile(contentPath(record))), resources, sourcePath: record.sourcePath };
    });
  }

  async function readSnapshot(id: string, signal?: AbortSignal): Promise<DocumentSnapshot> {
    return serializeDocument(id, async () => {
      signal?.throwIfAborted();
      const record = await getStored(id);
      const path = join(files, `.snapshot-${randomUUID()}.${EXT[record.type]}`);
      await link(contentPath(record), path);
      try { signal?.throwIfAborted(); }
      catch (error) { await cleanup(path); throw error; }
      return { record: publicRecord(record), path, release: () => rm(path, { force: true }) };
    });
  }

  async function commitContent(record: DocumentRecord, content: DocumentContent, previous?: StoredDocument, signal?: AbortSignal): Promise<DocumentRecord> {
    const input = contentOf(content);
    const { resources, sourcePath } = input;
    signal?.throwIfAborted();
    const seen = new Set<string>();
    for (const resource of resources ?? []) {
      const path = resourcePath(resource.path);
      if (seen.has(path.toLowerCase())) throw new OfficeError('invalid_request', `Duplicate resource path: ${path}.`);
      seen.add(path.toLowerCase());
    }
    await ensure();
    const storedResources: StoredResource[] = resources === undefined ? [...(previous?.resources ?? [])] : [];
    let committed = record;
    const stored: StoredDocument = { ...record, file: `${record.id}.${randomUUID()}.${EXT[record.type]}`, resources: storedResources, sourcePath: sourcePath ?? previous?.sourcePath };
    const created: string[] = [];
    async function stage(file: string, data: Uint8Array): Promise<void> {
      const path = join(files, file);
      try {
        await writeFile(path, data, { mode: 0o600, flag: 'wx' });
        created.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await cleanup(path);
        throw error;
      }
    }
    try {
      if ('filePath' in input) {
        const path = join(files, stored.file!);
        try {
          await copyFile(input.filePath, path, constants.COPYFILE_EXCL);
          created.push(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await cleanup(path);
          throw error;
        }
        committed = { ...record, size: (await stat(path)).size };
      } else {
        await stage(stored.file!, input.bytes);
        committed = { ...record, size: input.bytes.byteLength };
      }
      for (const resource of resources ?? []) {
        signal?.throwIfAborted();
        const file = `${record.id}.${randomUUID()}.asset`;
        await stage(file, resource.bytes);
        storedResources.push({ path: resource.path, file, size: resource.bytes.byteLength, ...(resource.ownedSha256 === undefined ? {} : { ownedSha256: resource.ownedSha256 }) });
      }
      await serializeIndex(async () => {
        const index = await readIndex();
        const staged: StoredDocument = { ...stored, size: committed.size };
        assertUniquePath(index, committed);
        await writeIndex({
          version: 1,
          documents: previous
            ? index.documents.map((entry) => entry.id === record.id ? staged : entry)
            : [...index.documents, staged]
        }, signal);
      });
    } catch (error) {
      await Promise.all(created.map(cleanup));
      throw error;
    }
    if (previous) {
      await cleanup(contentPath(previous));
      if (resources !== undefined) await Promise.all((previous.resources ?? []).map((resource) => cleanup(join(files, resource.file))));
    }
    return committed;
  }

  async function create(input: Exclude<DocumentContent, Uint8Array> & { name: string; type: DocumentType; libraryPath?: string; autoNamePending?: true }, signal?: AbortSignal): Promise<DocumentRecord> {
    const id = `doc_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    return serializeDocument(id, async () => {
      const timestamp = now();
      const record: DocumentRecord = {
        id,
        name: input.libraryPath === undefined ? cleanName(input.name, input.type) : libraryPathFor(input.libraryPath, input.type).split('/').pop()!,
        ...(input.libraryPath === undefined ? {} : { libraryPath: input.libraryPath }),
        type: input.type,
        mimeType: input.type === 'xlsx' && extname(input.name).toLowerCase() === '.xlsm' ? 'application/vnd.ms-excel.sheet.macroEnabled.12' : MIME[input.type],
        size: 0,
        ...(input.type === 'pdf' && input.autoNamePending ? { autoNamePending: true as const } : {}),
        createdAt: timestamp,
        updatedAt: timestamp,
        revision: 0
      };
      return commitContent(record, input, undefined, signal);
    });
  }

  async function updateFrom(id: string, expectedRevision: number, produce: () => Promise<DocumentContent>, signal?: AbortSignal): Promise<DocumentRecord> {
    return serializeDocument(id, async () => {
      signal?.throwIfAborted();
      const current = await getStored(id);
      if (current.revision !== expectedRevision) {
        throw new OfficeError('revision_conflict', `Revision conflict: current revision is ${current.revision}.`, { currentRevision: current.revision });
      }
      const content = await produce();
      const record: DocumentRecord = { ...publicRecord(current), updatedAt: now(), revision: current.revision + 1 };
      return commitContent(record, content, current, signal);
    });
  }

  async function listResources(id: string): Promise<readonly { path: string; size: number; readonly ownedSha256?: string }[]> {
    return (await getStored(id)).resources?.map(({ path, size, ownedSha256 }) => ({ path, size, ...(ownedSha256 === undefined ? {} : { ownedSha256 }) })) ?? [];
  }

  async function readResource(id: string, path: string): Promise<Uint8Array> {
    resourcePath(path);
    return serializeDocument(id, async () => {
      const resource = (await getStored(id)).resources?.find((entry) => entry.path === path);
      if (!resource) throw new OfficeError('not_found', 'Document resource not found.');
      return new Uint8Array(await readFile(join(files, resource.file)));
    });
  }

  async function putResource(id: string, expectedRevision: number, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<DocumentRecord> {
    resourcePath(path);
    return updateFrom(id, expectedRevision, async () => {
      const current = await getStored(id);
      const resources: DocumentResource[] = await Promise.all((current.resources ?? []).filter((entry) => entry.path !== path).map(async (entry) => ({
        path: entry.path, bytes: new Uint8Array(await readFile(join(files, entry.file))),
        ...(entry.ownedSha256 === undefined ? {} : { ownedSha256: entry.ownedSha256 })
      })));
      resources.push({ path, bytes });
      return { bytes: new Uint8Array(await readFile(contentPath(current))), resources };
    }, signal);
  }

  async function update(id: string, bytes: Uint8Array, expectedRevision: number): Promise<DocumentRecord> {
    return updateFrom(id, expectedRevision, async () => bytes);
  }

  async function createCopy(id: string, expectedRevision: number, name: string, bytes: Uint8Array): Promise<DocumentRecord> {
    return serializeDocument(id, async () => {
      const source = await getStored(id);
      if (source.revision !== expectedRevision) throw new OfficeError('revision_conflict', `Revision conflict: current revision is ${source.revision}.`, { currentRevision: source.revision });
      return create({ name, type: source.type, bytes, sourcePath: source.sourcePath });
    });
  }

  async function move(id: string, expectedRevision: number, libraryPath: string, signal?: AbortSignal): Promise<DocumentRecord> {
    return serializeDocument(id, async () => {
      signal?.throwIfAborted();
      const current = await getStored(id);
      if (current.revision !== expectedRevision) throw new OfficeError('revision_conflict', `Revision conflict: current revision is ${current.revision}.`, { currentRevision: current.revision });
      libraryPathFor(libraryPath, current.type);
      if (current.type === 'xlsx' && (extname(current.name).toLowerCase() === '.xlsm') !== (extname(libraryPath).toLowerCase() === '.xlsm')) throw new OfficeError('invalid_request', 'Moving a workbook cannot change its native file format; use a native Save As conversion.');
      const { autoNamePending: _pending, ...named } = current;
      const stored: StoredDocument = { ...named, libraryPath, name: libraryPath.split('/').pop()!, updatedAt: now(), revision: current.revision + 1 };
      await serializeIndex(async () => {
        const index = await readIndex();
        assertUniquePath(index, stored);
        await writeIndex({ version: 1, documents: index.documents.map((entry) => entry.id === id ? stored : entry) }, signal);
      });
      return publicRecord(stored);
    });
  }

  async function autoNameDocument(id: string, expectedRevision: number, baseName: string): Promise<DocumentRecord | null> {
    return serializeDocument(id, async () => {
      const current = await getStored(id);
      if (current.revision !== expectedRevision) throw new OfficeError('revision_conflict', `Revision conflict: current revision is ${current.revision}.`, { currentRevision: current.revision });
      if (current.type !== 'pdf' || !current.autoNamePending) return null;
      resourcePath(baseName);
      if (baseName.includes('/') || baseName.length > 190) throw new OfficeError('invalid_request', 'An automatic document name must be a safe filename stem.');
      if (current.name.toLowerCase() === `${baseName}.pdf`.toLowerCase()) return null;
      return serializeIndex(async () => {
        const index = await readIndex();
        const directory = posix.dirname(current.libraryPath ?? `${current.id}/${current.name}`);
        const occupied = new Set(index.documents.filter((entry) => entry.id !== id).map((entry) => (entry.libraryPath ?? `${entry.id}/${entry.name}`).toLowerCase()));
        let name = `${baseName}.pdf`;
        for (let n = 2; occupied.has(posix.join(directory, name).toLowerCase()); n++) name = `${baseName}-${n}.pdf`;
        const libraryPath = libraryPathFor(posix.join(directory, name), 'pdf');
        const { autoNamePending: _pending, ...named } = current;
        const stored: StoredDocument = { ...named, name, libraryPath, updatedAt: now(), revision: current.revision + 1 };
        await writeIndex({ version: 1, documents: index.documents.map((entry) => entry.id === id ? stored : entry) });
        return publicRecord(stored);
      });
    });
  }

  async function remove(id: string): Promise<void> {
    return serializeDocument(id, async () => {
      const record = await getStored(id);
      await serializeIndex(async () => {
        const index = await readIndex();
        await writeIndex({ version: 1, documents: index.documents.filter((entry) => entry.id !== id) });
      });
      await cleanup(contentPath(record));
      await Promise.all((record.resources ?? []).map((resource) => cleanup(join(files, resource.file))));
    });
  }

  return { list, get, read, readSnapshot, create, updateFrom, update, listResources, readResource, putResource, createCopy, move, autoNameDocument, remove, cleanName };
}

export function mimeFor(type: DocumentType): string {
  return MIME[type];
}

export function typeFromName(name: string, mimeType?: string): DocumentType | undefined {
  const extension = extname(name).slice(1).toLowerCase();
  if (extension === 'xlsm') return 'xlsx';
  if (extension === 'docx' || extension === 'xlsx' || extension === 'csv' || extension === 'pptx' || extension === 'pdf' || extension === 'md' || extension === 'markdown' || extension === 'html' || extension === 'htm' || extension === 'txt' || extension === 'json') {
    return extension === 'markdown' ? 'md' : extension === 'htm' ? 'html' : extension as DocumentType;
  }
  if (mimeType?.includes('wordprocessingml')) return 'docx';
  if (mimeType?.includes('spreadsheetml') || mimeType === 'application/vnd.ms-excel.sheet.macroEnabled.12') return 'xlsx';
  if (mimeType === 'text/csv') return 'csv';
  if (mimeType?.includes('presentationml')) return 'pptx';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'text/markdown') return 'md';
  if (mimeType === 'text/html') return 'html';
  if (mimeType === 'text/plain') return 'txt';
  if (mimeType === 'application/json') return 'json';
  return undefined;
}

export function extensionFor(type: DocumentType): string {
  return EXT[type];
}
