import { describe, expect, it } from 'vitest'
import plugin from '../../packages/openclaw-task-manager-plugin/src/index'

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown
type GatewayHandler = (options: any) => Promise<void> | void
type ToolFactory = (ctx: Record<string, unknown>) => { name: string }
type PluginApiLike = Parameters<NonNullable<typeof plugin.register>>[0]

function createFakeApi() {
  const hooks = new Map<string, HookHandler>()
  const tools: string[] = []
  const gatewayMethods: string[] = []

  const api = {
    config: {},
    pluginConfig: {},
    runtime: {
      tasks: {
        runs: {
          fromToolContext: () => ({
            resolve: () => undefined,
            cancel: async () => ({ found: false, cancelled: false }),
          }),
        },
      },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: (factory: ToolFactory) => {
      tools.push(factory({}).name)
    },
    registerGatewayMethod: (name: string, _handler: GatewayHandler) => {
      gatewayMethods.push(name)
    },
    registerHttpRoute: () => {},
    on: (name: string, handler: HookHandler) => {
      hooks.set(name, handler)
    },
  }

  plugin.register(api as PluginApiLike)
  return { hooks, tools, gatewayMethods }
}

describe('task-manager task-list 插件入口注册', () => {
  it('注册 task-list 工具与 task_manager 网关方法', () => {
    const { tools, gatewayMethods } = createFakeApi()

    expect(tools).toEqual([
      'TaskCreate',
      'TaskUpdate',
      'TaskList',
      'TaskGet',
      'TodoWrite',
      'TodoGet',
      'task_create',
      'task_update',
      'task_list',
      'task_get',
      'task_claim',
      'TaskOutput',
      'TaskStop',
    ])

    expect(gatewayMethods).toEqual([
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
      'TodoWrite',
      'TodoGet',
      'TaskOutput',
      'TaskStop',
      'task_create',
      'task_update',
      'task_list',
      'task_get',
      'task_claim',
    ])
  })

  it('不再注册旧 task_router/message_sending 过滤 hook', () => {
    const { hooks } = createFakeApi()
    expect(hooks.has('message_sending')).toBe(false)
  })
})
