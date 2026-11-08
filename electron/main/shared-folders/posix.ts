import { randomUUID } from 'node:crypto';
import { constants, close, fstat, fsync, read, write } from 'node:fs';
import { readlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { decodeText, FolderError, isProtectedComponent, isValidComponent, SHARED_FOLDER_READ_MAX_BYTES } from './contracts';
import { callNative, loadKoffi, type DirectoryPageEntry, type FolderDirectory } from './native';

const closeFile = promisify(close);
const statFile = promisify(fstat);
const readFile = promisify(read);
const writeFile = promisify(write);
const syncFile = promisify(fsync);

let functions: ReturnType<typeof loadPosixFunctions> | undefined;
function loadPosixFunctions() {
  const koffi = loadKoffi();
  const darwin = process.platform === 'darwin';
  const libc = koffi.load(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
  const openAt = libc.func('int openat(int directory, const char *name, int flags, uint32_t mode)');
  const statAt = libc.func('int fstatat(int directory, const char *name, void *stat, int flags)');
  const renameAt = libc.func('int renameat(int source, const char *name, int target, const char *destination)');
  const unlinkAt = libc.func('int unlinkat(int directory, const char *name, int flags)');
  const openDirectory = libc.func('void *fdopendir(int file)');
  const readDirectory = libc.func('int readdir_r(void *directory, void *entry, void *result)');
  const closeDirectory = libc.func('int closedir(void *directory)');
  const getPath = darwin ? libc.func('int fcntl(int file, int command, void *buffer)') : undefined;
  const noFollow = constants.O_NOFOLLOW | constants.O_NONBLOCK | (darwin ? 0x1000000 : 0x80000); // O_CLOEXEC.
  return { koffi, darwin, openAt, statAt, renameAt, unlinkAt, openDirectory, readDirectory, closeDirectory, getPath, noFollow };
}

function posixFiles() {
  const { koffi, darwin, openAt, statAt, renameAt, unlinkAt, openDirectory, readDirectory, closeDirectory, getPath, noFollow } = functions ??= loadPosixFunctions();
  const descriptors = new Set<number>();
  const streams = new Map<bigint, number>();
  const releaseFile = async (file: number) => {
    if (!descriptors.has(file)) return;
    await closeFile(file);
    descriptors.delete(file);
  };
  const canonical = async (file: number, directory = true): Promise<string> => {
    let path: string;
    if (darwin) {
      const buffer = Buffer.alloc(4096);
      if (await callNative(getPath!, file, 50, buffer) !== 0) throw new FolderError('unavailable'); // F_GETPATH.
      const end = buffer.indexOf(0);
      if (end < 0) throw new FolderError('unavailable');
      try { path = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, end)); }
      catch { throw new FolderError('unavailable'); }
    } else path = await readlink(`/proc/self/fd/${file}`);
    const parts = path.split('/');
    if (!path.startsWith('/') || path.endsWith(' (deleted)') || parts.some((part, index) => isProtectedComponent(part, directory || index < parts.length - 1))) throw new FolderError('forbidden-path');
    return path;
  };
  const openChild = async (parent: number, name: string, directory: boolean, temporary = false): Promise<number> => {
    const flags = noFollow | (directory ? constants.O_RDONLY | constants.O_DIRECTORY : temporary ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY);
    const file = await callNative(openAt, parent, name, flags, 0o600);
    if (file < 0) {
      // Koffi cannot return a worker thread's errno. Only a failed open uses this narrow synchronous classification;
      // no path is opened or followed here, and creation still requires O_EXCL.
      const result = statAt(parent, name, Buffer.alloc(512), darwin ? 0x20 : 0x100); // AT_SYMLINK_NOFOLLOW.
      if (result < 0 && koffi.errno() === koffi.os.errno.ENOENT) throw new FolderError('not-found');
      throw new FolderError('unavailable');
    }
    descriptors.add(file);
    try {
      const stat = await statFile(file);
      if (directory ? !stat.isDirectory() : !stat.isFile()) throw new FolderError(directory ? 'not-directory' : 'not-file');
      if (!directory && stat.nlink !== 1) throw new FolderError('forbidden-path');
      if (!temporary) await canonical(file, directory);
      return file;
    } catch (error) { await releaseFile(file); throw error; }
  };
  const readBytes = async (file: number): Promise<Buffer> => {
    const stat = await statFile(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new FolderError('forbidden-path');
    if (stat.size > SHARED_FOLDER_READ_MAX_BYTES) throw new FolderError('too-large');
    const bytes = Buffer.alloc(SHARED_FOLDER_READ_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await readFile(file, bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > SHARED_FOLDER_READ_MAX_BYTES) throw new FolderError('too-large');
    return bytes.subarray(0, length);
  };
  const directory = (file: number, canonicalRoot?: string): FolderDirectory => {
    let closed = false;
    let stream: bigint | undefined;
    return {
      canonicalRoot,
      async close() {
        if (closed) return;
        if (stream !== undefined) {
          if (streams.has(stream)) {
            if (await callNative(closeDirectory, stream) !== 0) throw new FolderError('unavailable');
            streams.delete(stream);
          }
          stream = undefined;
        }
        await releaseFile(file);
        closed = true;
      },
      async child(name) {
        const child = await openChild(file, name, true);
        return directory(child, await canonical(child));
      },
      async next(): Promise<DirectoryPageEntry | null | undefined> {
        if (stream === undefined) {
          const descriptor = await openChild(file, '.', true);
          try {
            stream = await new Promise<bigint>((resolve, reject) => {
              openDirectory.async(descriptor, (error: unknown, result: bigint) => error || !result ? reject(new FolderError('unavailable')) : resolve(result));
            });
            descriptors.delete(descriptor); // fdopendir now owns this descriptor.
            streams.set(stream, descriptor);
          } catch (error) { await releaseFile(descriptor); throw error; }
        }
        // readdir_r's explicit status avoids reading another thread's errno; buffer exceeds either platform's dirent.
        const entry = Buffer.alloc(8192);
        const output = Buffer.alloc(8);
        if (await callNative(readDirectory, stream, entry, output) !== 0) throw new FolderError('unavailable');
        if (output.readBigUInt64LE() === 0n) return undefined;
        const start = darwin ? 21 : 19;
        const end = entry.indexOf(0, start);
        if (end < start || end > start + (darwin ? 1024 : 255)) throw new FolderError('unavailable');
        let name: string;
        try { name = new TextDecoder('utf-8', { fatal: true }).decode(entry.subarray(start, end)); }
        catch { return null; }
        const isDirectory = entry[darwin ? 20 : 18] === 4;
        if (!isValidComponent(name) || isProtectedComponent(name, isDirectory)) return null;
        let child: number;
        try { child = await openChild(file, name, isDirectory); }
        catch (error) { if (error instanceof FolderError) return null; throw error; }
        try { return { name, kind: (await statFile(child)).isDirectory() ? 'directory' : 'file' }; }
        finally { await releaseFile(child); }
      },
      async read(name) {
        const child = await openChild(file, name, false);
        try { return await readBytes(child); } finally { await releaseFile(child); }
      },
      async write(name, bytes, beforeCommit) {
        let existing: number | undefined;
        try { existing = await openChild(file, name, false); }
        catch (error) { if (!(error instanceof FolderError) || error.outcome !== 'not-found') throw error; }
        if (existing !== undefined) {
          try { decodeText(await readBytes(existing)); } finally { await releaseFile(existing); }
        }
        beforeCommit();
        const temporaryName = `.matcha-folder-write-${randomUUID()}`;
        const temporary = await openChild(file, temporaryName, false, true);
        let commitState: 'not-started' | 'committed' | 'unknown' = 'not-started';
        let failure: unknown;
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const { bytesWritten } = await writeFile(temporary, bytes, offset, bytes.length - offset, offset);
            if (!bytesWritten) throw new FolderError('unavailable');
            offset += bytesWritten;
          }
          await syncFile(temporary);
          beforeCommit();
          // Both names are relative to the held directory; rename replaces a raced link instead of following it.
          let renameStatus: number;
          try { renameStatus = await callNative(renameAt, file, temporaryName, file, name); }
          catch { commitState = 'unknown'; throw new FolderError('outcome-unknown'); }
          if (renameStatus !== 0) throw new FolderError('unavailable');
          commitState = 'committed';
          try { await syncFile(file); } catch { throw new FolderError('outcome-unknown'); }
        } catch (error) { failure = error; }
        if (commitState === 'not-started') {
          try { if (await callNative(unlinkAt, file, temporaryName, 0) !== 0) throw new FolderError('unavailable'); }
          catch { failure ??= new FolderError('unavailable'); }
        }
        await releaseFile(temporary).catch(() => { failure = new FolderError(commitState !== 'not-started' ? 'outcome-unknown' : 'unavailable'); });
        if (failure) throw failure;
      },
    };
  };
  return {
    async open(): Promise<FolderDirectory> {
      const file = await callNative(openAt, darwin ? -2 : -100, '/', constants.O_RDONLY | constants.O_DIRECTORY | noFollow, 0);
      if (file < 0) throw new FolderError('unavailable');
      descriptors.add(file);
      return directory(file, '/');
    },
    async closeRemaining() {
      for (const stream of streams.keys()) {
        if (await callNative(closeDirectory, stream) === 0) streams.delete(stream);
      }
      await Promise.allSettled([...descriptors].map(releaseFile));
      if (streams.size || descriptors.size) throw new FolderError('unavailable');
    },
  };
}

export async function openPosixRoot(root: { components: string[] }): Promise<FolderDirectory> {
  const files = posixFiles();
  const custody: FolderDirectory[] = [];
  try {
    custody.push(await files.open());
    for (const name of root.components) custody.push(await custody[custody.length - 1].child(name));
    const leaf = custody[custody.length - 1];
    return {
      canonicalRoot: leaf.canonicalRoot ?? `/${root.components.join('/')}`,
      child: (name) => leaf.child(name), next: () => leaf.next(), read: (name) => leaf.read(name),
      write: (name, bytes, beforeCommit) => leaf.write(name, bytes, beforeCommit),
      async close() {
        for (const directory of [...custody].reverse()) await directory.close().catch(() => {});
        await files.closeRemaining();
      },
    };
  } catch (error) { for (const directory of custody.reverse()) await directory.close().catch(() => {}); throw error; }
}
