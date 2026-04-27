import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const discoverInstalledBrowserRelayProfilesMock = vi.fn()
const isFailureThresholdReachedMock = vi.fn(() => false)
const readLaunchProfileStateMock = vi.fn(async () => ({
  lastUsableProfile: null,
  knownGoodProfiles: [],
}))
const writeLaunchProfileStateMock = vi.fn(async () => {})

vi.mock('node:child_process', () => ({
  default: {
    spawn: spawnMock,
  },
  spawn: spawnMock,
}))

vi.mock('node:os', () => ({
  default: {
    homedir: () => 'C:\\Users\\MatchaClaw',
  },
}))

vi.mock('../../packages/openclaw-browser-relay-plugin/src/browser-launch/installed-profile-discovery.js', () => ({
  discoverInstalledBrowserRelayProfiles: discoverInstalledBrowserRelayProfilesMock,
  isFailureThresholdReached: isFailureThresholdReachedMock,
}))

vi.mock('../../packages/openclaw-browser-relay-plugin/src/browser-launch/launch-profile-state.js', () => ({
  readLaunchProfileState: readLaunchProfileStateMock,
  writeLaunchProfileState: writeLaunchProfileStateMock,
}))

describe('installed profile auto launcher', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it('launches Chrome without forcing an about:blank bootstrap page', async () => {
    let connected = false
    let extensionConnectedListener:
      | ((connection: { browserInstanceId: string; browserName: string }) => void | Promise<void>)
      | null = null

    discoverInstalledBrowserRelayProfilesMock.mockReturnValue([
      {
        browserName: 'Chrome',
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        userDataDir: 'C:\\Users\\MatchaClaw\\AppData\\Local\\Google\\Chrome\\User Data',
        profileDirectory: 'Profile 1',
        profilePath: 'C:\\Users\\MatchaClaw\\AppData\\Local\\Google\\Chrome\\User Data\\Profile 1',
        extensionId: 'relay-extension-id',
        browserInstanceId: 'browser-a',
        relayEnabled: true,
      },
    ])

    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void }
      child.unref = vi.fn()
      queueMicrotask(() => {
        child.emit('spawn')
        connected = true
        void extensionConnectedListener?.({
          browserInstanceId: 'browser-a',
          browserName: 'Chrome',
        })
      })
      return child
    })

    const { InstalledProfileAutoLauncher } = await import(
      '../../packages/openclaw-browser-relay-plugin/src/browser-launch/installed-profile-auto-launcher'
    )

    const launcher = new InstalledProfileAutoLauncher({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as any,
      relay: {
        get hasExtensionConnection() {
          return connected
        },
        onExtensionConnected(listener: typeof extensionConnectedListener) {
          extensionConnectedListener = listener
          return () => {
            extensionConnectedListener = null
          }
        },
      } as any,
    })

    await expect(launcher.ensureRelayBrowserAvailable()).resolves.toMatchObject({
      launched: true,
      browserName: 'Chrome',
      profileDirectory: 'Profile 1',
    })

    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock).toHaveBeenCalledWith(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      [
        '--user-data-dir=C:\\Users\\MatchaClaw\\AppData\\Local\\Google\\Chrome\\User Data',
        '--profile-directory=Profile 1',
        '--no-first-run',
        '--no-default-browser-check',
      ],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }),
    )
    expect(spawnMock.mock.calls[0]?.[1]).not.toContain('about:blank')
  })
})
