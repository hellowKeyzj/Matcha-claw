import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type InstalledBrowserRelayProfile = {
  browserName: 'Chrome'
  executablePath: string
  userDataDir: string
  profileDirectory: string
  profilePath: string
  extensionId: string
  browserInstanceId: string
  relayEnabled: boolean
}

type RelayExtensionStorageState = {
  browserInstanceId: string | null
  relayEnabled: boolean
}

type ExtensionSettingMatch = {
  extensionId: string
}

const RELAY_EXTENSION_NAME = 'MatchaClaw Browser Relay'
const RELAY_EXTENSION_DESCRIPTION = 'Attach MatchaClaw to your existing Chrome tab via a local CDP relay server.'
const CHROME_PROFILE_FAILURE_THRESHOLD = 2
const EXTENSION_LOCATION_UNPACKED = 4
const RELAY_EXTENSION_PATH_SEGMENTS = ['resources', 'tools', 'data', 'extension', 'chrome-extension', 'browser-relay']

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function matchesRelayExtension(value: Record<string, unknown>): boolean {
  const manifest = isRecord(value.manifest) ? value.manifest : null
  const manifestName = normalizeText(manifest?.name)
  const manifestDescription = normalizeText(manifest?.description)

  return manifestName === RELAY_EXTENSION_NAME
    || manifestDescription === RELAY_EXTENSION_DESCRIPTION
}

function splitPathSegments(input: string): string[] {
  return input
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
}

function normalizePathSegment(segment: string): string {
  return process.platform === 'win32' ? segment.toLowerCase() : segment
}

function matchesRelayExtensionPath(value: Record<string, unknown>): boolean {
  const rawPath = normalizeText(value.path)
  if (!rawPath) return false
  if (value.location !== EXTENSION_LOCATION_UNPACKED) return false

  const candidateSegments = splitPathSegments(rawPath).map(normalizePathSegment)
  const suffixSegments = RELAY_EXTENSION_PATH_SEGMENTS.map(normalizePathSegment)
  if (candidateSegments.length < suffixSegments.length) {
    return false
  }

  return suffixSegments.every((segment, index) =>
    candidateSegments[candidateSegments.length - suffixSegments.length + index] === segment,
  )
}

function normalizeDisableReasons(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (Array.isArray(value)) {
    return value.length
  }
  if (isRecord(value)) {
    return Object.keys(value).length
  }
  return 0
}

function hasExtensionFailureFlags(value: Record<string, unknown>): boolean {
  return value.blacklist === true
    || value.terminated === true
    || value.corrupt_install === true
    || normalizeDisableReasons(value.disable_reasons) > 0
}

function findHealthyRelayExtension(profilePath: string): ExtensionSettingMatch | null {
  for (const fileName of ['Secure Preferences', 'Preferences']) {
    const preferences = readJsonFile(path.join(profilePath, fileName))
    const extensions = isRecord(preferences?.extensions) ? preferences.extensions : null
    const settings = isRecord(extensions?.settings) ? extensions.settings : null
    if (!settings) continue

    for (const [extensionId, rawSetting] of Object.entries(settings)) {
      if (!isRecord(rawSetting)) continue
      if (hasExtensionFailureFlags(rawSetting)) continue
      if (!matchesRelayExtensionPath(rawSetting) && !matchesRelayExtension(rawSetting)) continue
      return { extensionId }
    }
  }

  return null
}

function readChromeProfileOrder(userDataDir: string): string[] {
  const discovered = new Set<string>()
  const localState = readJsonFile(path.join(userDataDir, 'Local State'))
  const profile = isRecord(localState?.profile) ? localState.profile : null
  const lastUsed = normalizeText(profile?.last_used)
  const infoCache = isRecord(profile?.info_cache) ? profile.info_cache : null

  if (lastUsed) {
    discovered.add(lastUsed)
  }

  if (infoCache) {
    for (const name of Object.keys(infoCache)) {
      if (name === 'Default' || /^Profile \d+$/.test(name)) {
        discovered.add(name)
      }
    }
  }

  discovered.add('Default')

  try {
    for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (entry.name !== 'Default' && !/^Profile \d+$/.test(entry.name)) continue
      discovered.add(entry.name)
    }
  } catch {
    return []
  }

  return [...discovered]
    .filter((profileDirectory) => fs.existsSync(path.join(userDataDir, profileDirectory, 'Preferences')))
    .sort((left, right) => {
      if (lastUsed) {
        if (left === lastUsed && right !== lastUsed) return -1
        if (right === lastUsed && left !== lastUsed) return 1
      }
      if (left === 'Default' && right !== 'Default') return -1
      if (right === 'Default' && left !== 'Default') return 1
      const leftMatch = left.match(/^Profile (\d+)$/)
      const rightMatch = right.match(/^Profile (\d+)$/)
      if (leftMatch && rightMatch) {
        return Number(leftMatch[1]) - Number(rightMatch[1])
      }
      return left.localeCompare(right)
    })
}

function extractQuotedValue(text: string, key: string): string | null {
  const keyIndex = text.indexOf(key)
  if (keyIndex < 0) return null
  const firstQuote = text.indexOf('"', keyIndex + key.length)
  if (firstQuote < 0) return null
  const secondQuote = text.indexOf('"', firstQuote + 1)
  if (secondQuote < 0) return null
  const value = text.slice(firstQuote + 1, secondQuote).trim()
  return value || null
}

function extractBooleanValue(text: string, key: string): boolean | null {
  const keyIndex = text.indexOf(key)
  if (keyIndex < 0) return null
  const snippet = text.slice(keyIndex, keyIndex + 64)
  if (snippet.includes('true')) return true
  if (snippet.includes('false')) return false
  return null
}

function readRelayExtensionStorage(profilePath: string, extensionId: string): RelayExtensionStorageState {
  const extensionStorageDir = path.join(profilePath, 'Local Extension Settings', extensionId)
  if (!fs.existsSync(extensionStorageDir)) {
    return { browserInstanceId: null, relayEnabled: false }
  }

  const files = fs.readdirSync(extensionStorageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.log') || entry.name.endsWith('.ldb')))
    .map((entry) => path.join(extensionStorageDir, entry.name))
    .sort((left, right) => {
      const leftStat = fs.statSync(left)
      const rightStat = fs.statSync(right)
      return rightStat.mtimeMs - leftStat.mtimeMs
    })

  let browserInstanceId: string | null = null
  let relayEnabled = false

  for (const filePath of files) {
    try {
      const text = fs.readFileSync(filePath).toString('utf8')
      browserInstanceId = browserInstanceId ?? extractQuotedValue(text, 'browserInstanceId')
      const enabledValue = extractBooleanValue(text, 'relayEnabled')
      if (enabledValue !== null) {
        relayEnabled = enabledValue
      }
      if (browserInstanceId && enabledValue !== null) {
        break
      }
    } catch {
      // noop
    }
  }

  return { browserInstanceId, relayEnabled }
}

function resolveChromeExecutablePath(homeDir = os.homedir(), env = process.env): string | null {
  const platform = process.platform

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local')
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const joinWin = path.win32.join
    const candidates = [
      joinWin(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      joinWin(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      joinWin(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ]
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
  }

  if (platform === 'darwin') {
    const candidate = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    return fs.existsSync(candidate) ? candidate : null
  }

  if (platform === 'linux') {
    const candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome-beta',
      '/usr/bin/google-chrome-unstable',
      '/snap/bin/google-chrome',
    ]
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
  }

  return null
}

function resolveChromeUserDataDir(homeDir = os.homedir(), env = process.env): string | null {
  const platform = process.platform

  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local')
    return path.win32.join(localAppData, 'Google', 'Chrome', 'User Data')
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library/Application Support/Google/Chrome')
  }
  if (platform === 'linux') {
    return path.join(homeDir, '.config/google-chrome')
  }
  return null
}

export function discoverInstalledBrowserRelayProfiles(): InstalledBrowserRelayProfile[] {
  const executablePath = resolveChromeExecutablePath()
  const userDataDir = resolveChromeUserDataDir()
  if (!executablePath || !userDataDir || !fs.existsSync(userDataDir)) {
    return []
  }

  const discovered: InstalledBrowserRelayProfile[] = []

  for (const profileDirectory of readChromeProfileOrder(userDataDir)) {
    const profilePath = path.join(userDataDir, profileDirectory)
    const extension = findHealthyRelayExtension(profilePath)
    if (!extension) continue

    const storage = readRelayExtensionStorage(profilePath, extension.extensionId)
    if (!storage.browserInstanceId || !storage.relayEnabled) continue

    discovered.push({
      browserName: 'Chrome',
      executablePath,
      userDataDir,
      profileDirectory,
      profilePath,
      extensionId: extension.extensionId,
      browserInstanceId: storage.browserInstanceId,
      relayEnabled: true,
    })
  }

  return discovered
}

export function discoverInstalledBrowserRelayProfile(): InstalledBrowserRelayProfile | null {
  return discoverInstalledBrowserRelayProfiles()[0] ?? null
}

export function isFailureThresholdReached(failureCount: number | undefined): boolean {
  return Number.isInteger(failureCount) && Number(failureCount) >= CHROME_PROFILE_FAILURE_THRESHOLD
}
