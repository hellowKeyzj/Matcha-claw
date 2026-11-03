import { readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { discoverInstalledBrowserRelayProfiles } from './installed-profile-discovery.js'

// This admits a local source directory; it does not attest a particular download.
export async function resolveLocalDownloadDirectory(browserInstanceId: string, assertCurrent: () => void): Promise<string> {
  assertCurrent()
  const profiles = discoverInstalledBrowserRelayProfiles()
    .filter((profile) => profile.browserInstanceId === browserInstanceId && profile.relayEnabled)
  if (profiles.length !== 1) {
    throw new Error(profiles.length === 0
      ? 'No enabled local Relay profile matches the download browser instance.'
      : 'Multiple enabled local Relay profiles match the download browser instance.')
  }

  const preferencesPath = path.join(profiles[0]!.profilePath, 'Preferences')
  let preferences: unknown
  try {
    preferences = JSON.parse(await readFile(preferencesPath, 'utf8')) as unknown
  } catch (error) {
    throw new Error(`Cannot read local Relay profile Preferences: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  assertCurrent()
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences)) {
    throw new Error('Local Relay profile Preferences must be a JSON object.')
  }
  const download = (preferences as Record<string, unknown>).download
  if (download !== undefined && (!download || typeof download !== 'object' || Array.isArray(download))) {
    throw new Error('Local Relay profile Preferences download settings must be an object.')
  }
  const configuredDirectory = (download as Record<string, unknown> | undefined)?.default_directory
  if (configuredDirectory !== undefined && typeof configuredDirectory !== 'string') {
    throw new Error('Local Relay profile download.default_directory must be a string when set.')
  }
  const homeDirectory = os.homedir()
  const directory = configuredDirectory ?? path.join(homeDirectory, 'Downloads')
  if (!directory.trim() || !path.isAbsolute(directory)
    || (process.platform === 'win32' && path.parse(directory).root.length === 1)) {
    throw new Error('Local Relay download directory must be an absolute path.')
  }

  const realDirectory = await realpath(directory)
  assertCurrent()
  const realHome = await realpath(homeDirectory)
  assertCurrent()
  if (!path.isAbsolute(realDirectory) || realDirectory === path.parse(realDirectory).root
    || path.relative(realHome, realDirectory) === '') {
    throw new Error('Local Relay download directory cannot be a filesystem root or the entire home directory.')
  }
  const directoryStat = await stat(realDirectory)
  assertCurrent()
  if (!directoryStat.isDirectory()) {
    throw new Error('Local Relay download directory must be an existing directory.')
  }
  return realDirectory
}
