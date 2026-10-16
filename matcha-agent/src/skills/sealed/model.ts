import type { ToolPermissionContext } from '../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import {
  readSealedCatalog,
  readSealedContent,
  SealedSkillError,
} from './catalog.js'
import { sealedReadPermission } from './permissions.js'
import { withSealedModelContext } from './privacy.js'
import {
  collectSealedSkillReferences,
  type SealedSkillReference,
  SEALED_REDACTION,
  hasSealedSkillReferences,
  parseSealedSkillReference,
  sealedReferenceKey,
  sealedSkillPath,
} from './reference.js'

type ModelStreamEvent = StreamEvent | AssistantMessage | SystemAPIErrorMessage

// Generator work must enter the scope on each resume, not only construction.
export async function* protectSealedModelStream(
  messages: Message[],
  call: () => AsyncGenerator<ModelStreamEvent, void>,
): AsyncGenerator<ModelStreamEvent, void> {
  const sealed = hasSealedSkillReferences(messages)
  const stream = call()
  try {
    while (true) {
      const step = await withSealedModelContext(sealed, () => stream.next())
      if (step.done) return
      const event = step.value
      if (
        sealed &&
        event &&
        typeof event === 'object' &&
        'isApiErrorMessage' in event &&
        event.isApiErrorMessage === true
      ) {
        const message = 'message' in event ? event.message : undefined
        yield {
          ...event,
          error: new Error(SEALED_REDACTION),
          errorDetails: SEALED_REDACTION,
          ...(message && typeof message === 'object'
            ? {
                message: {
                  ...message,
                  content: [{ type: 'text', text: SEALED_REDACTION }],
                },
              }
            : {}),
        }
      } else {
        yield event
      }
    }
  } finally {
    await withSealedModelContext(sealed, () => stream.return())
  }
}

export async function hydrateSealedModelMessages<T extends Message>(
  messages: T[],
  signal: AbortSignal,
  permissionContext: ToolPermissionContext,
  maxTokens: number,
  trustedReferences: readonly SealedSkillReference[],
): Promise<T[]> {
  const trusted = new Set(trustedReferences.map(sealedReferenceKey))
  const refs = messages.flatMap(message =>
    message.type === 'user' && message.message
      ? collectSealedSkillReferences(message.message.content).filter(ref =>
          trusted.has(sealedReferenceKey(ref)),
        )
      : [],
  )
  if (refs.length === 0) return messages
  const { roughTokenCountEstimationForMessages } = await import(
    '../../services/tokenEstimation.js'
  )
  if (
    Math.ceil(
      (roughTokenCountEstimationForMessages(
        messages.map(({ type, message }) => ({ type, message })),
      ) *
        4) /
        3,
    ) > maxTokens
  ) {
    throw new SealedSkillError('sealed_whole_document_budget')
  }
  const catalog = await readSealedCatalog(signal)
  const contents = new Map<string, string>()
  for (const ref of refs) {
    const key = sealedReferenceKey(ref)
    if (contents.has(key)) continue
    const uri = sealedSkillPath(ref.skillKey, ref.path)
    // A durable native producer proves the original ask was approved. Current
    // explicit deny still revokes access; current Host authorization is re-read.
    if (sealedReadPermission(uri, permissionContext).behavior === 'deny') {
      throw new SealedSkillError('sealed_read_permission_required')
    }
    const skill = catalog.find(skill => skill.skillKey === ref.skillKey)
    if (!skill) throw new SealedSkillError('sealed_unknown')
    if (skill.packageSha256 !== ref.packageSha256)
      throw new SealedSkillError('sealed_package_changed')
    const body = await readSealedContent(skill, ref.path, signal)
    if (
      body.contentBytes !== ref.contentBytes ||
      body.contentTokens !== ref.contentTokens
    ) {
      throw new SealedSkillError('sealed_reference_changed')
    }
    contents.set(
      key,
      `Base directory for this sealed skill: ${uri.slice(0, uri.lastIndexOf('/'))}/\nUse Read with exact matcha-skill:// URIs for package resources; no local filesystem copy exists.\n\n${body.text}`,
    )
  }
  function copyContent(value: unknown): unknown {
    if (typeof value === 'string') {
      const ref = parseSealedSkillReference(value)
      return ref ? (contents.get(sealedReferenceKey(ref)) ?? value) : value
    }
    if (Array.isArray(value)) return value.map(copyContent)
    if (!value || typeof value !== 'object') return value
    const block = value as Record<string, unknown>
    if (block.type === 'text')
      return { ...block, text: copyContent(block.text) }
    if (block.type === 'tool_result' && !block.is_error)
      return { ...block, content: copyContent(block.content) }
    return value
  }
  const hydrated = messages.map(message => {
    if (message.type !== 'user' || !message.message) return message
    return {
      ...message,
      message: {
        ...message.message,
        content: copyContent(message.message.content),
      },
    } as T
  })
  if (
    Math.ceil(
      (roughTokenCountEstimationForMessages(
        hydrated.map(({ type, message }) => ({ type, message })),
      ) *
        4) /
        3,
    ) > maxTokens
  ) {
    throw new SealedSkillError('sealed_whole_document_budget')
  }
  return hydrated
}

// Durable helper queries must not summarize or learn protected source text.
export function sealedExecutionQuery(source: string): boolean {
  return (
    source === 'sdk' ||
    source === 'main_loop' ||
    source === 'workflow' ||
    source.startsWith('repl_main_thread') ||
    source.startsWith('agent:')
  )
}
