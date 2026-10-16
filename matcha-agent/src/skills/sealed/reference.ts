import type { Message } from '../../types/message.js'

const PREFIX = 'matcha-skill://'
const nativeReferenceBlocks = new WeakMap<object, boolean>()

// Capture both native and ordinary refs before merging; inherited isMeta must
// never promote an ordinary block. Provenance stays private, not in durable refs.
export function markSealedMetaContent(
  message: Message,
  content = message.message?.content,
): void {
  if (message.type !== 'user' || !Array.isArray(content)) return
  for (const block of content) {
    if (
      block.type === 'text' &&
      parseSealedSkillReference(block.text) &&
      !nativeReferenceBlocks.has(block)
    ) {
      nativeReferenceBlocks.set(block, message.isMeta === true)
    }
  }
}
export const SEALED_REDACTION = '[Sealed skill model context redacted]'

export type SealedSkillReference = {
  type: 'matcha.sealedSkill'
  skillKey: string
  path: string
  packageSha256: string
  contentBytes: number
  contentTokens: number
}

export function isSealedSkillPath(value: string): boolean {
  return value.toLowerCase().startsWith(PREFIX)
}

function validKey(value: string): boolean {
  return (
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, 'utf8') <= 4096 &&
    !value.includes('\0') &&
    value !== '.' &&
    value !== '..'
  )
}

function validSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== '.' &&
    value !== '..' &&
    !/[/\\\0]/u.test(value)
  )
}

export function sealedSkillPath(skillKey: string, path: string): string {
  if (!validKey(skillKey) || !path.split('/').every(validSegment)) {
    throw new Error('Invalid sealed skill reference')
  }
  return (
    PREFIX +
    encodeURIComponent(skillKey) +
    '/' +
    path.split('/').map(encodeURIComponent).join('/')
  )
}

export function parseSealedSkillPath(value: string): {
  skillKey: string
  path: string
} {
  if (!value.startsWith(PREFIX))
    throw new Error('Invalid sealed skill reference')
  try {
    const parts = value.slice(PREFIX.length).split('/').map(decodeURIComponent)
    const skillKey = parts.shift()!
    const path = parts.join('/')
    if (sealedSkillPath(skillKey, path) !== value) throw new Error()
    return { skillKey, path }
  } catch {
    throw new Error('Invalid sealed skill reference')
  }
}

export function parseSealedSkillReference(
  text: string,
): SealedSkillReference | undefined {
  if (!text.trimStart().startsWith('{')) return undefined
  try {
    const ref = JSON.parse(text) as SealedSkillReference
    if (
      !ref ||
      Object.keys(ref).length !== 6 ||
      ref.type !== 'matcha.sealedSkill' ||
      typeof ref.skillKey !== 'string' ||
      typeof ref.path !== 'string' ||
      typeof ref.packageSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(ref.packageSha256) ||
      !Number.isSafeInteger(ref.contentBytes) ||
      ref.contentBytes < 0 ||
      !Number.isSafeInteger(ref.contentTokens) ||
      ref.contentTokens < 0
    )
      return undefined
    sealedSkillPath(ref.skillKey, ref.path)
    return ref
  } catch {
    return undefined
  }
}

// Only content-bearing fields are visited; tool inputs are never skill references.
export function collectSealedSkillReferences(
  value: unknown,
): SealedSkillReference[] {
  if (typeof value === 'string') {
    const ref = parseSealedSkillReference(value)
    return ref ? [ref] : []
  }
  if (Array.isArray(value)) return value.flatMap(collectSealedSkillReferences)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  return ['message', 'content', 'text', 'attachment', 'skills'].flatMap(key =>
    collectSealedSkillReferences(record[key]),
  )
}

// Trust native producers, not JSON pasted by a user or emitted by the model.
export function collectSealedMessageReferences(
  messages: readonly Message[],
): SealedSkillReference[] {
  const reads = new Map<string, string>()
  const refs: SealedSkillReference[] = []
  for (const message of messages) {
    if (
      message.type === 'assistant' &&
      message.message &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use' || block.name !== 'Read') continue
        const input = block.input as { file_path?: unknown }
        if (
          typeof input?.file_path === 'string' &&
          isSealedSkillPath(input.file_path)
        ) {
          reads.set(block.id, input.file_path)
        }
      }
    } else if (
      message.type === 'attachment' &&
      message.attachment?.type === 'invoked_skills'
    ) {
      const skills = message.attachment.skills
      if (!Array.isArray(skills)) continue
      for (const skill of skills) {
        if (
          !skill ||
          typeof skill !== 'object' ||
          typeof skill.content !== 'string' ||
          typeof skill.path !== 'string'
        )
          continue
        const ref = parseSealedSkillReference(skill.content)
        if (ref && skill.path === sealedSkillPath(ref.skillKey, ref.path))
          refs.push(ref)
      }
    } else if (message.type === 'user' && message.message) {
      const content = message.message.content
      if (typeof content === 'string') {
        if (message.isMeta) refs.push(...collectSealedSkillReferences(content))
        continue
      }
      markSealedMetaContent(message)
      if (!Array.isArray(content)) continue
      for (const block of content) {
        if (nativeReferenceBlocks.get(block) === true)
          refs.push(...collectSealedSkillReferences(block))
        if (block.type !== 'tool_result' || block.is_error) continue
        const uri = reads.get(block.tool_use_id)
        if (!uri) continue
        for (const ref of collectSealedSkillReferences(block.content)) {
          if (uri === sealedSkillPath(ref.skillKey, ref.path)) refs.push(ref)
        }
      }
    }
  }
  return refs
}

export function hasSealedSkillReferences(value: unknown): boolean {
  return collectSealedSkillReferences(value).length > 0
}

export function sealedReferenceKey(ref: SealedSkillReference): string {
  return JSON.stringify([
    ref.skillKey,
    ref.path,
    ref.packageSha256,
    ref.contentBytes,
    ref.contentTokens,
  ])
}
