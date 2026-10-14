import type { UUID } from 'crypto'
import { open, stat } from 'fs/promises'
import type {
  SessionContentParams,
  SessionContentResult,
  SessionTranscriptParams,
  SessionTranscriptResult,
} from '../app-server/protocol/types.js'
import type { TranscriptMessage } from '../types/logs.js'
import { loadTranscriptHistoryFromJsonlPath } from './conversationRecovery.js'
import { hasRealUserMessage } from './sessionConversationEligibility.js'
import {
  firstPromptFromMessages,
  hasTranscriptReplayContent,
  listSessionHistorySummaries,
  type SessionHistorySummary,
  sessionHistorySummaryFromMessages,
  transcriptReplayLineFromTranscriptMessage,
  transcriptTextPreview,
} from './sessionHistoryReadModel.js'
import {
  resolveSessionFilePath,
  type TranscriptSourceSpan,
  validateUuid,
} from './sessionStoragePortable.js'

const PAGE_BYTES = 512 * 1024
const MAX_INDEX_ENTRIES = 20000
const MAX_INDEX_BYTES = 8 * 1024 * 1024
const MAX_CACHED_SESSIONS = 16

type IndexedMessage = {
  uuid: UUID
  parentUuid: UUID | null
  span: TranscriptSourceSpan
}
type HistoryIndex = {
  path: string
  fingerprint: string
  messages: IndexedMessage[]
  byUuid: Map<string, IndexedMessage>
  summary: SessionHistorySummary
  bytes: number
}

export type SessionHistoryReader = {
  list(limit: number): Promise<SessionHistorySummary[]>
  load(sessionId: string): Promise<SessionHistorySummary | null>
  transcript(params: SessionTranscriptParams): Promise<SessionTranscriptResult>
  content(params: SessionContentParams): Promise<SessionContentResult | null>
  close(): void
}

/** One native history reader owns only bounded, rebuildable source metadata. */
export function createSessionHistoryReader(): SessionHistoryReader {
  const indexes = new Map<string, HistoryIndex>()
  let cachedEntries = 0
  let cachedBytes = 0
  let closed = false

  function discard(sessionId: string): void {
    const index = indexes.get(sessionId)
    if (!index) return
    cachedEntries -= index.messages.length
    cachedBytes -= index.bytes
    indexes.delete(sessionId)
  }

  async function indexFor(sessionId: string): Promise<HistoryIndex | null> {
    if (closed || !validateUuid(sessionId)) return null
    const source = await resolveSessionFilePath(sessionId)
    if (!source) {
      discard(sessionId)
      return null
    }
    const fileStat = await stat(source.filePath)
    const fingerprint = sourceFingerprint(fileStat)
    const cached = indexes.get(sessionId)
    if (
      cached?.path === source.filePath &&
      cached.fingerprint === fingerprint
    ) {
      indexes.delete(sessionId)
      indexes.set(sessionId, cached)
      return cached
    }
    discard(sessionId)
    const spans = new Map<UUID, TranscriptSourceSpan>()
    const visible = new Set<UUID>()
    const realUsers = new Set<UUID>()
    // Exact totals need a cold source scan; all recovery stays in the native loader.
    const loaded = await loadTranscriptHistoryFromJsonlPath(source.filePath, {
      fileSize: fileStat.size,
      sourceSpans: spans,
      transform(message) {
        if (hasTranscriptReplayContent(message, sessionId)) {
          visible.add(message.uuid)
        } else {
          visible.delete(message.uuid)
        }
        if (hasRealUserMessage(message)) realUsers.add(message.uuid)
        else realUsers.delete(message.uuid)
        return displaySkeleton(message, firstPromptFromMessages([message]))
      },
    })
    if (sourceFingerprint(await stat(source.filePath)) !== fingerprint) {
      throw new Error(
        'Session transcript changed while indexing; retry the request',
      )
    }
    const summary = sessionHistorySummaryFromMessages(
      sessionId,
      source.projectPath,
      loaded.messages,
    )
    if (loaded.messages.some(message => realUsers.has(message.uuid))) {
      summary.hasConversation = true
    } else {
      summary.hasConversation = undefined
    }
    const messages = loaded.messages.flatMap(message => {
      const span = spans.get(message.uuid)
      return visible.has(message.uuid) && span
        ? [{ uuid: message.uuid, parentUuid: message.parentUuid, span }]
        : []
    })
    const index: HistoryIndex = {
      path: source.filePath,
      fingerprint,
      messages,
      byUuid: new Map(messages.map(message => [message.uuid, message])),
      summary,
      bytes: Buffer.byteLength(
        JSON.stringify({
          messages,
          summary,
          path: source.filePath,
          fingerprint,
        }),
      ),
    }
    if (
      !closed &&
      messages.length <= MAX_INDEX_ENTRIES &&
      index.bytes <= MAX_INDEX_BYTES
    ) {
      discard(sessionId)
      while (
        indexes.size >= MAX_CACHED_SESSIONS ||
        cachedEntries + messages.length > MAX_INDEX_ENTRIES ||
        cachedBytes + index.bytes > MAX_INDEX_BYTES
      ) {
        discard(indexes.keys().next().value!)
      }
      indexes.set(sessionId, index)
      cachedEntries += messages.length
      cachedBytes += index.bytes
    }
    return index
  }

  return {
    list: limit =>
      closed ? Promise.resolve([]) : listSessionHistorySummaries(limit),
    async load(sessionId) {
      const index = await indexFor(sessionId)
      return index ? { ...index.summary } : null
    },
    async transcript(params) {
      const index = await indexFor(params.sessionId)
      const total = index?.messages.length ?? 0
      const limit = boundedInteger(params.limit ?? 80, 200)
      const anchor = boundedInteger(params.offset ?? total, total)
      const direction = params.direction ?? 'latest'
      let start =
        direction === 'latest'
          ? Math.max(0, total - limit)
          : direction === 'older'
            ? Math.max(0, anchor - limit)
            : anchor
      let end =
        direction === 'latest'
          ? total
          : direction === 'older'
            ? Math.min(total, anchor + limit, start + 200)
            : Math.min(total, anchor + limit)
      if (limit === 0) end = start
      const result = (): SessionTranscriptResult => ({
        lines,
        window: {
          totalItemCount: total,
          windowStartOffset: start,
          windowEndOffset: end,
        },
      })
      const lines: string[] = []
      if (!index || start === end) return result()
      const fd = await open(index.path, 'r')
      try {
        if (sourceFingerprint(await fd.stat()) !== index.fingerprint) {
          discard(params.sessionId)
          throw new Error(
            'Session transcript changed before reading; retry the request',
          )
        }
        const headerBytes = Buffer.byteLength(
          JSON.stringify({
            lines: [],
            window: {
              totalItemCount: total,
              windowStartOffset: total,
              windowEndOffset: total,
            },
          }),
        )
        let responseBytes = headerBytes
        const reverse = direction === 'latest'
        for (
          let offset = reverse ? end - 1 : start;
          reverse ? offset >= start : offset < end;
          offset += reverse ? -1 : 1
        ) {
          const indexed = index.messages[offset]!
          const message = await readSourceMessage(fd, indexed)
          message.parentUuid = indexed.parentUuid
          let previewBytes = 4096
          let line = transcriptReplayLineFromTranscriptMessage(
            message,
            params.sessionId,
            previewBytes,
          )
          let lineBytes = line ? Buffer.byteLength(JSON.stringify(line)) : 0
          while (
            line &&
            headerBytes + lineBytes > PAGE_BYTES &&
            previewBytes > 1
          ) {
            previewBytes = Math.max(1, Math.floor(previewBytes / 2))
            line = transcriptReplayLineFromTranscriptMessage(
              message,
              params.sessionId,
              previewBytes,
            )
            lineBytes = line ? Buffer.byteLength(JSON.stringify(line)) : 0
          }
          if (!line || headerBytes + lineBytes > PAGE_BYTES) {
            throw new Error(
              'Session transcript message exceeds the display response budget',
            )
          }
          if (responseBytes + lineBytes + (lines.length ? 1 : 0) > PAGE_BYTES)
            break
          responseBytes += lineBytes + (lines.length ? 1 : 0)
          lines.push(line)
        }
        if (reverse) {
          lines.reverse()
          start = end - lines.length
        } else {
          end = start + lines.length
        }
        if (sourceFingerprint(await fd.stat()) !== index.fingerprint) {
          discard(params.sessionId)
          throw new Error(
            'Session transcript changed while reading; retry the request',
          )
        }
      } finally {
        await fd.close()
      }
      return result()
    },
    async content(params) {
      const ref = decodeContentRef(params.contentRef, params.sessionId)
      if (
        !ref ||
        !Number.isSafeInteger(params.offset) ||
        params.offset < 0 ||
        !Number.isSafeInteger(params.limit) ||
        params.limit < 1
      )
        return null
      const index = await indexFor(params.sessionId)
      const indexed = index?.byUuid.get(ref.uuid)
      if (!index || !indexed) return null
      const fd = await open(index.path, 'r')
      let message: TranscriptMessage
      try {
        if (sourceFingerprint(await fd.stat()) !== index.fingerprint) {
          discard(params.sessionId)
          return null
        }
        message = await readSourceMessage(fd, indexed)
        if (sourceFingerprint(await fd.stat()) !== index.fingerprint) {
          discard(params.sessionId)
          return null
        }
      } finally {
        await fd.close()
      }
      const record = message as unknown as Record<string, unknown>
      const nested = isRecord(record.message) ? record.message : null
      const content =
        ref.root === 'm'
          ? nested?.content
          : !nested || !Object.hasOwn(nested, 'content')
            ? record.content
            : undefined
      const block =
        ref.block === null
          ? content
          : Array.isArray(content)
            ? content[ref.block]
            : undefined
      const text =
        ref.block === null
          ? typeof block === 'string'
            ? block
            : undefined
          : isRecord(block) &&
              block.type === 'text' &&
              typeof block.text === 'string'
            ? block.text
            : undefined
      if (text === undefined) return null
      const bytes = Buffer.from(text)
      if (
        params.offset > bytes.length ||
        (params.offset < bytes.length &&
          (bytes[params.offset]! & 0xc0) === 0x80)
      )
        return null
      let end = Math.min(
        bytes.length,
        params.offset + Math.min(params.limit, 65536),
      )
      while (
        end > params.offset &&
        end < bytes.length &&
        (bytes[end]! & 0xc0) === 0x80
      )
        end--
      if (params.limit > 0 && end === params.offset && end < bytes.length)
        return null
      return {
        contentRef: params.contentRef,
        offset: params.offset,
        text: bytes.toString('utf8', params.offset, end),
        nextOffset: end,
        totalBytes: bytes.length,
        complete: end === bytes.length,
      }
    },
    close() {
      closed = true
      indexes.clear()
      cachedEntries = 0
      cachedBytes = 0
    },
  }
}

function sourceFingerprint(value: {
  size: number
  mtimeMs: number
  ctimeMs: number
}): string {
  return `${value.size}:${value.mtimeMs}:${value.ctimeMs}`
}

function boundedInteger(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid transcript window bounds')
  return Math.min(value, maximum)
}

async function readSourceMessage(
  fd: Awaited<ReturnType<typeof open>>,
  indexed: IndexedMessage,
): Promise<TranscriptMessage> {
  const bytes = Buffer.allocUnsafe(indexed.span.length)
  let read = 0
  while (read < bytes.length) {
    const { bytesRead } = await fd.read(
      bytes,
      read,
      bytes.length - read,
      indexed.span.start + read,
    )
    if (!bytesRead)
      throw new Error('Session transcript source line is incomplete')
    read += bytesRead
  }
  const message = JSON.parse(
    bytes.toString('utf8').replace(/^﻿/, ''),
  ) as TranscriptMessage
  if (message.uuid !== indexed.uuid)
    throw new Error('Session transcript source message changed')
  return message
}

function displaySkeleton(
  message: TranscriptMessage,
  firstPrompt: string | undefined,
): TranscriptMessage {
  const record = message as unknown as Record<string, unknown>
  const nested = isRecord(record.message) ? record.message : null
  const content =
    nested && Object.hasOwn(nested, 'content') ? nested.content : record.content
  const skeleton = firstPrompt
    ? transcriptTextPreview(firstPrompt, 512)
    : Array.isArray(content)
      ? content.flatMap(block =>
          isRecord(block) ? [{ type: block.type }] : [],
        )
      : ''
  return {
    uuid: message.uuid,
    parentUuid: message.parentUuid,
    timestamp: message.timestamp,
    sessionId: message.sessionId,
    cwd: message.cwd,
    type: message.type,
    isSidechain: message.isSidechain,
    isMeta: record.isMeta,
    isCompactSummary: record.isCompactSummary,
    subtype: record.subtype,
    compactMetadata: record.compactMetadata,
    snipMetadata: record.snipMetadata,
    message: { id: nested?.id, content: skeleton },
  } as unknown as TranscriptMessage
}

type ContentLocation = { uuid: string; root: 'm' | 'c'; block: number | null }
function decodeContentRef(
  contentRef: string,
  sessionId: string,
): ContentLocation | null {
  if (
    Buffer.byteLength(contentRef) > 512 ||
    !/^mt1:[A-Za-z0-9_-]+$/.test(contentRef)
  )
    return null
  try {
    const value: unknown = JSON.parse(
      Buffer.from(contentRef.slice(4), 'base64url').toString('utf8'),
    )
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== sessionId ||
      !validateUuid(value[1]) ||
      (value[2] !== 'm' && value[2] !== 'c') ||
      (value[3] !== null && (!Number.isSafeInteger(value[3]) || value[3] < 0))
    )
      return null
    return { uuid: value[1], root: value[2], block: value[3] }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
