import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { join } from 'node:path'
import { TaskStore } from '../infrastructure/session-task-store.js'
import { TodoStore } from '../infrastructure/todo-store.js'
import { toNonEmptyString } from '../shared/params.js'

const DEFAULT_STORAGE_ROOT = '.openclaw'

const taskStoreCache = new Map<string, TaskStore>()
const todoStoreCache = new Map<string, TodoStore>()

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

export function resolveScopeKey(input: {
  params?: Record<string, unknown>
  sessionKey?: string
}): string {
  const teamKey = input.params?.teamKey
  if (typeof teamKey === 'string' && teamKey.trim().length > 0) {
    return teamKey.trim()
  }
  const paramSessionKey = input.params?.sessionKey
  if (typeof paramSessionKey === 'string' && paramSessionKey.trim().length > 0) {
    return paramSessionKey.trim()
  }
  return toNonEmptyString(input.sessionKey, 'sessionKey')
}
