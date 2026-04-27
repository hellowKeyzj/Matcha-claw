import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveRelayPluginStatePath } from '../relay/paths.js'

const LAUNCH_PROFILE_STATE_FILE = 'launch-profile-state.json'

export type LaunchProfileRecord = {
  browserName: 'Chrome'
  userDataDir: string
  profileDirectory: string
  extensionId: string
  browserInstanceId: string
  lastSuccessAt: number
  lastFailureAt?: number
  failureCount?: number
}

export type LaunchProfileState = {
  lastUsableProfile: LaunchProfileRecord | null
  knownGoodProfiles: LaunchProfileRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeLaunchProfileRecord(value: unknown): LaunchProfileRecord | null {
  if (!isRecord(value)) return null
  if (value.browserName !== 'Chrome') return null
  if (typeof value.userDataDir !== 'string' || !value.userDataDir.trim()) return null
  if (typeof value.profileDirectory !== 'string' || !value.profileDirectory.trim()) return null
  if (typeof value.extensionId !== 'string' || !value.extensionId.trim()) return null
  if (typeof value.browserInstanceId !== 'string' || !value.browserInstanceId.trim()) return null
  if (!Number.isFinite(value.lastSuccessAt)) return null

  const record: LaunchProfileRecord = {
    browserName: 'Chrome',
    userDataDir: value.userDataDir.trim(),
    profileDirectory: value.profileDirectory.trim(),
    extensionId: value.extensionId.trim(),
    browserInstanceId: value.browserInstanceId.trim(),
    lastSuccessAt: Number(value.lastSuccessAt),
  }

  if (Number.isFinite(value.lastFailureAt)) {
    record.lastFailureAt = Number(value.lastFailureAt)
  }
  if (Number.isFinite(value.failureCount)) {
    record.failureCount = Number(value.failureCount)
  }

  return record
}

export function getLaunchProfileStateFilePath(stateDir?: string): string {
  return resolveRelayPluginStatePath(LAUNCH_PROFILE_STATE_FILE, stateDir)
}

export async function readLaunchProfileState(stateDir?: string): Promise<LaunchProfileState> {
  try {
    const raw = await readFile(getLaunchProfileStateFilePath(stateDir), 'utf8')
    const parsed = JSON.parse(raw) as {
      lastUsableProfile?: unknown
      knownGoodProfiles?: unknown
    }

    const knownGoodProfiles = Array.isArray(parsed.knownGoodProfiles)
      ? parsed.knownGoodProfiles
        .map((entry) => normalizeLaunchProfileRecord(entry))
        .filter((entry): entry is LaunchProfileRecord => Boolean(entry))
      : []

    return {
      lastUsableProfile: normalizeLaunchProfileRecord(parsed.lastUsableProfile) ?? null,
      knownGoodProfiles,
    }
  } catch {
    return {
      lastUsableProfile: null,
      knownGoodProfiles: [],
    }
  }
}

export async function writeLaunchProfileState(state: LaunchProfileState, stateDir?: string): Promise<void> {
  const filePath = getLaunchProfileStateFilePath(stateDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf8')
}
