import { spawn } from 'node:child_process'
import os from 'node:os'
import type { PluginLogger } from 'openclaw/plugin-sdk'
import type { BrowserRelayExtensionConnection, BrowserRelayServer } from '../relay/server.js'
import {
  discoverInstalledBrowserRelayProfiles,
  isFailureThresholdReached,
  type InstalledBrowserRelayProfile,
} from './installed-profile-discovery.js'
import {
  readLaunchProfileState,
  writeLaunchProfileState,
  type LaunchProfileRecord,
  type LaunchProfileState,
} from './launch-profile-state.js'

const RELAY_CONNECT_TIMEOUT_MS = 15_000
const RELAY_CONNECT_POLL_MS = 200

export type InstalledProfileLaunchResult = {
  launched: boolean
  browserName?: string
  profileDirectory?: string
}

type InstalledProfileAutoLauncherOptions = {
  logger: PluginLogger
  relay: BrowserRelayServer
  stateDir?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function profileKey(profile: { userDataDir: string; profileDirectory: string }): string {
  return `${profile.userDataDir}::${profile.profileDirectory}`
}

function toRecord(profile: InstalledBrowserRelayProfile, now = Date.now()): LaunchProfileRecord {
  return {
    browserName: 'Chrome',
    userDataDir: profile.userDataDir,
    profileDirectory: profile.profileDirectory,
    extensionId: profile.extensionId,
    browserInstanceId: profile.browserInstanceId,
    lastSuccessAt: now,
    failureCount: 0,
  }
}

function mergeKnownGoodProfiles(
  profiles: LaunchProfileRecord[],
  record: LaunchProfileRecord,
): LaunchProfileRecord[] {
  const deduped = profiles.filter((entry) => profileKey(entry) !== profileKey(record))
  deduped.push(record)
  deduped.sort((left, right) => right.lastSuccessAt - left.lastSuccessAt)
  return deduped
}

export class InstalledProfileAutoLauncher {
  private pendingLaunch: Promise<InstalledProfileLaunchResult> | null = null
  private currentLaunchCandidate: InstalledBrowserRelayProfile | null = null
  private readonly unsubscribeExtensionConnected: () => void

  constructor(private readonly options: InstalledProfileAutoLauncherOptions) {
    this.unsubscribeExtensionConnected = options.relay.onExtensionConnected((connection) =>
      this.recordSuccessfulConnection(connection),
    )
  }

  stop(): void {
    this.unsubscribeExtensionConnected()
  }

  async ensureRelayBrowserAvailable(): Promise<InstalledProfileLaunchResult> {
    if (this.options.relay.hasExtensionConnection) {
      return { launched: false }
    }

    if (!this.pendingLaunch) {
      this.pendingLaunch = this.launchAndWait().finally(() => {
        this.currentLaunchCandidate = null
        this.pendingLaunch = null
      })
    }

    return await this.pendingLaunch
  }

  private async launchAndWait(): Promise<InstalledProfileLaunchResult> {
    if (this.options.relay.hasExtensionConnection) {
      return { launched: false }
    }

    const profiles = discoverInstalledBrowserRelayProfiles()
    const profile = await this.chooseLaunchCandidate(profiles)
    if (!profile) {
      throw new Error('No usable Chrome profile with MatchaClaw Browser Relay enabled was found.')
    }

    this.currentLaunchCandidate = profile
    await this.spawnBrowser(profile)

    try {
      await this.waitForRelayConnection(profile)
    } catch (error) {
      await this.recordFailedLaunch(profile)
      throw error
    }

    this.options.logger.info(
      `[browser-relay] auto-launched ${profile.browserName} profile "${profile.profileDirectory}" and relay reconnected`,
    )

    return {
      launched: true,
      browserName: profile.browserName,
      profileDirectory: profile.profileDirectory,
    }
  }

  private async chooseLaunchCandidate(
    profiles: InstalledBrowserRelayProfile[],
  ): Promise<InstalledBrowserRelayProfile | null> {
    if (!profiles.length) {
      return null
    }

    const state = await readLaunchProfileState(this.options.stateDir)
    const byKey = new Map(profiles.map((profile) => [profileKey(profile), profile]))

    const preferred = state.lastUsableProfile
    if (preferred && !isFailureThresholdReached(preferred.failureCount)) {
      const preferredProfile = byKey.get(profileKey(preferred))
      if (preferredProfile) {
        return preferredProfile
      }
    }

    const sortedKnownGood = [...state.knownGoodProfiles]
      .sort((left, right) => right.lastSuccessAt - left.lastSuccessAt)

    for (const record of sortedKnownGood) {
      if (isFailureThresholdReached(record.failureCount)) continue
      const candidate = byKey.get(profileKey(record))
      if (candidate) {
        return candidate
      }
    }

    return profiles[0] ?? null
  }

  private async spawnBrowser(profile: InstalledBrowserRelayProfile): Promise<void> {
    const args = [
      `--user-data-dir=${profile.userDataDir}`,
      `--profile-directory=${profile.profileDirectory}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]

    await new Promise<void>((resolve, reject) => {
      const child = spawn(profile.executablePath, args, {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          HOME: os.homedir(),
        },
      })

      child.once('error', reject)
      child.once('spawn', () => {
        child.unref()
        resolve()
      })
    })

    this.options.logger.info(
      `[browser-relay] auto-launching ${profile.browserName} profile "${profile.profileDirectory}"`,
    )
  }

  private async waitForRelayConnection(profile: InstalledBrowserRelayProfile): Promise<void> {
    const deadline = Date.now() + RELAY_CONNECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (this.options.relay.hasExtensionConnection) {
        return
      }
      await sleep(RELAY_CONNECT_POLL_MS)
    }

    throw new Error(
      `Launched ${profile.browserName} profile "${profile.profileDirectory}" but MatchaClaw Browser Relay did not reconnect.`,
    )
  }

  private async recordSuccessfulConnection(connection: BrowserRelayExtensionConnection): Promise<void> {
    const profile = this.resolveConnectedProfile(connection)
    if (!profile) {
      return
    }

    const now = Date.now()
    const record = toRecord(profile, now)
    const state = await readLaunchProfileState(this.options.stateDir)

    await writeLaunchProfileState(
      {
        lastUsableProfile: record,
        knownGoodProfiles: mergeKnownGoodProfiles(state.knownGoodProfiles, record),
      },
      this.options.stateDir,
    )
  }

  private resolveConnectedProfile(connection: BrowserRelayExtensionConnection): InstalledBrowserRelayProfile | null {
    if (this.currentLaunchCandidate?.browserInstanceId === connection.browserInstanceId) {
      return this.currentLaunchCandidate
    }

    const profiles = discoverInstalledBrowserRelayProfiles()
    return profiles.find((profile) => profile.browserInstanceId === connection.browserInstanceId) ?? null
  }

  private async recordFailedLaunch(profile: InstalledBrowserRelayProfile): Promise<void> {
    const state = await readLaunchProfileState(this.options.stateDir)
    const failedKey = profileKey(profile)
    const fallbackRecord = state.knownGoodProfiles.find((entry) => profileKey(entry) === failedKey)
      ?? (state.lastUsableProfile && profileKey(state.lastUsableProfile) === failedKey ? state.lastUsableProfile : null)

    if (!fallbackRecord) {
      return
    }

    const baseRecord = fallbackRecord
    const updatedRecord: LaunchProfileRecord = {
      ...baseRecord,
      lastFailureAt: Date.now(),
      failureCount: (baseRecord.failureCount ?? 0) + 1,
      lastSuccessAt: baseRecord.lastSuccessAt,
    }

    const nextState: LaunchProfileState = {
      lastUsableProfile:
        state.lastUsableProfile && profileKey(state.lastUsableProfile) === failedKey
          ? updatedRecord
          : state.lastUsableProfile,
      knownGoodProfiles: mergeKnownGoodProfiles(
        state.knownGoodProfiles.filter((entry) => profileKey(entry) !== failedKey),
        updatedRecord,
      ),
    }

    await writeLaunchProfileState(nextState, this.options.stateDir)
  }
}
