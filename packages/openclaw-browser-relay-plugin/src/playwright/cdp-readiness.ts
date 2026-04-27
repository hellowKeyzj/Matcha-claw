import WebSocket from 'ws'

type BrowserCdpReadinessInput = {
  cdpUrl: string
  headers?: Record<string, string>
  httpTimeoutMs?: number
  readyTimeoutMs?: number
  label: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isWebSocketUrl(url: string): boolean {
  return url.startsWith('ws://') || url.startsWith('wss://')
}

function appendVersionPath(cdpUrl: string): string {
  return `${cdpUrl.replace(/\/$/, '')}/json/version`
}

async function readVersionPayload(
  cdpUrl: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(appendVersionPath(cdpUrl), {
      signal: controller.signal,
      ...(headers && Object.keys(headers).length ? { headers } : {}),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function resolveWebSocketDebuggerUrl(
  cdpUrl: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<string | null> {
  if (isWebSocketUrl(cdpUrl)) {
    return cdpUrl
  }

  try {
    const versionPayload = await readVersionPayload(cdpUrl, headers, timeoutMs)
    return typeof versionPayload?.webSocketDebuggerUrl === 'string'
      ? versionPayload.webSocketDebuggerUrl
      : null
  } catch {
    return null
  }
}

async function canRunBrowserGetVersion(
  wsUrl: string,
  headers: Record<string, string> | undefined,
  timeoutMs: number,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(wsUrl, {
      handshakeTimeout: timeoutMs,
      ...(headers && Object.keys(headers).length ? { headers } : {}),
    })

    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        ws.close()
      } catch {
        // noop
      }
      resolve(value)
    }

    const timer = setTimeout(() => {
      try {
        ws.terminate()
      } catch {
        // noop
      }
      finish(false)
    }, Math.max(50, timeoutMs + 25))

    ws.once('open', () => {
      try {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Browser.getVersion',
        }))
      } catch {
        finish(false)
      }
    })

    ws.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString())
        if (payload?.id === 1 && payload?.result) {
          finish(true)
        }
      } catch {
        finish(false)
      }
    })

    ws.once('error', () => finish(false))
    ws.once('close', () => finish(false))
  })
}

export async function isBrowserHttpReachable(
  cdpUrl: string,
  headers?: Record<string, string>,
  timeoutMs = 1_200,
): Promise<boolean> {
  if (isWebSocketUrl(cdpUrl)) {
    return true
  }

  try {
    await readVersionPayload(cdpUrl, headers, timeoutMs)
    return true
  } catch {
    return false
  }
}

export async function isBrowserCdpReachable(
  cdpUrl: string,
  headers?: Record<string, string>,
  timeoutMs = 1_200,
): Promise<boolean> {
  const wsUrl = await resolveWebSocketDebuggerUrl(cdpUrl, headers, timeoutMs)
  if (!wsUrl) {
    return false
  }

  return await canRunBrowserGetVersion(wsUrl, headers, timeoutMs)
}

export async function waitForBrowserCdpReady(input: BrowserCdpReadinessInput): Promise<void> {
  const httpTimeoutMs = Math.max(200, Math.floor(input.httpTimeoutMs ?? 1_200))
  const readyTimeoutMs = Math.max(500, Math.floor(input.readyTimeoutMs ?? 3_000))

  if (!await isBrowserHttpReachable(input.cdpUrl, input.headers, httpTimeoutMs)) {
    throw new Error(`${input.label} HTTP endpoint is not reachable.`)
  }

  const deadline = Date.now() + readyTimeoutMs
  while (Date.now() < deadline) {
    const remainingMs = Math.max(100, Math.min(httpTimeoutMs, deadline - Date.now()))
    if (await isBrowserCdpReachable(input.cdpUrl, input.headers, remainingMs)) {
      return
    }
    await sleep(100)
  }

  throw new Error(`${input.label} CDP endpoint is not reachable.`)
}
