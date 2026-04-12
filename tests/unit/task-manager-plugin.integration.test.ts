import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin from '../../packages/openclaw-task-manager-plugin/src/index'

type ToolDefinition = {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ details?: unknown }>
}

type ToolFactory = (ctx: { workspaceDir?: string; sessionKey?: string }) => ToolDefinition
type GatewayHandler = (options: {
  params: Record<string, unknown>
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}) => Promise<void> | void

function createPluginHarness() {
  const toolFactories: ToolFactory[] = []
  const gatewayMethods = new Map<string, GatewayHandler>()

  plugin.register({
    config: {},
    pluginConfig: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: (factory: ToolFactory) => {
      toolFactories.push(factory)
    },
    registerGatewayMethod: (name: string, handler: GatewayHandler) => {
      gatewayMethods.set(name, handler)
    },
    registerHttpRoute: () => {},
    on: () => {},
  } as any)

  const getTool = (name: string, ctx: { workspaceDir?: string; sessionKey?: string }): ToolDefinition => {
    for (const factory of toolFactories) {
      const tool = factory(ctx)
      if (tool.name === name) {
        return tool
      }
    }
    throw new Error(`tool not found: ${name}`)
  }

  const callGateway = async (method: string, params: Record<string, unknown>) => {
    const handler = gatewayMethods.get(method)
    if (!handler) {
      throw new Error(`gateway method not found: ${method}`)
    }
    const response = await new Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }>((resolve, reject) => {
      Promise.resolve(handler({
        params,
        respond: (success, data, error) => resolve({ success, data, error }),
      })).catch(reject)
    })
    return response
  }

  return { getTool, callGateway }
}

describe('task-manager plugin integration chain', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true })
    }
  })

  it('gateway 主链路覆盖 create -> list -> get -> update -> claim', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-gateway-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()

    const created = await harness.callGateway('task_manager.create', {
      workspaceDir,
      subject: '整理 spec',
      description: '按要求拆分模块',
    })
    expect(created.success).toBe(true)
    const createdTask = (created.data as { task: { id: string } }).task

    const listed = await harness.callGateway('task_manager.list', { workspaceDir })
    expect(listed.success).toBe(true)
    expect((listed.data as { tasks: Array<{ id: string }> }).tasks[0]?.id).toBe(createdTask.id)

    const got = await harness.callGateway('task_manager.get', {
      workspaceDir,
      taskId: createdTask.id,
    })
    expect(got.success).toBe(true)
    expect((got.data as { task: { subject: string } }).task.subject).toBe('整理 spec')

    const updated = await harness.callGateway('task_manager.update', {
      workspaceDir,
      taskId: createdTask.id,
      description: '按 design 6.2 拆分插件模块',
    })
    expect(updated.success).toBe(true)
    expect((updated.data as { updatedFields: string[] }).updatedFields).toContain('description')

    const claimed = await harness.callGateway('task_manager.claim', {
      workspaceDir,
      taskId: createdTask.id,
      sessionKey: 'agent:alpha:main',
    })
    expect(claimed.success).toBe(true)
    expect((claimed.data as { task: { status: string; owner?: string } }).task.status).toBe('in_progress')
    expect((claimed.data as { task: { owner?: string } }).task.owner).toBe('alpha')
  })

  it('claim 冲突时返回 already_claimed', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-claim-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()

    const taskCreate = harness.getTool('task_create', { workspaceDir })
    const created = await taskCreate.execute('call-1', {
      subject: '处理并发领取',
      description: '同一任务只能被一个 owner 领取',
    })
    const taskId = (created.details as { task: { id: string } }).task.id

    const claimByAlpha = await harness.callGateway('task_manager.claim', {
      workspaceDir,
      taskId,
      owner: 'agent-alpha',
      sessionKey: 'agent:alpha:main',
    })
    expect(claimByAlpha.success).toBe(true)

    const claimByBeta = await harness.callGateway('task_manager.claim', {
      workspaceDir,
      taskId,
      owner: 'agent-beta',
      sessionKey: 'agent:beta:main',
    })
    expect(claimByBeta.success).toBe(false)
    expect(claimByBeta.error).toEqual({
      code: 'already_claimed',
      message: 'Task already claimed by agent-alpha',
    })
  })

  it('新会话可从持久化列表恢复并按同 owner 重入 claim', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-recovery-'))
    tempDirs.push(workspaceDir)
    const firstSession = createPluginHarness()

    const created = await firstSession.callGateway('task_manager.create', {
      workspaceDir,
      subject: '恢复任务',
      description: '验证新会话可继续',
    })
    const taskId = (created.data as { task: { id: string } }).task.id

    const claimed = await firstSession.callGateway('task_manager.claim', {
      workspaceDir,
      taskId,
      sessionKey: 'agent:alpha:main',
    })
    expect(claimed.success).toBe(true)

    const secondSession = createPluginHarness()
    const listed = await secondSession.callGateway('task_manager.list', { workspaceDir })
    expect(listed.success).toBe(true)
    expect((listed.data as { tasks: Array<{ id: string; status: string; owner?: string }> }).tasks).toContainEqual(
      expect.objectContaining({
        id: taskId,
        status: 'in_progress',
        owner: 'alpha',
      }),
    )

    const reentered = await secondSession.callGateway('task_manager.claim', {
      workspaceDir,
      taskId,
      sessionKey: 'agent:alpha:resume',
    })
    expect(reentered.success).toBe(true)
    expect((reentered.data as { task: { owner?: string } }).task.owner).toBe('alpha')
  })
})
