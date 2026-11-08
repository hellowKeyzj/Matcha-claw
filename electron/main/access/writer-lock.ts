import { closeSync, constants, fchmodSync, fstatSync, lstatSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, toNamespacedPath } from 'node:path';
import { AccessError } from './model';

const SQLITE_FILES = ['access.sqlite', 'access.sqlite-wal', 'access.sqlite-shm', 'access.sqlite-journal'];

// Access alone owns these handles. Closing the file (or process exit) releases the OS lock.
export async function acquireWriterLock(root: string) {
  if (!isAbsolute(root) || root.includes('\0') || dirname(root) === root) throw new AccessError('unavailable');
  const koffi = createRequire(__filename)('koffi') as typeof import('koffi');
  const windows = process.platform === 'win32' ? windowsFiles(koffi) : undefined;
  const libc = windows ? undefined : koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
  const flock = libc?.func('int flock(int fd, int operation)');
  const aclGet = process.platform === 'darwin' ? libc!.func('void *acl_get_fd_np(int fd, int type)') : undefined;
  const aclFree = aclGet ? libc!.func('int acl_free(void *acl)') : undefined;
  const assertNoAcl = (fd: number) => {
    if (!aclGet) return;
    koffi.errno(0);
    const acl = aclGet(fd, 0x100);
    if (acl) { aclFree!(acl); throw new AccessError('unavailable'); }
    if (koffi.errno() !== koffi.os.errno.ENOENT) throw new AccessError('unavailable');
  };
  const checkAncestors = () => {
    for (let path = root; ; path = dirname(path)) {
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new AccessError('unavailable');
      if (stat) windows?.assertNoReparse(path);
      if (dirname(path) === path) break;
    }
  };
  checkAncestors();
  await mkdir(root, { recursive: true, mode: 0o700 });
  checkAncestors();

  let directory: number | bigint | undefined;
  let writer: number | bigint | undefined;
  const closeFile = (file: number | bigint) => {
    if (windows) windows.close(file as bigint);
    else closeSync(file as number);
  };
  const close = () => {
    if (writer !== undefined) { closeFile(writer); writer = undefined; }
    if (directory !== undefined) { closeFile(directory); directory = undefined; }
  };
  try {
    directory = windows ? windows.open(root, true, false) : openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const identity = lstatSync(root, { bigint: true });
    if (windows) windows.makePrivate(directory as bigint, true);
    else {
      const stat = fstatSync(directory as number);
      if (stat.uid !== process.geteuid!() || (stat.mode & 0o022) !== 0) throw new AccessError('unavailable');
      assertNoAcl(directory as number);
      fchmodSync(directory as number, 0o700);
    }
    const openFile = (name: string, create: boolean): number | bigint => {
      const path = join(root, name);
      if (windows) {
        const handle = windows.open(path, false, create);
        try { windows.makePrivate(handle, false); return handle; }
        catch (error) { windows.close(handle); throw error; }
      }
      const fd = openSync(path, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid!()) throw new AccessError('unavailable');
        assertNoAcl(fd);
        fchmodSync(fd, 0o600);
        return fd;
      } catch (error) { closeSync(fd); throw error; }
    };
    writer = openFile('writer.lock', true);
    if (windows) windows.lock(writer as bigint);
    else if (flock!(writer, 2 | 4) !== 0) throw new AccessError('unavailable'); // LOCK_EX | LOCK_NB, like Rust File::try_lock.
    const verifyFiles = () => {
      checkAncestors();
      const current = lstatSync(root, { bigint: true });
      if (current.dev !== identity.dev || current.ino !== identity.ino) throw new AccessError('unavailable');
      for (const name of SQLITE_FILES) {
        const path = join(root, name);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new AccessError('unavailable');
        windows?.assertNoReparse(path);
        if (!windows && (stat.uid !== process.geteuid!() || (stat.mode & 0o077) !== 0)) throw new AccessError('unavailable');
      }
    };
    // Never open/close extra database descriptors after SQLite opens: POSIX close releases its fcntl locks.
    for (const name of SQLITE_FILES) {
      if (!lstatSync(join(root, name), { throwIfNoEntry: false })) continue;
      closeFile(openFile(name, false));
    }
    verifyFiles();
    closeFile(openFile('access.sqlite', true));
    return { verifyFiles, close };
  } catch (error) { close(); throw error; }
}

function windowsFiles(koffi: typeof import('koffi')) {
  if (!['x64', 'arm64'].includes(process.arch)) throw new AccessError('unavailable');
  const kernel = koffi.load('kernel32.dll');
  const security = koffi.load('advapi32.dll');
  const createFile = kernel.func('void * __stdcall CreateFileW(const char16_t *path, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)');
  const fileInformation = kernel.func('int __stdcall GetFileInformationByHandle(void *file, void *information)');
  const attributes = kernel.func('uint32_t __stdcall GetFileAttributesW(const char16_t *path)');
  const closeHandle = kernel.func('int __stdcall CloseHandle(void *handle)');
  const lockFile = kernel.func('int __stdcall LockFileEx(void *file, uint32_t flags, uint32_t reserved, uint32_t low, uint32_t high, void *overlapped)');
  const localFree = kernel.func('void * __stdcall LocalFree(void *memory)');
  const openToken = security.func('int __stdcall OpenProcessToken(void *process, uint32_t access, void *token)');
  const tokenInformation = security.func('int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t length, void *returned)');
  const getSecurity = security.func('uint32_t __stdcall GetSecurityInfo(void *handle, int kind, uint32_t flags, void *owner, void *group, void *dacl, void *sacl, void *descriptor)');
  const equalSid = security.func('int __stdcall EqualSid(void *left, void *right)');
  const convertSecurity = security.func('int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *sddl, uint32_t revision, void *descriptor, void *size)');
  const setSecurity = security.func('int __stdcall SetKernelObjectSecurity(void *handle, uint32_t flags, void *descriptor)');
  const check = (result: number) => { if (!result) throw new AccessError('unavailable'); };
  const close = (handle: bigint) => { check(closeHandle(handle)); };
  const tokenPointer = Buffer.alloc(8);
  check(openToken(-1n, 8, tokenPointer)); // Current process pseudo-handle; TOKEN_QUERY.
  const token = tokenPointer.readBigUInt64LE();
  const user = Buffer.alloc(256); // TOKEN_USER plus SECURITY_MAX_SID_SIZE fits within this buffer on Win64.
  try { check(tokenInformation(token, 1, user, user.length, Buffer.alloc(4))); }
  finally { close(token); }

  return {
    close,
    assertNoReparse(path: string) {
      const value = attributes(toNamespacedPath(path));
      if (value === 0xffff_ffff || (value & 0x400) !== 0) throw new AccessError('unavailable');
    },
    open(path: string, directory: boolean, create: boolean): bigint {
      // No FILE_SHARE_DELETE pins the directory and writer.lock; no reparse traversal at the leaf.
      const handle = createFile(toNamespacedPath(path), 0x60000 | (directory ? 0x80 : 0xc0000000), 3, null, create ? 4 : 3, 0x00200000 | (directory ? 0x02000000 : 0), null) as bigint;
      if (handle === 0xffff_ffff_ffff_ffffn || handle === -1n || !handle) throw new AccessError('unavailable');
      try {
        const info = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION.
        check(fileInformation(handle, info));
        const flags = info.readUInt32LE();
        if ((flags & 0x400) !== 0 || Boolean(flags & 0x10) !== directory || (!directory && info.readUInt32LE(40) !== 1)) throw new AccessError('unavailable');
        return handle;
      } catch (error) { close(handle); throw error; }
    },
    makePrivate(handle: bigint, directory: boolean) {
      const owner = Buffer.alloc(8);
      const descriptor = Buffer.alloc(8);
      if (getSecurity(handle, 1, 1, owner, null, null, null, descriptor) !== 0) throw new AccessError('unavailable');
      try { check(equalSid(owner.readBigUInt64LE(), user.readBigUInt64LE())); }
      finally { localFree(descriptor.readBigUInt64LE()); }
      check(convertSecurity(directory ? 'D:P(A;OICI;FA;;;OW)' : 'D:P(A;;FA;;;OW)', 1, descriptor, null));
      try { check(setSecurity(handle, 0x80000004, descriptor.readBigUInt64LE())); }
      finally { localFree(descriptor.readBigUInt64LE()); }
    },
    lock(handle: bigint) {
      // Same [0, u64::MAX) region and flags as Rust File::try_lock, not an existence/PID sentinel.
      check(lockFile(handle, 3, 0, 0xffff_ffff, 0xffff_ffff, Buffer.alloc(32)));
    },
  };
}
