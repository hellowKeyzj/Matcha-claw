import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getLaunchProfileStateFilePath,
  readLaunchProfileState,
  writeLaunchProfileState,
} from '../../packages/openclaw-browser-relay-plugin/src/browser-launch/launch-profile-state'

const tempDirs: string[] = []

async function createTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'matchaclaw-launch-state-test-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('launch-profile-state', () => {
  it('returns the empty default state when no file exists', async () => {
    const stateDir = await createTempDir()

    await expect(readLaunchProfileState(stateDir)).resolves.toEqual({
      lastUsableProfile: null,
      knownGoodProfiles: [],
    })
  })

  it('writes and reads the persisted profile state', async () => {
    const stateDir = await createTempDir()
    const state = {
      lastUsableProfile: {
        browserName: 'Chrome' as const,
        userDataDir: 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\User Data',
        profileDirectory: 'Default',
        extensionId: 'relayabc',
        browserInstanceId: 'browser-a',
        lastSuccessAt: 123,
        failureCount: 0,
      },
      knownGoodProfiles: [
        {
          browserName: 'Chrome' as const,
          userDataDir: 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\User Data',
          profileDirectory: 'Default',
          extensionId: 'relayabc',
          browserInstanceId: 'browser-a',
          lastSuccessAt: 123,
          failureCount: 0,
        },
      ],
    }

    await writeLaunchProfileState(state, stateDir)

    await expect(readLaunchProfileState(stateDir)).resolves.toEqual(state)
  })

  it('ignores malformed persisted records', async () => {
    const stateDir = await createTempDir()
    await fs.mkdir(path.dirname(getLaunchProfileStateFilePath(stateDir)), { recursive: true })
    await fs.writeFile(
      getLaunchProfileStateFilePath(stateDir),
      JSON.stringify({
        lastUsableProfile: {
          browserName: 'Chrome',
          userDataDir: '',
          profileDirectory: 'Default',
        },
        knownGoodProfiles: [
          {
            browserName: 'Chrome',
            userDataDir: 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\User Data',
            profileDirectory: 'Default',
            extensionId: 'relayabc',
            browserInstanceId: 'browser-a',
            lastSuccessAt: 456,
          },
          {
            browserName: 'Edge',
            userDataDir: 'bad',
            profileDirectory: 'Default',
            extensionId: 'bad',
            browserInstanceId: 'bad',
            lastSuccessAt: 1,
          },
        ],
      }),
      'utf8',
    )

    await expect(readLaunchProfileState(stateDir)).resolves.toEqual({
      lastUsableProfile: null,
      knownGoodProfiles: [
        {
          browserName: 'Chrome',
          userDataDir: 'C:\\Users\\Test\\AppData\\Local\\Google\\Chrome\\User Data',
          profileDirectory: 'Default',
          extensionId: 'relayabc',
          browserInstanceId: 'browser-a',
          lastSuccessAt: 456,
        },
      ],
    })
  })
})
