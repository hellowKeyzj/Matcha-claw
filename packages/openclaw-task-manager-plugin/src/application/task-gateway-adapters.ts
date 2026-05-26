import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { TaskStoreError, mapTaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'
import { executeTaskOutput, executeTaskStop } from './background-task-tools.js'
import { parseTaskCreateInput, parseTaskUpdateInput } from './task-inputs.js'
import { asTaskDetailPayload } from './task-payloads.js'
import { getStore, getTodoStore, resolveTaskScope, resolveTodoScopeKey } from './task-store-context.js'
import { parseTodoWriteInput } from './todo-inputs.js'

type GatewayParams = Record<string, unknown>
type GatewayOptions = {
  params: GatewayParams
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
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

async function withGatewayGuard(options: GatewayOptions, task: () => Promise<unknown>): Promise<void> {
  try {
    const data = await task()
    options.respond(true, data)
  } catch (error) {
    const mapped = mapTaskStoreError(error)
    options.respond(false, undefined, { code: mapped.code, message: mapped.message })
  }
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
      const scope = resolveTaskScope({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const store = getStore({ api, workspaceDir: options.params.workspaceDir })
      const task = await store.create(scope.key, parseTaskCreateInput(options.params))
      return { scope, task: asTaskDetailPayload(task) }
    })
  })

  api.registerGatewayMethod('TaskList', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scope = resolveTaskScope({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const store = getStore({ api, workspaceDir: options.params.workspaceDir })
      const tasks = await store.list(scope.key)
      logTaskPipeline(api, 'gateway.TaskList', {
        scopeKey: scope.key,
        scopeType: scope.type,
        paramSessionKey: typeof options.params.sessionKey === 'string' ? options.params.sessionKey : null,
        workspaceDir: typeof options.params.workspaceDir === 'string' ? options.params.workspaceDir : null,
        storageRoot: readPluginStorageRoot(api),
        tasksCount: tasks.length,
      })
      const todos = await loadStoredTodos(api, options.params.workspaceDir, resolveTodoScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined }))
      return { scope, tasks: tasks.map(asTaskDetailPayload), todos }
    })
  })

  api.registerGatewayMethod('TaskGet', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scope = resolveTaskScope({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const taskId = toNonEmptyString(options.params.taskId, 'taskId')
      const task = await getStore({ api, workspaceDir: options.params.workspaceDir }).get(scope.key, taskId)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }
      return { scope, task: asTaskDetailPayload(task) }
    })
  })

  api.registerGatewayMethod('TaskUpdate', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scope = resolveTaskScope({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const store = getStore({ api, workspaceDir: options.params.workspaceDir })
      const input = parseTaskUpdateInput(options.params)
      const { taskId } = input
      if (input.status === 'deleted') {
        const deleted = await store.delete(scope.key, taskId)
        if (!deleted) {
          throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
        }
        const todos = await loadStoredTodos(api, options.params.workspaceDir, resolveTodoScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined }))
        return { scope, taskId, deleted: true, todos }
      }
      const task = await store.update(scope.key, taskId, input)
      if (!task) {
        throw new TaskStoreError('task_not_found', `Task not found: ${taskId}`)
      }
      return { scope, task: asTaskDetailPayload(task) }
    })
  })

  api.registerGatewayMethod('TodoWrite', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveTodoScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
      const input = parseTodoWriteInput(options.params)
      const result = await getTodoStore({ api, workspaceDir: options.params.workspaceDir }).save(scopeKey, input.newTodos)
      logTaskPipeline(api, 'gateway.TodoWrite', {
        scopeKey,
        paramSessionKey: typeof options.params.sessionKey === 'string' ? options.params.sessionKey : null,
        workspaceDir: typeof options.params.workspaceDir === 'string' ? options.params.workspaceDir : null,
        storageRoot: readPluginStorageRoot(api),
        todosCount: result.todos.length,
      })
      return { todos: result.todos, updatedAt: result.updatedAt }
    })
  })

  api.registerGatewayMethod('TodoGet', async (options: GatewayOptions) => {
    await withGatewayGuard(options, async () => {
      const scopeKey = resolveTodoScopeKey({ params: options.params, sessionKey: options.params.sessionKey as string | undefined })
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

}
