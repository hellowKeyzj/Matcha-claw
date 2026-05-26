import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { taskOutputParameters, taskStopParameters } from '../schemas/task-store-schema.js'
import { toNonEmptyString } from '../shared/params.js'

type ToolParams = Record<string, unknown>
type ToolContext = {
  sessionKey?: string
  deliveryContext?: unknown
}
type TaskRunsRuntime = ReturnType<OpenClawPluginApi['runtime']['tasks']['runs']['fromToolContext']>
type TaskRunDetail = NonNullable<ReturnType<TaskRunsRuntime['resolve']>>
type TaskRunCancelResult = Awaited<ReturnType<TaskRunsRuntime['cancel']>>

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function bindTaskRuns(api: OpenClawPluginApi, toolCtx: ToolContext): TaskRunsRuntime {
  if (!toolCtx.sessionKey) {
    throw new Error('TaskOutput/TaskStop requires an active sessionKey.')
  }
  return api.runtime.tasks.runs.fromToolContext({
    sessionKey: toolCtx.sessionKey,
    deliveryContext: toolCtx.deliveryContext as Parameters<OpenClawPluginApi['runtime']['tasks']['runs']['fromToolContext']>[0]['deliveryContext'],
  })
}

function renderTaskOutput(task: TaskRunDetail | undefined, taskId: string): string {
  if (!task) {
    return `Background task not found: ${taskId}`
  }
  const lines = [
    `Task ID: ${task.id}`,
    `Status: ${task.status}`,
    `Runtime: ${task.runtime}`,
    `Title: ${task.title}`,
  ]
  if (task.progressSummary) lines.push(`Progress: ${task.progressSummary}`)
  if (task.terminalSummary) lines.push(`Result: ${task.terminalSummary}`)
  if (task.error) lines.push(`Error: ${task.error}`)
  if (task.status === 'queued' || task.status === 'running') {
    lines.push('Task is still running. Call TaskOutput again to read later output.')
  }
  return lines.join('\n')
}

export async function executeTaskOutput(
  api: OpenClawPluginApi,
  toolCtx: ToolContext,
  params: ToolParams,
) {
  const taskId = toNonEmptyString(params.taskId, 'taskId')
  const task = bindTaskRuns(api, toolCtx).resolve(taskId)
  const payload = {
    success: Boolean(task),
    taskId,
    ...(task ? { task } : { status: 'not_found', message: `Background task not found: ${taskId}` }),
    ...(task && (task.status === 'queued' || task.status === 'running')
      ? { message: 'Task is still running. Call TaskOutput again to read later output.' }
      : {}),
  }
  return {
    content: [{ type: 'text' as const, text: renderTaskOutput(task, taskId) }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'text' },
  }
}

export async function executeTaskStop(
  api: OpenClawPluginApi,
  toolCtx: ToolContext,
  params: ToolParams,
) {
  const taskId = toNonEmptyString(params.taskId, 'taskId')
  const taskRuns = bindTaskRuns(api, toolCtx)
  const resolved = taskRuns.resolve(taskId)
  const result: TaskRunCancelResult = resolved
    ? await taskRuns.cancel({
      taskId: resolved.id,
      cfg: api.config,
    })
    : { found: false, cancelled: false, reason: 'Task not found.' }
  const payload = {
    success: result.cancelled,
    taskId,
    found: result.found,
    cancelled: result.cancelled,
    ...(result.reason ? { message: result.reason } : {}),
    ...(result.task ? { task: result.task } : {}),
  }
  return {
    content: [{ type: 'text' as const, text: result.cancelled
      ? `Stop requested for task ${taskId}`
      : `Background task cannot be stopped or was not found: ${taskId}` }],
    rawResponse: payload,
    details: payload,
    renderer: { type: 'text' },
  }
}

export function registerBackgroundTaskTools(api: OpenClawPluginApi): void {
  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskOutput',
    label: 'Task Output',
    description: 'Read output and status from a running or completed background task by taskId. Use to inspect progress, final results, or errors before deciding whether to continue, wait, or fix failures.',
    parameters: taskOutputParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskOutput(api, toolCtx, params)
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'TaskStop',
    label: 'Task Stop',
    description: 'Stop a running background task by taskId. Use when a task is obsolete, stuck, explicitly cancelled by the user, or no longer worth waiting for; otherwise prefer TaskOutput.',
    parameters: taskStopParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      return await executeTaskStop(api, toolCtx, params)
    },
  }))
}
