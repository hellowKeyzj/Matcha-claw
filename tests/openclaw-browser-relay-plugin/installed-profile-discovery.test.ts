import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discoverInstalledBrowserRelayProfile,
  discoverInstalledBrowserRelayProfiles,
  isFailureThresholdReached,
} from '../../packages/openclaw-browser-relay-plugin/src/browser-launch/installed-profile-discovery'

const RELAY_NAME = 'MatchaClaw Browser Relay'
const RELAY_DESCRIPTION = 'Attach MatchaClaw to your existing Chrome tab via a local CDP relay server.'

const tempDirs: string[] = []

type ChromeFixture = {
  executablePath: string
  userDataDir: string
}

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'matchaclaw-browser-relay-test-'))
  tempDirs.push(dir)
  return dir
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8')
}

async function writeText(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, value, 'utf8')
}

async function createChromeFixture(): Promise<ChromeFixture> {
  const homeDir = await createTempDir()
  vi.spyOn(os, 'homedir').mockReturnValue(homeDir)

  if (process.platform === 'win32') {
    const localAppData = path.join(homeDir, 'AppData', 'Local')
    vi.stubEnv('LOCALAPPDATA', localAppData)

    const executablePath = path.win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
    const userDataDir = path.win32.join(localAppData, 'Google', 'Chrome', 'User Data')
    await writeText(executablePath, '')
    return { executablePath, userDataDir }
  }

  const executablePath = process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome'
  const userDataDir = process.platform === 'darwin'
    ? path.join(homeDir, 'Library/Application Support/Google/Chrome')
    : path.join(homeDir, '.config/google-chrome')

  const originalExistsSync = fsSync.existsSync.bind(fsSync)
  vi.spyOn(fsSync, 'existsSync').mockImplementation((targetPath: fsSync.PathLike) => {
    if (String(targetPath) === executablePath) {
      return true
    }
    return originalExistsSync(targetPath)
  })

  return { executablePath, userDataDir }
}

async function createProfile(
  fixture: ChromeFixture,
  profileDirectory: string,
  options: {
    securePreferences?: Record<string, unknown>
    preferences?: Record<string, unknown>
    extensionId?: string
    browserInstanceId?: string
    relayEnabled?: boolean
  } = {},
): Promise<void> {
  const profilePath = path.join(fixture.userDataDir, profileDirectory)
  const extensionId = options.extensionId ?? 'relayabc'

  await writeJson(path.join(fixture.userDataDir, 'Local State'), {
    profile: {
      last_used: profileDirectory,
      info_cache: {
        [profileDirectory]: {},
      },
    },
  })

  await writeJson(path.join(profilePath, 'Preferences'), options.preferences ?? {})

  if (options.securePreferences) {
    await writeJson(path.join(profilePath, 'Secure Preferences'), options.securePreferences)
  }

  if (options.browserInstanceId || options.relayEnabled !== undefined) {
    const parts: string[] = []
    if (options.browserInstanceId) {
      parts.push(`browserInstanceId&\"${options.browserInstanceId}\"`)
    }
    if (options.relayEnabled !== undefined) {
      parts.push(`relayEnabled:${options.relayEnabled ? 'true' : 'false'}`)
    }
    await writeText(
      path.join(profilePath, 'Local Extension Settings', extensionId, '000001.log'),
      parts.join('\n'),
    )
  }
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('discoverInstalledBrowserRelayProfiles', () => {
  it('finds a healthy unpacked Chrome profile from path and extension storage even without manifest', async () => {
    const fixture = await createChromeFixture()
    await createProfile(fixture, 'Default', {
      securePreferences: {
        extensions: {
          settings: {
            relayabc: {
              path: path.join('E:', 'code', 'Matcha-claw', 'resources', 'tools', 'data', 'extension', 'chrome-extension', 'accio-browser-relay'),
              location: 4,
            },
          },
        },
      },
      browserInstanceId: 'browser-default',
      relayEnabled: true,
    })

    const profiles = discoverInstalledBrowserRelayProfiles()

    expect(profiles).toEqual([
      expect.objectContaining({
        browserName: 'Chrome',
        executablePath: fixture.executablePath,
        userDataDir: fixture.userDataDir,
        profileDirectory: 'Default',
        extensionId: 'relayabc',
        browserInstanceId: 'browser-default',
        relayEnabled: true,
      }),
    ])
    expect(discoverInstalledBrowserRelayProfile()?.profileDirectory).toBe('Default')
  })

  it('falls back to manifest matching when path matching is unavailable', async () => {
    const fixture = await createChromeFixture()
    await createProfile(fixture, 'Profile 1', {
      preferences: {
        extensions: {
          settings: {
            relayxyz: {
              manifest: {
                name: RELAY_NAME,
                description: RELAY_DESCRIPTION,
              },
            },
          },
        },
      },
      extensionId: 'relayxyz',
      browserInstanceId: 'browser-profile-1',
      relayEnabled: true,
    })

    const profiles = discoverInstalledBrowserRelayProfiles()

    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.profileDirectory).toBe('Profile 1')
    expect(profiles[0]?.extensionId).toBe('relayxyz')
  })

  it('rejects profiles whose unpacked extension path does not point at our relay extension', async () => {
    const fixture = await createChromeFixture()
    await createProfile(fixture, 'Default', {
      securePreferences: {
        extensions: {
          settings: {
            relayabc: {
              path: path.join('E:', 'other', 'not-our-extension'),
              location: 4,
            },
          },
        },
      },
      browserInstanceId: 'browser-default',
      relayEnabled: true,
    })

    const profiles = discoverInstalledBrowserRelayProfiles()

    expect(profiles).toHaveLength(0)
  })

  it('filters out damaged or relay-disabled profiles and keeps the healthy one', async () => {
    const fixture = await createChromeFixture()

    await createProfile(fixture, 'Default', {
      securePreferences: {
        extensions: {
          settings: {
            badrelay: {
              path: path.join('E:', 'code', 'Matcha-claw', 'resources', 'tools', 'data', 'extension', 'chrome-extension', 'accio-browser-relay'),
              location: 4,
              disable_reasons: [1],
            },
          },
        },
      },
      extensionId: 'badrelay',
      browserInstanceId: 'browser-bad',
      relayEnabled: true,
    })

    await createProfile(fixture, 'Profile 1', {
      securePreferences: {
        extensions: {
          settings: {
            relayoff: {
              path: path.join('E:', 'code', 'Matcha-claw', 'resources', 'tools', 'data', 'extension', 'chrome-extension', 'accio-browser-relay'),
              location: 4,
            },
          },
        },
      },
      extensionId: 'relayoff',
      browserInstanceId: 'browser-off',
      relayEnabled: false,
    })

    await createProfile(fixture, 'Profile 2', {
      securePreferences: {
        extensions: {
          settings: {
            relayok: {
              path: path.join('E:', 'code', 'Matcha-claw', 'resources', 'tools', 'data', 'extension', 'chrome-extension', 'accio-browser-relay'),
              location: 4,
            },
          },
        },
      },
      extensionId: 'relayok',
      browserInstanceId: 'browser-ok',
      relayEnabled: true,
    })

    const profiles = discoverInstalledBrowserRelayProfiles()

    expect(profiles).toHaveLength(1)
    expect(profiles[0]?.profileDirectory).toBe('Profile 2')
    expect(profiles[0]?.browserInstanceId).toBe('browser-ok')
  })

  it('applies the failure threshold at two consecutive failures', () => {
    expect(isFailureThresholdReached(undefined)).toBe(false)
    expect(isFailureThresholdReached(1)).toBe(false)
    expect(isFailureThresholdReached(2)).toBe(true)
  })
})
