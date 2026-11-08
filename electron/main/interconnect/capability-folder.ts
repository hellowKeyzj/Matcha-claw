import { randomBytes } from 'node:crypto';
import type { SharedFolderBinding } from '../access/model';
import {
  assertText, decodeText, FolderError, isProtectedComponent, relativeComponents,
  SHARED_FOLDER_CURSOR_TTL_MS, SHARED_FOLDER_LIST_MAX_LIMIT, SHARED_FOLDER_MAX_CURSORS,
  SHARED_FOLDER_PATH_MAX_LENGTH, SHARED_FOLDER_READ_MAX_BYTES, SHARED_FOLDER_WRITE_MAX_BYTES, SHARED_FOLDER_WRITE_MAX_LENGTH,
  type FolderEntry,
} from '../shared-folders/contracts';
import { normalizedRoot, openFolderRoot, type FolderDirectory } from '../shared-folders/native';
import type { SharedCapabilityCandidate } from './capability';

const PATH_SCHEMA = {
  type: 'string', maxLength: SHARED_FOLDER_PATH_MAX_LENGTH,
  pattern: '^(?:[^/\\\\:\\u0000-\\u001f]+(?:/[^/\\\\:\\u0000-\\u001f]+)*)?$',
};
const INPUTS = {
  list: {
    type: 'object', additionalProperties: false,
    properties: {
      relativePath: PATH_SCHEMA,
      cursor: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', maxLength: 43 },
      limit: { type: 'integer', minimum: 1, maximum: SHARED_FOLDER_LIST_MAX_LIMIT },
    },
  },
  read: {
    type: 'object', additionalProperties: false, required: ['relativePath'],
    properties: { relativePath: { ...PATH_SCHEMA, minLength: 1 } },
  },
  write: {
    type: 'object', additionalProperties: false, required: ['relativePath', 'text'],
    properties: {
      relativePath: { ...PATH_SCHEMA, minLength: 1 },
      text: { type: 'string', maxLength: SHARED_FOLDER_WRITE_MAX_LENGTH },
    },
  },
};

export async function prepareSharedFolder(path: string): Promise<string> {
  let directory: FolderDirectory | undefined;
  try {
    directory = await openFolderRoot(path);
    return directory.canonicalRoot ?? normalizedRoot(path).root;
  } catch (error) { throw error instanceof FolderError ? error : new FolderError('unavailable'); }
  finally { await directory?.close().catch(() => { throw new FolderError('unavailable'); }); }
}

type Cursor = {
  bindingKey: string; relativePath: string; directory: FolderDirectory; custody: FolderDirectory[];
  expiresAt: number; busy: boolean;
};

export function createSharedFolders() {
  const cursors = new Map<string, Cursor>();
  const active = new Set<Promise<unknown>>();
  const pendingCleanup = new Set<FolderDirectory>();
  const closing = new Map<FolderDirectory, Promise<void>>();
  let closed = false;
  let opening = 0;
  const closeDirectories = async (directories: FolderDirectory[]) => {
    let failed = false;
    for (const directory of [...directories].reverse()) {
      pendingCleanup.add(directory);
      let pending = closing.get(directory);
      if (!pending) {
        pending = directory.close().finally(() => { closing.delete(directory); });
        closing.set(directory, pending);
      }
      try { await pending; pendingCleanup.delete(directory); }
      catch { failed = true; }
    }
    if (failed) throw new FolderError('unavailable');
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleExpiry = () => {
    clearTimeout(timer);
    const idle = [...cursors.values()].filter((cursor) => !cursor.busy);
    if (closed || !idle.length) { timer = undefined; return; }
    const expiresAt = Math.min(...idle.map((cursor) => cursor.expiresAt));
    timer = setTimeout(() => {
      const expired = [...cursors].filter(([, cursor]) => !cursor.busy && cursor.expiresAt <= Date.now());
      for (const [token] of expired) cursors.delete(token);
      void Promise.allSettled(expired.map(([, cursor]) => closeDirectories(cursor.custody)));
      scheduleExpiry();
    }, Math.max(1, expiresAt - Date.now()));
    timer.unref();
  };
  const observe = (signal: AbortSignal) => { if (closed || signal.aborted) throw new FolderError('cancelled'); };
  const openDirectory = async (root: string, components: string[]) => {
    const custody: FolderDirectory[] = [];
    try {
      custody.push(await openFolderRoot(root));
      for (const component of components) custody.push(await custody[custody.length - 1].child(component));
      return { directory: custody[custody.length - 1], custody };
    } catch (error) { await closeDirectories(custody); throw error; }
  };

  async function list(binding: SharedFolderBinding, args: Record<string, unknown>, signal: AbortSignal, relativePath: string, parts: string[]) {
    const limit = args.limit === undefined ? 50 : args.limit;
    if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > SHARED_FOLDER_LIST_MAX_LIMIT
      || (args.cursor !== undefined && (typeof args.cursor !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(args.cursor)))) throw new FolderError('invalid-input');
    const bindingKey = JSON.stringify([binding.id, binding.root, binding.operation]);
    let cursor: Cursor;
    let token: string;
    if (typeof args.cursor === 'string') {
      token = args.cursor;
      const found = cursors.get(token);
      if (!found || found.expiresAt <= Date.now()) throw new FolderError('cursor-expired');
      if (found.bindingKey !== bindingKey || found.relativePath !== relativePath) throw new FolderError('cursor-mismatch');
      if (found.busy) throw new FolderError('busy');
      found.busy = true;
      scheduleExpiry();
      cursor = found;
    } else {
      if (cursors.size + opening >= SHARED_FOLDER_MAX_CURSORS) throw new FolderError('busy');
      opening++;
      try {
        const opened = await openDirectory(binding.root, parts);
        cursor = { ...opened, bindingKey, relativePath, expiresAt: Date.now() + SHARED_FOLDER_CURSOR_TTL_MS, busy: true };
        token = randomBytes(32).toString('base64url');
        cursors.set(token, cursor);
      } finally { opening--; }
    }
    try {
      const entries: FolderEntry[] = [];
      let exhausted = false;
      // Bound both returned items and scanned/filtered entries; a page may be empty but have a next cursor.
      for (let scanned = 0; scanned < (limit as number) * 4 && entries.length < (limit as number); scanned++) {
        observe(signal);
        const entry = await cursor.directory.next();
        if (entry === undefined) { exhausted = true; break; }
        if (entry === null) continue;
        const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entryPath.length <= SHARED_FOLDER_PATH_MAX_LENGTH) entries.push({ ...entry, relativePath: entryPath });
      }
      observe(signal);
      cursors.delete(token);
      let nextCursor: string | null = null;
      if (exhausted) await closeDirectories(cursor.custody);
      else {
        nextCursor = randomBytes(32).toString('base64url');
        cursor.busy = false;
        cursors.set(nextCursor, cursor);
      }
      return { outcome: 'listed', relativePath, entries, nextCursor };
    } catch (error) {
      cursors.delete(token);
      await closeDirectories(cursor.custody);
      throw error;
    } finally { scheduleExpiry(); }
  }

  async function execute(binding: SharedFolderBinding, args: Record<string, unknown>, signal: AbortSignal) {
    let relativePath: string | undefined;
    try {
      observe(signal);
      const keys = binding.operation === 'list' ? ['relativePath', 'cursor', 'limit'] : binding.operation === 'write' ? ['relativePath', 'text'] : ['relativePath'];
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !keys.includes(key))) throw new FolderError('invalid-input');
      const parts = relativeComponents(binding.operation === 'list' && args.relativePath === undefined ? '' : args.relativePath, binding.operation === 'list');
      relativePath = parts.join('/');
      if (parts.some((part, index) => isProtectedComponent(part, binding.operation === 'list' || index < parts.length - 1))) throw new FolderError('forbidden-path');
      if (binding.operation === 'list') return await list(binding, args, signal, relativePath, parts);
      let bytes: Buffer | undefined;
      if (binding.operation === 'write') {
        if (typeof args.text !== 'string' || args.text.length > SHARED_FOLDER_WRITE_MAX_LENGTH) throw new FolderError('invalid-input');
        assertText(args.text);
        bytes = Buffer.from(args.text, 'utf8');
        if (bytes.length > SHARED_FOLDER_WRITE_MAX_BYTES) throw new FolderError('too-large');
      }
      const opened = await openDirectory(binding.root, parts.slice(0, -1));
      let written = false;
      let result: unknown;
      let failure: unknown;
      try {
        observe(signal);
        const leaf = parts[parts.length - 1];
        if (binding.operation === 'read') {
          const content = await opened.directory.read(leaf);
          observe(signal);
          result = { outcome: 'read', relativePath, text: decodeText(content), byteLength: content.length };
        } else {
          await opened.directory.write(leaf, bytes!, () => observe(signal));
          written = true;
          // Once committed, cancellation cannot truthfully turn a write into a cancelled/no-effect result.
          result = { outcome: 'written', relativePath, byteLength: bytes!.length };
        }
      } catch (error) { failure = error; }
      await closeDirectories(opened.custody).catch(() => {
        if (written || failure instanceof FolderError && failure.outcome === 'outcome-unknown') failure = new FolderError('outcome-unknown');
        else failure ??= new FolderError('unavailable');
      });
      if (failure) throw failure;
      return result;
    } catch (error) {
      return { outcome: error instanceof FolderError ? error.outcome : 'unavailable', ...(relativePath !== undefined ? { relativePath } : {}) };
    }
  }

  return {
    folderCapability(binding: SharedFolderBinding): SharedCapabilityCandidate {
      const fixed = Object.freeze({ ...binding });
      return {
        definition: { kind: 'builtin', folderId: fixed.id, operation: `folder.${fixed.operation}`, output: `SharedFolderResults.${fixed.operation}@1` },
        descriptor: {
          name: `Folder ${fixed.operation}`,
          description: fixed.operation === 'list'
            ? 'List a bounded unsorted page. Use the same relativePath with nextCursor within 60 seconds; cursors are single-use, process-local, not snapshots. Restart after expiry. Protected entries are omitted.'
            : fixed.operation === 'read'
              ? `Read a strict UTF-8 plain text file up to ${SHARED_FOLDER_READ_MAX_BYTES} bytes using a relative path. Protected paths and links are unavailable.`
              : `Create or atomically replace a small UTF-8 plain text file in an existing directory. text accepts at most ${SHARED_FOLDER_WRITE_MAX_LENGTH} UTF-16 units and ${SHARED_FOLDER_WRITE_MAX_BYTES} UTF-8 bytes; existing files must be text up to ${SHARED_FOLDER_READ_MAX_BYTES} bytes. No mkdir, links or protected paths. Do not automatically retry an unknown write outcome.`,
          inputSchema: structuredClone(INPUTS[fixed.operation]),
        },
        presentation: { kind: 'folder', targetId: fixed.id, targetName: fixed.name, operation: `folder.${fixed.operation}` },
        async execute(args, signal) {
          if (closed || pendingCleanup.size) return { outcome: 'unavailable' };
          if (active.size >= 32) return { outcome: 'busy' };
          const pending = execute(fixed, args, signal);
          active.add(pending);
          try { return await pending; } finally { active.delete(pending); }
        },
      };
    },
    async close() {
      closed = true;
      clearTimeout(timer);
      await Promise.allSettled([...active]);
      const remaining = [...cursors.values()];
      cursors.clear();
      await Promise.allSettled(remaining.map((cursor) => closeDirectories(cursor.custody)));
      await Promise.allSettled([...closing.values()]);
      if (pendingCleanup.size) await closeDirectories([...pendingCleanup]);
    },
  };
}
