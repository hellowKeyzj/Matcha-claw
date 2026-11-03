import { randomUUID } from 'node:crypto'

export function relayOperationError(message: string, code: string, detail: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), {
    errorDetail: { code, message, outcome: 'unknown', retryable: false, ...detail },
  })
}

export type RelayDownload = {
  downloadId: number
  url: string
  mime?: string
  startTimeMs: number
  filePath?: string
  fileSizeBytes?: number
  state: 'created' | 'completed' | 'interrupted'
  error?: string
}

type DownloadWatch = {
  browserInstanceId: string
  watchId: string
  sinceTs: number
  expiresAtMs: number
  records: Map<number, RelayDownload>
  error?: Error
  terminal: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DOWNLOAD_WATCH_MAX_TTL_MS = 10 * 60 * 1000

export class RelayDownloadWatches {
  private readonly watches = new Map<string, DownloadWatch>()

  arm(browserInstanceId: string, timeoutMs: number): DownloadWatch {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > DOWNLOAD_WATCH_MAX_TTL_MS) {
      throw relayOperationError('Download watch timeout must be between 1 and 600000 milliseconds.', 'DOWNLOAD_INVALID_TIMEOUT', { outcome: 'not_started' })
    }
    if ([...this.watches.values()].some((watch) => watch.browserInstanceId === browserInstanceId)) {
      throw relayOperationError('Another download watch is already active in this browser; download attribution would be ambiguous.', 'DOWNLOAD_AMBIGUOUS', { outcome: 'not_started' })
    }
    const sinceTs = Date.now()
    let resolve!: () => void
    let reject!: (error: Error) => void
    const terminal = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    // The arm command or trigger can still be in flight when the watch expires.
    void terminal.catch(() => {})
    const watch: DownloadWatch = {
      browserInstanceId,
      watchId: `${browserInstanceId}:${randomUUID()}`,
      sinceTs,
      expiresAtMs: sinceTs + timeoutMs,
      records: new Map(),
      terminal,
      resolve,
      reject,
      timer: setTimeout(() => this.reject(watch, relayOperationError('Timed out waiting for browser download; completion is unknown. Do not repeat the trigger automatically.', 'DOWNLOAD_TIMEOUT')), timeoutMs),
    }
    this.watches.set(JSON.stringify([browserInstanceId, watch.watchId]), watch)
    return watch
  }

  receive(browserInstanceId: string, method: string, params: Record<string, unknown>): void {
    if (method !== 'Extension.downloadCreated' && method !== 'Extension.downloadCompleted' && method !== 'Extension.downloadInterrupted') return
    if (!Array.isArray(params.watchIds) || !Number.isSafeInteger(params.downloadId) || (params.downloadId as number) < 0 || typeof params.startTimeMs !== 'number' || !Number.isFinite(params.startTimeMs)) return
    const watchIds = [...new Set(params.watchIds.filter((id): id is string => typeof id === 'string'))]
    for (const watchId of watchIds) {
      const watch = this.watches.get(JSON.stringify([browserInstanceId, watchId]))
      if (!watch || watch.browserInstanceId !== browserInstanceId || watch.error) continue
      if (params.startTimeMs < watch.sinceTs || params.startTimeMs > watch.expiresAtMs) continue
      if (watchIds.length !== 1 || watch.records.size > 0 && !watch.records.has(params.downloadId as number)) {
        this.reject(watch, relayOperationError('Multiple downloads or watches matched the browser-wide time window; the originating tab cannot be determined.', 'DOWNLOAD_AMBIGUOUS'))
        continue
      }
      const downloadId = params.downloadId as number
      const previous = watch.records.get(downloadId)
      const state = method === 'Extension.downloadCompleted' ? 'completed' : method === 'Extension.downloadInterrupted' ? 'interrupted' : 'created'
      // Reconnect resync and delayed created events must not regress a terminal record.
      if (previous && previous.state !== 'created' && state !== previous.state) continue
      watch.records.set(downloadId, {
        downloadId,
        url: typeof params.url === 'string' ? params.url : previous?.url ?? '',
        mime: typeof params.mime === 'string' ? params.mime : previous?.mime,
        startTimeMs: params.startTimeMs,
        state,
        filePath: typeof params.filePath === 'string' ? params.filePath : previous?.filePath,
        fileSizeBytes: typeof params.fileSizeBytes === 'number' && Number.isFinite(params.fileSizeBytes) && params.fileSizeBytes >= 0 ? params.fileSizeBytes : previous?.fileSizeBytes,
        error: typeof params.error === 'string' ? params.error : previous?.error,
      })
      if (state === 'interrupted') {
        this.reject(watch, relayOperationError(`Browser download interrupted: ${typeof params.error === 'string' ? params.error : 'unknown'}`, 'DOWNLOAD_INTERRUPTED', { outcome: 'failed' }))
      } else if (state === 'completed') {
        watch.resolve()
      }
    }
  }

  result(watch: DownloadWatch): RelayDownload {
    if (watch.error) throw watch.error
    const [record] = watch.records.values()
    if (watch.records.size !== 1 || record?.state !== 'completed') {
      throw relayOperationError('Browser download completion could not be determined.', 'DOWNLOAD_UNKNOWN')
    }
    return record
  }

  reject(watch: DownloadWatch, error: Error): void {
    watch.error ??= error
    watch.reject(watch.error)
  }

  disarm(watch: DownloadWatch): void {
    clearTimeout(watch.timer)
    this.watches.delete(JSON.stringify([watch.browserInstanceId, watch.watchId]))
  }

  stop(): void {
    for (const watch of this.watches.values()) {
      this.reject(watch, relayOperationError('Relay stopping; browser download completion is unknown.', 'DOWNLOAD_STOPPED'))
      this.disarm(watch)
    }
  }
}
