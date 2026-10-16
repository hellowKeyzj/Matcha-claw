import { createHash } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import { sealedReadTokenBudget } from './budget.js'
import { sealedReadPermission } from './permissions.js'
import {
  parseSealedSkillPath,
  sealedSkillPath,
  type SealedSkillReference,
} from './reference.js'

export type SealedSkill = {
  skillKey: string
  packageSha256: string
  descriptor: {
    name: string
    description: string
    userInvocable: boolean
    disableModelInvocation: boolean
  }
  files: { path: string; sizeBytes: number; sha256: string }[]
}

export class SealedSkillError extends Error {
  constructor(readonly kind: string) {
    super(`Sealed skill is unavailable (${kind})`)
    this.name = 'SealedSkillError'
  }
}

function source(): { origin: string; token: string } | undefined {
  if (process.env.MATCHA_SEALED_RUNTIME !== 'matcha-agent') return undefined
  const endpoint = process.env.MATCHA_SEALED_ENDPOINT
  const token = process.env.MATCHA_SEALED_TOKEN
  if (!endpoint || !token)
    throw new SealedSkillError('sealed_source_unavailable')
  try {
    const url = new URL(endpoint)
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error()
    if (!/^[\x21-\x7e]+$/u.test(token)) throw new Error()
    return { origin: url.origin, token }
  } catch {
    throw new SealedSkillError('sealed_source_invalid')
  }
}

async function request(
  path: string,
  signal?: AbortSignal,
  expectedSha?: string,
): Promise<unknown> {
  const reader = source()
  if (!reader) throw new SealedSkillError('sealed_source_unavailable')
  try {
    const response = await fetch(
      `${reader.origin}/sealed-skills/${encodeURIComponent(getSessionId())}/${path}`,
      {
        method: 'GET',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${reader.token}`,
          ...(expectedSha && { 'x-matcha-sealed-package-sha256': expectedSha }),
        },
      },
    )
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { data?: { kind?: unknown } }
      } | null
      const kind = body?.error?.data?.kind
      const safeKinds = [
        'sealed_invalid_request',
        'sealed_unauthorized',
        'sealed_unknown',
        'sealed_disabled',
        'sealed_package_changed',
        'sealed_unavailable',
        'sealed_source_unavailable',
      ]
      throw new SealedSkillError(
        typeof kind === 'string' && safeKinds.includes(kind)
          ? kind
          : 'sealed_read_failed',
      )
    }
    return await response.json()
  } catch (error) {
    if (signal?.aborted)
      throw signal.reason ?? new SealedSkillError('cancelled')
    if (error instanceof SealedSkillError) throw error
    throw new SealedSkillError('sealed_transport_failed')
  }
}

function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

export async function readSealedCatalog(
  signal?: AbortSignal,
): Promise<SealedSkill[]> {
  if (!source()) return []
  const body = (await request('catalog', signal)) as {
    agentId?: unknown
    skills?: unknown
  }
  if (
    !body ||
    typeof body.agentId !== 'string' ||
    !body.agentId ||
    !Array.isArray(body.skills)
  ) {
    throw new SealedSkillError('sealed_catalog_invalid')
  }
  const keys = new Set<string>()
  const names = new Set<string>()
  return body.skills.map((value: unknown) => {
    const skill = value as SealedSkill
    try {
      if (
        !skill ||
        typeof skill.skillKey !== 'string' ||
        !hash(skill.packageSha256) ||
        !skill.descriptor ||
        typeof skill.descriptor.name !== 'string' ||
        !skill.descriptor.name ||
        typeof skill.descriptor.description !== 'string' ||
        typeof skill.descriptor.userInvocable !== 'boolean' ||
        typeof skill.descriptor.disableModelInvocation !== 'boolean' ||
        !Array.isArray(skill.files) ||
        keys.has(skill.skillKey) ||
        names.has(skill.descriptor.name)
      )
        throw new Error()
      sealedSkillPath(skill.skillKey, 'SKILL.md')
      const paths = new Set<string>()
      for (const file of skill.files) {
        if (
          !file ||
          typeof file.path !== 'string' ||
          !Number.isSafeInteger(file.sizeBytes) ||
          file.sizeBytes < 0 ||
          !hash(file.sha256) ||
          paths.has(file.path)
        )
          throw new Error()
        sealedSkillPath(skill.skillKey, file.path)
        paths.add(file.path)
      }
      if (!paths.has('SKILL.md')) throw new Error()
      keys.add(skill.skillKey)
      names.add(skill.descriptor.name)
      return skill
    } catch {
      throw new SealedSkillError('sealed_catalog_invalid')
    }
  })
}

export async function readSealedContent(
  skill: SealedSkill,
  path: string,
  signal?: AbortSignal,
): Promise<{ text: string; contentBytes: number; contentTokens: number }> {
  const file = skill.files.find(file => file.path === path)
  if (!file) throw new SealedSkillError('sealed_unknown')
  const body = (await request(
    `read/${encodeURIComponent(skill.skillKey)}/${path.split('/').map(encodeURIComponent).join('/')}`,
    signal,
    skill.packageSha256,
  )) as { contentBase64?: unknown; packageSha256?: unknown }
  if (
    !body ||
    typeof body.contentBase64 !== 'string' ||
    body.packageSha256 !== skill.packageSha256
  ) {
    throw new SealedSkillError('sealed_read_invalid')
  }
  const bytes = Buffer.from(body.contentBase64, 'base64')
  try {
    if (
      bytes.toString('base64') !== body.contentBase64 ||
      bytes.length !== file.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new Error()
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    // Conservative local estimate; never send protected text to a token-count API.
    return {
      text,
      contentBytes: bytes.length,
      contentTokens: Math.ceil(text.length / 2),
    }
  } catch {
    throw new SealedSkillError('sealed_read_invalid')
  } finally {
    bytes.fill(0)
  }
}

export async function readSealedReference(
  uri: string,
  signal: AbortSignal,
  limits: { maxSizeBytes: number; maxTokens: number },
  expectedSha?: string,
): Promise<SealedSkillReference> {
  const { skillKey, path } = parseSealedSkillPath(uri)
  const skill = (await readSealedCatalog(signal)).find(
    skill => skill.skillKey === skillKey,
  )
  if (!skill) throw new SealedSkillError('sealed_unknown')
  if (expectedSha && skill.packageSha256 !== expectedSha)
    throw new SealedSkillError('sealed_package_changed')
  const file = skill.files.find(file => file.path === path)
  if (!file) throw new SealedSkillError('sealed_unknown')
  if (file.sizeBytes > limits.maxSizeBytes)
    throw new SealedSkillError('sealed_whole_document_budget')
  const { contentBytes, contentTokens } = await readSealedContent(
    skill,
    path,
    signal,
  )
  if (contentTokens > limits.maxTokens)
    throw new SealedSkillError('sealed_whole_document_budget')
  return {
    type: 'matcha.sealedSkill',
    skillKey,
    path,
    packageSha256: skill.packageSha256,
    contentBytes,
    contentTokens,
  }
}

export async function loadSealedCommands(): Promise<Command[]> {
  const catalog = await readSealedCatalog()
  return catalog.map(skill => ({
    type: 'prompt',
    name: skill.descriptor.name,
    description: skill.descriptor.description,
    hasUserSpecifiedDescription: true,
    userInvocable: skill.descriptor.userInvocable,
    disableModelInvocation: skill.descriptor.disableModelInvocation,
    isHidden: !skill.descriptor.userInvocable,
    source: 'userSettings',
    loadedFrom: 'skills',
    progressMessage: 'running',
    contentLength: skill.files.find(file => file.path === 'SKILL.md')!
      .sizeBytes,
    skillRoot: sealedSkillPath(skill.skillKey, 'SKILL.md'),
    async getPromptForCommand(args: string, context: ToolUseContext) {
      const uri = sealedSkillPath(skill.skillKey, 'SKILL.md')
      if (
        sealedReadPermission(uri, context.getAppState().toolPermissionContext)
          .behavior !== 'allow'
      ) {
        throw new SealedSkillError('sealed_read_permission_required')
      }
      const { getDefaultFileReadingLimits } = await import(
        '@claude-code-best/builtin-tools/tools/FileReadTool/limits.js'
      )
      const defaults = getDefaultFileReadingLimits()
      const ref = await readSealedReference(
        uri,
        context.abortController.signal,
        {
          maxSizeBytes:
            context.fileReadingLimits?.maxSizeBytes ?? defaults.maxSizeBytes,
          maxTokens: Math.min(
            context.fileReadingLimits?.maxTokens ?? defaults.maxTokens,
            await sealedReadTokenBudget(context),
          ),
        },
        skill.packageSha256,
      )
      return [
        { type: 'text' as const, text: JSON.stringify(ref) },
        ...(args
          ? [{ type: 'text' as const, text: `Skill arguments: ${args}` }]
          : []),
      ]
    },
  }))
}
