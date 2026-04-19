import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

export const DIRECT_CDP_MIN_CHROME_VERSION = 144
export const M144_PLACEHOLDER_TARGET_ID = '_m144_placeholder'

export type DiscoveredChromeInstance = {
  port: number
  browser: string
  version: string
  wsUrl: string | null
}

export type ResolvedCdpEndpoint = {
  httpUrl: string | null
  wsUrl: string | null
  port: number
  preferredUrl: string
}

export type DirectCdpTab = {
  targetId: string
  title: string
  url: string
  type?: string
  webSocketDebuggerUrl?: string
}

function getKnownUserDataDirs(): string[] {
  const homeDir = os.homedir()
  const platform = os.platform()

  if (platform === 'darwin') {
    return [
      path.join(homeDir, 'Library/Application Support/Google/Chrome'),
      path.join(homeDir, 'Library/Application Support/Google/Chrome Canary'),
      path.join(homeDir, 'Library/Application Support/Chromium'),
      path.join(homeDir, 'Library/Application Support/Microsoft Edge'),
      path.join(homeDir, 'Library/Application Support/BraveSoftware/Brave-Browser'),
      path.join(homeDir, 'Library/Application Support/Vivaldi'),
      path.join(homeDir, 'Library/Application Support/com.operasoftware.Opera'),
    ]
  }

  if (platform === 'linux') {
    return [
      path.join(homeDir, '.config/google-chrome'),
      path.join(homeDir, '.config/google-chrome-unstable'),
      path.join(homeDir, '.config/chromium'),
      path.join(homeDir, '.config/microsoft-edge'),
      path.join(homeDir, '.config/BraveSoftware/Brave-Browser'),
      path.join(homeDir, '.config/vivaldi'),
      path.join(homeDir, '.config/opera'),
    ]
  }

  if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local')
    return [
      path.join(localAppData, 'Google/Chrome/User Data'),
      path.join(localAppData, 'Google/Chrome SxS/User Data'),
      path.join(localAppData, 'Chromium/User Data'),
      path.join(localAppData, 'Microsoft/Edge/User Data'),
      path.join(localAppData, 'BraveSoftware/Brave-Browser/User Data'),
      path.join(localAppData, 'Vivaldi/User Data'),
      path.join(localAppData, 'Opera Software/Opera Stable'),
    ]
  }

  return []
}

function inferBrowserName(userDataDir: string): string {
  const lower = userDataDir.toLowerCase()
  if (lower.includes('edge')) return 'Edge'
  if (lower.includes('brave')) return 'Brave'
  if (lower.includes('vivaldi')) return 'Vivaldi'
  if (lower.includes('opera')) return 'Opera'
  if (lower.includes('chromium')) return 'Chromium'
  if (lower.includes('canary') || lower.includes('sxs') || lower.includes('unstable')) {
    return 'Chrome Canary'
  }
  return 'Chrome'
}

function readDevToolsActivePort(userDataDir: string): { port: number; wsPath: string } | null {
  const markerPath = path.join(userDataDir, 'DevToolsActivePort')
  if (!fs.existsSync(markerPath)) return null

  try {
    const lines = fs.readFileSync(markerPath, 'utf8').trim().split('\n')
    if (lines.length < 2) return null

    const port = Number.parseInt(lines[0].trim(), 10)
    const wsPath = lines[1].trim()
    if (!Number.isFinite(port) || port <= 0 || port > 65535 || !wsPath) {
      return null
    }

    return { port, wsPath }
  } catch {
    return null
  }
}

export async function isCdpPortReachable(port: number, timeoutMs = 2_000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })

    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)

    socket.on('error', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(false)
    })
  })
}

async function readJson(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function getDirectCdpVersion(port: number): Promise<any> {
  try {
    return await readJson(`http://127.0.0.1:${port}/json/version`, 2_000)
  } catch {
    const instances = await discoverChromeInstancesLight()
    const instance = instances.find((entry) => entry.port === port)
    if (!instance) {
      throw new Error(`No CDP version info available for port ${port}`)
    }
    return {
      browser: `${instance.browser} (M144+ remote debugging)`,
      protocolVersion: '1.3',
      webSocketDebuggerUrl: instance.wsUrl,
    }
  }
}

export async function listDirectCdpTabs(port: number): Promise<DirectCdpTab[]> {
  try {
    const tabs = await readJson(`http://127.0.0.1:${port}/json/list`, 2_000)
    return Array.isArray(tabs)
      ? tabs
        .filter((tab) => tab?.type === 'page')
        .map((tab) => ({
          targetId: String(tab.id ?? ''),
          url: String(tab.url ?? ''),
          title: String(tab.title ?? ''),
          type: String(tab.type ?? 'page'),
          webSocketDebuggerUrl: typeof tab.webSocketDebuggerUrl === 'string' ? tab.webSocketDebuggerUrl : undefined,
        }))
      : []
  } catch {
    return [{ targetId: M144_PLACEHOLDER_TARGET_ID, url: '', title: '', type: 'page' }]
  }
}

export async function discoverChromeInstancesLight(): Promise<DiscoveredChromeInstance[]> {
  const explicitDir = process.env.CDP_USER_DATA_DIR
  const candidates = explicitDir ? [explicitDir] : getKnownUserDataDirs()
  const discovered: DiscoveredChromeInstance[] = []

  for (const userDataDir of candidates) {
    const activePort = readDevToolsActivePort(userDataDir)
    if (!activePort) continue
    if (!(await isCdpPortReachable(activePort.port))) continue

    try {
      const versionPayload = await readJson(`http://127.0.0.1:${activePort.port}/json/version`, 2_000)
      const majorVersionMatch = String(versionPayload?.Browser ?? versionPayload?.browser ?? '').match(/\/(\d+)/)
      discovered.push({
        port: activePort.port,
        browser: inferBrowserName(userDataDir),
        version: majorVersionMatch?.[1] ?? 'unknown',
        wsUrl:
          typeof versionPayload?.webSocketDebuggerUrl === 'string'
            ? versionPayload.webSocketDebuggerUrl
            : `ws://127.0.0.1:${activePort.port}${activePort.wsPath.startsWith('/') ? activePort.wsPath : `/${activePort.wsPath}`}`,
      })
      continue
    } catch {
      discovered.push({
        port: activePort.port,
        browser: inferBrowserName(userDataDir),
        version: 'M144+',
        wsUrl: `ws://127.0.0.1:${activePort.port}${activePort.wsPath.startsWith('/') ? activePort.wsPath : `/${activePort.wsPath}`}`,
      })
    }
  }

  return discovered
}

export function resolveCdpEndpoint(input: { directCdpPort?: number | null; directCdpWsUrl?: string | null }): ResolvedCdpEndpoint | null {
  const port = input.directCdpPort ?? 0
  const httpUrl = port > 0 ? `http://127.0.0.1:${port}` : null
  const wsUrl = input.directCdpWsUrl ?? null
  const preferredUrl = wsUrl ?? httpUrl
  if (!preferredUrl) return null
  return { httpUrl, wsUrl, port, preferredUrl }
}
