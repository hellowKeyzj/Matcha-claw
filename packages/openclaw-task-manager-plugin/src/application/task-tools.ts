import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import type { TaskItem, TodoItem } from '../domain/task-item.js'
import { taskCreateParameters } from '../schemas/task-create-schema.js'
import { taskGetParameters, taskListParameters, todoGetParameters, todoWriteParameters } from '../schemas/task-store-schema.js'
import { taskUpdateParameters } from '../schemas/task-update-schema.js'
import { TaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'
import { parseTaskCreateInput, parseTaskUpdateInput } from './task-inputs.js'
import { asTaskDetailPayload } from './task-payloads.js'
import { getStore, getTodoStore, resolveTaskScope, resolveTodoScopeKey } from './task-store-context.js'
import { parseTodoWriteInput } from './todo-inputs.js'

type ToolParams = Record<string, unknown>
type ToolContext = {
  workspaceDir?: string
  sessionKey?: string
}

function logTaskPipeline(api: OpenClawPluginApi, event: string, payload: Record<string, unknown>): void {
  api.logger?.debug?.(`[task-pipeline] plugin.${event} ${JSON.stringify(payload)}`)
}

function readPluginStorageRoot(api: OpenClawPluginApi): string | null {
  const config = api.pluginConfig
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null
  }
  const storageRoot = (config as Record<string, unknown>).storageRoot
  return typeof storageRoot === 'string' && storageRoot.trim() ? storageRoot.trim() : null
}

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function generateActiveForm(subject: string): string {
  const words = subject.trim().split(/\s+/)
  if (words.length === 0) {
    return subject
  }
  const first = words[0]?.toLowerCase() ?? ''
  let active = first.endsWith('e') && !first.endsWith('ee')
    ? `${first.slice(0, -1)}ing`
    : /[aeiou][^aeiou]$/i.test(first) && first.length <= 4
      ? `${first}${first.slice(-1)}ing`
      : `${first}ing`
  active = `${active.charAt(0).toUpperCase()}${active.slice(1)}`
  return [active, ...words.slice(1)].join(' ')
}

async function loadStoredTodos(api: OpenClawPluginApi, toolCtx: ToolContext, scopeKey: string): Promise<TodoItem[]> {
  return (await getTodoStore({ api, workspaceDir: toolCtx.workspaceDir }).load(scopeKey)).todos
}

function renderTaskList(tasks: TaskItem[]): string {
  if (tasks.length === 0) {
    return 'No tasks found.'
  }
  const lines: string[] = []
  for (const task of tasks) {
    let line = `#${task.id} [${task.status}] ${task.subject}`
    if (task.owner) {
      line += ` (${task.owner})`
    }
    const unresolvedBlockers = task.blockedBy.filter((blockerId) => {
      const blocker = tasks.find(item => item.id === blockerId)
      return blocker && blocker.status !== 'completed'
    })
    if (unresolvedBlockers.length > 0) {
      line += ` [blocked by: ${unresolvedBlockers.join(', ')}]`
    }
    lines.push(line)
  }
  const completed = tasks.filter(task => task.status === 'completed').length
  const inProgress = tasks.filter(task => task.status === 'in_progress').length
  const pending = tasks.filter(task => task.status === 'pending').length
  lines.push('')
  lines.push(`Summary: ${completed} completed, ${inProgress} in progress, ${pending} pending (${tasks.length} total)`)
  return lines.join('\n')
}

function renderTaskDetail(task: TaskItem): string {
  const lines = [
    `Task ID: ${task.id}`,
    `Subject: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description}`,
  ]
  if (task.activeForm) lines.push(`Active Form: ${task.activeForm}`)
  if (task.owner) lines.push(`Owner: ${task.owner}`)
  if (task.blocks.length > 0) lines.push(`Blocks: ${task.blocks.join(', ')}`)
  if (task.blockedBy.length > 0) lines.push(`Blocked By: ${task.blockedBy.join(', ')}`)
  if (task.metadata && Object.keys(task.metadata).length > 0) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`)
  return lines.join('\n')
}

async function executeTaskCreate(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scope = resolveTaskScope({ params, sessionKey: toolCtx.sessionKey })
  const store = getStore({ api, workspaceDir: toolCtx.workspaceDir })
  const input = parseTaskCreateInput(params)
  const task = await store.create(scope.key, {
    ...input,
    activeForm: input.activeForm || generateActiveForm(input.subject),
  })
  const payload = { scope, task: asTaskDetailPayload(task) }
  return {
    content: [{ type: 'text' as const, text: `Task #${task.id} created successfully: ${task.subject}` }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTaskUpdate(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scope = resolveTaskScope({ params, sessionKey: toolCtx.sessionKey })
  const store = getStore({ api, workspaceDir: toolCtx.workspaceDir })
  const input = parseTaskUpdateInput(params)
  const { taskId } = input
  if (input.status === 'deleted') {
    const deleted = await store.delete(scope.key, taskId)
    if (!deleted) {
      throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
    }
    const todos = await loadStoredTodos(api, toolCtx, resolveTodoScopeKey({ params, sessionKey: toolCtx.sessionKey }))
    const payload = { scope, taskId, deleted: true, todos }
    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} deleted successfully` }],
      rawResponse: payload,
      details: payload,
      renderer: { type: 'todo' },
    }
  }
  const task = await store.update(scope.key, taskId, input)
  if (!task) {
    throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
  }
  const payload = { scope, task: asTaskDetailPayload(task) }
  return {
    content: [{ type: 'text' as const, text: `Updated task #${task.id}` }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTaskList(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scope = resolveTaskScope({ params, sessionKey: toolCtx.sessionKey })
  const tasks = await getStore({ api, workspaceDir: toolCtx.workspaceDir }).list(scope.key)
  logTaskPipeline(api, 'tool.TaskList', {
    scopeKey: scope.key,
    scopeType: scope.type,
    toolCtxSessionKey: toolCtx.sessionKey ?? null,
    paramSessionKey: typeof params.sessionKey === 'string' ? params.sessionKey : null,
    workspaceDir: toolCtx.workspaceDir ?? null,
    storageRoot: readPluginStorageRoot(api),
    tasksCount: tasks.length,
  })
  const todos = await loadStoredTodos(api, toolCtx, resolveTodoScopeKey({ params, sessionKey: toolCtx.sessionKey }))
  const payload = { scope, tasks: tasks.map(asTaskDetailPayload), todos }
  return {
    content: [{ type: 'text' as const, text: renderTaskList(tasks) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTaskGet(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scope = resolveTaskScope({ params, sessionKey: toolCtx.sessionKey })
  const taskId = toNonEmptyString(params.taskId, 'taskId')
  const task = await getStore({ api, workspaceDir: toolCtx.workspaceDir }).get(scope.key, taskId)
  if (!task) {
    throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
  }
  const payload = { scope, task: asTaskDetailPayload(task) }
  return {
    content: [{ type: 'text' as const, text: renderTaskDetail(task) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'text' },
  }
}

async function executeTodoWrite(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveTodoScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const input = parseTodoWriteInput(params)
  const result = await getTodoStore({ api, workspaceDir: toolCtx.workspaceDir }).save(scopeKey, input.newTodos)
  logTaskPipeline(api, 'tool.TodoWrite', {
    scopeKey,
    toolCtxSessionKey: toolCtx.sessionKey ?? null,
    paramSessionKey: typeof params.sessionKey === 'string' ? params.sessionKey : null,
    workspaceDir: toolCtx.workspaceDir ?? null,
    storageRoot: readPluginStorageRoot(api),
    todosCount: result.todos.length,
  })
  const payload = { todos: result.todos, updatedAt: result.updatedAt }
  return {
    content: [{ type: 'text' as const, text: 'Todo list updated successfully' }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTodoGet(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveTodoScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const result = await getTodoStore({ api, workspaceDir: toolCtx.workspaceDir }).load(scopeKey)
  const payload = { todos: result.todos, updatedAt: result.updatedAt }
  return {
    content: [{ type: 'text' as const, text: asJsonText(payload) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

export function registerTaskTools(api: OpenClawPluginApi): void {
  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskCreate',
    label: 'Task Create',
    description: 'Create a persisted task for durable, cross-session, or multi-agent work. Use for complex multi-step work, user-requested task tracking, or work that needs owner/dependency/status management.',
    parameters: taskCreateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskCreate(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskUpdate',
    label: 'Task Update',
    description: 'Update a persisted task as work progresses. Use to mark in_progress/completed immediately, claim owner, change details, add or remove dependencies, or delete obsolete tasks.',
    parameters: taskUpdateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskUpdate(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskList',
    label: 'Task List',
    description: 'List persisted tasks and current session todos. Use before creating duplicate tasks, when choosing available unblocked work, after completing tasks, or when recovering task context.',
    parameters: taskListParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskList(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskGet',
    label: 'Task Get',
    description: 'Get full details for one persisted task by taskId. Use before starting assigned work, before updates where stale state matters, or when inspecting dependencies and acceptance criteria.',
    parameters: taskGetParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskGet(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TodoWrite',
    label: 'Todo Write',
    description: 'Create and manage the current session todo list for multi-step work. Requires oldTodos and newTodos; newTodos is the full replacement list. Use newTodos: [] to clear completed temporary todos.',
    parameters: todoWriteParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTodoWrite(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TodoGet',
    label: 'Todo Get',
    description: 'Get the current session todo list. Use before TodoWrite when you need to inspect current todos, or before clearing todos. Takes no parameters.',
    parameters: todoGetParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTodoGet(api, toolCtx, params)
    },
  }))
}
