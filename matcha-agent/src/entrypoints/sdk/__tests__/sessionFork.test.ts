import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  canonicalizePath,
  getProjectDir,
} from '../../../utils/sessionStoragePortable.js'
import { forkSession } from '../sessionFork.js'

describe('forkSession', () => {
  test('rewrites message UUIDs and parent chain in the forked transcript', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const configDir = await mkdtemp(join(tmpdir(), 'matcha-sdk-fork-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'matcha-sdk-project-'))
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      const sourceSessionId = '11111111-1111-4111-8111-111111111111'
      const canonicalProjectDir = await canonicalizePath(projectDir)
      const sourceProjectDir = getProjectDir(canonicalProjectDir)
      await mkdir(sourceProjectDir, { recursive: true })
      await writeFile(
        join(sourceProjectDir, `${sourceSessionId}.jsonl`),
        [
          JSON.stringify({
            type: 'user',
            uuid: '22222222-2222-4222-8222-222222222222',
            sessionId: sourceSessionId,
            parentUuid: null,
            isSidechain: false,
            message: { role: 'user', content: 'hello' },
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: '33333333-3333-4333-8333-333333333333',
            sessionId: sourceSessionId,
            parentUuid: '22222222-2222-4222-8222-222222222222',
            isSidechain: false,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'hi' }],
            },
          }),
        ].join('\n') + '\n',
      )

      const result = await forkSession(sourceSessionId, { dir: projectDir })
      const forkPath = join(sourceProjectDir, `${result.sessionId}.jsonl`)
      const forked = (await readFile(forkPath, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)

      expect(forked).toHaveLength(2)
      expect(forked[0]!.sessionId).toBe(result.sessionId)
      expect(forked[1]!.sessionId).toBe(result.sessionId)
      expect(forked[0]!.uuid).not.toBe('22222222-2222-4222-8222-222222222222')
      expect(forked[1]!.uuid).not.toBe('33333333-3333-4333-8333-333333333333')
      expect(forked[0]!.parentUuid).toBeNull()
      expect(forked[1]!.parentUuid).toBe(forked[0]!.uuid)
      expect(forked[0]!.forkedFrom).toEqual({
        sessionId: sourceSessionId,
        messageUuid: '22222222-2222-4222-8222-222222222222',
      })
      expect(forked[1]!.forkedFrom).toEqual({
        sessionId: sourceSessionId,
        messageUuid: '33333333-3333-4333-8333-333333333333',
      })
    } finally {
      if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      await rm(configDir, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })
})
