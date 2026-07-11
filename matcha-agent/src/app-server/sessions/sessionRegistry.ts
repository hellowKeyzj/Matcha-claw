import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { SessionRecord, WorkerRuntimeState } from '../protocol/types.js'

export type SessionRegistryOptions = {
  createSessionId?: () => string
  now?: () => Date
  resolveWorkspaceRoot?: (cwd: string) => Promise<string>
}

export type SessionCreateInput = {
  cwd: string
  sessionId?: string
  title?: string
  model?: string
  permissionMode?: string
}

export type SessionCreateResult =
  | { resultType: 'created'; session: SessionRecord }
  | { resultType: 'sessionAlreadyExists'; sessionId: string }
  | {
      resultType: 'workspaceUnavailable'
      cwd: string
      resolvedPath: string
      message: string
    }

type WorkspaceUnavailableResult = Extract<
  SessionCreateResult,
  { resultType: 'workspaceUnavailable' }
>

type WorkspaceRootResult =
  | { resultType: 'resolved'; workspaceRoot: string }
  | WorkspaceUnavailableResult

const SENSITIVE_WORKSPACE_DIRECTORY_NAMES = new Set([
  '.git',
  '.claude',
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
])

const SENSITIVE_WORKSPACE_FILE_NAMES = new Set([
  'settings.json',
  'settings.local.json',
  '.mcp.json',
  'mcp.json',
  'claude_desktop_config.json',
  '.claude.json',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  'profile.ps1',
  'microsoft.powershell_profile.ps1',
  'powershell_profile.ps1',
  '.gitconfig',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.env',
  '.env.local',
  '.envrc',
  'credentials',
  'credentials.json',
  'credential',
  'credential.json',
  'id_rsa',
  'id_ed25519',
])

export type SessionLoadResult =
  | { resultType: 'loaded'; session: SessionRecord }
  | { resultType: 'sessionNotFound'; sessionId: string }

export type SessionCloseResult =
  | { resultType: 'closed'; session: SessionRecord }
  | { resultType: 'sessionNotFound'; sessionId: string }

export type SessionUpdateWorkerStateResult =
  | { resultType: 'updated'; session: SessionRecord }
  | { resultType: 'sessionNotFound'; sessionId: string }

export class SessionRegistry {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly createSessionId: () => string
  private readonly now: () => Date
  private readonly resolveWorkspaceRoot: (cwd: string) => Promise<string>

  constructor(options: SessionRegistryOptions = {}) {
    this.createSessionId = options.createSessionId ?? randomUUID
    this.now = options.now ?? (() => new Date())
    this.resolveWorkspaceRoot =
      options.resolveWorkspaceRoot ?? defaultResolveWorkspaceRoot
  }

  async create(input: SessionCreateInput): Promise<SessionCreateResult> {
    const sessionId = input.sessionId ?? this.createSessionId()
    if (this.sessions.has(sessionId)) {
      return { resultType: 'sessionAlreadyExists', sessionId }
    }

    const workspaceRootResult = await this.normalizeWorkspaceRoot(input.cwd)
    if (workspaceRootResult.resultType === 'workspaceUnavailable') {
      return workspaceRootResult
    }

    const now = this.now().toISOString()
    const session: SessionRecord = {
      sessionId,
      workspaceRoot: workspaceRootResult.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      ...(input.title !== undefined ? { title: input.title } : {}),
      runtime: 'matcha-agent',
      lastSeq: 0,
      lastSnapshotVersion: 0,
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.permissionMode !== undefined
        ? { permissionMode: input.permissionMode }
        : {}),
      workerState: { state: 'unloaded', reason: 'notStarted' },
    }

    this.sessions.set(sessionId, session)
    return { resultType: 'created', session }
  }

  load(sessionId: string): SessionLoadResult {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { resultType: 'sessionNotFound', sessionId }
    }
    return { resultType: 'loaded', session }
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values()).sort((left, right) => {
      const updatedCompare = right.updatedAt.localeCompare(left.updatedAt)
      if (updatedCompare !== 0) return updatedCompare
      return left.sessionId.localeCompare(right.sessionId)
    })
  }

  upsert(session: SessionRecord): SessionRecord {
    this.sessions.set(session.sessionId, session)
    return session
  }

  update(
    sessionId: string,
    updater: (session: SessionRecord) => SessionRecord,
  ): SessionUpdateWorkerStateResult {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { resultType: 'sessionNotFound', sessionId }
    }

    const updated = updater(session)
    this.sessions.set(sessionId, updated)
    return { resultType: 'updated', session: updated }
  }

  close(sessionId: string): SessionCloseResult {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { resultType: 'sessionNotFound', sessionId }
    }

    this.sessions.delete(sessionId)
    return { resultType: 'closed', session }
  }

  updateWorkerState(
    sessionId: string,
    workerState: WorkerRuntimeState,
  ): SessionUpdateWorkerStateResult {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { resultType: 'sessionNotFound', sessionId }
    }

    const updated: SessionRecord = {
      ...session,
      updatedAt: this.now().toISOString(),
      workerState,
    }
    this.sessions.set(sessionId, updated)
    return { resultType: 'updated', session: updated }
  }

  private async normalizeWorkspaceRoot(
    cwd: string,
  ): Promise<WorkspaceRootResult> {
    const resolvedPath = resolve(cwd)
    try {
      const workspaceRoot = resolve(
        await this.resolveWorkspaceRoot(resolvedPath),
      )
      const sensitivePath = sensitiveWorkspacePathMessage(workspaceRoot)
      if (sensitivePath) {
        return workspaceUnavailable(cwd, workspaceRoot, sensitivePath)
      }
      return { resultType: 'resolved', workspaceRoot }
    } catch (error) {
      return workspaceUnavailable(cwd, resolvedPath, errorToMessage(error))
    }
  }
}

async function defaultResolveWorkspaceRoot(cwd: string): Promise<string> {
  return realpath(resolve(cwd))
}

function workspaceUnavailable(
  cwd: string,
  resolvedPath: string,
  message: string,
): WorkspaceUnavailableResult {
  return {
    resultType: 'workspaceUnavailable',
    cwd,
    resolvedPath,
    message,
  }
}

function sensitiveWorkspacePathMessage(
  workspaceRoot: string,
): string | undefined {
  const pathSegments = resolve(workspaceRoot).split(/[\\/]+/)
  const lastSegment = pathSegments.at(-1)

  for (const segment of pathSegments) {
    if (
      SENSITIVE_WORKSPACE_DIRECTORY_NAMES.has(normalizePathSegment(segment))
    ) {
      return `Sensitive workspace path is not allowed: ${segment}`
    }
  }

  if (
    lastSegment !== undefined &&
    SENSITIVE_WORKSPACE_FILE_NAMES.has(normalizePathSegment(lastSegment))
  ) {
    return `Sensitive workspace path is not allowed: ${lastSegment}`
  }

  return undefined
}

function normalizePathSegment(segment: string): string {
  return segment.toLowerCase()
}

function errorToMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
