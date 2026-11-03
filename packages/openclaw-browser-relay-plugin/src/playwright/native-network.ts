import { relayOperationError } from '../relay/downloads.js'
import { checkSnapshotFailure, type NativeTransport } from './native-snapshot.js'

const responseBodyLimit = 262144
const responseBodyBudget = 1048576
const captureMethods = [
  'Network.requestWillBeSent', 'Network.responseReceived', 'Network.dataReceived',
  'Network.requestWillBeSentExtraInfo', 'Network.responseReceivedExtraInfo',
  'Network.loadingFinished', 'Network.loadingFailed',
  'Page.frameAttached', 'Page.frameNavigated', 'Page.frameDetached', 'Inspector.targetCrashed',
]

type NetworkEntry = Record<string, unknown> & {
  id: string
  startedAt: number
  finishedAt?: number
  sessionId?: string
  requestId?: string
  request?: { method?: string; url?: string; headers?: Record<string, unknown>; postData?: string }
  response?: {
    status?: number; statusText?: string; protocol?: string; mimeType?: string
    headers?: Record<string, unknown>; timing?: Record<string, number>
  }
  type?: string
  resourceType?: string
  status?: number
  ok?: boolean
  failureText?: string
  decodedDataLength?: number
  encodedDataLength?: number
  body?: string
  base64Encoded?: boolean
  bodyError?: string
  bodyTruncated?: boolean
}

type NetworkOperation = { transport: NativeTransport; reserved: number; active: boolean }

export class NativeNetworkCapture {
  private readonly requests: NetworkEntry[] = []
  private readonly networkEntries = new Map<string, NetworkEntry>()
  private readonly frameParents = new Map<string, string | undefined>()
  private readonly bodyTasks = new Set<Promise<void>>()
  private readonly retainedBodies = new Map<NetworkEntry, number>()
  private retainedBodyBytes = 0
  private nextRequest = 0
  private readonly subscriptions: (() => void)[] = []
  private operation?: NetworkOperation
  private failure?: { error: unknown }
  private initialized = false
  private disposed = false

  constructor(private readonly transport: NativeTransport) {}

  initialize(): void {
    this.transport.assertCurrent()
    if (this.disposed) throw new Error('Native network capture is disposed')
    if (this.initialized) return
    for (const method of captureMethods) this.subscriptions.push(this.transport.onEvent(method, (params, sessionId) => this.receive(method, params, sessionId)))
    this.initialized = true
  }

  beginOperation(transport: NativeTransport): () => void {
    transport.assertCurrent()
    if (this.disposed) throw new Error('Native network capture is disposed')
    if (this.operation) this.operation.active = false
    const operation: NetworkOperation = { transport, reserved: 0, active: true }
    this.operation = operation
    return () => {
      operation.active = false
      if (this.operation === operation) this.operation = undefined
    }
  }

  async settle(): Promise<void> {
    while (this.bodyTasks.size) await Promise.allSettled([...this.bodyTasks])
    const failure = this.failure
    this.failure = undefined
    if (failure) throw failure.error
  }

  readRequests(filter?: string, last?: number): unknown[] {
    const keyword = filter?.toLowerCase()
    const requests = this.requests.slice(-500).filter((entry) => !keyword || String(entry.request?.url ?? '').toLowerCase().includes(keyword)).map((entry) => ({
      id: entry.id, timestamp: new Date(entry.startedAt).toISOString(),
      method: String(entry.request?.method ?? ''), url: String(entry.request?.url ?? ''),
      ...(typeof entry.type === 'string' ? { resourceType: entry.type } : {}),
      ...(typeof entry.status === 'number' ? { status: entry.status } : {}),
      ...(typeof entry.ok === 'boolean' ? { ok: entry.ok } : {}),
      ...(typeof entry.failureText === 'string' ? { failureText: entry.failureText } : {}),
    }))
    return typeof last === 'number' && Number.isFinite(last) && last > 0 && requests.length > last ? requests.slice(requests.length - Math.floor(last)) : requests
  }

  readHar(filter?: string, last?: number): { har: Record<string, unknown>; content: string; entries: number; bytes: number } {
    const keyword = filter?.toLowerCase()
    let requests = this.requests.filter((entry) => !keyword || String(entry.request?.url ?? '').toLowerCase().includes(keyword))
    if (typeof last === 'number' && Number.isFinite(last) && last > 0 && requests.length > last) requests = requests.slice(requests.length - Math.floor(last))
    const har = { log: { version: '1.2', creator: { name: 'Matcha', version: '1.0' }, entries: requests.filter((entry) => entry.request?.url).map(harEntry) } }
    const content = JSON.stringify(har, null, 2)
    return { har, content, entries: har.log.entries.length, bytes: content.length }
  }

  clear(): void {
    this.requests.length = 0
    this.networkEntries.clear()
    this.retainedBodies.clear()
    this.retainedBodyBytes = 0
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.operation) this.operation.active = false
    this.operation = undefined
    const failures: unknown[] = []
    for (const stop of this.subscriptions.splice(0)) {
      try { stop() } catch (error) { failures.push(error) }
    }
    try { await this.settle() } catch (error) { failures.push(error) }
    this.clear()
    this.frameParents.clear()
    if (failures.length > 1) throw new AggregateError(failures, 'Network capture cleanup failed', { cause: failures[0] })
    if (failures.length) throw failures[0]
  }

  private receive(method: string, params: Record<string, unknown>, sessionId?: string): void {
    if (this.disposed) return
    if (method === 'Inspector.targetCrashed') {
      this.networkEntries.clear()
      this.frameParents.clear()
      return
    }
    if (method === 'Page.frameAttached' && typeof params.frameId === 'string') this.frameParents.set(params.frameId, typeof params.parentFrameId === 'string' ? params.parentFrameId : undefined)
    if (method === 'Page.frameNavigated' || method === 'Page.frameDetached') {
      const frame = params.frame as { id?: string; parentId?: string; loaderId?: string } | undefined
      const frameId = method === 'Page.frameNavigated' ? frame?.id : params.frameId
      if (typeof frameId === 'string') {
        const branch = new Set([frameId])
        for (const id of branch) for (const [child, parent] of this.frameParents) if (parent === id) branch.add(child)
        for (const [key, entry] of this.networkEntries) {
          if (typeof entry.frameId === 'string' && branch.has(entry.frameId)
            && (method === 'Page.frameNavigated' ? entry.frameId !== frameId || entry.loaderId !== frame?.loaderId : entry.sessionId === sessionId)) this.networkEntries.delete(key)
        }
        if (method === 'Page.frameNavigated') {
          const parentId = frame?.parentId ?? this.frameParents.get(frameId)
          for (const id of branch) this.frameParents.delete(id)
          this.frameParents.set(frameId, parentId)
        } else if (params.reason !== 'swap') for (const id of branch) this.frameParents.delete(id)
      }
      return
    }
    if (typeof params.requestId !== 'string' || !params.requestId) return
    const requestId = params.requestId
    const key = `${sessionId ?? ''}\0${requestId}`
    if (method === 'Network.requestWillBeSent') {
      const previous = this.networkEntries.get(key)
      if (previous && params.redirectResponse) {
        previous.response = params.redirectResponse as NetworkEntry['response']
        previous.finishedAt = Date.now()
      }
      const entry: NetworkEntry = { ...params, id: `r${++this.nextRequest}`, ...(sessionId ? { sessionId } : {}), startedAt: Date.now() }
      this.networkEntries.set(key, entry)
      this.requests.push(entry)
      if (this.requests.length > 1000) {
        const previous = this.requests.shift()!
        const previousKey = `${previous.sessionId ?? ''}\0${previous.requestId}`
        if (this.networkEntries.get(previousKey) === previous) this.networkEntries.delete(previousKey)
        const bytes = this.retainedBodies.get(previous)
        if (bytes !== undefined) { this.retainedBodies.delete(previous); this.retainedBodyBytes -= bytes }
      }
    }
    const entry = this.networkEntries.get(key)
    if (!entry) return
    if (method === 'Network.responseReceived') {
      entry.response = params.response as NetworkEntry['response']
      if (typeof params.type === 'string') entry.resourceType = params.type
      const status = entry.response?.status
      if (typeof status === 'number') { entry.status = status; entry.ok = status < 400 }
    }
    if (method === 'Network.dataReceived') entry.decodedDataLength = Number(entry.decodedDataLength ?? 0) + Number(params.dataLength ?? 0)
    if (method === 'Network.requestWillBeSentExtraInfo') entry.requestExtraInfo = params
    if (method === 'Network.responseReceivedExtraInfo') entry.responseExtraInfo = params
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      entry.finishedAt = Date.now()
      entry.encodedDataLength = Number(params.encodedDataLength ?? 0)
      if (method === 'Network.loadingFailed') {
        entry.failure = params
        entry.ok = false
        if (typeof params.errorText === 'string') entry.failureText = params.errorText
      } else if (['XHR', 'Fetch', 'Script', 'Document'].includes(String(entry.resourceType))) {
        const operation = this.operation
        if (!operation?.active) { entry.bodyError = 'Response body was not captured outside a live browser operation'; return }
        try { operation.transport.assertCurrent() }
        catch (error) { this.failure ??= { error }; return }
        if (!this.failure) this.collectResponseBody(key, entry, requestId, sessionId, operation)
      }
    }
  }

  private collectResponseBody(key: string, entry: NetworkEntry, requestId: string, sessionId: string | undefined, operation: NetworkOperation): void {
    const omitted = (reason: string) => { entry.bodyError = reason; entry.bodyTruncated = true }
    if (Math.max(Number(entry.decodedDataLength ?? 0), Number(entry.encodedDataLength ?? 0)) > responseBodyLimit) { omitted('Response body exceeds the 262144-byte capture limit'); return }
    if (this.bodyTasks.size >= 2) { omitted('Response body capture concurrency limit reached'); return }
    if (operation.reserved + responseBodyLimit > responseBodyBudget) { omitted('Response body operation capture budget exhausted'); return }
    // Network.enable bounds the native buffer before reads; reserve its ceiling without queuing bodies.
    operation.reserved += responseBodyLimit
    const task = (async () => {
      try {
        const deadlineAt = Math.min(operation.transport.deadlineAt ?? Infinity, Date.now() + 5000)
        const body = await operation.transport.send<{ body: string; base64Encoded?: boolean }>('Network.getResponseBody', { requestId }, sessionId, { deadlineAt })
        operation.transport.assertCurrent()
        if (!operation.active) throw relayOperationError('Response body operation is no longer current', 'COMMAND_CANCELLED')
        if (this.networkEntries.get(key) !== entry) { omitted('Response body is no longer in the current network capture'); return }
        const bytes = Buffer.from(String(body.body ?? ''))
        let end = Math.min(bytes.length, responseBodyLimit)
        if (body.base64Encoded) end -= end % 4
        else if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--
        while (this.retainedBodyBytes + end > responseBodyBudget || this.retainedBodies.size >= 1000) {
          const [previous, size] = this.retainedBodies.entries().next().value!
          this.retainedBodies.delete(previous)
          this.retainedBodyBytes -= size
          delete previous.body
          delete previous.base64Encoded
          previous.bodyError = 'Response body evicted from the 1048576-byte retained capture budget'
          previous.bodyTruncated = true
        }
        entry.body = bytes.subarray(0, end).toString()
        entry.base64Encoded = body.base64Encoded ?? false
        entry.bodyTruncated = end < bytes.length
        this.retainedBodies.set(entry, end)
        this.retainedBodyBytes += end
      } catch (error) {
        checkSnapshotFailure(operation.transport, error)
        entry.bodyError = error instanceof Error ? error.message : String(error)
      }
    })()
    this.bodyTasks.add(task)
    const release = () => { this.bodyTasks.delete(task) }
    void task.then(release, (error) => { this.failure ??= { error }; release() })
  }
}

function harEntry(entry: NetworkEntry): Record<string, unknown> {
  const request = entry.request ?? {}, response = entry.response ?? {}
  const headers = (value: Record<string, unknown> = {}) => Object.entries(value).map(([name, item]) => ({ name, value: String(item) }))
  const timing = response.timing
  const elapsed = Math.max(0, Number(entry.finishedAt ?? entry.startedAt) - entry.startedAt)
  let queryString: { name: string; value: string }[] = []
  try { queryString = [...new URL(request.url!).searchParams].map(([name, value]) => ({ name, value })) } catch { /* Non-HTTP page resources have no URL query. */ }
  return {
    startedDateTime: new Date(entry.startedAt).toISOString(), time: elapsed,
    request: { method: request.method ?? 'GET', url: request.url ?? '', httpVersion: response.protocol ?? '', headers: headers(request.headers), queryString, cookies: [], headersSize: -1, bodySize: request.postData ? Buffer.byteLength(request.postData) : 0, ...(request.postData ? { postData: { mimeType: request.headers?.['Content-Type'] ?? '', text: request.postData } } : {}) },
    response: { status: response.status ?? 0, statusText: response.statusText ?? '', httpVersion: response.protocol ?? '', headers: headers(response.headers), cookies: [], redirectURL: response.headers?.location ?? '', headersSize: -1, bodySize: entry.encodedDataLength ?? -1, content: { size: entry.encodedDataLength ?? 0, mimeType: response.mimeType ?? '', ...(entry.body === undefined ? {} : { text: entry.body, ...(entry.base64Encoded ? { encoding: 'base64' } : {}) }), ...(entry.bodyError ? { _error: entry.bodyError } : {}), ...(entry.bodyTruncated ? { _truncated: true } : {}) } },
    cache: {}, timings: { blocked: -1, dns: timing && timing.dnsEnd >= 0 ? timing.dnsEnd - timing.dnsStart : -1, connect: timing && timing.connectEnd >= 0 ? timing.connectEnd - timing.connectStart : -1, ssl: timing && timing.sslEnd >= 0 ? timing.sslEnd - timing.sslStart : -1, send: timing && timing.sendEnd >= 0 ? timing.sendEnd - timing.sendStart : 0, wait: timing && timing.receiveHeadersEnd >= 0 ? timing.receiveHeadersEnd - timing.sendEnd : elapsed, receive: 0 },
    ...(entry.failure ? { _failure: entry.failure } : {}),
  }
}
