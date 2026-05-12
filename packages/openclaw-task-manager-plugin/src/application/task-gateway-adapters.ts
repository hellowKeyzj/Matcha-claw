import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { TaskStoreError, mapTaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'
import { executeTaskOutput, executeTaskStop } from './background-task-tools.js'
import { toTaskCreateInput, toTaskUpdateInput } from './task-inputs.js'
import { asTaskDetailPayload } from './task-payloads.js'
import { getStore, getTodoStore, resolveScopeKey } from './task-store-context.js'

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

function normalizeTodos(value: unknown) {
  return Array.isArray(value) ? value : []
}

function gatewayToolContext(params: GatewayParams) {
  const sessionKey = typeof params.sessionKey === 'string' && params.sessionKey.trim()
    ? params.sessionKey.trim()
    : undefined
  const deliveryContext = params.deliveryContext
  return {
    ...(sessionKey ? { sessionKey } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
  }
}

async function loadStoredTodos(api: OpenClawPluginApi, workspaceDir: unknown, scopeKey: string) {
  return (await getTodoStore({ api, workspaceDir }).load(scopeKey)).todos
}

export function registerTaskGatewayMethods(api: OpenClawPluginApi): void {
  api.registerGatewayMethod('TaskCreate', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const store = getStore({ api, workspaceDir: options.params.workspaceDir })
      const task = await store.create(scopeKey, toTaskCreateInput(options.params))
      const todos = await loadStoredTodos(api, options.params.workspaceDir, scopeKey)
      return { task: asTaskDetailPayload(task), todos }
    })
  })

  api.registerGatewayMethod('TaskList', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const store = getStore({ api, workspaceDir: options.params.workspaceDir })
      const tasks = await store.list(scopeKey)
      return { tasks: tasks.map(asTaskDetailPayload), todos: await loadStoredTodos(api, options.params.workspaceDir, scopeKey) }
    })
  })

  api.registerGatewayMethod('TaskGet', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const taskId = toNonEmptyString(options.params.taskId, 'taskId')
      const task = await getStore({ api, workspaceDir: options.params.workspaceDir }).get(scopeKey, taskId)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }
      return { task: asTaskDetailPayload(task) }
    })
  })

  api.registerGatewayMethod('TaskUpdate', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const store = getStore({ api, workspaceDir: options.params.workspaceDir })
      const input = toTaskUpdateInput(options.params)
      const taskId = toNonEmptyString(options.params.taskId, 'taskId')
      if (input.status === 'deleted') {
        const deleted = await store.delete(scopeKey, taskId)
        if (!deleted) {
          throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
        }
        return { taskId, deleted: true, todos: await loadStoredTodos(api, options.params.workspaceDir, scopeKey) }
      }
      const task = await store.update(scopeKey, taskId, input)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }
      return { task: asTaskDetailPayload(task), todos: await loadStoredTodos(api, options.params.workspaceDir, scopeKey) }
    })
  })

  api.registerGatewayMethod('TodoWrite', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const result = await getTodoStore({ api, workspaceDir: options.params.workspaceDir }).save(scopeKey, normalizeTodos(options.params.newTodos) as never)
      return { todos: result.todos, updatedAt: result.updatedAt }
    })
  })

  api.registerGatewayMethod('TodoGet', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const result = await getTodoStore({ api, workspaceDir: options.params.workspaceDir }).load(scopeKey)
      return { todos: result.todos, updatedAt: result.updatedAt }
    })
  })

  api.registerGatewayMethod('TaskOutput', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const result = await executeTaskOutput(api, gatewayToolContext(options.params), options.params)
      return result.rawResponse
    })
  })

  api.registerGatewayMethod('TaskStop', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const result = await executeTaskStop(api, gatewayToolContext(options.params), options.params)
      return result.rawResponse
    })
  })

  api.registerGatewayMethod('task_create', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const store = getStore({ api, workspaceDir: options.params.workspaceDir })
      const task = await store.create(scopeKey, toTaskCreateInput(options.params))
      return { task: asTaskDetailPayload(task), todos: await loadStoredTodos(api, options.params.workspaceDir, scopeKey) }
    })
  })

  api.registerGatewayMethod('task_update', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const taskId = toNonEmptyString(options.params.taskId, 'taskId')
      const task = await getStore({ api, workspaceDir: options.params.workspaceDir }).update(scopeKey, taskId, toTaskUpdateInput(options.params))
      if (!task) throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      return { task: asTaskDetailPayload(task), todos: await loadStoredTodos(api, options.params.workspaceDir, scopeKey) }
    })
  })

  api.registerGatewayMethod('task_list', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const tasks = await getStore({ api, workspaceDir: options.params.workspaceDir }).list(scopeKey)
      return { tasks: tasks.map(asTaskDetailPayload), todos: await loadStoredTodos(api, options.params.workspaceDir, scopeKey) }
    })
  })

  api.registerGatewayMethod('task_get', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const taskId = toNonEmptyString(options.params.taskId, 'taskId')
      const task = await getStore({ api, workspaceDir: options.params.workspaceDir }).get(scopeKey, taskId)
      if (!task) throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      return { task: asTaskDetailPayload(task) }
    })
  })

  api.registerGatewayMethod('task_claim', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const taskId = toNonEmptyString(options.params.taskId, 'taskId')
      const task = await getStore({ api, workspaceDir: options.params.workspaceDir }).update(scopeKey, taskId, {
        ...toTaskUpdateInput(options.params),
        taskId,
        status: 'in_progress',
      })
      if (!task) throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      return { task: asTaskDetailPayload(task), todos: await loadStoredTodos(api, options.params.workspaceDir, scopeKey) }
    })
  })
}
