import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { TaskStoreError, mapTaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'
import { toTaskCreateInput, toTaskUpdateInput, resolveClaimOwner } from './task-inputs.js'
import { asTaskDetailPayload, asTaskSummaryPayload } from './task-payloads.js'
import { getStore } from './task-store-context.js'

type GatewayParams = Record<string, unknown>
type GatewayOptions = {
  params: GatewayParams
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}

async function withGatewayGuard(options: GatewayOptions, task: () => Promise<unknown>): Promise<void> {
  try {
    const data = await task()
    options.respond(true, data)
  } catch (error) {
    const mapped = mapTaskStoreError(error)
    options.respond(false, undefined, { code: mapped.code, message: mapped.message })
  }
}

export function registerTaskGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod('task_manager.create', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const store = getStore({
        api,
        workspaceDir: options.params.workspaceDir,
        taskListId: options.params.taskListId,
      })
      const task = await store.createTask(toTaskCreateInput(options.params))
      return { task: asTaskDetailPayload(task) }
    })
  })

  api.registerGatewayMethod('task_manager.list', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const store = getStore({
        api,
        workspaceDir: options.params.workspaceDir,
        taskListId: options.params.taskListId,
      })
      const tasks = await store.listTaskSummaries()
      return { tasks: tasks.map(asTaskSummaryPayload) }
    })
  })

  api.registerGatewayMethod('task_manager.get', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const store = getStore({
        api,
        workspaceDir: options.params.workspaceDir,
        taskListId: options.params.taskListId,
      })
      const taskId = toNonEmptyString(options.params.taskId, 'taskId')
      const task = await store.getTask(taskId)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }
      return { task: asTaskDetailPayload(task) }
    })
  })

  api.registerGatewayMethod('task_manager.update', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const store = getStore({
        api,
        workspaceDir: options.params.workspaceDir,
        taskListId: options.params.taskListId,
      })
      const result = await store.updateTask(toTaskUpdateInput(options.params))
      return {
        success: true,
        taskId: result.task.id,
        updatedFields: result.updatedFields,
        ...(result.statusChange ? { statusChange: result.statusChange } : {}),
        task: asTaskDetailPayload(result.task),
      }
    })
  })

  api.registerGatewayMethod('task_manager.claim', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const store = getStore({
        api,
        workspaceDir: options.params.workspaceDir,
        taskListId: options.params.taskListId,
      })
      const owner = resolveClaimOwner({
        owner: options.params.owner,
        sessionKey: typeof options.params.sessionKey === 'string' ? options.params.sessionKey : undefined,
      })
      const task = await store.claimTask({
        taskId: toNonEmptyString(options.params.taskId, 'taskId'),
        owner,
      })
      return {
        success: true,
        task: asTaskDetailPayload(task),
      }
    })
  })
}
