import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  canonicalizePath,
  getProjectDir,
  resolveSessionFilePath,
} from '../../utils/sessionStoragePortable.js'
import type { ForkSessionOptions, ForkSessionResult } from './runtimeTypes.js'

export async function forkSession(
  sessionId: string,
  options?: ForkSessionOptions,
): Promise<ForkSessionResult> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) throw new Error(`Session not found: ${sessionId}`)

  const source = await readFile(resolved.filePath, 'utf8')
  if (!source.trim()) throw new Error(`Session is empty: ${sessionId}`)

  const forkSessionId = randomUUID()
  const projectPath =
    resolved.projectPath ??
    (options?.dir ? await canonicalizePath(options.dir) : process.cwd())
  const projectDir = getProjectDir(projectPath)
  await mkdir(projectDir, { recursive: true, mode: 0o700 })

  const entries = source
    .split('\n')
    .filter(line => line.trim())
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })

  const mainEntries: Record<string, unknown>[] = []
  let cutoffFound = options?.upToMessageId === undefined
  for (const entry of entries) {
    const type = typeof entry.type === 'string' ? entry.type : undefined
    if (
      entry.isSidechain !== true &&
      (type === 'user' || type === 'assistant' || type === 'progress')
    ) {
      mainEntries.push(entry)
      if (entry.uuid === options?.upToMessageId) {
        cutoffFound = true
        break
      }
    }
  }

  if (!cutoffFound) {
    throw new Error(`Message not found in session: ${options?.upToMessageId}`)
  }

  const contentReplacementRecords = entries
    .filter(
      entry =>
        entry.type === 'content-replacement' &&
        entry.sessionId === sessionId &&
        Array.isArray(entry.replacements),
    )
    .flatMap(entry => entry.replacements as unknown[])

  const uuidMap = new Map<string, string>()
  for (const entry of mainEntries) {
    if (typeof entry.uuid === 'string') uuidMap.set(entry.uuid, randomUUID())
  }

  const lines: string[] = []
  let parentUuid: string | null = null
  for (const entry of mainEntries) {
    const forked = rewriteEntry(
      entry,
      sessionId,
      forkSessionId,
      uuidMap,
      parentUuid,
    )
    lines.push(JSON.stringify(forked))
    if (entry.type !== 'progress' && typeof forked.uuid === 'string') {
      parentUuid = forked.uuid
    }
  }

  if (contentReplacementRecords.length > 0) {
    lines.push(
      JSON.stringify({
        type: 'content-replacement',
        sessionId: forkSessionId,
        replacements: contentReplacementRecords,
      }),
    )
  }

  if (options?.title) {
    lines.push(
      JSON.stringify({
        type: 'custom-title',
        customTitle: options.title,
        sessionId: forkSessionId,
        timestamp: new Date().toISOString(),
      }),
    )
  }

  if (lines.length === 0) throw new Error(`No messages to fork: ${sessionId}`)

  await writeFile(
    join(projectDir, `${forkSessionId}.jsonl`),
    `${lines.join('\n')}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  )

  return { sessionId: forkSessionId }
}

function rewriteEntry(
  entry: Record<string, unknown>,
  sourceSessionId: string,
  forkSessionId: string,
  uuidMap: Map<string, string>,
  parentUuid: string | null,
): Record<string, unknown> {
  const originalUuid = typeof entry.uuid === 'string' ? entry.uuid : undefined
  const rewrittenUuid = originalUuid ? uuidMap.get(originalUuid) : undefined
  const originalParentUuid =
    typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined
  const rewrittenParentUuid = originalParentUuid
    ? (uuidMap.get(originalParentUuid) ?? parentUuid)
    : parentUuid
  const rewritten: Record<string, unknown> = {
    ...entry,
    sessionId: forkSessionId,
    parentUuid: rewrittenParentUuid,
    isSidechain: false,
  }

  if (rewrittenUuid) rewritten.uuid = rewrittenUuid

  if (originalUuid) {
    rewritten.forkedFrom = {
      sessionId: sourceSessionId,
      messageUuid: originalUuid,
    }
  }

  return rewritten
}
