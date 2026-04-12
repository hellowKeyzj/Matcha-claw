import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { TaskStore } from '../infrastructure/task-store.js'

const DEFAULT_TASK_LIST_ID = 'default'

const storeCache = new Map<string, TaskStore>()

export function parseAgentIdFromSessionKey(sessionKey?: string): string {
  if (!sessionKey) {
    return 'main'
  }
  const matched = sessionKey.match(/^agent:([^:]+):/i)
  return matched?.[1]?.trim() || 'main'
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

function resolveTaskListId(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim()
  }
  return DEFAULT_TASK_LIST_ID
}

export function getStore(input: {
  api: OpenClawPluginApi
  workspaceDir?: unknown
  taskListId?: unknown
}): TaskStore {
  const workspaceDir = resolveWorkspaceDir({
    workspaceDir: input.workspaceDir,
    pluginConfig: input.api.pluginConfig,
  })
  const taskListId = resolveTaskListId(input.taskListId)
  const key = `${workspaceDir}::${taskListId}`
  const cached = storeCache.get(key)
  if (cached) {
    return cached
  }
  const created = new TaskStore(workspaceDir, taskListId)
  storeCache.set(key, created)
  return created
}
