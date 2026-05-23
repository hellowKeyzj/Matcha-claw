import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import type { TaskItem, TodoItem } from '../domain/task-item.js'
import { getStore, getTodoStore, resolveTaskScope, resolveTodoScopeKey } from './task-store-context.js'

export const TASK_MANAGEMENT_SYSTEM_CONTEXT = String.raw`<task_management>
You have access to the TaskCreate, TaskGet, TaskUpdate, and TaskList tools to help you manage tasks. Use these tools VERY frequently to ensure that you are tracking your tasks and giving the user visibility into your progress.

These tools are also EXTREMELY helpful for planning tasks, and for breaking down larger complex tasks into smaller steps. If you do not use these tools when planning, you may forget to do important tasks - and that is unacceptable.

It is critical that you mark tasks as completed as soon as you are done with a task. Do not batch up multiple tasks before marking them as completed.

Use the user's language for all task and todo text. If the user writes in Chinese, write task subjects, descriptions, todo content, and activeForm in Chinese unless explicitly asked otherwise.

Use persistent tasks for durable, cross-session or multi-agent work. Use todos for temporary steps within the current conversation, and clear them when done.

Examples:

<example>
user: Run the build and fix any type errors
assistant: I'm going to use the TaskCreate tool to create tasks:
- Run the build
- Fix any type errors

I'm now going to run the build using Bash.

Looks like I found 10 type errors. I'm going to create 10 tasks to track fixing each error.

Using TaskUpdate to mark the first task as in_progress

Let me start working on the first item...

The first item has been fixed, let me mark the first task as completed using TaskUpdate, and move on to the second item...
..
..
</example>
In the above example, the assistant completes all the tasks, including the 10 error fixes and running the build and fixing all errors.

<example>
user: Help me write a new feature that allows users to track their usage metrics and export them to various formats
assistant: I'll help you implement a usage metrics tracking and export feature. Let me first create tasks to plan this work.
Creating the following tasks:
1. Research existing metrics tracking in the codebase
2. Design the metrics collection system
3. Implement core metrics tracking functionality
4. Create export functionality for different formats

Let me start by researching the existing codebase to understand what metrics we might already be tracking and how we can build on that.

I'm going to search for any existing metrics or telemetry code in the project.

I've found some existing telemetry code. Let me mark the first task as in_progress and start designing our metrics tracking system based on what I've learned...

[Assistant continues implementing the feature step by step, marking tasks as in_progress and completed as they go]
</example>
</task_management>`

const TASK_TOOL_NAMES = new Set([
  'TaskCreate',
  'TaskGet',
  'TaskUpdate',
  'TaskList',
  'TodoWrite',
  'TodoGet',
  'TaskOutput',
  'TaskStop',
])
const TASK_TOOL_REMINDER_COOLDOWN_MS = 5 * 60 * 1000
const lastTaskToolUseAtByScope = new Map<string, number>()
const lastTaskToolReminderAtByScope = new Map<string, number>()

type HookRecord = Record<string, unknown>

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readRecord(value: unknown): HookRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as HookRecord : {}
}

function readSessionKey(event: HookRecord, ctx: HookRecord): string {
  return readString(ctx.sessionKey) || readString(event.sessionKey)
}

function readWorkspaceDir(event: HookRecord, ctx: HookRecord): string | undefined {
  return readString(ctx.workspaceDir) || readString(event.workspaceDir) || undefined
}

function readScopeKey(event: HookRecord, ctx: HookRecord): string {
  return readString(ctx.teamKey) || readString(event.teamKey) || readSessionKey(event, ctx)
}

function readTaskParams(event: HookRecord, ctx: HookRecord): Record<string, unknown> {
  return {
    ...(readString(ctx.sessionKey) ? { sessionKey: readString(ctx.sessionKey) } : {}),
    ...(readString(event.sessionKey) ? { sessionKey: readString(event.sessionKey) } : {}),
    ...(readString(ctx.teamKey) ? { teamKey: readString(ctx.teamKey) } : {}),
    ...(readString(event.teamKey) ? { teamKey: readString(event.teamKey) } : {}),
  }
}

function scopeKeyOf(storageScopeKey: string, workspaceDir?: string): string {
  return `${workspaceDir ?? ''}\n${storageScopeKey}`
}

function readToolName(event: HookRecord): string {
  const tool = readRecord(event.tool)
  const toolCall = readRecord(event.toolCall)
  const functionCall = readRecord(event.function_call)
  return readString(event.toolName)
    || readString(event.name)
    || readString(tool.name)
    || readString(toolCall.name)
    || readString(functionCall.name)
}

function formatTaskLine(task: TaskItem, tasks: TaskItem[]): string {
  let line = `- #${task.id} [${task.status}] ${task.subject}`
  if (task.owner) {
    line += ` (owner: ${task.owner})`
  }
  const openBlockers = task.blockedBy.filter((blockerId) => {
    const blocker = tasks.find(item => item.id === blockerId)
    return blocker && blocker.status !== 'completed'
  })
  if (openBlockers.length > 0) {
    line += ` (blocked by: ${openBlockers.join(', ')})`
  }
  return line
}

function formatTodoLine(todo: TodoItem): string {
  let line = `- [${todo.status}] ${todo.content}`
  if (todo.owner) {
    line += ` (owner: ${todo.owner})`
  }
  return line
}

function buildStateReminder(tasks: TaskItem[], todos: TodoItem[]): string | null {
  if (tasks.length === 0 && todos.length === 0) {
    return null
  }

  const lines = ['<system-reminder>', 'Current task manager state:']
  if (tasks.length > 0) {
    lines.push('', 'Tasks:')
    lines.push(...tasks.map(task => formatTaskLine(task, tasks)))
  }
  if (todos.length > 0) {
    lines.push('', 'Todos:')
    lines.push(...todos.map(formatTodoLine))
    lines.push('', 'Call TodoGet before TodoWrite if you need the latest oldTodos for stale update detection.')
  }
  lines.push('', 'Keep task and todo statuses current before summarizing progress to the user.', '</system-reminder>')
  return lines.join('\n')
}

function buildUnusedToolReminder(scopeKey: string): string | null {
  const now = Date.now()
  const lastUseAt = lastTaskToolUseAtByScope.get(scopeKey) ?? 0
  const lastReminderAt = lastTaskToolReminderAtByScope.get(scopeKey) ?? 0
  if (now - lastUseAt < TASK_TOOL_REMINDER_COOLDOWN_MS || now - lastReminderAt < TASK_TOOL_REMINDER_COOLDOWN_MS) {
    return null
  }
  lastTaskToolReminderAtByScope.set(scopeKey, now)
  return `<system-reminder>\nThe task management tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using them. Ignore this if it is not relevant.\n</system-reminder>`
}

async function buildDynamicReminder(api: OpenClawPluginApi, event: HookRecord, ctx: HookRecord): Promise<string | null> {
  const storageScopeKey = readScopeKey(event, ctx)
  if (!storageScopeKey) {
    return null
  }

  const taskParams = readTaskParams(event, ctx)
  const taskScope = resolveTaskScope({ params: taskParams, sessionKey: readSessionKey(event, ctx) })
  const todoScopeKey = resolveTodoScopeKey({ params: taskParams, sessionKey: readSessionKey(event, ctx) })
  const workspaceDir = readWorkspaceDir(event, ctx)
  const reminderScopeKey = scopeKeyOf(taskScope.key, workspaceDir)
  try {
    const tasks = await getStore({ api, workspaceDir }).list(taskScope.key)
    const todos = (await getTodoStore({ api, workspaceDir }).load(todoScopeKey)).todos
    return buildStateReminder(tasks, todos)
      ?? (lastTaskToolUseAtByScope.has(reminderScopeKey) ? buildUnusedToolReminder(reminderScopeKey) : null)
  } catch (error) {
    api.logger?.warn?.(`task-manager prompt reminder unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function registerTaskPromptHook(api: OpenClawPluginApi): void {
  api.on('before_prompt_build', async (event: HookRecord = {}, ctx: HookRecord = {}) => {
    const dynamicReminder = await buildDynamicReminder(api, readRecord(event), readRecord(ctx))
    return {
      appendSystemContext: dynamicReminder
        ? `${TASK_MANAGEMENT_SYSTEM_CONTEXT}\n\n${dynamicReminder}`
        : TASK_MANAGEMENT_SYSTEM_CONTEXT,
    }
  })

  api.on('after_tool_call', (event: HookRecord = {}, ctx: HookRecord = {}) => {
    const toolName = readToolName(readRecord(event))
    if (!TASK_TOOL_NAMES.has(toolName)) {
      return
    }
    const params = readTaskParams(readRecord(event), readRecord(ctx))
    const sessionKey = readSessionKey(readRecord(event), readRecord(ctx))
    if (!sessionKey) {
      return
    }
    lastTaskToolUseAtByScope.set(scopeKeyOf(resolveTaskScope({ params, sessionKey }).key, readWorkspaceDir(readRecord(event), readRecord(ctx))), Date.now())
  })
}
