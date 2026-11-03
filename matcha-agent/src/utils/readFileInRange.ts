// ---------------------------------------------------------------------------
// readFileInRange — line-oriented file reader with two code paths
// ---------------------------------------------------------------------------
//
// Returns lines [offset, offset + maxLines) from a file.
//
// Fast path (regular files < 10 MB):
//   Opens the file, stats the fd, reads the whole file with readFile(),
//   then splits lines in memory.  This avoids the per-chunk async overhead
//   of createReadStream and is ~2x faster for typical source files.
//
// Streaming path (large files, pipes, devices, etc.):
//   Uses createReadStream with manual indexOf('\n') scanning.  Content is
//   only accumulated for lines inside the requested range — lines outside
//   the range are counted (for totalLines) but discarded, so reading line
//   1 of a 100 GB file won't balloon RSS.
//
//   All event handlers (streamOnOpen/Data/End) are module-level named
//   functions with zero closures.  State lives in a StreamState object;
//   handlers access it via `this`, bound at registration time.
//
//   Lifecycle: `open`, `end`, and `error` use .once() (auto-remove).
//   `data` fires until the stream ends or is destroyed — either way the
//   stream and state become unreachable together and are GC'd.
//
//   On error (including maxBytes exceeded), stream.destroy(err) emits
//   'error' → reject (passed directly to .once('error')).
//
// Both paths strip UTF-8 BOM and \r (CRLF → LF).
//
// mtime comes from fstat/stat on the already-open fd — no extra open().
//
// maxBytes behavior depends on options.truncateOnByteLimit:
//   false (default): legacy semantics — throws FileTooLargeError if the FILE
//     size (fast path) or total streamed bytes (streaming) exceed maxBytes.
//   true: caps SELECTED OUTPUT at maxBytes.  Stops at the last complete line
//     that fits; sets truncatedByBytes in the result.  Never throws.
// ---------------------------------------------------------------------------

import {
  constants,
  createReadStream,
  fstat,
  type BigIntStats,
  type Stats,
} from 'fs'
import { open, stat as fsStat, readFile } from 'fs/promises'
import { formatFileSize } from './format.js'
import {
  InvestigationAdmissionError,
  admitInvestigationIo,
  currentInvestigationScope,
  investigationDigest,
  investigationRemaining,
  investigationSignal,
  investigationUsage,
  observeInvestigationIo,
  requireInvestigationEffects,
  trackInvestigationOperation,
  type InvestigationPermit,
} from '../world/investigation.js'

const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024 // 10 MB

export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  totalBytes: number
  readBytes: number
  mtimeMs: number
  /** true when output was clipped to maxBytes under truncate mode */
  truncatedByBytes?: boolean
}

export class FileTooLargeError extends Error {
  constructor(
    public sizeInBytes: number,
    public maxSizeBytes: number,
  ) {
    super(
      `File content (${formatFileSize(sizeInBytes)}) exceeds maximum allowed size (${formatFileSize(maxSizeBytes)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
    this.name = 'FileTooLargeError'
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function readFileInRange(
  filePath: string,
  offset = 0,
  maxLines?: number,
  maxBytes?: number,
  signal?: AbortSignal,
  options?: { truncateOnByteLimit?: boolean },
): Promise<ReadFileRangeResult> {
  signal?.throwIfAborted()
  if (currentInvestigationScope()) {
    return trackInvestigationOperation(
      readInvestigationFile(
        filePath,
        offset,
        maxLines,
        maxBytes,
        signal,
        options?.truncateOnByteLimit ?? false,
      ),
    )
  }
  const truncateOnByteLimit = options?.truncateOnByteLimit ?? false

  // stat to decide the code path and guard against OOM.
  // For regular files under 10 MB: readFile + in-memory split (fast).
  // Everything else (large files, FIFOs, devices): streaming.
  const stats = await fsStat(filePath)

  if (stats.isDirectory()) {
    throw new Error(
      `EISDIR: illegal operation on a directory, read '${filePath}'`,
    )
  }

  if (stats.isFile() && stats.size < FAST_PATH_MAX_SIZE) {
    if (
      !truncateOnByteLimit &&
      maxBytes !== undefined &&
      stats.size > maxBytes
    ) {
      throw new FileTooLargeError(stats.size, maxBytes)
    }

    // For targeted reads of moderately large files, prefer streaming to
    // avoid loading the full file into memory when only a slice is needed.
    const isTargetedRead = offset > 0 || maxLines !== undefined
    if (isTargetedRead && stats.size > FAST_PATH_MAX_SIZE / 4) {
      return readFileInRangeStreaming(
        filePath,
        offset,
        maxLines,
        maxBytes,
        truncateOnByteLimit,
        signal,
      )
    }

    const text = await readFile(filePath, { encoding: 'utf8', signal })
    return readFileInRangeFast(
      text,
      stats.mtimeMs,
      offset,
      maxLines,
      truncateOnByteLimit ? maxBytes : undefined,
    )
  }

  return readFileInRangeStreaming(
    filePath,
    offset,
    maxLines,
    maxBytes,
    truncateOnByteLimit,
    signal,
  )
}

export function sourceCleanupFailure(
  primary: unknown,
  related: unknown,
): unknown {
  if (primary === undefined) return related
  if (primary instanceof Error) {
    Object.defineProperty(primary, 'cause', {
      configurable: true,
      value: new AggregateError(
        [...(primary.cause === undefined ? [] : [primary.cause]), related],
        'Source cleanup failed',
      ),
    })
    return primary
  }
  return new AggregateError(
    [primary, related],
    'Source operation and cleanup failed',
  )
}

// fs_stat_v1 encodes the actual public numeric fields as decimal strings.
// Native stat fields are at most 64-bit (nanosecond timestamps at most 128-bit);
// 4096 bytes also bounds the number-valued Stats representation and JSON keys.
export const SOURCE_STAT_MAX_BYTES = 4096
export function sourceStatBytes(stats: Stats | BigIntStats): number {
  return Buffer.byteLength(
    JSON.stringify({
      type: 'fs_stat_v1',
      dev: String(stats.dev),
      ino: String(stats.ino),
      mode: String(stats.mode),
      nlink: String(stats.nlink),
      uid: String(stats.uid),
      gid: String(stats.gid),
      rdev: String(stats.rdev),
      size: String(stats.size),
      blksize: String(stats.blksize),
      blocks: String(stats.blocks),
      atimeMs: String(stats.atimeMs),
      mtimeMs: String(stats.mtimeMs),
      ctimeMs: String(stats.ctimeMs),
      birthtimeMs: String(stats.birthtimeMs),
      ...('atimeNs' in stats
        ? {
            atimeNs: String(stats.atimeNs),
            mtimeNs: String(stats.mtimeNs),
            ctimeNs: String(stats.ctimeNs),
            birthtimeNs: String(stats.birthtimeNs),
          }
        : {}),
    }),
    'utf8',
  )
}

export async function readSourceBytes(
  filePath: string,
  options?: { maxBytes?: number; signal?: AbortSignal },
): Promise<Buffer> {
  options?.signal?.throwIfAborted()
  if (currentInvestigationScope()) {
    return trackInvestigationOperation(
      readBoundedSource(filePath, options?.maxBytes, options?.signal),
    ).then(result => result.buffer)
  }
  if (options?.maxBytes === undefined)
    return readFile(filePath, { signal: options?.signal })
  const file = await open(filePath, 'r')
  try {
    const { size } = await file.stat()
    const buffer = Buffer.allocUnsafe(Math.min(size, options.maxBytes))
    let bytes = 0
    while (bytes < buffer.length) {
      options.signal?.throwIfAborted()
      const read = await file.read(buffer, bytes, buffer.length - bytes, bytes)
      if (read.bytesRead === 0) break
      bytes += read.bytesRead
    }
    return buffer.subarray(0, bytes)
  } finally {
    await file.close()
  }
}

async function readInvestigationFile(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  signal: AbortSignal | undefined,
  truncate: boolean,
): Promise<ReadFileRangeResult> {
  const { buffer, mtimeMs } = await readBoundedSource(
    filePath,
    undefined,
    signal,
    !truncate ? maxBytes : undefined,
  )
  return readFileInRangeFast(
    buffer.toString('utf8'),
    mtimeMs,
    offset,
    maxLines,
    truncate ? maxBytes : undefined,
  )
}

async function readBoundedSource(
  filePath: string,
  prefixBytes: number | undefined,
  signal: AbortSignal | undefined,
  maxFileBytes?: number,
): Promise<{ buffer: Buffer; mtimeMs: number }> {
  requireInvestigationEffects(['source_read'])
  const scope = currentInvestigationScope()!
  const metadataCap = SOURCE_STAT_MAX_BYTES * 2
  const permit = await admitInvestigationIo({
    kind: 'source',
    preparedRequestDigest: investigationDigest({
      filePath,
      prefixBytes,
      maxFileBytes,
      part: 'metadata',
    }),
    reservation: investigationUsage({
      sourceReads: '1',
      rows: '2',
      bytes: String(metadataCap),
    }),
    proof: {
      producer: 'bounded_regular_file',
      operation: 'file_read',
      effect: 'source_read',
      byteCap: String(metadataCap),
      rowCap: '2',
      record: 'fs_stat_v1',
      statRecordMaxBytes: String(SOURCE_STAT_MAX_BYTES),
    },
  })
  let dataPermit: InvestigationPermit | undefined
  let attempted = false
  let bytes = 0
  let metadataBytes = 0
  let metadataRows = 0n
  let rows = 0n
  let atLineStart = true
  let file: Awaited<ReturnType<typeof open>> | undefined
  let failure: unknown
  const checkLive = () => {
    signal?.throwIfAborted()
    investigationSignal()?.throwIfAborted()
    if (Date.now() >= scope.deadlineMs)
      throw new InvestigationAdmissionError('investigation_deadline_exceeded')
  }
  try {
    checkLive()
    attempted = true
    file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK)
    checkLive()
    const before = await file.stat()
    metadataBytes += sourceStatBytes(before)
    metadataRows++
    checkLive()
    if (before.isDirectory())
      throw Object.assign(
        new Error(
          `EISDIR: illegal operation on a directory, read '${filePath}'`,
        ),
        { code: 'EISDIR' },
      )
    if (!before.isFile())
      throw new InvestigationAdmissionError(
        'investigation_source_requires_regular_file',
      )
    const size =
      prefixBytes === undefined
        ? before.size
        : Math.min(before.size, prefixBytes)
    const remaining = investigationRemaining()!
    if (
      BigInt(size) > BigInt(remaining.bytes) ||
      (maxFileBytes !== undefined && before.size > maxFileBytes)
    ) {
      throw new InvestigationAdmissionError('investigation_source_byte_limit')
    }
    const rowCap =
      BigInt(size) < BigInt(remaining.rows)
        ? BigInt(size)
        : BigInt(remaining.rows)
    dataPermit = await admitInvestigationIo({
      kind: 'source',
      preparedRequestDigest: investigationDigest({
        filePath,
        size,
        prefixBytes,
        part: 'content',
      }),
      reservation: investigationUsage({
        rows: rowCap.toString(),
        bytes: String(size),
      }),
      proof: {
        producer: 'bounded_regular_file',
        operation: 'file_read',
        effect: 'source_read',
        byteCap: String(size),
        rowCap: rowCap.toString(),
        record: 'file_lf_rows_v1',
      },
    })
    const chunks: Buffer[] = []
    const buffer = Buffer.allocUnsafe(4096)
    while (bytes < size) {
      checkLive()
      const length = Math.min(buffer.length, size - bytes)
      // At most one new LF-delimited row per input byte. Reserve before read;
      // never shrink a native read to one byte to work around a row limit.
      if (BigInt(length) > rowCap - rows)
        throw new InvestigationAdmissionError('investigation_source_row_limit')
      const read = await file.read(buffer, 0, length, bytes)
      if (read.bytesRead === 0)
        throw new InvestigationAdmissionError('investigation_source_changed')
      for (let index = 0; index < read.bytesRead; index++) {
        if (atLineStart) rows++
        atLineStart = buffer[index] === 10
      }
      bytes += read.bytesRead
      chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)))
    }
    checkLive()
    const after = await file.stat()
    metadataBytes += sourceStatBytes(after)
    metadataRows++
    checkLive()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new InvestigationAdmissionError('investigation_source_changed')
    }
    return { buffer: Buffer.concat(chunks, bytes), mtimeMs: after.mtimeMs }
  } catch (error) {
    failure = error
    throw error
  } finally {
    let closed = false
    try {
      await file?.close()
      closed = true
    } catch (error) {
      failure = sourceCleanupFailure(failure, error)
    }
    const reason =
      failure === undefined
        ? {}
        : {
            reason:
              failure instanceof Error
                ? failure.message
                : 'investigation_source_unknown',
          }
    const status = closed ? 'complete' : 'unknown'
    try {
      await observeInvestigationIo(dataPermit, {
        status,
        usage: investigationUsage({
          rows: rows.toString(),
          bytes: String(bytes),
        }),
        rawUsage: { bytesRead: String(bytes), rowsScanned: rows.toString() },
        ...reason,
      })
    } catch (error) {
      failure = sourceCleanupFailure(failure, error)
    }
    try {
      await observeInvestigationIo(permit, {
        status,
        usage: investigationUsage({
          sourceReads: attempted ? '1' : '0',
          rows: metadataRows.toString(),
          bytes: String(metadataBytes),
        }),
        rawUsage: { metadataBytes: String(metadataBytes) },
        ...reason,
      })
    } catch (error) {
      failure = sourceCleanupFailure(failure, error)
    }
    if (failure !== undefined) throw failure
  }
}

// ---------------------------------------------------------------------------
// Fast path — readFile + in-memory split
// ---------------------------------------------------------------------------

function readFileInRangeFast(
  raw: string,
  mtimeMs: number,
  offset: number,
  maxLines: number | undefined,
  truncateAtBytes: number | undefined,
): ReadFileRangeResult {
  const endLine = maxLines !== undefined ? offset + maxLines : Infinity

  // Strip BOM.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

  // Split lines, strip \r, select range.
  const selectedLines: string[] = []
  let lineIndex = 0
  let startPos = 0
  let newlinePos: number
  let selectedBytes = 0
  let truncatedByBytes = false

  function tryPush(line: string): boolean {
    if (truncateAtBytes !== undefined) {
      const sep = selectedLines.length > 0 ? 1 : 0
      const nextBytes = selectedBytes + sep + Buffer.byteLength(line)
      if (nextBytes > truncateAtBytes) {
        truncatedByBytes = true
        return false
      }
      selectedBytes = nextBytes
    }
    selectedLines.push(line)
    return true
  }

  while ((newlinePos = text.indexOf('\n', startPos)) !== -1) {
    if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
      let line = text.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      tryPush(line)
    }
    lineIndex++
    startPos = newlinePos + 1
  }

  // Final fragment (no trailing newline).
  if (lineIndex >= offset && lineIndex < endLine && !truncatedByBytes) {
    let line = text.slice(startPos)
    if (line.endsWith('\r')) {
      line = line.slice(0, -1)
    }
    tryPush(line)
  }
  lineIndex++

  const content = selectedLines.join('\n')
  return {
    content,
    lineCount: selectedLines.length,
    totalLines: lineIndex,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    readBytes: Buffer.byteLength(content, 'utf8'),
    mtimeMs,
    ...(truncatedByBytes ? { truncatedByBytes: true } : {}),
  }
}

// ---------------------------------------------------------------------------
// Streaming path — createReadStream + event handlers
// ---------------------------------------------------------------------------

type StreamState = {
  stream: ReturnType<typeof createReadStream>
  offset: number
  endLine: number
  maxBytes: number | undefined
  truncateOnByteLimit: boolean
  resolve: (value: ReadFileRangeResult) => void
  totalBytesRead: number
  selectedBytes: number
  truncatedByBytes: boolean
  currentLineIndex: number
  selectedLines: string[]
  partial: string
  isFirstChunk: boolean
  resolveMtime: (ms: number) => void
  mtimeReady: Promise<number>
}

function streamOnOpen(this: StreamState, fd: number): void {
  fstat(fd, (err, stats) => {
    this.resolveMtime(err ? 0 : stats.mtimeMs)
  })
}

function streamOnData(this: StreamState, chunk: string): void {
  if (this.isFirstChunk) {
    this.isFirstChunk = false
    if (chunk.charCodeAt(0) === 0xfeff) {
      chunk = chunk.slice(1)
    }
  }

  this.totalBytesRead += Buffer.byteLength(chunk)
  if (
    !this.truncateOnByteLimit &&
    this.maxBytes !== undefined &&
    this.totalBytesRead > this.maxBytes
  ) {
    this.stream.destroy(
      new FileTooLargeError(this.totalBytesRead, this.maxBytes),
    )
    return
  }

  const data = this.partial.length > 0 ? this.partial + chunk : chunk
  this.partial = ''

  let startPos = 0
  let newlinePos: number
  while ((newlinePos = data.indexOf('\n', startPos)) !== -1) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      let line = data.slice(startPos, newlinePos)
      if (line.endsWith('\r')) {
        line = line.slice(0, -1)
      }
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
        if (nextBytes > this.maxBytes) {
          // Cap hit — collapse the selection range so nothing more is
          // accumulated.  Stream continues (to count totalLines).
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
        } else {
          this.selectedBytes = nextBytes
          this.selectedLines.push(line)
        }
      } else {
        this.selectedLines.push(line)
      }
    }
    this.currentLineIndex++
    startPos = newlinePos + 1
  }

  // Only keep the trailing fragment when inside the selected range.
  // Outside the range we just count newlines — discarding prevents
  // unbounded memory growth on huge single-line files.
  if (startPos < data.length) {
    if (
      this.currentLineIndex >= this.offset &&
      this.currentLineIndex < this.endLine
    ) {
      const fragment = data.slice(startPos)
      // In truncate mode, `partial` can grow unboundedly if the selected
      // range contains a huge single line (no newline across many chunks).
      // Once the fragment alone would overflow the remaining budget, we know
      // the completed line can never fit — set truncated, collapse the
      // selection range, and discard the fragment to stop accumulation.
      if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
        const sep = this.selectedLines.length > 0 ? 1 : 0
        const fragBytes = this.selectedBytes + sep + Buffer.byteLength(fragment)
        if (fragBytes > this.maxBytes) {
          this.truncatedByBytes = true
          this.endLine = this.currentLineIndex
          return
        }
      }
      this.partial = fragment
    }
  }
}

function streamOnEnd(this: StreamState): void {
  let line = this.partial
  if (line.endsWith('\r')) {
    line = line.slice(0, -1)
  }
  if (
    this.currentLineIndex >= this.offset &&
    this.currentLineIndex < this.endLine
  ) {
    if (this.truncateOnByteLimit && this.maxBytes !== undefined) {
      const sep = this.selectedLines.length > 0 ? 1 : 0
      const nextBytes = this.selectedBytes + sep + Buffer.byteLength(line)
      if (nextBytes > this.maxBytes) {
        this.truncatedByBytes = true
      } else {
        this.selectedLines.push(line)
      }
    } else {
      this.selectedLines.push(line)
    }
  }
  this.currentLineIndex++

  const content = this.selectedLines.join('\n')
  const truncated = this.truncatedByBytes
  this.mtimeReady.then(mtimeMs => {
    this.resolve({
      content,
      lineCount: this.selectedLines.length,
      totalLines: this.currentLineIndex,
      totalBytes: this.totalBytesRead,
      readBytes: Buffer.byteLength(content, 'utf8'),
      mtimeMs,
      ...(truncated ? { truncatedByBytes: true } : {}),
    })
  })
}

function readFileInRangeStreaming(
  filePath: string,
  offset: number,
  maxLines: number | undefined,
  maxBytes: number | undefined,
  truncateOnByteLimit: boolean,
  signal?: AbortSignal,
): Promise<ReadFileRangeResult> {
  return new Promise((resolve, reject) => {
    const state: StreamState = {
      stream: createReadStream(filePath, {
        encoding: 'utf8',
        highWaterMark: 512 * 1024,
        ...(signal ? { signal } : undefined),
      }),
      offset,
      endLine: maxLines !== undefined ? offset + maxLines : Infinity,
      maxBytes,
      truncateOnByteLimit,
      resolve,
      totalBytesRead: 0,
      selectedBytes: 0,
      truncatedByBytes: false,
      currentLineIndex: 0,
      selectedLines: [],
      partial: '',
      isFirstChunk: true,
      resolveMtime: () => {},
      mtimeReady: null as unknown as Promise<number>,
    }
    state.mtimeReady = new Promise<number>(r => {
      state.resolveMtime = r
    })

    state.stream.once('open', streamOnOpen.bind(state))
    state.stream.on('data', streamOnData.bind(state))
    state.stream.once('end', streamOnEnd.bind(state))
    state.stream.once('error', reject)
  })
}
