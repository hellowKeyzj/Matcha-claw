import * as fs from 'fs'
import {
  mkdir as mkdirPromise,
  lstat as lstatPromise,
  open,
  opendir,
  realpath as realpathPromise,
  readlink as readlinkPromise,
  readdir as readdirPromise,
  readFile as readFilePromise,
  rename as renamePromise,
  rmdir as rmdirPromise,
  rm as rmPromise,
  stat as statPromise,
  unlink as unlinkPromise,
} from 'fs/promises'
import { homedir } from 'os'
import * as nodePath from 'path'
import { getErrnoCode } from './errors.js'
import { slowLogging } from './slowOperations.js'
import { readSourceBytes, SOURCE_STAT_MAX_BYTES, sourceStatBytes, sourceCleanupFailure } from './readFileInRange.js'
import {
  InvestigationAdmissionError, admitInvestigationIo, currentInvestigationScope,
  investigationDigest, investigationSignal, investigationUsage,
  observeInvestigationIo, requireInvestigationEffects, rethrowInvestigationAdmission, trackInvestigationOperation,
  type InvestigationPermit,
} from '../world/investigation.js'

type SourceStatOptions = { bigint?: false; followSymlinks?: boolean; signal?: AbortSignal }
type SourceBigIntStatOptions = { bigint: true; followSymlinks?: boolean; signal?: AbortSignal }

function checkSourceLive(signal?: AbortSignal): void {
  signal?.throwIfAborted()
  requireInvestigationEffects(['source_read'])
  investigationSignal()?.throwIfAborted()
}

function sourcePathUnits(): number {
  // Native dirent/pathname storage bounds, not an assumed filesystem NAME_MAX.
  // Linux d_reclen is uint16; Darwin d_name is 1024 bytes; NT UNICODE_STRING
  // holds at most 32767 UTF-16 units. Unknown backends cannot prove a bound.
  switch (process.platform) {
    case 'linux': return 65535
    case 'darwin': return 1024
    case 'win32': return 32767
    default: throw new InvestigationAdmissionError('investigation_source_path_bound_unavailable')
  }
}

function sourceRecordBytes(record: object): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8')
}

async function readSourceRecord<T>(
  path: string, operation: 'stat' | 'lstat' | 'realpath' | 'readlink', byteCap: number,
  read: () => Promise<T>, measure: (value: T) => number, signal?: AbortSignal,
): Promise<T> {
  checkSourceLive(signal)
  const permit = await admitInvestigationIo({ kind: 'source',
    preparedRequestDigest: investigationDigest({ path, operation, byteCap }),
    reservation: investigationUsage({ sourceReads: '1', rows: '1', bytes: String(byteCap) }),
    proof: { producer: 'matcha_local_source', operation, effect: 'source_read',
      record: operation === 'realpath' ? 'fs_realpath_v1' : operation === 'readlink' ? 'fs_readlink_v1' : 'fs_stat_v1',
      byteCap: String(byteCap), rowCap: '1' },
  })
  let attempted = false
  let bytes = 0
  let rows = 0
  let failure: unknown
  try {
    checkSourceLive(signal)
    attempted = true
    const value = await read()
    bytes = measure(value)
    rows = 1
    checkSourceLive(signal)
    return value
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      await observeInvestigationIo(permit, { status: 'complete',
        usage: investigationUsage({ sourceReads: attempted ? '1' : '0', rows: String(rows), bytes: String(bytes) }),
        ...(failure === undefined ? {} : { reason: failure instanceof Error ? failure.message : 'investigation_source_failed' }),
      })
    } catch (error) {
      failure = sourceCleanupFailure(failure, error)
    }
    if (failure !== undefined) throw failure
  }
}

export function statSourcePath(filePath: string, options: SourceBigIntStatOptions): Promise<fs.BigIntStats>
export function statSourcePath(filePath: string, options?: SourceStatOptions): Promise<fs.Stats>
export function statSourcePath(
  filePath: string, options?: SourceStatOptions | SourceBigIntStatOptions,
): Promise<fs.Stats | fs.BigIntStats> {
  const read = () => (options?.followSymlinks === false ? lstatPromise : statPromise)(filePath, { bigint: options?.bigint ?? false })
  if (!currentInvestigationScope()) return read()
  return trackInvestigationOperation(readSourceRecord(filePath,
    options?.followSymlinks === false ? 'lstat' : 'stat', SOURCE_STAT_MAX_BYTES, read, sourceStatBytes, options?.signal))
}

export function realSourcePath(path: string, signal?: AbortSignal): Promise<string> {
  if (!currentInvestigationScope()) return realpathPromise(path)
  // glibc realpath(NULL) can return a canonical path longer than PATH_MAX;
  // the Linux dirent bound does not bound this dynamically allocated result.
  if (process.platform === 'linux') throw new InvestigationAdmissionError('investigation_source_path_bound_unavailable')
  return trackInvestigationOperation(readSourceRecord(path, 'realpath', sourcePathUnits() * 6 + 128,
    () => realpathPromise(path), value => sourceRecordBytes({ type: 'fs_realpath_v1', path: value }), signal))
}

export function readSourceDirectory(directoryPath: string, signal?: AbortSignal): Promise<fs.Dirent[]> {
  if (!currentInvestigationScope()) return readdirPromise(directoryPath, { withFileTypes: true })
  return trackInvestigationOperation(readBoundedDirectory(directoryPath, signal))
}

async function readBoundedDirectory(directoryPath: string, signal?: AbortSignal): Promise<fs.Dirent[]> {
  checkSourceLive(signal)
  const batchSize = 8
  // JSON may escape every native name unit as six ASCII bytes. parentPath is
  // repeated because each returned Dirent carries that real application field.
  const recordCap = sourcePathUnits() * 6 + sourceRecordBytes({ parentPath: directoryPath }) + 256
  const batches: { permit: InvestigationPermit | undefined; bytes: number; rows: number }[] = []
  const admitBatch = async () => {
    const first = batches.length === 0
    const permit = await admitInvestigationIo({ kind: 'source',
      preparedRequestDigest: investigationDigest({ directoryPath, batch: batches.length, batchSize, recordCap }),
      reservation: investigationUsage({ sourceReads: first ? '1' : '0', rows: String(batchSize), bytes: String(recordCap * batchSize) }),
      proof: { producer: 'matcha_local_source', operation: 'directory_read', effect: 'source_read',
        record: 'fs_dirent_v1', recordMaxBytes: String(recordCap), batchSize,
        byteCap: String(recordCap * batchSize), rowCap: String(batchSize) },
    })
    const batch = { permit, bytes: 0, rows: 0 }
    batches.push(batch)
    return batch
  }
  let batch = await admitBatch()
  let dir: Awaited<ReturnType<typeof opendir>> | undefined
  let attempted = false
  let failure: unknown
  let closed = false
  try {
    checkSourceLive(signal)
    attempted = true
    dir = await opendir(directoryPath, { bufferSize: batchSize })
    const entries: fs.Dirent[] = []
    while (true) {
      checkSourceLive(signal)
      let ended = false
      // Drain the complete native batch before checking cancellation again;
      // this accounts for every prefetched entry, including later filters.
      for (let index = 0; index < batchSize; index++) {
        const entry = await dir.read()
        if (!entry) { ended = true; break }
        const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory'
          : entry.isSymbolicLink() ? 'symlink' : entry.isBlockDevice() ? 'block'
            : entry.isCharacterDevice() ? 'character' : entry.isFIFO() ? 'fifo'
              : entry.isSocket() ? 'socket' : 'unknown'
        const parentPath = 'parentPath' in entry ? entry.parentPath : directoryPath
        batch.bytes += sourceRecordBytes({ type: 'fs_dirent_v1', name: entry.name, kind, parentPath })
        batch.rows++
        entries.push(entry)
      }
      checkSourceLive(signal)
      if (ended) return entries
      batch = await admitBatch()
    }
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      await dir?.close()
      closed = true
    } catch (error) {
      failure = sourceCleanupFailure(failure, error)
    }
    for (const [index, batch] of batches.entries()) {
      try {
        await observeInvestigationIo(batch.permit, { status: closed ? 'complete' : attempted ? 'unknown' : 'not_sent',
          usage: investigationUsage({ sourceReads: index === 0 && attempted ? '1' : '0', rows: String(batch.rows), bytes: String(batch.bytes) }),
          ...(failure === undefined ? {} : { reason: failure instanceof Error ? failure.message : 'investigation_source_directory_failed' }),
        })
      } catch (error) {
        failure = sourceCleanupFailure(failure, error)
      }
    }
    if (failure !== undefined) throw failure
  }
}

/**
 * Simplified filesystem operations interface based on Node.js fs module.
 * Provides a subset of commonly used sync operations with type safety.
 * Allows abstraction for alternative implementations (e.g., mock, virtual).
 */
export type FsOperations = {
  // File access and information operations
  /** Gets the current working directory */
  cwd(): string
  /** Checks if a file or directory exists */
  existsSync(path: string): boolean
  /** Gets file stats asynchronously */
  stat(path: string): Promise<fs.Stats>
  /** Lists directory contents with file type information asynchronously */
  readdir(path: string): Promise<fs.Dirent[]>
  /** Deletes file asynchronously */
  unlink(path: string): Promise<void>
  /** Removes an empty directory asynchronously */
  rmdir(path: string): Promise<void>
  /** Removes files and directories asynchronously (with recursive option) */
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void>
  /** Creates directory recursively asynchronously. */
  mkdir(path: string, options?: { mode?: number }): Promise<void>
  /** Reads file content as string asynchronously */
  readFile(path: string, options: { encoding: BufferEncoding }): Promise<string>
  /** Renames/moves file asynchronously */
  rename(oldPath: string, newPath: string): Promise<void>
  /** Gets file stats */
  statSync(path: string): fs.Stats
  /** Gets file stats without following symlinks */
  lstatSync(path: string): fs.Stats

  // File content operations
  /** Reads file content as string with specified encoding */
  readFileSync(
    path: string,
    options: {
      encoding: BufferEncoding
    },
  ): string
  /** Reads raw file bytes as Buffer */
  readFileBytesSync(path: string): Buffer
  /** Reads specified number of bytes from file start */
  readSync(
    path: string,
    options: {
      length: number
    },
  ): {
    buffer: Buffer
    bytesRead: number
  }
  /** Appends string to file */
  appendFileSync(path: string, data: string, options?: { mode?: number }): void
  /** Copies file from source to destination */
  copyFileSync(src: string, dest: string): void
  /** Deletes file */
  unlinkSync(path: string): void
  /** Renames/moves file */
  renameSync(oldPath: string, newPath: string): void
  /** Creates hard link */
  linkSync(target: string, path: string): void
  /** Creates symbolic link */
  symlinkSync(
    target: string,
    path: string,
    type?: 'dir' | 'file' | 'junction',
  ): void
  /** Reads symbolic link */
  readlinkSync(path: string): string
  /** Resolves symbolic links and returns the canonical pathname */
  realpathSync(path: string): string

  // Directory operations
  /** Creates directory recursively. Mode defaults to 0o777 & ~umask if not specified. */
  mkdirSync(
    path: string,
    options?: {
      mode?: number
    },
  ): void
  /** Lists directory contents with file type information */
  readdirSync(path: string): fs.Dirent[]
  /** Lists directory contents as strings */
  readdirStringSync(path: string): string[]
  /** Checks if the directory is empty */
  isDirEmptySync(path: string): boolean
  /** Removes an empty directory */
  rmdirSync(path: string): void
  /** Removes files and directories (with recursive option) */
  rmSync(
    path: string,
    options?: {
      recursive?: boolean
      force?: boolean
    },
  ): void
  /** Create a writable stream for writing data to a file. */
  createWriteStream(path: string): fs.WriteStream
  /** Reads raw file bytes as Buffer asynchronously.
   *  When maxBytes is set, only reads up to that many bytes. */
  readFileBytes(path: string, maxBytes?: number): Promise<Buffer>
}

/**
 * Safely resolves a file path, handling symlinks and errors gracefully.
 *
 * Error handling strategy:
 * - If the file doesn't exist, returns the original path (allows for file creation)
 * - If symlink resolution fails (broken symlink, permission denied, circular links),
 *   returns the original path and marks it as not a symlink
 * - This ensures operations can continue with the original path rather than failing
 *
 * @param fs The filesystem implementation to use
 * @param filePath The path to resolve
 * @returns Object containing the resolved path and whether it was a symlink
 */
export function safeResolvePath(
  fs: FsOperations,
  filePath: string,
): { resolvedPath: string; isSymlink: boolean; isCanonical: boolean } {
  // Block UNC paths before any filesystem access to prevent network
  // requests (DNS/SMB) during validation on Windows
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }

  try {
    // Check for special file types (FIFOs, sockets, devices) before calling realpathSync.
    // realpathSync can block on FIFOs waiting for a writer, causing hangs.
    // If the file doesn't exist, lstatSync throws ENOENT which the catch
    // below handles by returning the original path (allows file creation).
    const stats = fs.lstatSync(filePath)
    if (
      stats.isFIFO() ||
      stats.isSocket() ||
      stats.isCharacterDevice() ||
      stats.isBlockDevice()
    ) {
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }

    const resolvedPath = fs.realpathSync(filePath)
    return {
      resolvedPath,
      isSymlink: resolvedPath !== filePath,
      // realpathSync returned: resolvedPath is canonical (all symlinks in
      // all path components resolved). Callers can skip further symlink
      // resolution on this path.
      isCanonical: true,
    }
  } catch (_error) {
    // If lstat/realpath fails for any reason (ENOENT, broken symlink,
    // EACCES, ELOOP, etc.), return the original path to allow operations
    // to proceed
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}

export async function safeResolveSourcePath(
  filePath: string, signal?: AbortSignal,
): Promise<{ resolvedPath: string; isSymlink: boolean; isCanonical: boolean }> {
  if (!currentInvestigationScope()) return safeResolvePath(getFsImplementation(), filePath)
  if (filePath.startsWith('//') || filePath.startsWith('\\\\')) {
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
  try {
    const stats = await statSourcePath(filePath, { followSymlinks: false, signal })
    if (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) {
      return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
    }
    const resolvedPath = (await realSourcePath(filePath, signal)).normalize('NFC')
    return { resolvedPath, isSymlink: resolvedPath !== filePath, isCanonical: true }
  } catch (error) {
    rethrowInvestigationAdmission(error)
    if (error instanceof Error && error.cause !== undefined) throw error
    checkSourceLive(signal)
    return { resolvedPath: filePath, isSymlink: false, isCanonical: false }
  }
}

/**
 * Check if a file path is a duplicate and should be skipped.
 * Resolves symlinks to detect duplicates pointing to the same file.
 * If not a duplicate, adds the resolved path to loadedPaths.
 *
 * @returns true if the file should be skipped (is duplicate)
 */
export function isDuplicatePath(
  fs: FsOperations,
  filePath: string,
  loadedPaths: Set<string>,
): boolean {
  const { resolvedPath } = safeResolvePath(fs, filePath)
  if (loadedPaths.has(resolvedPath)) {
    return true
  }
  loadedPaths.add(resolvedPath)
  return false
}

/**
 * Resolve the deepest existing ancestor of a path via realpathSync, walking
 * up until it succeeds. Detects dangling symlinks (link entry exists, target
 * doesn't) via lstat and resolves them via readlink.
 *
 * Use when the input path may not exist (new file writes) and you need to
 * know where the write would ACTUALLY land after the OS follows symlinks.
 *
 * Returns the resolved absolute path with non-existent tail segments
 * rejoined, or undefined if no symlink was found in any existing ancestor
 * (the path's existing ancestors all resolve to themselves).
 *
 * Handles: live parent symlinks, dangling file symlinks, dangling parent
 * symlinks. Same core algorithm as teamMemPaths.ts:realpathDeepestExisting.
 */
export function resolveDeepestExistingAncestorSync(
  fs: FsOperations,
  absolutePath: string,
): string | undefined {
  let dir = absolutePath
  const segments: string[] = []
  // Walk up using lstat (cheap, O(1)) to find the first existing component.
  // lstat does not follow symlinks, so dangling symlinks are detected here.
  // Only call realpathSync (expensive, O(depth)) once at the end.
  while (dir !== nodePath.dirname(dir)) {
    let st: fs.Stats
    try {
      st = fs.lstatSync(dir)
    } catch {
      // lstat failed: truly non-existent. Walk up.
      segments.unshift(nodePath.basename(dir))
      dir = nodePath.dirname(dir)
      continue
    }
    if (st.isSymbolicLink()) {
      // Found a symlink (live or dangling). Try realpath first (resolves
      // chained symlinks); fall back to readlink for dangling symlinks.
      try {
        const resolved = fs.realpathSync(dir)
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      } catch {
        // Dangling: realpath failed but lstat saw the link entry.
        const target = fs.readlinkSync(dir)
        const absTarget = nodePath.isAbsolute(target)
          ? target
          : nodePath.resolve(nodePath.dirname(dir), target)
        return segments.length === 0
          ? absTarget
          : nodePath.join(absTarget, ...segments)
      }
    }
    // Existing non-symlink component. One realpath call resolves any
    // symlinks in its ancestors. If none, return undefined (no symlink).
    try {
      const resolved = fs.realpathSync(dir)
      if (resolved !== dir) {
        return segments.length === 0
          ? resolved
          : nodePath.join(resolved, ...segments)
      }
    } catch {
      // realpath can still fail (e.g. EACCES in ancestors). Return
      // undefined — we can't resolve, and the logical path is already
      // in pathSet for the caller.
    }
    return undefined
  }
  return undefined
}

/**
 * Gets all paths that should be checked for permissions.
 * This includes the original path, all intermediate symlink targets in the chain,
 * and the final resolved path.
 *
 * For example, if test.txt -> /etc/passwd -> /private/etc/passwd:
 * - test.txt (original path)
 * - /etc/passwd (intermediate symlink target)
 * - /private/etc/passwd (final resolved path)
 *
 * This is important for security: a deny rule for /etc/passwd should block
 * access even if the file is actually at /private/etc/passwd (as on macOS).
 *
 * @param path - The path to check (will be converted to absolute)
 * @returns An array of absolute paths to check permissions for
 */
export function getPathsForPermissionCheck(inputPath: string): string[] {
  // Expand tilde notation defensively - tools should do this in getPath(),
  // but we normalize here as defense in depth for permission checking
  let path = inputPath
  if (path === '~') {
    path = homedir().normalize('NFC')
  } else if (path.startsWith('~/')) {
    path = nodePath.join(homedir().normalize('NFC'), path.slice(2))
  }

  const pathSet = new Set<string>()
  const fsImpl = getFsImplementation()

  // Always check the original path
  pathSet.add(path)

  // Block UNC paths before any filesystem access to prevent network
  // requests (DNS/SMB) during validation on Windows
  if (path.startsWith('//') || path.startsWith('\\\\')) {
    return Array.from(pathSet)
  }

  // Follow the symlink chain, collecting ALL intermediate targets
  // This handles cases like: test.txt -> /etc/passwd -> /private/etc/passwd
  // We want to check all three paths, not just test.txt and /private/etc/passwd
  try {
    let currentPath = path
    const visited = new Set<string>()
    const maxDepth = 40 // Prevent runaway loops, matches typical SYMLOOP_MAX

    for (let depth = 0; depth < maxDepth; depth++) {
      // Prevent infinite loops from circular symlinks
      if (visited.has(currentPath)) {
        break
      }
      visited.add(currentPath)

      if (!fsImpl.existsSync(currentPath)) {
        // Path doesn't exist (new file case). existsSync follows symlinks,
        // so this is also reached for DANGLING symlinks (link entry exists,
        // target doesn't). Resolve symlinks in the path and its ancestors
        // so permission checks see the real destination. Without this,
        // `./data -> /etc/cron.d/` (live parent symlink) or
        // `./evil.txt -> ~/.ssh/authorized_keys2` (dangling file symlink)
        // would allow writes that escape the working directory.
        if (currentPath === path) {
          const resolved = resolveDeepestExistingAncestorSync(fsImpl, path)
          if (resolved !== undefined) {
            pathSet.add(resolved)
          }
        }
        break
      }

      const stats = fsImpl.lstatSync(currentPath)

      // Skip special file types that can cause issues
      if (
        stats.isFIFO() ||
        stats.isSocket() ||
        stats.isCharacterDevice() ||
        stats.isBlockDevice()
      ) {
        break
      }

      if (!stats.isSymbolicLink()) {
        break
      }

      // Get the immediate symlink target
      const target = fsImpl.readlinkSync(currentPath)

      // If target is relative, resolve it relative to the symlink's directory
      const absoluteTarget = nodePath.isAbsolute(target)
        ? target
        : nodePath.resolve(nodePath.dirname(currentPath), target)

      // Add this intermediate target to the set
      pathSet.add(absoluteTarget)
      currentPath = absoluteTarget
    }
  } catch {
    // If anything fails during chain traversal, continue with what we have
  }

  // Also add the final resolved path using realpathSync for completeness
  // This handles any remaining symlinks in directory components
  const { resolvedPath, isSymlink } = safeResolvePath(fsImpl, path)
  if (isSymlink && resolvedPath !== path) {
    pathSet.add(resolvedPath)
  }

  return Array.from(pathSet)
}

function rethrowSourcePreparationFailure(error: unknown, signal?: AbortSignal): void {
  rethrowInvestigationAdmission(error)
  if (error instanceof Error && error.cause !== undefined) throw error
  checkSourceLive(signal)
}

function readSourceLink(path: string, signal?: AbortSignal): Promise<string> {
  // The NT reparse target is bounded by UNICODE_STRING. A POSIX magic-link
  // target need not share the directory-entry name bound.
  if (process.platform !== 'win32') throw new InvestigationAdmissionError('investigation_source_link_bound_unavailable')
  return trackInvestigationOperation(readSourceRecord(path, 'readlink', sourcePathUnits() * 6 + 128,
    () => readlinkPromise(path), value => sourceRecordBytes({ type: 'fs_readlink_v1', path: value }), signal))
}

async function resolveDeepestExistingSourceAncestor(
  absolutePath: string, signal?: AbortSignal,
): Promise<string | undefined> {
  let dir = absolutePath
  const segments: string[] = []
  while (dir !== nodePath.dirname(dir)) {
    let stats: fs.Stats
    try {
      stats = await statSourcePath(dir, { followSymlinks: false, signal })
    } catch (error) {
      rethrowSourcePreparationFailure(error, signal)
      segments.unshift(nodePath.basename(dir))
      dir = nodePath.dirname(dir)
      continue
    }
    if (stats.isSymbolicLink()) {
      let resolved: string
      try {
        resolved = (await realSourcePath(dir, signal)).normalize('NFC')
      } catch (error) {
        rethrowSourcePreparationFailure(error, signal)
        const target = await readSourceLink(dir, signal)
        resolved = nodePath.isAbsolute(target) ? target : nodePath.resolve(nodePath.dirname(dir), target)
      }
      return segments.length === 0 ? resolved : nodePath.join(resolved, ...segments)
    }
    try {
      const resolved = (await realSourcePath(dir, signal)).normalize('NFC')
      if (resolved !== dir) return segments.length === 0 ? resolved : nodePath.join(resolved, ...segments)
    } catch (error) {
      rethrowSourcePreparationFailure(error, signal)
    }
    return undefined
  }
  return undefined
}

export function getSourcePathsForPermissionCheck(inputPath: string, signal?: AbortSignal): Promise<string[]> {
  if (!currentInvestigationScope()) return Promise.resolve(getPathsForPermissionCheck(inputPath))
  return trackInvestigationOperation(collectSourcePermissionPaths(inputPath, signal))
}

async function collectSourcePermissionPaths(inputPath: string, signal?: AbortSignal): Promise<string[]> {
  signal?.throwIfAborted()
  requireInvestigationEffects([])
  let path = inputPath
  if (path === '~') path = homedir().normalize('NFC')
  else if (path.startsWith('~/')) path = nodePath.join(homedir().normalize('NFC'), path.slice(2))
  const paths = new Set([path])
  if (path.startsWith('//') || path.startsWith('\\\\')) return [...paths]
  try {
    let currentPath = path
    const visited = new Set<string>()
    for (let depth = 0; depth < 40; depth++) {
      if (visited.has(currentPath)) break
      visited.add(currentPath)
      let exists = true
      try {
        await statSourcePath(currentPath, { signal })
      } catch (error) {
        rethrowSourcePreparationFailure(error, signal)
        exists = false
      }
      if (!exists) {
        if (currentPath === path) {
          const resolved = await resolveDeepestExistingSourceAncestor(path, signal)
          if (resolved !== undefined) paths.add(resolved)
        }
        break
      }
      const stats = await statSourcePath(currentPath, { followSymlinks: false, signal })
      if (stats.isFIFO() || stats.isSocket() || stats.isCharacterDevice() || stats.isBlockDevice()) break
      if (!stats.isSymbolicLink()) break
      const target = await readSourceLink(currentPath, signal)
      const absoluteTarget = nodePath.isAbsolute(target) ? target : nodePath.resolve(nodePath.dirname(currentPath), target)
      paths.add(absoluteTarget)
      currentPath = absoluteTarget
    }
  } catch (error) {
    rethrowSourcePreparationFailure(error, signal)
  }
  const { resolvedPath, isSymlink } = await safeResolveSourcePath(path, signal)
  if (isSymlink && resolvedPath !== path) paths.add(resolvedPath)
  return [...paths]
}

export const NodeFsOperations: FsOperations = {
  cwd() {
    return process.cwd()
  },

  existsSync(fsPath) {
    using _ = slowLogging`fs.existsSync(${fsPath})`
    return fs.existsSync(fsPath)
  },

  async stat(fsPath) {
    return statSourcePath(fsPath)
  },

  async readdir(fsPath) {
    return readSourceDirectory(fsPath)
  },

  async unlink(fsPath) {
    return unlinkPromise(fsPath)
  },

  async rmdir(fsPath) {
    return rmdirPromise(fsPath)
  },

  async rm(fsPath, options) {
    return rmPromise(fsPath, options)
  },

  async mkdir(dirPath, options) {
    try {
      await mkdirPromise(dirPath, { recursive: true, ...options })
    } catch (e) {
      // Bun/Windows: recursive:true throws EEXIST on directories with the
      // FILE_ATTRIBUTE_READONLY bit set (Group Policy, OneDrive, desktop.ini).
      // Bun's directoryExistsAt misclassifies DIRECTORY+READONLY as not-a-dir
      // (bun-internal src/sys.zig existsAtType). The dir exists; ignore.
      // https://github.com/anthropics/claude-code/issues/30924
      if (getErrnoCode(e) !== 'EEXIST') throw e
    }
  },

  async readFile(fsPath, options) {
    if (!currentInvestigationScope()) return readFilePromise(fsPath, { encoding: options.encoding })
    return (await readSourceBytes(fsPath)).toString(options.encoding)
  },

  async rename(oldPath, newPath) {
    return renamePromise(oldPath, newPath)
  },

  statSync(fsPath) {
    using _ = slowLogging`fs.statSync(${fsPath})`
    return fs.statSync(fsPath)
  },

  lstatSync(fsPath) {
    using _ = slowLogging`fs.lstatSync(${fsPath})`
    return fs.lstatSync(fsPath)
  },

  readFileSync(fsPath, options) {
    using _ = slowLogging`fs.readFileSync(${fsPath})`
    return fs.readFileSync(fsPath, { encoding: options.encoding })
  },

  readFileBytesSync(fsPath) {
    using _ = slowLogging`fs.readFileBytesSync(${fsPath})`
    return fs.readFileSync(fsPath)
  },

  readSync(fsPath, options) {
    using _ = slowLogging`fs.readSync(${fsPath}, ${options.length} bytes)`
    let fd: number | undefined
    try {
      fd = fs.openSync(fsPath, 'r')
      const buffer = Buffer.alloc(options.length)
      const bytesRead = fs.readSync(fd, buffer, 0, options.length, 0)
      return { buffer, bytesRead }
    } finally {
      if (fd) fs.closeSync(fd)
    }
  },

  appendFileSync(path, data, options) {
    using _ = slowLogging`fs.appendFileSync(${path}, ${data.length} chars)`
    // For new files with explicit mode, use 'ax' (atomic create-with-mode) to avoid
    // TOCTOU race between existence check and open. Fall back to normal append if exists.
    if (options?.mode !== undefined) {
      try {
        const fd = fs.openSync(path, 'ax', options.mode)
        try {
          fs.appendFileSync(fd, data)
        } finally {
          fs.closeSync(fd)
        }
        return
      } catch (e) {
        if (getErrnoCode(e) !== 'EEXIST') throw e
        // File exists — fall through to normal append
      }
    }
    fs.appendFileSync(path, data)
  },

  copyFileSync(src, dest) {
    using _ = slowLogging`fs.copyFileSync(${src} → ${dest})`
    fs.copyFileSync(src, dest)
  },

  unlinkSync(path: string) {
    using _ = slowLogging`fs.unlinkSync(${path})`
    fs.unlinkSync(path)
  },

  renameSync(oldPath: string, newPath: string) {
    using _ = slowLogging`fs.renameSync(${oldPath} → ${newPath})`
    fs.renameSync(oldPath, newPath)
  },

  linkSync(target: string, path: string) {
    using _ = slowLogging`fs.linkSync(${target} → ${path})`
    fs.linkSync(target, path)
  },

  symlinkSync(
    target: string,
    path: string,
    type?: 'dir' | 'file' | 'junction',
  ) {
    using _ = slowLogging`fs.symlinkSync(${target} → ${path})`
    fs.symlinkSync(target, path, type)
  },

  readlinkSync(path: string) {
    using _ = slowLogging`fs.readlinkSync(${path})`
    return fs.readlinkSync(path)
  },

  realpathSync(path: string) {
    using _ = slowLogging`fs.realpathSync(${path})`
    return fs.realpathSync(path).normalize('NFC')
  },

  mkdirSync(dirPath, options) {
    using _ = slowLogging`fs.mkdirSync(${dirPath})`
    const mkdirOptions: { recursive: boolean; mode?: number } = {
      recursive: true,
    }
    if (options?.mode !== undefined) {
      mkdirOptions.mode = options.mode
    }
    try {
      fs.mkdirSync(dirPath, mkdirOptions)
    } catch (e) {
      // Bun/Windows: recursive:true throws EEXIST on directories with the
      // FILE_ATTRIBUTE_READONLY bit set (Group Policy, OneDrive, desktop.ini).
      // Bun's directoryExistsAt misclassifies DIRECTORY+READONLY as not-a-dir
      // (bun-internal src/sys.zig existsAtType). The dir exists; ignore.
      // https://github.com/anthropics/claude-code/issues/30924
      if (getErrnoCode(e) !== 'EEXIST') throw e
    }
  },

  readdirSync(dirPath) {
    using _ = slowLogging`fs.readdirSync(${dirPath})`
    return fs.readdirSync(dirPath, { withFileTypes: true })
  },

  readdirStringSync(dirPath) {
    using _ = slowLogging`fs.readdirStringSync(${dirPath})`
    return fs.readdirSync(dirPath)
  },

  isDirEmptySync(dirPath) {
    using _ = slowLogging`fs.isDirEmptySync(${dirPath})`
    const files = this.readdirSync(dirPath)
    return files.length === 0
  },

  rmdirSync(dirPath) {
    using _ = slowLogging`fs.rmdirSync(${dirPath})`
    fs.rmdirSync(dirPath)
  },

  rmSync(path, options) {
    using _ = slowLogging`fs.rmSync(${path})`
    fs.rmSync(path, options)
  },

  createWriteStream(path: string) {
    return fs.createWriteStream(path)
  },

  async readFileBytes(fsPath: string, maxBytes?: number) {
    return readSourceBytes(fsPath, { maxBytes })
  },
}

// The currently active filesystem implementation
let activeFs: FsOperations = NodeFsOperations

/**
 * Overrides the filesystem implementation. Note: This function does not
 * automatically update cwd.
 * @param implementation The filesystem implementation to use
 */
export function setFsImplementation(implementation: FsOperations): void {
  activeFs = implementation
}

/**
 * Gets the currently active filesystem implementation
 * @returns The currently active filesystem implementation
 */
export function getFsImplementation(): FsOperations {
  return activeFs
}

/**
 * Resets the filesystem implementation to the default Node.js implementation.
 * Note: This function does not automatically update cwd.
 */
export function setOriginalFsImplementation(): void {
  activeFs = NodeFsOperations
}

export type ReadFileRangeResult = {
  content: string
  bytesRead: number
  bytesTotal: number
}

/**
 * Read up to `maxBytes` from a file starting at `offset`.
 * Returns a flat string from Buffer — no sliced string references to a
 * larger parent. Returns null if the file is smaller than the offset.
 */
export async function readFileRange(
  path: string,
  offset: number,
  maxBytes: number,
): Promise<ReadFileRangeResult | null> {
  await using fh = await open(path, 'r')
  const size = (await fh.stat()).size
  if (size <= offset) {
    return null
  }
  const bytesToRead = Math.min(size - offset, maxBytes)
  const buffer = Buffer.allocUnsafe(bytesToRead)

  let totalRead = 0
  while (totalRead < bytesToRead) {
    const { bytesRead } = await fh.read(
      buffer,
      totalRead,
      bytesToRead - totalRead,
      offset + totalRead,
    )
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }

  return {
    content: buffer.toString('utf8', 0, totalRead),
    bytesRead: totalRead,
    bytesTotal: size,
  }
}

/**
 * Read the last `maxBytes` of a file.
 * Returns the whole file if it's smaller than maxBytes.
 */
export async function tailFile(
  path: string,
  maxBytes: number,
): Promise<ReadFileRangeResult> {
  await using fh = await open(path, 'r')
  const size = (await fh.stat()).size
  if (size === 0) {
    return { content: '', bytesRead: 0, bytesTotal: 0 }
  }
  const offset = Math.max(0, size - maxBytes)
  const bytesToRead = size - offset
  const buffer = Buffer.allocUnsafe(bytesToRead)

  let totalRead = 0
  while (totalRead < bytesToRead) {
    const { bytesRead } = await fh.read(
      buffer,
      totalRead,
      bytesToRead - totalRead,
      offset + totalRead,
    )
    if (bytesRead === 0) {
      break
    }
    totalRead += bytesRead
  }

  return {
    content: buffer.toString('utf8', 0, totalRead),
    bytesRead: totalRead,
    bytesTotal: size,
  }
}

/**
 * Async generator that yields lines from a file in reverse order.
 * Reads the file backwards in chunks to avoid loading the entire file into memory.
 * @param path - The path to the file to read
 * @returns An async generator that yields lines in reverse order
 */
export async function* readLinesReverse(
  path: string,
): AsyncGenerator<string, void, undefined> {
  const CHUNK_SIZE = 1024 * 4
  const fileHandle = await open(path, 'r')
  try {
    const stats = await fileHandle.stat()
    let position = stats.size
    // Carry raw bytes (not a decoded string) across chunk boundaries so that
    // multi-byte UTF-8 sequences split by the 4KB boundary are not corrupted.
    // Decoding per-chunk would turn a split sequence into U+FFFD on both sides,
    // which for history.jsonl means JSON.parse throws and the entry is dropped.
    let remainder = Buffer.alloc(0)
    const buffer = Buffer.alloc(CHUNK_SIZE)

    while (position > 0) {
      const currentChunkSize = Math.min(CHUNK_SIZE, position)
      position -= currentChunkSize

      await fileHandle.read(buffer, 0, currentChunkSize, position)
      const combined = Buffer.concat([
        buffer.subarray(0, currentChunkSize),
        remainder,
      ])

      const firstNewline = combined.indexOf(0x0a)
      if (firstNewline === -1) {
        remainder = combined
        continue
      }

      remainder = Buffer.from(combined.subarray(0, firstNewline))
      const lines = combined.toString('utf8', firstNewline + 1).split('\n')

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!
        if (line) {
          yield line
        }
      }
    }

    if (remainder.length > 0) {
      yield remainder.toString('utf8')
    }
  } finally {
    await fileHandle.close()
  }
}
