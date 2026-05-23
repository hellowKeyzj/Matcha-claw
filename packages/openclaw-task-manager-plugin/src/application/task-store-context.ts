import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { join } from 'node:path'
import { TaskStore } from '../infrastructure/session-task-store.js'
import { TodoStore } from '../infrastructure/todo-store.js'
import { toNonEmptyString } from '../shared/params.js'

const DEFAULT_STORAGE_ROOT = '.openclaw'

const taskStoreCache = new Map<string, TaskStore>()
const todoStoreCache = new Map<string, TodoStore>()

export type TaskScope = {
  type: 'session' | 'team'
  key: string
  label: string
  sessionKey?: string
  teamKey?: string
  agentId?: string
}

function resolveWorkspaceDir(input: {
  workspaceDir?: unknown
  pluginConfig?: unknown
}): string {
  if (typeof input.workspaceDir === 'string' && input.workspaceDir.trim().length > 0) {
    return input.workspaceDir.trim()
  }
  const pluginConfig = input.pluginConfig && typeof input.pluginConfig === 'object'
    ? (input.pluginConfig as Record<string, unknown>)
    : undefined
  if (typeof pluginConfig?.storageRoot === 'string' && pluginConfig.storageRoot.trim().length > 0) {
    return pluginConfig.storageRoot.trim()
  }
  return process.cwd()
}

function resolveRootDir(input: {
  workspaceDir?: unknown
  pluginConfig?: unknown
}): string {
  const workspaceDir = resolveWorkspaceDir(input)
  const pluginConfig = input.pluginConfig && typeof input.pluginConfig === 'object'
    ? (input.pluginConfig as Record<string, unknown>)
    : undefined
  if (typeof pluginConfig?.storageRoot === 'string' && pluginConfig.storageRoot.trim().length > 0) {
    return pluginConfig.storageRoot.trim()
  }
  return join(workspaceDir, DEFAULT_STORAGE_ROOT, 'task-manager')
}

export function getStore(input: {
  api: OpenClawPluginApi
  workspaceDir?: unknown
}): TaskStore {
  const rootDir = resolveRootDir({
    workspaceDir: input.workspaceDir,
    pluginConfig: input.api.pluginConfig,
  })
  const cached = taskStoreCache.get(rootDir)
  if (cached) {
    return cached
  }
  const created = new TaskStore(rootDir)
  taskStoreCache.set(rootDir, created)
  return created
}

export function getTodoStore(input: {
  api: OpenClawPluginApi
  workspaceDir?: unknown
}): TodoStore {
  const rootDir = resolveRootDir({
    workspaceDir: input.workspaceDir,
    pluginConfig: input.api.pluginConfig,
  })
  const cached = todoStoreCache.get(rootDir)
  if (cached) {
    return cached
  }
  const created = new TodoStore(rootDir)
  todoStoreCache.set(rootDir, created)
  return created
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function parseAgentId(sessionKey: string): string | undefined {
  const match = /^agent:([^:]+):/.exec(sessionKey)
  return match?.[1]
}

function formatSessionLabel(sessionKey: string): string {
  const agentId = parseAgentId(sessionKey)
  if (!agentId) {
    return sessionKey
  }
  const suffix = sessionKey.split(':').slice(2).join(':')
  if (!suffix || suffix === 'main') {
    return `${agentId} · main`
  }
  if (suffix.startsWith('subagent:')) {
    return `${agentId} · subagent`
  }
  if (suffix.startsWith('team:')) {
    return `${agentId} · team`
  }
  return `${agentId} · ${suffix}`
}

export function resolveTaskScope(input: {
  params?: Record<string, unknown>
  sessionKey?: string
}): TaskScope {
  const teamKey = readString(input.params?.teamKey)
  if (teamKey) {
    return {
      type: 'team',
      key: `team:${teamKey}`,
      label: `Team · ${teamKey}`,
      teamKey,
    }
  }

  const sessionKey = readString(input.params?.sessionKey) || toNonEmptyString(input.sessionKey, 'sessionKey')
  const agentId = parseAgentId(sessionKey)
  return {
    type: 'session',
    key: sessionKey,
    label: formatSessionLabel(sessionKey),
    sessionKey,
    ...(agentId ? { agentId } : {}),
  }
}

export function resolveTaskScopeKey(input: {
  params?: Record<string, unknown>
  sessionKey?: string
}): string {
  return resolveTaskScope(input).key
}

export function resolveTodoScopeKey(input: {
  params?: Record<string, unknown>
  sessionKey?: string
}): string {
  const paramSessionKey = readString(input.params?.sessionKey)
  if (paramSessionKey) {
    return paramSessionKey
  }
  return toNonEmptyString(input.sessionKey, 'sessionKey')
}
