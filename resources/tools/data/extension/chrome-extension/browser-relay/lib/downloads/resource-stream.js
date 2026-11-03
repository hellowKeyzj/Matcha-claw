// Browser-authorized explicit GET downloads only, not a generic read/web_fetch
// helper. Binary data stays inside encrypted Relay, never in model history.
const MAX_BYTES = 256 * 1024 * 1024
const MAX_RESOURCES = 4
const CHUNK_BYTES = 49152
const IDLE_MS = 30000
const MAX_LIFETIME_MS = 300000
const resourceError = (code) => new Error(`DOWNLOAD_RESOURCE_${code}`)

function suggestedFilename(header) {
  if (!header || header.length > 8192) return undefined
  const extended = /(?:^|;)\s*filename\*\s*=\s*UTF-8'[^']*'([^;]*)/i.exec(header)
  let name
  if (extended) {
    try {
      name = decodeURIComponent(extended[1].trim())
    } catch {
      /* Try the ASCII fallback. */
    }
  }
  if (!name) {
    const plain = /(?:^|;)\s*filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/i.exec(header)
    name = plain?.[1]?.replace(/\\(.)/g, '$1') ?? plain?.[2]?.trim()
  }
  // This remains untrusted metadata: the Host chooses a safe single filename.
  return name && name.length <= 1024 && !/[\x00-\x1f\x7f]/.test(name) ? name : undefined
}

export function createDownloadResourceStore({
  fetchFn = (...args) => fetch(...args),
  onTabRemoved = globalThis.chrome?.tabs?.onRemoved,
} = {}) {
  const resources = new Map()
  let listening = false
  const onRemoved = (tabId) => {
    for (const resource of resources.values()) {
      if (resource.tabId === tabId) dispose(resource)
    }
  }

  function dispose(resource, abort = true) {
    if (resources.get(resource.id) !== resource) return
    resources.delete(resource.id)
    clearTimeout(resource.timer)
    resource.owner.removeEventListener('abort', resource.onDisconnect)
    if (abort) {
      resource.controller.abort()
      void resource.reader?.cancel().catch(() => {})
    } else resource.reader?.releaseLock()
    resource.remainder = null
    if (!resources.size && listening) {
      onTabRemoved.removeListener(onRemoved)
      listening = false
    }
  }

  function renew(resource) {
    clearTimeout(resource.timer)
    resource.timer = setTimeout(
      () => dispose(resource),
      Math.max(0, Math.min(IDLE_MS, resource.deadlineAt - Date.now())),
    )
  }

  function validateContext(context) {
    if (
      !context?.transportSignal ||
      context.transportSignal.aborted ||
      typeof context.targetId !== 'string' ||
      !context.targetId ||
      !Number.isInteger(context.tabId)
    ) {
      throw resourceError('INVALID_CONTEXT')
    }
  }

  function lookup(params, context, canceling = false) {
    validateContext(context)
    const resource = resources.get(params?.resourceId)
    if (
      resource &&
      (resource.owner !== context.transportSignal ||
        resource.targetId !== context.targetId ||
        (!canceling && resource.tabId !== context.tabId))
    ) {
      throw resourceError('OWNERSHIP_MISMATCH')
    }
    return resource
  }

  async function run(resource, context, action) {
    let timer
    let onAbort
    try {
      const remainingMs =
        Math.min(resource.deadlineAt, context.deadlineAt ?? resource.deadlineAt) - Date.now()
      if (remainingMs <= 0 || resource.controller.signal.aborted) throw resourceError('ABORTED')
      return await Promise.race([
        action(),
        new Promise((_, reject) => {
          onAbort = () => reject(resourceError('ABORTED'))
          resource.controller.signal.addEventListener('abort', onAbort, { once: true })
          if (resource.controller.signal.aborted) onAbort()
          timer = setTimeout(() => dispose(resource), remainingMs)
        }),
      ])
    } catch (error) {
      const aborted = resource.controller.signal.aborted
      dispose(resource)
      // Do not forward fetch exceptions containing signed URLs or credentials.
      if (error instanceof Error && /^DOWNLOAD_RESOURCE_[A-Z_0-9]+$/.test(error.message))
        throw error
      throw resourceError(aborted ? 'ABORTED' : 'FETCH_FAILED')
    } finally {
      clearTimeout(timer)
      if (onAbort) resource.controller.signal.removeEventListener('abort', onAbort)
    }
  }

  async function open(params, context) {
    validateContext(context)
    let url
    try {
      url = new URL(params?.url)
    } catch {
      throw resourceError('INVALID_URL')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw resourceError('INVALID_URL')
    }
    const id = params?.resourceId
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ||
      resources.has(id)
    ) {
      throw resourceError('INVALID_ID')
    }
    if (
      !Number.isSafeInteger(params.maxBytes) ||
      params.maxBytes <= 0 ||
      params.maxBytes > MAX_BYTES ||
      !Number.isFinite(params.deadlineAt) ||
      params.deadlineAt <= Date.now()
    ) {
      throw resourceError('INVALID_LIMIT')
    }
    if (resources.size >= MAX_RESOURCES) throw resourceError('TOO_MANY_RESOURCES')
    const resource = {
      id,
      owner: context.transportSignal,
      targetId: context.targetId,
      tabId: context.tabId,
      controller: new AbortController(),
      reader: null,
      received: 0,
      remainder: null,
      pending: false,
      maxBytes: params.maxBytes,
      deadlineAt: Math.min(params.deadlineAt, Date.now() + MAX_LIFETIME_MS),
    }
    resource.onDisconnect = () => dispose(resource)
    resources.set(id, resource)
    resource.owner.addEventListener('abort', resource.onDisconnect, { once: true })
    if (!listening && onTabRemoved) {
      onTabRemoved.addListener(onRemoved)
      listening = true
    }
    renew(resource)
    return run(resource, context, async () => {
      const response = await fetchFn(url.href, {
        credentials: 'include',
        // Preserve ordinary browser download redirects. Let Fetch apply browser
        // credential rules; do not replay requests or inject sensitive headers.
        redirect: 'follow',
        cache: 'no-store',
        signal: resource.controller.signal,
      })
      if (resource.controller.signal.aborted) throw resourceError('ABORTED')
      if (!response.ok) throw resourceError(`HTTP_${response.status}`)
      let finalUrl
      try {
        finalUrl = new URL(response.url || url.href)
      } catch {
        throw resourceError('INVALID_URL')
      }
      if (
        !['http:', 'https:'].includes(finalUrl.protocol) ||
        finalUrl.username ||
        finalUrl.password
      ) {
        throw resourceError('INVALID_URL')
      }
      const rawLength = response.headers.get('content-length')
      const length = rawLength !== null && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined
      if (length !== undefined && (!Number.isSafeInteger(length) || length > resource.maxBytes)) {
        throw resourceError('SIZE_LIMIT')
      }
      if (!response.body) throw resourceError('BODY_MISSING')
      resource.reader = response.body.getReader()
      renew(resource)
      const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
      const filename = suggestedFilename(response.headers.get('content-disposition'))
      return {
        status: response.status,
        url: finalUrl.href,
        contentType: response.headers.get('content-type') || '',
        ...(length === undefined || (encoding && encoding !== 'identity')
          ? {}
          : { contentLength: length }),
        ...(filename ? { suggestedFilename: filename } : {}),
      }
    })
  }

  async function read(params, context) {
    const resource = lookup(params, context)
    if (!resource?.reader) throw resourceError('HANDLE_EXPIRED')
    if (resource.pending) throw resourceError('READ_ALREADY_PENDING')
    resource.pending = true
    try {
      return await run(resource, context, async () => {
        let bytes = resource.remainder
        resource.remainder = null
        if (!bytes) {
          const chunk = await resource.reader.read()
          if (resource.controller.signal.aborted) throw resourceError('ABORTED')
          if (chunk.done) {
            dispose(resource, false)
            return { data: '', eof: true }
          }
          bytes = chunk.value
          resource.received += bytes.byteLength
          if (resource.received > resource.maxBytes) throw resourceError('SIZE_LIMIT')
        }
        const head = bytes.subarray(0, CHUNK_BYTES)
        if (bytes.byteLength > head.byteLength) resource.remainder = bytes.subarray(head.byteLength)
        let binary = ''
        for (let i = 0; i < head.length; i += 8192)
          binary += String.fromCharCode(...head.subarray(i, i + 8192))
        renew(resource)
        return { data: btoa(binary), eof: false }
      })
    } finally {
      resource.pending = false
    }
  }

  async function cancel(params, context) {
    const resource = lookup(params, context, true)
    if (resource) dispose(resource)
    return { canceled: Boolean(resource) }
  }

  return {
    open,
    read,
    cancel,
    get size() {
      return resources.size
    },
  }
}
