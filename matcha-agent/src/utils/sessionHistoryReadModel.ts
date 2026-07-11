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
      content: messageContent(message),
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
