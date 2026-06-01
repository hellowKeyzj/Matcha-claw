import { appendFile, readFile, stat } from 'node:fs/promises'
import {
  listSessionsImpl,
  parseSessionInfoFromLite,
} from '../../utils/listSessionsImpl.js'
import {
  readSessionLite,
  resolveSessionFilePath,
} from '../../utils/sessionStoragePortable.js'
import type { SDKSessionInfo } from './coreTypes.js'
import type {
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  SessionMessage,
  SessionMutationOptions,
} from './runtimeTypes.js'

export async function listSessions(
  options?: ListSessionsOptions,
): Promise<SDKSessionInfo[]> {
  return listSessionsImpl(options)
}

export async function getSessionInfo(
  sessionId: string,
  options?: GetSessionInfoOptions,
): Promise<SDKSessionInfo | undefined> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) return undefined
  const lite = await readSessionLite(resolved.filePath)
  if (!lite) return undefined
  const info = parseSessionInfoFromLite(sessionId, lite, resolved.projectPath)
  return info ?? undefined
}

export async function getSessionMessages(
  sessionId: string,
  options?: GetSessionMessagesOptions,
): Promise<SessionMessage[]> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) return []

  const content = await readFile(resolved.filePath, 'utf8')
  const messages: SessionMessage[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      entry = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const type = typeof entry.type === 'string' ? entry.type : undefined
    if (
      type !== 'user' &&
      type !== 'assistant' &&
      !(options?.includeSystemMessages && type === 'system')
    ) {
      continue
    }
    const message = entry.message as Record<string, unknown> | undefined
    const role =
      typeof message?.role === 'string'
        ? message.role
        : type === 'system'
          ? 'system'
          : type
    messages.push({
      role,
      content: message?.content ?? entry.content,
      uuid: typeof entry.uuid === 'string' ? entry.uuid : undefined,
      parentUuid:
        typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined,
      timestamp:
        typeof entry.timestamp === 'string' ? entry.timestamp : undefined,
      type,
      raw: entry,
    })
  }

  const offset = Math.max(0, options?.offset ?? 0)
  const limit = options?.limit
  return messages.slice(
    offset,
    limit === undefined ? undefined : offset + limit,
  )
}

export async function renameSession(
  sessionId: string,
  title: string,
  options?: SessionMutationOptions,
): Promise<void> {
  await appendSessionMetadata(
    sessionId,
    { type: 'custom-title', customTitle: title },
    options,
  )
}

export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: SessionMutationOptions,
): Promise<void> {
  await appendSessionMetadata(
    sessionId,
    { type: 'tag', tag: tag ?? '' },
    options,
  )
}

async function appendSessionMetadata(
  sessionId: string,
  metadata: Record<string, unknown>,
  options?: SessionMutationOptions,
): Promise<void> {
  const resolved = await resolveSessionFilePath(sessionId, options?.dir)
  if (!resolved) throw new Error(`Session not found: ${sessionId}`)
  await stat(resolved.filePath)
  await appendFile(
    resolved.filePath,
    `${JSON.stringify({ ...metadata, sessionId, timestamp: new Date().toISOString() })}\n`,
    'utf8',
  )
}
