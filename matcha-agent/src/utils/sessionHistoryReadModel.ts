import type {
  LogOption,
  SerializedMessage,
  TranscriptMessage,
} from '../types/logs.js'
import {
  loadMessagesFromJsonlPath,
  loadTranscriptHistoryFromJsonlPath,
} from './conversationRecovery.js'
import {
  getSessionIdFromLog,
  loadAllProjectsMessageLogs,
} from './sessionStorage.js'
import { hasRealUserMessage } from './sessionConversationEligibility.js'
import { resolveSessionFilePath } from './sessionStoragePortable.js'

const EPOCH_ISO = new Date(0).toISOString()
const TRANSCRIPT_IMAGE_MEDIA_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
])

export type SessionHistorySummary = {
  sessionId: string
  workspaceRoot: string
  createdAt: string
  updatedAt: string
  title?: string
  hasConversation?: boolean
}

export async function listSessionHistorySummaries(
  limit: number,
): Promise<SessionHistorySummary[]> {
  const logs = await loadAllProjectsMessageLogs(limit, {
    initialEnrichCount: limit,
  })
  return logs.flatMap(log => {
    const summary = sessionHistorySummaryFromLog(log)
    return summary ? [summary] : []
  })
}

export async function loadSessionHistorySummary(
  sessionId: string,
): Promise<SessionHistorySummary | null> {
  const resolved = await resolveSessionFilePath(sessionId)
  if (!resolved) return null
  const loaded = await loadMessagesFromJsonlPath(resolved.filePath)
  return sessionHistorySummaryFromMessages(
    sessionId,
    resolved.projectPath,
    loaded.messages,
  )
}

export async function readSessionTranscriptReplayLines(
  sessionId: string,
  maxLines: number,
): Promise<string[]> {
  const resolved = await resolveSessionFilePath(sessionId)
  if (!resolved) return []
  const loaded = await loadTranscriptHistoryFromJsonlPath(resolved.filePath)
  return loaded.messages.slice(-maxLines).flatMap(message => {
    const line = transcriptReplayLineFromTranscriptMessage(message)
    return line ? [line] : []
  })
}

function sessionHistorySummaryFromLog(
  log: LogOption,
): SessionHistorySummary | null {
  const sessionId = getSessionIdFromLog(log)
  if (!sessionId) return null
  return {
    sessionId,
    workspaceRoot: log.projectPath ?? '',
    createdAt: log.created.toISOString(),
    updatedAt: log.modified.toISOString(),
    ...(log.customTitle || log.firstPrompt
      ? { title: log.customTitle || log.firstPrompt }
      : {}),
    ...(hasConversationFromLog(log) ? { hasConversation: true } : {}),
  }
}

function sessionHistorySummaryFromMessages(
  sessionId: string,
  projectPath: string | undefined,
  messages: SerializedMessage[],
): SessionHistorySummary {
  const firstMessage = messages[0]
  const lastMessage = messages.at(-1)
  const title = firstPromptFromMessages(messages)
  return {
    sessionId,
    workspaceRoot: projectPath ?? firstMessage?.cwd ?? '',
    createdAt: firstMessage?.timestamp ?? EPOCH_ISO,
    updatedAt: lastMessage?.timestamp ?? firstMessage?.timestamp ?? EPOCH_ISO,
    ...(title ? { title } : {}),
    ...(hasConversationFromMessages(messages) ? { hasConversation: true } : {}),
  }
}

function hasConversationFromLog(log: LogOption): boolean {
  return log.hasRealUserMessage === true
}

function hasConversationFromMessages(messages: SerializedMessage[]): boolean {
  return messages.some(hasRealUserMessage)
}

function transcriptReplayLineFromTranscriptMessage(
  message: TranscriptMessage,
): string | null {
  const role = transcriptReplayRole(message)
  if (!role) return null
  const content = transcriptReplayContent(message)
  if (content === null) return null
  const messageId = readMessageId(message)
  const parentMessageId = readParentMessageId(message)
  const toolCallId =
    role === 'toolresult' ? readToolResultCallId(message) : undefined
  return JSON.stringify({
    id: messageId,
    parentId: parentMessageId,
    timestamp: message.timestamp,
    message: {
      role,
      content,
      id: messageId,
      originMessageId: parentMessageId,
      ...(toolCallId ? { toolCallId } : {}),
      metadata: {
        sessionId: message.sessionId,
      },
    },
  })
}

function transcriptReplayRole(
  message: SerializedMessage,
): 'user' | 'assistant' | 'system' | 'toolresult' | null {
  const type = String(message.type ?? '')
  if (type === 'assistant') return 'assistant'
  if (type === 'user') {
    return isToolResultMessage(message) ? 'toolresult' : 'user'
  }
  if (
    type === 'system' ||
    type === 'system_local_command' ||
    type === 'progress'
  ) {
    return 'system'
  }
  if (type === 'tool_use_summary') return 'toolresult'
  return null
}

function messageContent(message: SerializedMessage): unknown {
  const record = message as unknown as Record<string, unknown>
  const nestedMessage = isRecord(record.message) ? record.message : null
  if (nestedMessage && Object.hasOwn(nestedMessage, 'content')) {
    return nestedMessage.content
  }
  if (Object.hasOwn(record, 'content')) {
    return record.content
  }
  return ''
}

type TranscriptReplayContentBlock = Record<string, unknown>

function transcriptReplayContent(
  message: SerializedMessage,
): string | TranscriptReplayContentBlock[] | null {
  const content = messageContent(message)
  if (typeof content === 'string') return content ? content : null
  if (!Array.isArray(content)) return null
  const blocks = content.flatMap(block => {
    const replayBlock = transcriptReplayContentBlock(block)
    return replayBlock ? [replayBlock] : []
  })
  return blocks.length > 0 ? blocks : null
}

function transcriptReplayContentBlock(
  block: unknown,
): TranscriptReplayContentBlock | null {
  if (!isRecord(block) || typeof block.type !== 'string') return null
  switch (block.type) {
    case 'text':
      return transcriptReplayTextBlock(block)
    case 'thinking':
      return transcriptReplayThinkingBlock(block)
    case 'tool_use':
      return transcriptReplayToolUseBlock(block)
    case 'tool_result':
    case 'tool_use_result':
      return transcriptReplayToolResultBlock(block)
    case 'image':
      return transcriptReplayImageBlock(block)
    default:
      return null
  }
}

function transcriptReplayTextBlock(
  block: Record<string, unknown>,
): TranscriptReplayContentBlock | null {
  return typeof block.text === 'string' && block.text
    ? { type: 'text', text: block.text }
    : null
}

function transcriptReplayThinkingBlock(
  block: Record<string, unknown>,
): TranscriptReplayContentBlock | null {
  const text =
    typeof block.text === 'string'
      ? block.text
      : typeof block.thinking === 'string'
        ? block.thinking
        : ''
  return text ? { type: 'thinking', thinking: text } : null
}

function transcriptReplayToolUseBlock(
  block: Record<string, unknown>,
): TranscriptReplayContentBlock | null {
  if (typeof block.id !== 'string' || typeof block.name !== 'string') {
    return null
  }
  return {
    type: 'tool_use',
    id: block.id,
    name: block.name,
    input: transcriptReplayToolInput(block.input),
  }
}

function transcriptReplayToolInput(value: unknown): Record<string, null> {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.keys(value).map(key => [key, null]))
}

function transcriptReplayToolResultBlock(
  block: Record<string, unknown>,
): TranscriptReplayContentBlock | null {
  const replayBlock: TranscriptReplayContentBlock = { type: block.type }
  for (const key of ['tool_use_id', 'toolUseId', 'id'] as const) {
    if (typeof block[key] === 'string') replayBlock[key] = block[key]
  }
  const content = transcriptReplayToolResultContent(block.content)
  if (content !== undefined) replayBlock.content = content
  if (typeof block.is_error === 'boolean') replayBlock.is_error = block.is_error
  if (typeof block.isError === 'boolean') replayBlock.isError = block.isError
  return Object.keys(replayBlock).length > 1 ? replayBlock : null
}

function transcriptReplayToolResultContent(
  content: unknown,
): string | TranscriptReplayContentBlock[] | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const blocks = content.flatMap(block => {
    const replayBlock = isRecord(block)
      ? transcriptReplayTextBlock(block)
      : null
    return replayBlock ? [replayBlock] : []
  })
  return blocks.length > 0 ? blocks : undefined
}

function transcriptReplayImageBlock(
  block: Record<string, unknown>,
): TranscriptReplayContentBlock | null {
  const source = isRecord(block.source) ? block.source : null
  if (!source || source.type !== 'url' || typeof source.url !== 'string') {
    return null
  }
  const mediaType =
    typeof source.media_type === 'string'
      ? source.media_type
      : typeof source.mediaType === 'string'
        ? source.mediaType
        : ''
  if (!TRANSCRIPT_IMAGE_MEDIA_TYPES.has(mediaType)) {
    return null
  }
  if (!source.url.startsWith('https://') && !source.url.startsWith('http://')) {
    return null
  }
  return {
    type: 'image',
    source: {
      type: 'url',
      media_type: mediaType,
      url: source.url,
    },
  }
}

function isToolResultMessage(message: SerializedMessage): boolean {
  const content = messageContent(message)
  return (
    Array.isArray(content) &&
    content.some(block => {
      if (!isRecord(block)) return false
      return block.type === 'tool_result'
    })
  )
}

function readToolResultCallId(message: SerializedMessage): string | undefined {
  const content = messageContent(message)
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_result') continue
    if (typeof block.tool_use_id === 'string') return block.tool_use_id
    if (typeof block.toolUseId === 'string') return block.toolUseId
    if (typeof block.id === 'string') return block.id
  }
  return undefined
}

function readMessageId(message: SerializedMessage): string | undefined {
  return typeof message.uuid === 'string' ? message.uuid : undefined
}

function readParentMessageId(message: TranscriptMessage): string | undefined {
  return message.parentUuid ?? undefined
}

function firstPromptFromMessages(
  messages: SerializedMessage[],
): string | undefined {
  for (const message of messages) {
    if (transcriptReplayRole(message) !== 'user') continue
    const content = messageContent(message)
    if (typeof content === 'string' && content.trim()) return content.trim()
    if (!Array.isArray(content)) continue
    const text = content
      .flatMap(block => {
        if (!isRecord(block)) return []
        return typeof block.text === 'string' ? [block.text] : []
      })
      .join('')
      .trim()
    if (text) return text
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
