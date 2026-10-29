import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime'
import { logTaskPipeline } from '../shared/debug-logging.js'
import { TaskStoreError, mapTaskStoreError } from '../shared/errors.js'
import { toNonEmptyString } from '../shared/params.js'
import { parseTaskCreateInput, parseTaskUpdateInput } from './task-inputs.js'
import { asTaskDetailPayload } from './task-payloads.js'
import { getStore, getTodoStore, resolveTaskScope, resolveTodoScopeKey } from './task-store-context.js'
import { parseTodoWriteInput } from './todo-inputs.js'

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

async function invokeBackgroundTask(options: GatewayOptions, name: 'TaskOutput' | 'TaskStop'): Promise<void> {
  try {
    const taskId = toNonEmptyString(options.params.taskId, 'taskId')
    const sessionKey = toNonEmptyString(options.params.sessionKey, 'sessionKey')
    const response = await dispatchGatewayMethod('tools.invoke', {
      name,
      sessionKey,
      args: { taskId },
    })
    if (!response.ok) {
      options.respond(false, undefined, {
        code: response.error?.code ?? 'internal_error',
        message: response.error?.message ?? `${name} dispatch failed.`,
      })
      return
    }
    const invocation = asRecord(response.payload)
    const output = asRecord(invocation?.output)
    const details = asRecord(output?.details)
    if (invocation?.ok !== true || output?.isError === true || details?.success !== true) {
      const error = asRecord(invocation?.error)
      options.respond(false, details, {
        code: typeof error?.code === 'string' ? error.code : typeof details?.status === 'string' ? details.status : 'internal_error',
        message: typeof error?.message === 'string' ? error.message : typeof details?.message === 'string' ? details.message : `${name} execution failed.`,
      })
      return
    }
    options.respond(true, details)
  } catch (error) {
    const mapped = mapTaskStoreError(error)
    options.respond(false, undefined, { code: mapped.code, message: mapped.message })
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
      logTaskPipeline(api, 'gateway.TaskList', tasks.length)
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
      logTaskPipeline(api, 'gateway.TodoWrite', result.todos.length)
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

  for (const name of ['TaskOutput', 'TaskStop'] as const) {
    api.registerGatewayMethod(name, async (options: GatewayOptions) => {
      await invokeBackgroundTask(options, name)
    }, { scope: 'operator.write', profileAccess: 'required', sessionAccess: { mode: 'write' } })
  }

}
