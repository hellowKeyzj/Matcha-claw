import axios, { type AxiosRequestConfig, type AxiosResponseHeaders, type RawAxiosResponseHeaders } from 'axios'
import { constants as bufferConstants } from 'node:buffer'
import * as http from 'node:http'
import { createHash } from 'node:crypto'
import * as https from 'node:https'
import type { Readable } from 'node:stream'
import { constants as fsConstants } from 'node:fs'
import { lstat, mkdir, open } from 'node:fs/promises'
import * as path from 'node:path'
import { getSessionId } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { SOURCE_STAT_MAX_BYTES, sourceStatBytes } from '../../utils/readFileInRange.js'
import {
  InvestigationAdmissionError, admitInvestigationIo, currentInvestigationScope,
  investigationDigest, investigationRemaining, investigationSignal, investigationUsage,
  observeInvestigationIo, requireInvestigationEffects, trackInvestigationOperation,
} from '../../world/investigation.js'

type FileRequest = {
  producer: 'matcha_files_api'
  operation: 'file_download' | 'file_list' | 'file_upload'
} | {
  producer: 'matcha_inbound_attachment'
  operation: 'attachment_download'
} | {
  producer: 'matcha_http_hook'
  operation: 'http_post'
} | {
  producer: 'matcha_sealed_skill'
  operation: 'catalog_read' | 'content_read'
}

type RequestOptions = FileRequest & {
  url: string
  method: 'GET' | 'POST'
  headers: Record<string, string>
  body?: Buffer
  timeoutMs: number
  signal?: AbortSignal
  axiosConfig?: AxiosRequestConfig
  records(body: Buffer, status: number): bigint
}

type FileResponse = {
  status: number
  headers: RawAxiosResponseHeaders | AxiosResponseHeaders
  data: Buffer
}

type StagedFile = {
  producer: 'matcha_files_api'
  operation: 'file_stage'
  sessionId: string
} | {
  producer: 'matcha_inbound_attachment'
  operation: 'attachment_stage'
}

export function stageInvestigationFile(options: StagedFile & { root: string; target: string; data: Buffer }): Promise<void> {
  return trackInvestigationOperation(stageFile(options))
}

async function stageFile(options: StagedFile & { root: string; target: string; data: Buffer }): Promise<void> {
  const sessionId = options.producer === 'matcha_files_api' ? options.sessionId : getSessionId()
  if (!sessionId || sessionId === '.' || sessionId === '..' || /[/\\\\:]/.test(sessionId)) {
    throw new InvestigationAdmissionError('investigation_staging_session_invalid')
  }
  const expectedRoot = options.producer === 'matcha_files_api'
    ? path.join(getCwd(), sessionId, 'uploads')
    : path.join(getClaudeConfigHomeDir(), 'uploads', sessionId)
  const root = path.resolve(options.root)
  const target = path.resolve(options.target)
  const relative = path.relative(root, target)
  if (root !== path.resolve(expectedRoot) || !relative || relative === '..'
    || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new InvestigationAdmissionError('investigation_staging_path_invalid')
  }
  const scope = currentInvestigationScope()
  if (!scope) throw new InvestigationAdmissionError('investigation_staging_scope_missing')
  checkFileInvestigation()
  requireInvestigationEffects(['source_read'])
  const remaining = investigationRemaining()!
  const metadataRecords = relative.split(path.sep).length + 4
  const byteReservation = BigInt(options.data.length) + BigInt(metadataRecords * SOURCE_STAT_MAX_BYTES)
  if (byteReservation > BigInt(remaining.bytes) || BigInt(metadataRecords) > BigInt(remaining.rows)) {
    throw new InvestigationAdmissionError('investigation_staging_metadata_limit')
  }
  const preparedRequestDigest = investigationDigest({ producer: options.producer, operation: options.operation,
    root, relative, contentDigest: `sha256:${createHash('sha256').update(options.data).digest('hex')}`,
    contentBytes: String(options.data.length) })
  const permit = await admitInvestigationIo({ kind: 'source', preparedRequestDigest,
    reservation: investigationUsage({ sourceReads: '1', rows: String(metadataRecords), bytes: byteReservation.toString() }),
    proof: { producer: options.producer, operation: options.operation, effect: 'source_read', requestDigest: preparedRequestDigest,
      root, relativeTarget: relative, contentBytes: String(options.data.length), metadataRecord: 'fs_stat_v1' },
  })
  let attempted = false
  let settled = false
  let metadataBytes = 0
  let rows = 0
  let written = 0
  let file: Awaited<ReturnType<typeof open>> | undefined
  const record = (stats: Parameters<typeof sourceStatBytes>[0]) => { metadataBytes += sourceStatBytes(stats); rows++ }
  try {
    checkFileInvestigation()
    attempted = true
    const base = options.producer === 'matcha_files_api' ? getCwd() : getClaudeConfigHomeDir()
    const baseStats = await lstat(base)
    record(baseStats)
    if (baseStats.isSymbolicLink() || !baseStats.isDirectory()) throw new InvestigationAdmissionError('investigation_staging_directory_invalid')
    const parent = path.dirname(target)
    // This checks concrete staging paths; it is not descriptor-relative ancestor isolation.
    let directory = path.resolve(base)
    for (const segment of path.relative(directory, parent).split(path.sep)) {
      directory = path.join(directory, segment)
      checkFileInvestigation()
      try { await mkdir(directory) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      checkFileInvestigation()
      const stats = await lstat(directory)
      record(stats)
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new InvestigationAdmissionError('investigation_staging_directory_invalid')
    }
    checkFileInvestigation()
    let existing: Awaited<ReturnType<typeof lstat>> | undefined
    try { existing = await lstat(target); record(existing) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
      throw new InvestigationAdmissionError('investigation_staging_target_invalid')
    }
    checkFileInvestigation()
    file = await open(target, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0)
      | (existing ? 0 : fsConstants.O_CREAT | fsConstants.O_EXCL), 0o600)
    checkFileInvestigation()
    const opened = await file.stat()
    record(opened)
    if (!opened.isFile() || opened.nlink !== 1 || (existing && (opened.ino !== existing.ino || opened.dev !== existing.dev))) {
      throw new InvestigationAdmissionError('investigation_staging_target_changed')
    }
    checkFileInvestigation()
    await file.truncate(0)
    while (written < options.data.length) {
      checkFileInvestigation()
      const result = await file.write(options.data, written, options.data.length - written, written)
      if (!result.bytesWritten) throw new InvestigationAdmissionError('investigation_staging_write_incomplete')
      written += result.bytesWritten
    }
    await file.close()
    file = undefined
    checkFileInvestigation()
    settled = true
    await observeInvestigationIo(permit, { status: 'complete',
      usage: investigationUsage({ sourceReads: '1', rows: String(rows), bytes: String(metadataBytes + written) }),
      rawUsage: { bytesWritten: String(written), metadataBytes: String(metadataBytes), metadataRecords: String(rows) },
    })
  } catch (error) {
    const related: unknown[] = []
    try { await file?.close() } catch (closeError) { related.push(closeError) } finally { file = undefined }
    if (!settled) {
      try { await observeInvestigationIo(permit, { status: attempted ? 'unknown' : 'not_sent',
        ...(!attempted && { usage: investigationUsage() }),
        rawUsage: { bytesWritten: String(written), metadataBytes: String(metadataBytes), metadataRecords: String(rows) },
        reason: error instanceof Error ? error.message : 'investigation_staging_unknown' })
      } catch (observeError) { related.push(observeError) }
    }
    throw fileFailure('investigation_staging_unknown', error, related)
  }
}

function fileFailure(reason: string, primary: unknown, related: unknown[] = []): InvestigationAdmissionError {
  const failure = new InvestigationAdmissionError(primary instanceof InvestigationAdmissionError ? primary.reason : reason)
  Object.defineProperty(failure, 'cause', { value: related.length ? new AggregateError([primary, ...related], reason) : primary })
  return failure
}

export function checkFileInvestigation(signal?: AbortSignal): void {
  const scope = currentInvestigationScope()
  if (!scope) return
  if (signal?.aborted || investigationSignal()?.aborted || Date.now() >= scope.deadlineMs) {
    throw new InvestigationAdmissionError('investigation_deadline_or_cancellation')
  }
}

/** One actual attempt; the original Run owns both admission and settlement. */
export function requestInvestigationFile(options: RequestOptions): Promise<FileResponse> {
  return trackInvestigationOperation(requestAttempt(options))
}

async function requestAttempt(options: RequestOptions): Promise<FileResponse> {
  const scope = currentInvestigationScope()
  if (!scope) {
    const response = await axios.request<Buffer>({ ...options.axiosConfig, url: options.url,
      method: options.method, headers: options.headers, data: options.body,
      timeout: options.timeoutMs, signal: options.signal, responseType: 'arraybuffer', validateStatus: () => true })
    return { status: response.status, headers: response.headers, data: Buffer.from(response.data) }
  }
  checkFileInvestigation(options.signal)
  const writing = options.operation === 'file_upload' || options.operation === 'http_post'
  if (options.method !== (writing ? 'POST' : 'GET')) {
    throw new InvestigationAdmissionError('investigation_file_operation_invalid')
  }
  requireInvestigationEffects(writing ? ['source_read', 'external_write'] : ['source_read'])
  const requestBytes = options.body?.length ?? 0
  const remaining = investigationRemaining()!
  const available = BigInt(remaining.bytes) - BigInt(requestBytes)
  if (available <= 0n) throw new InvestigationAdmissionError('investigation_file_byte_limit')
  const allocationLimit = BigInt(bufferConstants.MAX_LENGTH) < BigInt(Number.MAX_SAFE_INTEGER - requestBytes)
    ? BigInt(bufferConstants.MAX_LENGTH) : BigInt(Number.MAX_SAFE_INTEGER - requestBytes)
  const responseLimit = Number(available < allocationLimit ? available : allocationLimit)
  const rowLimit = BigInt(remaining.rows)
  const preparedRequestDigest = investigationDigest({ producer: options.producer, operation: options.operation,
    method: options.method, endpoint: options.url,
    bodyDigest: `sha256:${createHash('sha256').update(options.body ?? Buffer.alloc(0)).digest('hex')}`,
    contentType: options.headers['Content-Type'] ?? options.headers['content-type'],
    beta: options.headers['anthropic-beta'], version: options.headers['anthropic-version'] })
  const permit = await admitInvestigationIo({ kind: 'source', preparedRequestDigest,
    reservation: investigationUsage({ sourceReads: '1', rows: remaining.rows, bytes: String(requestBytes + responseLimit) }),
    proof: { producer: options.producer, operation: options.operation, effect: writing ? 'external_write' : 'source_read',
      requestDigest: preparedRequestDigest,
      endpoint: options.producer === 'matcha_sealed_skill' ? investigationDigest(options.url) : options.url,
      method: options.method,
      requestBytes: String(requestBytes), responseByteLimit: String(responseLimit), rowLimit: remaining.rows },
  })
  const abort = new AbortController()
  const signal = AbortSignal.any([abort.signal, investigationSignal()!, ...(options.signal ? [options.signal] : [])])
  const timeout = setTimeout(() => abort.abort(new InvestigationAdmissionError('investigation_file_timeout')),
    Math.max(1, Math.min(options.timeoutMs, scope.deadlineMs - Date.now())))
  timeout.unref()
  let request: http.ClientRequest | undefined
  let responseBody: Readable | undefined
  let requestFinished = false
  const closed: Promise<void>[] = []
  const join = (stream: http.ClientRequest | Readable) => {
    closed.push(stream.closed ? Promise.resolve() : new Promise<void>(resolve => stream.once('close', resolve)))
  }
  const transport = {
    request(requestOptions: http.RequestOptions, callback: (response: http.IncomingMessage) => void) {
      request = (requestOptions.protocol === 'https:' ? https : http).request(requestOptions, response => {
        join(response)
        callback(response)
      })
      join(request)
      request.once('finish', () => { requestFinished = true })
      return request
    },
  }
  let invoked = false
  let settled = false
  let responseBytes = 0
  const cancel = () => {
    responseBody?.destroy()
    request?.destroy()
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    checkFileInvestigation(signal)
    invoked = true
    const response = await axios.request<Readable>({ ...options.axiosConfig, url: options.url,
      method: options.method, headers: options.headers, data: options.body,
      signal, timeout: 0, maxRedirects: 0, responseType: 'stream', adapter: 'http', transport,
      maxBodyLength: requestBytes, maxContentLength: -1, transformRequest: [], transformResponse: [], validateStatus: () => true })
    responseBody = response.data
    join(responseBody)
    const chunks: Buffer[] = []
    for await (const value of responseBody) {
      checkFileInvestigation(signal)
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
      responseBytes += chunk.length
      if (responseBytes > responseLimit) throw new InvestigationAdmissionError('investigation_file_response_limit')
      chunks.push(chunk)
    }
    await Promise.all(closed)
    checkFileInvestigation(signal)
    const data = Buffer.concat(chunks, responseBytes)
    const rows = options.records(data, response.status)
    if (rows < 0n || rows > rowLimit) throw new InvestigationAdmissionError('investigation_file_row_limit')
    const complete = !writing || (requestFinished && response.status >= 200 && response.status < 300)
    settled = true
    await observeInvestigationIo(permit, { status: complete ? 'complete' : 'unknown',
      ...(complete && { usage: investigationUsage({ sourceReads: '1', rows: rows.toString(),
        bytes: String(requestBytes + responseBytes) }) }),
      rawUsage: { status: response.status, requestFinished, preparedRequestBytes: String(requestBytes),
        responseBytes: String(responseBytes), rows: rows.toString(), costBasis: 'unavailable' },
      ...(!complete && { reason: 'investigation_file_write_outcome_unknown' }),
    })
    if (!complete) throw new InvestigationAdmissionError('investigation_file_write_outcome_unknown')
    return { status: response.status, headers: response.headers, data }
  } catch (caught) {
    const error = options.producer === 'matcha_sealed_skill' && axios.isAxiosError(caught)
      ? Object.assign(new Error('investigation_sealed_skill_transport_unknown'), { name: caught.name, code: caught.code, stage: 'http_attempt' })
      : caught
    const cancelled = signal.aborted
    abort.abort(error)
    responseBody?.destroy()
    request?.destroy()
    await Promise.all(closed)
    const related: unknown[] = []
    if (!settled) {
      try { await observeInvestigationIo(permit, { status: invoked ? 'unknown' : 'not_sent',
        ...(!invoked && { usage: investigationUsage() }),
        rawUsage: { preparedRequestBytes: String(requestBytes), requestFinished, responseBytes: String(responseBytes) },
        reason: error instanceof Error ? error.message : invoked ? 'investigation_file_may_have_sent' : 'investigation_file_not_sent' })
      } catch (observeError) { related.push(observeError) }
    }
    if (writing || cancelled || related.length || error instanceof InvestigationAdmissionError) {
      throw fileFailure('investigation_file_transport_unknown', error, related)
    }
    throw error
  } finally {
    signal.removeEventListener('abort', cancel)
    clearTimeout(timeout)
  }
}
