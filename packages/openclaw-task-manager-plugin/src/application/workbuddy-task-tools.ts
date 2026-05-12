import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import type { TaskItem, TodoItem } from '../domain/task-item.js'
import type { TaskStatus } from '../domain/task-status.js'
import { taskCreateParameters } from '../schemas/task-create-schema.js'
import { taskGetParameters, taskListParameters, todoWriteParameters } from '../schemas/task-store-schema.js'
import { taskUpdateParameters } from '../schemas/task-update-schema.js'
import { TaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'
import { toTaskCreateInput, toTaskUpdateInput } from './task-inputs.js'
import { asTaskDetailPayload } from './task-payloads.js'
import { getStore, getTodoStore, resolveScopeKey } from './task-store-context.js'

type ToolParams = Record<string, unknown>
type ToolContext = {
  workspaceDir?: string
  sessionKey?: string
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

function normalizeTodoStatus(value: unknown): TaskStatus {
  if (value === 'in_progress' || value === 'completed' || value === 'deleted') {
    return value
  }
  return 'pending'
}

function normalizeTodoItems(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      ...(typeof item.id === 'string' && item.id.trim() ? { id: item.id.trim() } : {}),
      content: typeof item.content === 'string' ? item.content : '',
      ...(typeof item.activeForm === 'string' && item.activeForm.trim() ? { activeForm: item.activeForm.trim() } : {}),
      status: normalizeTodoStatus(item.status),
      ...(typeof item.owner === 'string' && item.owner.trim() ? { owner: item.owner.trim() } : {}),
    }))
    .filter(item => item.content.trim().length > 0)
}

async function executeTaskCreate(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const store = getStore({ api, workspaceDir: toolCtx.workspaceDir })
  const input = toTaskCreateInput(params)
  const task = await store.create(scopeKey, {
    ...input,
    activeForm: input.activeForm || generateActiveForm(input.subject),
  })
  const todos = await loadStoredTodos(api, toolCtx, scopeKey)
  const payload = { task: asTaskDetailPayload(task), todos }
  return {
    content: [{ type: 'text' as const, text: `Task #${task.id} created successfully: ${task.subject}` }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTaskUpdate(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const store = getStore({ api, workspaceDir: toolCtx.workspaceDir })
  const input = toTaskUpdateInput(params)
  const taskId = toNonEmptyString(params.taskId, 'taskId')
  if (input.status === 'deleted') {
    const deleted = await store.delete(scopeKey, taskId)
    if (!deleted) {
      throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
    }
    const todos = await loadStoredTodos(api, toolCtx, scopeKey)
    const payload = { taskId, deleted: true, todos }
    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} deleted successfully` }],
      rawResponse: payload,
      details: payload,
      renderer: { type: 'todo' },
    }
  }
  const task = await store.update(scopeKey, taskId, input)
  if (!task) {
    throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
  }
  const todos = await loadStoredTodos(api, toolCtx, scopeKey)
  const payload = { task: asTaskDetailPayload(task), todos }
  return {
    content: [{ type: 'text' as const, text: `Updated task #${task.id}` }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTaskList(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const tasks = await getStore({ api, workspaceDir: toolCtx.workspaceDir }).list(scopeKey)
  const todos = await loadStoredTodos(api, toolCtx, scopeKey)
  const payload = { tasks: tasks.map(asTaskDetailPayload), todos }
  return {
    content: [{ type: 'text' as const, text: renderTaskList(tasks) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTaskGet(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const taskId = toNonEmptyString(params.taskId, 'taskId')
  const task = await getStore({ api, workspaceDir: toolCtx.workspaceDir }).get(scopeKey, taskId)
  if (!task) {
    throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
  }
  const payload = { task: asTaskDetailPayload(task) }
  return {
    content: [{ type: 'text' as const, text: renderTaskDetail(task) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'text' },
  }
}

async function executeTodoWrite(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const result = await getTodoStore({ api, workspaceDir: toolCtx.workspaceDir }).save(scopeKey, normalizeTodoItems(params.newTodos))
  const payload = { todos: result.todos, updatedAt: result.updatedAt }
  return {
    content: [{ type: 'text' as const, text: 'Todo list updated successfully' }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

async function executeTodoGet(api: OpenClawPluginApi, toolCtx: ToolContext, params: ToolParams) {
  const scopeKey = resolveScopeKey({ params, sessionKey: toolCtx.sessionKey })
  const result = await getTodoStore({ api, workspaceDir: toolCtx.workspaceDir }).load(scopeKey)
  const payload = { todos: result.todos, updatedAt: result.updatedAt }
  return {
    content: [{ type: 'text' as const, text: asJsonText(payload) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'todo' },
  }
}

export function registerWorkBuddyTaskTools(api: OpenClawPluginApi): void {
  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskCreate',
    label: 'Task Create',
    description: 'Create a task in the current session or team task list.',
    parameters: taskCreateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskCreate(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskUpdate',
    label: 'Task Update',
    description: 'Update task fields and status in the current session or team task list.',
    parameters: taskUpdateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskUpdate(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskList',
    label: 'Task List',
    description: 'List tasks for the current session or team task list.',
    parameters: taskListParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskList(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskGet',
    label: 'Task Get',
    description: 'Get full details for a task in the current session or team task list.',
    parameters: taskGetParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskGet(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TodoWrite',
    label: 'Todo Write',
    description: 'Persist the current todo list for this session.',
    parameters: todoWriteParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTodoWrite(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TodoGet',
    label: 'Todo Get',
    description: 'Read the current todo list for this session.',
    parameters: taskListParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTodoGet(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_create',
    label: 'Task Create',
    description: 'Compatibility wrapper for TaskCreate.',
    parameters: taskCreateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskCreate(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_update',
    label: 'Task Update',
    description: 'Compatibility wrapper for TaskUpdate.',
    parameters: taskUpdateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskUpdate(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_list',
    label: 'Task List',
    description: 'Compatibility wrapper for TaskList.',
    parameters: taskListParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskList(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_get',
    label: 'Task Get',
    description: 'Compatibility wrapper for TaskGet.',
    parameters: taskGetParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskGet(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_claim',
    label: 'Task Claim',
    description: 'Compatibility wrapper for TaskUpdate owner + in_progress.',
    parameters: taskUpdateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskUpdate(api, toolCtx, {
        ...params,
        status: 'in_progress',
      })
    },
  }))
}
