import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { taskCreateParameters } from '../schemas/task-create-schema.js'
import { taskGetParameters, taskListParameters, taskClaimParameters } from '../schemas/task-store-schema.js'
import { taskUpdateParameters } from '../schemas/task-update-schema.js'
import { TaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'
import { toTaskCreateInput, toTaskUpdateInput, resolveClaimOwner } from './task-inputs.js'
import { asTaskDetailPayload, asTaskSummaryPayload } from './task-payloads.js'
import { getStore } from './task-store-context.js'

type ToolParams = Record<string, unknown>
type ToolContext = {
  workspaceDir?: string
  sessionKey?: string
}

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export function registerTaskTools(api: OpenClawPluginApi): void {
  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_create',
    label: 'Task Create',
    description: 'Create a task in the persistent task list.',
    parameters: taskCreateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const store = getStore({
        api,
        workspaceDir: toolCtx.workspaceDir,
        taskListId: params.taskListId,
      })
      const task = await store.createTask(toTaskCreateInput(params))
      const payload = { task: { id: task.id, subject: task.subject } }
      return {
        content: [{ type: 'text' as const, text: asJsonText(payload) }],
        details: payload,
      }
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_list',
    label: 'Task List',
    description: 'List task summaries for the current task list.',
    parameters: taskListParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const store = getStore({
        api,
        workspaceDir: toolCtx.workspaceDir,
        taskListId: params.taskListId,
      })
      const tasks = await store.listTaskSummaries()
      const payload = { tasks: tasks.map(asTaskSummaryPayload) }
      return {
        content: [{ type: 'text' as const, text: asJsonText(payload) }],
        details: payload,
      }
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_get',
    label: 'Task Get',
    description: 'Get full details for a task.',
    parameters: taskGetParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const store = getStore({
        api,
        workspaceDir: toolCtx.workspaceDir,
        taskListId: params.taskListId,
      })
      const taskId = toNonEmptyString(params.taskId, 'taskId')
      const task = await store.getTask(taskId)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }
      const payload = { task: asTaskDetailPayload(task) }
      return {
        content: [{ type: 'text' as const, text: asJsonText(payload) }],
        details: payload,
      }
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_update',
    label: 'Task Update',
    description: 'Update task fields and status.',
    parameters: taskUpdateParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const store = getStore({
        api,
        workspaceDir: toolCtx.workspaceDir,
        taskListId: params.taskListId,
      })
      const result = await store.updateTask(toTaskUpdateInput(params))
      const payload = {
        success: true,
        taskId: result.task.id,
        updatedFields: result.updatedFields,
        ...(result.statusChange ? { statusChange: result.statusChange } : {}),
        task: asTaskDetailPayload(result.task),
      }
      return {
        content: [{ type: 'text' as const, text: asJsonText(payload) }],
        details: payload,
      }
    },
  }))

  api.registerTool((toolCtx: ToolContext) => ({
    name: 'task_claim',
    label: 'Task Claim',
    description: 'Claim a task for an owner and mark as in_progress.',
    parameters: taskClaimParameters,
    async execute(_toolCallId: string, params: ToolParams) {
      const store = getStore({
        api,
        workspaceDir: toolCtx.workspaceDir,
        taskListId: params.taskListId,
      })
      const owner = resolveClaimOwner({
        owner: params.owner,
        sessionKey: toolCtx.sessionKey,
      })

      const task = await store.claimTask({
        taskId: toNonEmptyString(params.taskId, 'taskId'),
        owner,
      })

      const payload = {
        success: true,
        task: asTaskDetailPayload(task),
      }
      return {
        content: [{ type: 'text' as const, text: asJsonText(payload) }],
        details: payload,
      }
    },
  }))
}
