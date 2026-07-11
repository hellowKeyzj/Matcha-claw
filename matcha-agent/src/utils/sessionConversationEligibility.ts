import type { SerializedMessage } from '../types/logs.js'

export function hasRealUserMessage(message: SerializedMessage): boolean {
  if (message.type !== 'user' || message.isMeta) return false
  if ('isCompactSummary' in message && message.isCompactSummary) return false
  return hasRealUserContent(message.message?.content)
}

export function hasRealUserMessageRecord(value: unknown): boolean {
  const record = asRecord(value)
  if (
    !record ||
    record.type !== 'user' ||
    record.isMeta === true ||
    record.isCompactSummary === true
  ) {
    return false
  }

  return hasRealUserContent(asRecord(record.message)?.content)
}

function hasRealUserContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false

  return content.some(block => {
    const record = asRecord(block)
    if (!record) return false
    if (record.type === 'text') {
      return typeof record.text === 'string' && record.text.trim().length > 0
    }
    return record.type === 'image' || record.type === 'document'
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
