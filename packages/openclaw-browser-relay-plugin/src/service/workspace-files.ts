import path from 'node:path'
import { constants, type Stats } from 'node:fs'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { RelayDownload } from '../relay/downloads.js'

export function resolvePathWithinWorkspace(filePath: string | undefined, workspaceDir?: string): string | null {
  if (!filePath) return null
  const trimmed = filePath.trim()
  if (!trimmed) return null
  if (!workspaceDir) return path.resolve(trimmed)

  const resolvedWorkspace = path.resolve(workspaceDir)
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedWorkspace, trimmed)
  return candidate === resolvedWorkspace || candidate.startsWith(`${resolvedWorkspace}${path.sep}`)
    ? candidate
    : null
}

export async function writeWorkspaceFile(filePath: string, content: string | Uint8Array, workspaceDir: string | undefined, assertCurrent: () => void): Promise<void> {
  const realWorkspace = workspaceDir ? await fs.realpath(workspaceDir) : undefined
  let ancestor = path.dirname(filePath)
  while (true) {
    try {
      const realAncestor = await fs.realpath(ancestor)
      if (!resolvePathWithinWorkspace(realAncestor, realWorkspace)) throw new Error('savePath resolves outside the workspace')
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  assertCurrent()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const parent = await fs.realpath(path.dirname(filePath))
  if (!resolvePathWithinWorkspace(parent, realWorkspace)) throw new Error('savePath resolves outside the workspace')
  const destination = path.join(parent, path.basename(filePath))
  const temporary = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  try {
    assertCurrent()
    await fs.writeFile(temporary, content, { flag: 'wx' })
    assertCurrent()
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }) }
}

export type WorkspaceDownloadDestination = { directory: string; savePath?: string }

type WorkspaceDownloadReceipt = {
  savePath: string
  fileName: string
  suggestedFilename: string
  bytes: number
  sourceRemoved: boolean
  sourceCleanupError?: string
}

type OwnedDownloadFile = { filePath: string; stat: Stats }

const protectedDirectories = new Set(['.git', '.claude', '.ssh', '.aws', '.gnupg'])

function assertDownloadPath(root: string, target: string, allowRoot = false): void {
  const relative = path.relative(root, target)
  if ((!relative && !allowRoot) || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Download path must stay inside the trusted workspace')
  }
  if (relative.split(path.sep).some((segment) => protectedDirectories.has(segment.toLowerCase()))) {
    throw new Error('Downloads cannot access protected workspace directories')
  }
}

function safeDownloadFilename(value: string): string {
  let name = path.posix.basename(value.replace(/\\/gu, '/')).replace(/[\p{Cc}<>:"|?*]/gu, '_').replace(/[ .]+$/gu, '')
  if (!name || name === '.' || name === '..') name = 'download'
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name) || protectedDirectories.has(name.toLowerCase())) name = `_${name}`
  return name
}

export async function prepareWorkspaceDownload(request: { savePath?: string; dir?: string }, workspaceDir: string | undefined, assertCurrent: () => void): Promise<WorkspaceDownloadDestination> {
  assertCurrent()
  if (!workspaceDir?.trim()) throw new Error('A trusted workspace is required for download saving')
  if (request.savePath !== undefined && request.dir !== undefined) throw new Error('Download savePath and dir are mutually exclusive')
  const requested = request.savePath ?? request.dir ?? 'downloads'
  if (typeof requested !== 'string' || !requested.trim()) throw new Error('Download savePath or dir must be a non-empty path')
  const root = await fs.realpath(workspaceDir)
  assertCurrent()
  if (!(await fs.stat(root)).isDirectory()) throw new Error('The trusted workspace must be a directory')
  const requestedPath = requested.trim()
  const workspacePath = path.isAbsolute(requestedPath) ? resolvePathWithinWorkspace(requestedPath, workspaceDir) : null
  const resolved = path.resolve(root, workspacePath ? path.relative(path.resolve(workspaceDir), workspacePath) : requestedPath)
  assertDownloadPath(root, resolved, request.savePath === undefined)
  const filename = request.savePath === undefined ? undefined : path.basename(resolved)
  if (filename !== undefined && safeDownloadFilename(filename) !== filename) throw new Error('Download savePath must have a safe filename')
  let ancestor = filename === undefined ? resolved : path.dirname(resolved)
  const missing: string[] = []
  while (true) {
    assertCurrent()
    try { ancestor = await fs.realpath(ancestor); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      missing.unshift(path.basename(ancestor))
      const parent = path.dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
  assertDownloadPath(root, ancestor, true)
  if (!(await fs.stat(ancestor)).isDirectory()) throw new Error('Download destination ancestor must be a directory')
  const directory = path.join(ancestor, ...missing)
  assertDownloadPath(root, directory, true)
  assertCurrent()
  await fs.mkdir(directory, { recursive: true })
  assertCurrent()
  const realDirectory = await fs.realpath(directory)
  assertDownloadPath(root, realDirectory, true)
  if (!(await fs.stat(realDirectory)).isDirectory()) throw new Error('Download destination must be a directory')
  assertCurrent()
  return { directory: realDirectory, ...(filename === undefined ? {} : { savePath: path.join(realDirectory, filename) }) }
}

function sameDownloadFile(stat: Stats, expected: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && stat.dev === expected.dev && stat.ino === expected.ino
}

async function removeOwnedDownloadFile(file: OwnedDownloadFile | undefined, reservation = false): Promise<void> {
  if (!file) return
  try {
    if (await fs.realpath(path.dirname(file.filePath)) !== path.dirname(file.filePath)) return
    const current = await fs.lstat(file.filePath)
    if (!sameDownloadFile(current, file.stat)) return
    if (reservation && (current.size !== 0 || current.mtimeMs !== file.stat.mtimeMs || current.ctimeMs !== file.stat.ctimeMs)) return
    await fs.unlink(file.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function saveWorkspaceDownload(download: RelayDownload, sourceDirectory: string, destination: WorkspaceDownloadDestination, assertCurrent: () => void, onCommitSubmitted: (savePath: string) => void): Promise<WorkspaceDownloadReceipt> {
  assertCurrent()
  if (download.state !== 'completed' || typeof download.filePath !== 'string' || !path.isAbsolute(download.filePath)) throw new Error('A completed download with an absolute native file path is required')
  const bytes = download.fileSizeBytes
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) throw new Error('Completed download must include a finite non-negative byte count')
  const sourceRoot = await fs.realpath(sourceDirectory)
  assertCurrent()
  if (sourceRoot !== sourceDirectory) throw new Error('Authorized native download directory changed before saving')
  if (!(await fs.stat(sourceRoot)).isDirectory()) throw new Error('Native download source must be a directory')
  const reportedSource = path.resolve(download.filePath)
  if (/\.crdownload$/iu.test(reportedSource)) throw new Error('An incomplete Chrome download cannot be saved')
  const reportedStat = await fs.lstat(reportedSource)
  if (!reportedStat.isFile() || reportedStat.nlink !== 1) throw new Error('Native download must be a regular file without symbolic or hard links')
  const source = await fs.realpath(reportedSource)
  const relativeSource = path.relative(sourceRoot, source)
  if (!relativeSource || relativeSource === '..' || relativeSource.startsWith(`..${path.sep}`) || path.isAbsolute(relativeSource)) throw new Error('Native download file resolves outside the authorized download directory')
  if (/\.crdownload$/iu.test(source)) throw new Error('An incomplete Chrome download cannot be saved')
  assertCurrent()
  const sourceFile = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let reserved: OwnedDownloadFile | undefined
  let temporary: OwnedDownloadFile | undefined
  let saved: WorkspaceDownloadReceipt | undefined
  let saveOutcome: 'saved' | 'unknown' = 'saved'
  try {
    const sourceStat = await sourceFile.stat()
    if (!sameDownloadFile(sourceStat, reportedStat) || sourceStat.size !== bytes) throw new Error('Native download byte count or file identity does not match the completed receipt')
    const checkSource = async () => {
      assertCurrent()
      if (await fs.realpath(sourceRoot) !== sourceRoot || await fs.realpath(source) !== source) throw new Error('Native download source path changed before saving')
      const current = await fs.lstat(source)
      const opened = await sourceFile.stat()
      if (![current, opened].every((stat) => sameDownloadFile(stat, sourceStat) && stat.size === bytes && stat.mtimeMs === sourceStat.mtimeMs && stat.ctimeMs === sourceStat.ctimeMs)) throw new Error('Native download changed before saving')
      assertCurrent()
    }
    const checkDirectory = async () => {
      assertCurrent()
      if (!path.isAbsolute(destination.directory) || await fs.realpath(destination.directory) !== destination.directory || !(await fs.stat(destination.directory)).isDirectory()) throw new Error('Prepared workspace download directory changed before saving')
      assertCurrent()
    }
    await checkSource()
    await checkDirectory()
    const suggestedFilename = path.basename(source)
    const filename = destination.savePath === undefined ? safeDownloadFilename(suggestedFilename) : path.basename(destination.savePath)
    if (safeDownloadFilename(filename) !== filename || destination.savePath !== undefined && destination.savePath !== path.join(destination.directory, filename)) throw new Error('Download savePath must name a safe file in the prepared workspace directory')
    const parsed = path.parse(filename)
    for (let index = 0; ; index++) {
      assertCurrent()
      const candidate = path.join(destination.directory, index ? `${parsed.name}(${index})${parsed.ext}` : filename)
      // A download already in the destination is a name collision, never a source to truncate or delete.
      if (candidate === source) continue
      let reservation
      try { reservation = await fs.open(candidate, 'wx', 0o600) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
      try { reserved = { filePath: candidate, stat: await reservation.stat() } }
      finally { await reservation.close() }
      break
    }
    const checkReservation = async () => {
      await checkDirectory()
      const current = await fs.lstat(reserved!.filePath)
      if (!sameDownloadFile(current, reserved!.stat) || current.size !== 0 || current.mtimeMs !== reserved!.stat.mtimeMs || current.ctimeMs !== reserved!.stat.ctimeMs) throw new Error('Reserved download destination was changed by another writer')
      assertCurrent()
    }
    const receipt = (): WorkspaceDownloadReceipt => ({ savePath: reserved!.filePath, fileName: path.basename(reserved!.filePath), suggestedFilename, bytes, sourceRemoved: false })
    await checkSource()
    await checkReservation()
    try {
      onCommitSubmitted(reserved!.filePath)
      await fs.rename(source, reserved!.filePath)
      saved = { ...receipt(), sourceRemoved: true }
    } catch (error) {
      if (!['EXDEV', 'EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    if (!saved) {
      await checkSource()
      await checkReservation()
      const temporaryPath = path.join(destination.directory, `.download-${randomUUID()}.tmp`)
      const output = await fs.open(temporaryPath, 'wx', 0o600)
      try {
        temporary = { filePath: temporaryPath, stat: await output.stat() }
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let position = 0
        while (position < bytes) {
          assertCurrent()
          const read = await sourceFile.read(buffer, 0, Math.min(buffer.length, bytes - position), position)
          if (!read.bytesRead) throw new Error('Native download ended before the completed byte count')
          let written = 0
          while (written < read.bytesRead) {
            assertCurrent()
            const result = await output.write(buffer, written, read.bytesRead - written, position + written)
            if (!result.bytesWritten) throw new Error('Workspace download copy made no progress')
            written += result.bytesWritten
          }
          position += read.bytesRead
        }
        assertCurrent()
        await output.sync()
        const copied = await output.stat()
        if (!sameDownloadFile(copied, temporary.stat) || copied.size !== bytes) throw new Error('Workspace download copy does not match the completed byte count')
      } finally { await output.close() }
      await checkSource()
      await checkReservation()
      const copied = await fs.lstat(temporary!.filePath)
      if (!sameDownloadFile(copied, temporary!.stat) || copied.size !== bytes) throw new Error('Temporary workspace download was changed before commit')
      assertCurrent()
      await fs.rename(temporary!.filePath, reserved!.filePath)
      saved = receipt()
    }
    saveOutcome = 'unknown'
    const committed = await fs.lstat(saved.savePath)
    const expected = saved.sourceRemoved ? sourceStat : temporary!.stat
    if (!sameDownloadFile(committed, expected) || committed.size !== bytes || await fs.realpath(saved.savePath) !== saved.savePath) {
      throw new Error('Committed workspace download could not be verified; preserve the saved path and do not repeat the trigger')
    }
    saveOutcome = 'saved'
    assertCurrent()
    if (!saved.sourceRemoved) {
      try {
        await checkSource()
        await fs.unlink(source)
        saved.sourceRemoved = true
      } catch (error) {
        saved.sourceCleanupError = error instanceof Error ? error.message : String(error)
        assertCurrent()
      }
    }
    assertCurrent()
    return saved
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    throw Object.assign(failure, {
      partial: saved
        ? { ...saved, savedTo: saved.savePath, saveOutcome }
        : { ...(reserved ? { savePath: reserved.filePath } : {}), bytes: 0, saveOutcome: 'failed', sourceRemoved: false },
    })
  } finally {
    await sourceFile.close().catch(() => {})
    // Cleanup is identity-checked and never removes a committed destination or the native source.
    await removeOwnedDownloadFile(temporary).catch(() => {})
    if (!saved) await removeOwnedDownloadFile(reserved, true).catch(() => {})
  }
}
