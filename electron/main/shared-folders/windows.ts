import { randomUUID } from 'node:crypto';
import { win32 } from 'node:path';
import { decodeText, FolderError, isProtectedComponent, isValidComponent, SHARED_FOLDER_READ_MAX_BYTES } from './contracts';
import { callNative, loadKoffi, type DirectoryPageEntry, type FolderDirectory } from './native';

// NT relative opens are the same custody boundary used by native workspace access.
// No FILE_SHARE_DELETE pins every ancestor; OPEN_REPARSE_POINT never traverses the leaf.
let functions: ReturnType<typeof loadWindowsFunctions> | undefined;
function loadWindowsFunctions() {
  const koffi = loadKoffi();
  const kernel = koffi.load('kernel32.dll');
  const nt = koffi.load('ntdll.dll');
  const unicode = koffi.struct({ Length: 'uint16_t', MaximumLength: 'uint16_t', Buffer: 'void *' });
  const attributes = koffi.struct({ Length: 'uint32_t', RootDirectory: 'void *', ObjectName: koffi.pointer(unicode), Attributes: 'uint32_t', SecurityDescriptor: 'void *', SecurityQualityOfService: 'void *' });
  const create = nt.func('__stdcall', 'NtCreateFile', 'int32_t', ['void *', 'uint32_t', koffi.pointer(attributes), 'void *', 'void *', 'uint32_t', 'uint32_t', 'uint32_t', 'uint32_t', 'void *', 'uint32_t']);
  const createAbsolute = kernel.func('void * __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)');
  const information = kernel.func('int __stdcall GetFileInformationByHandle(void *file, void *information)');
  const finalPath = kernel.func('uint32_t __stdcall GetFinalPathNameByHandleW(void *file, void *path, uint32_t length, uint32_t flags)');
  const type = kernel.func('uint32_t __stdcall GetFileType(void *file)');
  const close = kernel.func('int __stdcall CloseHandle(void *file)');
  const read = nt.func('int32_t __stdcall NtReadFile(void *file, void *event, void *apc, void *context, void *status, void *buffer, uint32_t length, void *offset, void *key)');
  const write = nt.func('int32_t __stdcall NtWriteFile(void *file, void *event, void *apc, void *context, void *status, void *buffer, uint32_t length, void *offset, void *key)');
  const flush = nt.func('int32_t __stdcall NtFlushBuffersFile(void *file, void *status)');
  const setInformation = nt.func('int32_t __stdcall NtSetInformationFile(void *file, void *status, void *information, uint32_t length, uint32_t kind)');
  const query = nt.func('int32_t __stdcall NtQueryDirectoryFile(void *file, void *event, void *apc, void *context, void *status, void *information, uint32_t length, uint32_t kind, uint8_t single, void *filter, uint8_t restart)');

  const failStatus = (status: number): never => {
    const code = status >>> 0;
    if ([0xc000000f, 0xc0000034, 0xc000003a].includes(code)) throw new FolderError('not-found');
    if (code === 0xc0000103) throw new FolderError('not-directory');
    if ([0xc000050b, 0xc0000275, 0xc0000280].includes(code)) throw new FolderError('forbidden-path');
    throw new FolderError('unavailable');
  };
  const check = (status: number) => { if (status < 0 || status === 0x103) failStatus(status); };
  return { create, createAbsolute, information, finalPath, type, close, read, write, flush, setInformation, query, check };
}

function windowsFiles() {
  const { create, createAbsolute, information, finalPath, type, close, read, write, flush, setInformation, query, check } = functions ??= loadWindowsFunctions();
  const handles = new Set<bigint>();
  const closeFile = async (handle: bigint) => {
    if (!handles.has(handle)) return;
    if (!await callNative(close, handle)) throw new FolderError('unavailable');
    handles.delete(handle);
  };
  const metadata = async (handle: bigint, directory: boolean) => {
    const data = Buffer.alloc(52);
    if (!await callNative(information, handle, data)) throw new FolderError('unavailable');
    const flags = data.readUInt32LE();
    if (flags & (0x400 | 0x40)) throw new FolderError('forbidden-path'); // Reparse point or device.
    if (Boolean(flags & 0x10) !== directory) throw new FolderError(directory ? 'not-directory' : 'not-file');
    if (!directory && (data.readUInt32LE(40) !== 1 || await callNative(type, handle) !== 1)) throw new FolderError('forbidden-path');
    return (BigInt(data.readUInt32LE(32)) << 32n) | BigInt(data.readUInt32LE(36));
  };
  const canonical = async (handle: bigint, directory = true): Promise<string> => {
    const buffer = Buffer.alloc(32_768 * 2);
    const length = await callNative(finalPath, handle, buffer, buffer.length / 2, 0);
    if (length <= 4 || length >= buffer.length / 2) throw new FolderError('unavailable');
    const path = buffer.toString('utf16le', 0, length * 2);
    if (!/^\\\\\?\\[a-z]:\\/iu.test(path)) throw new FolderError('forbidden-path');
    const regular = path.slice(4);
    const parts = regular.slice(3).split('\\');
    if (parts.some((part, index) => isProtectedComponent(part, directory || index < parts.length - 1))) throw new FolderError('forbidden-path');
    return regular;
  };
  const openChild = async (parent: bigint, name: string, directory: boolean, temporary = false): Promise<bigint> => {
    const encoded = Buffer.from(name, 'utf16le');
    const output = Buffer.alloc(8);
    const status = Buffer.alloc(16);
    const result = await callNative(create, output, temporary ? 0x40110080 : (directory ? 0x100081 : 0x80100080), {
      Length: 48, RootDirectory: parent,
      ObjectName: { Length: encoded.length, MaximumLength: encoded.length, Buffer: encoded },
      Attributes: 0x1040, SecurityDescriptor: null, SecurityQualityOfService: null, // OBJ_DONT_REPARSE | CASE_INSENSITIVE.
    }, status, null, 0x80, temporary ? 0 : 3, temporary ? 2 : 1, 0x200020 | (directory ? 1 : 0x40), null, 0);
    check(result);
    const handle = output.readBigUInt64LE();
    handles.add(handle);
    try { await metadata(handle, directory); if (!temporary) await canonical(handle, directory); return handle; }
    catch (error) { if (temporary) await discard(handle).catch(() => {}); await closeFile(handle); throw error; }
  };
  const readFile = async (handle: bigint): Promise<Buffer> => {
    if (await metadata(handle, false) > BigInt(SHARED_FOLDER_READ_MAX_BYTES)) throw new FolderError('too-large');
    const buffer = Buffer.alloc(SHARED_FOLDER_READ_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const status = Buffer.alloc(16);
      const offset = Buffer.alloc(8); offset.writeBigInt64LE(BigInt(length));
      const result = await callNative(read, handle, null, null, null, status, buffer.subarray(length), buffer.length - length, offset, null);
      if ((result >>> 0) === 0xc0000011) break; // STATUS_END_OF_FILE.
      check(result);
      const count = Number(status.readBigUInt64LE(8));
      if (count < 0 || count > buffer.length - length) throw new FolderError('unavailable');
      if (!count) break;
      length += count;
    }
    if (length > SHARED_FOLDER_READ_MAX_BYTES) throw new FolderError('too-large');
    return buffer.subarray(0, length);
  };
  const discard = async (handle: bigint) => {
    check(await callNative(setInformation, handle, Buffer.alloc(16), Buffer.from([1]), 1, 13));
  };

  const directory = (handle: bigint, canonicalRoot?: string): FolderDirectory => {
    let closed = false;
    return {
      canonicalRoot,
      async close() { if (!closed) { await closeFile(handle); closed = true; } },
      async child(name) {
        const child = await openChild(handle, name, true);
        return directory(child, await canonical(child));
      },
      async next(): Promise<DirectoryPageEntry | null | undefined> {
        const buffer = Buffer.alloc(4096);
        const status = Buffer.alloc(16);
        const result = await callNative(query, handle, null, null, null, status, buffer, buffer.length, 1, 1, null, 0);
        if ([0x80000006, 0xc000000f].includes(result >>> 0)) return undefined;
        check(result);
        const length = Number(status.readBigUInt64LE(8));
        if (length < 64 || length > buffer.length) throw new FolderError('unavailable');
        const nameLength = buffer.readUInt32LE(60);
        if (nameLength % 2 || nameLength > length - 64) throw new FolderError('unavailable');
        const name = buffer.toString('utf16le', 64, 64 + nameLength);
        const flags = buffer.readUInt32LE(56);
        const isDirectory = Boolean(flags & 0x10);
        if (!isValidComponent(name) || isProtectedComponent(name, isDirectory) || flags & (0x400 | 0x40)) return null;
        // Verify the entry through this same held directory, not by a reconstructed absolute path.
        let child: bigint;
        try { child = await openChild(handle, name, isDirectory); }
        catch (error) { if (error instanceof FolderError) return null; throw error; }
        await closeFile(child);
        return { name, kind: isDirectory ? 'directory' : 'file' };
      },
      async read(name) {
        const file = await openChild(handle, name, false);
        try { return await readFile(file); } finally { await closeFile(file); }
      },
      async write(name, bytes, beforeCommit) {
        let existing: bigint | undefined;
        try { existing = await openChild(handle, name, false); }
        catch (error) { if (!(error instanceof FolderError) || error.outcome !== 'not-found') throw error; }
        if (existing !== undefined) {
          try { decodeText(await readFile(existing)); } finally { await closeFile(existing); }
        }
        beforeCommit();
        const temporary = await openChild(handle, `.matcha-folder-write-${randomUUID()}`, false, true);
        let commitState: 'not-started' | 'committed' | 'unknown' = 'not-started';
        let failure: unknown;
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const status = Buffer.alloc(16);
            check(await callNative(write, temporary, null, null, null, status, bytes.subarray(offset), bytes.length - offset, null, null));
            const count = Number(status.readBigUInt64LE(8));
            if (count <= 0 || count > bytes.length - offset) throw new FolderError('unavailable');
            offset += count;
          }
          check(await callNative(flush, temporary, Buffer.alloc(16)));
          beforeCommit();
          const encoded = Buffer.from(name, 'utf16le');
          const rename = Buffer.alloc(20 + encoded.length);
          rename[0] = 1; rename.writeBigUInt64LE(handle, 8); rename.writeUInt32LE(encoded.length, 16); encoded.copy(rename, 20);
          // Replacement never opens/follows a raced destination symlink; its directory entry is replaced.
          let renameStatus: number;
          try { renameStatus = await callNative(setInformation, temporary, Buffer.alloc(16), rename, rename.length, 10); }
          catch { commitState = 'unknown'; throw new FolderError('outcome-unknown'); }
          check(renameStatus);
          commitState = 'committed';
          try { check(await callNative(flush, temporary, Buffer.alloc(16))); }
          catch { throw new FolderError('outcome-unknown'); }
        } catch (error) { failure = error; }
        // An unknown rename may already have committed: deleting by this handle would delete the user's new file.
        if (commitState === 'not-started') await discard(temporary).catch(() => { failure ??= new FolderError('unavailable'); });
        await closeFile(temporary).catch(() => { failure = new FolderError(commitState !== 'not-started' ? 'outcome-unknown' : 'unavailable'); });
        if (failure) throw failure;
      },
    };
  };
  return {
    async open(prefix: string): Promise<FolderDirectory> {
      const output = await new Promise<bigint>((resolve, reject) => {
        createAbsolute.async(prefix, 0x81, 3, null, 3, 0x02200000, null, (error: unknown, result: bigint) => {
          if (error || !result || result === -1n || result === 0xffffffffffffffffn) reject(new FolderError('unavailable'));
          else resolve(result);
        });
      });
      handles.add(output);
      try { await metadata(output, true); return directory(output, await canonical(output)); }
      catch (error) { await closeFile(output); throw error; }
    },
    async closeRemaining() {
      await Promise.allSettled([...handles].map(closeFile));
      if (handles.size) throw new FolderError('unavailable');
    },
  };
}

export async function openWindowsRoot(root: { prefix: string; components: string[] }): Promise<FolderDirectory> {
  const files = windowsFiles();
  const custody: FolderDirectory[] = [];
  try {
    custody.push(await files.open(root.prefix));
    for (const name of root.components) custody.push(await custody[custody.length - 1].child(name));
    const leaf = custody[custody.length - 1];
    return {
      canonicalRoot: leaf.canonicalRoot ?? win32.join(root.prefix, ...root.components),
      child: (name) => leaf.child(name), next: () => leaf.next(), read: (name) => leaf.read(name),
      write: (name, bytes, beforeCommit) => leaf.write(name, bytes, beforeCommit),
      async close() {
        for (const directory of [...custody].reverse()) await directory.close().catch(() => {});
        await files.closeRemaining();
      },
    };
  } catch (error) { for (const directory of custody.reverse()) await directory.close().catch(() => {}); throw error; }
}
