import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import plugin from '../../packages/openclaw-task-manager-plugin/src/index'

type ToolResult = {
  content?: Array<{ type: string; text?: string }>
  details?: unknown
  rawResponse?: unknown
  renderer?: unknown
}

type ToolDefinition = {
  name: string
  parameters?: unknown
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<ToolResult>
}

type ToolFactory = (ctx: { workspaceDir?: string; sessionKey?: string }) => ToolDefinition
type GatewayHandler = (options: {
  params: Record<string, unknown>
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}) => Promise<void> | void

function createPluginHarness() {
  const toolFactories: ToolFactory[] = []
  const gatewayMethods = new Map<string, GatewayHandler>()
  const taskRuns = {
    resolve: (taskId: string) => taskId === 'task-run-1'
      ? {
        id: 'task-run-1',
        runtime: 'subagent',
        sessionKey: 'session-background',
        ownerKey: 'session-background',
        scope: 'session',
        title: '后台分析',
        status: 'running',
        deliveryStatus: 'delivered',
        notifyPolicy: 'state_changes',
        createdAt: 1,
        progressSummary: '分析中',
      }
      : undefined,
    cancel: async ({ taskId }: { taskId: string }) => taskId === 'task-run-1'
      ? {
        found: true,
        cancelled: true,
        task: {
          id: 'task-run-1',
          runtime: 'subagent',
          sessionKey: 'session-background',
          ownerKey: 'session-background',
          scope: 'session',
          title: '后台分析',
          status: 'cancelled',
          deliveryStatus: 'delivered',
          notifyPolicy: 'state_changes',
          createdAt: 1,
        },
      }
      : { found: false, cancelled: false, reason: 'Task not found.' },
  }

  plugin.register({
    config: {},
    pluginConfig: {},
    runtime: {
      tasks: {
        runs: {
          fromToolContext: () => taskRuns,
        },
      },
    },
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
    return await new Promise<{ success: boolean; data?: unknown; error?: { code: string; message: string } }>((resolve, reject) => {
      Promise.resolve(handler({
        params,
        respond: (success, data, error) => resolve({ success, data, error }),
      })).catch(reject)
    })
  }

  return { getTool, callGateway }
}

describe('task-manager semantics', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop() as string, { recursive: true, force: true })
    }
  })

  it('registers only final task tools and gateway methods', () => {
    const harness = createPluginHarness()

    expect(harness.getTool('TaskCreate', {}).name).toBe('TaskCreate')
    expect(harness.getTool('TaskUpdate', {}).name).toBe('TaskUpdate')
    expect(harness.getTool('TaskList', {}).name).toBe('TaskList')
    expect(harness.getTool('TaskGet', {}).name).toBe('TaskGet')
    expect(harness.getTool('TodoWrite', {}).name).toBe('TodoWrite')
    expect(harness.getTool('TodoGet', {}).name).toBe('TodoGet')
    expect(harness.getTool('TaskOutput', {}).name).toBe('TaskOutput')
    expect(harness.getTool('TaskStop', {}).name).toBe('TaskStop')
    expect(() => harness.getTool('task_create', {})).toThrow('tool not found: task_create')
  })

  it('TodoWrite schema requires explicit structured todo items and allows explicit clearing', () => {
    const harness = createPluginHarness()
    const todoWrite = harness.getTool('TodoWrite', {})

    expect(todoWrite).toMatchObject({
      name: 'TodoWrite',
      parameters: {
        required: ['newTodos'],
        properties: {
          newTodos: {
            description: expect.stringContaining('newTodos: []'),
            items: {
              required: ['content', 'status'],
              properties: {
                content: { type: 'string', description: expect.stringContaining('Required') },
                status: { enum: ['pending', 'in_progress', 'completed'], description: expect.stringContaining('Required') },
              },
            },
          },
        },
      },
    })
  })

  it('task tool schemas describe exact final tool contracts', () => {
    const harness = createPluginHarness()

    expect(harness.getTool('TaskCreate', {}).parameters).toMatchObject({
      additionalProperties: false,
      required: ['subject', 'description'],
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
      },
    })
    expect(harness.getTool('TaskUpdate', {}).parameters).toMatchObject({
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        status: { enum: ['pending', 'in_progress', 'completed', 'deleted'] },
      },
    })
    expect(harness.getTool('TaskList', {}).parameters).toMatchObject({
      additionalProperties: false,
      properties: {},
    })
    expect(harness.getTool('TaskGet', {}).parameters).toMatchObject({
      additionalProperties: false,
      required: ['taskId'],
    })
    expect(harness.getTool('TodoGet', {}).parameters).toMatchObject({
      additionalProperties: false,
      properties: {},
    })
    expect(harness.getTool('TaskOutput', {}).parameters).toMatchObject({
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
      },
    })
    expect(Object.keys((harness.getTool('TaskOutput', {}).parameters as { properties: Record<string, unknown> }).properties)).toEqual(['taskId'])
    expect(harness.getTool('TaskStop', {}).parameters).toMatchObject({
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
      },
    })
    expect(Object.keys((harness.getTool('TaskStop', {}).parameters as { properties: Record<string, unknown> }).properties)).toEqual(['taskId'])
  })

  it('TaskCreate rejects malformed parameters at the plugin boundary', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-create-invalid-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()

    await expect(harness.callGateway('TaskCreate', {
      workspaceDir,
      sessionKey: 'session-create-invalid',
      subject: '有效标题',
      description: '有效描述',
      metadata: [],
    })).resolves.toEqual({
      success: false,
      data: undefined,
      error: {
        code: 'invalid_params',
        message: 'metadata must be an object',
      },
    })

    const tool = harness.getTool('TaskCreate', { workspaceDir, sessionKey: 'session-create-invalid' })
    await expect(tool.execute('call-create-invalid', {
      subject: '有效标题',
      description: '有效描述',
      owner: '',
    })).rejects.toThrow('owner must be a non-empty string when provided')
  })

  it('TaskUpdate rejects no-op and malformed updates at the plugin boundary', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-update-invalid-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const sessionKey = 'session-update-invalid'

    await harness.callGateway('TaskCreate', {
      workspaceDir,
      sessionKey,
      subject: '待更新任务',
      description: '用于验证边界',
    })

    await expect(harness.callGateway('TaskUpdate', {
      workspaceDir,
      sessionKey,
      taskId: '1',
    })).resolves.toEqual({
      success: false,
      data: undefined,
      error: {
        code: 'invalid_params',
        message: 'TaskUpdate requires at least one field to update',
      },
    })

    await expect(harness.callGateway('TaskUpdate', {
      workspaceDir,
      sessionKey,
      taskId: '1',
      status: 'running',
    })).resolves.toMatchObject({
      success: false,
      error: {
        code: 'invalid_params',
        message: 'status must be one of: pending, in_progress, completed, deleted',
      },
    })

    const tool = harness.getTool('TaskUpdate', { workspaceDir, sessionKey })
    await expect(tool.execute('call-update-invalid-list', {
      taskId: '1',
      addBlockedBy: ['2', 3],
    })).rejects.toThrow('addBlockedBy must contain only non-empty strings')
  })

  it('TaskCreate -> TaskList -> TaskGet -> TaskUpdate uses session-scoped numeric tasks', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-session-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const sessionKey = 'session-alpha'

    const created = await harness.callGateway('TaskCreate', {
      workspaceDir,
      sessionKey,
      subject: '整理 spec',
      description: '按要求拆分模块',
      owner: 'lead',
    })
    expect(created.success).toBe(true)
    expect((created.data as { task: { id: string; status: string; owner?: string } }).task).toMatchObject({
      id: '1',
      status: 'pending',
      owner: 'lead',
    })

    const listed = await harness.callGateway('TaskList', { workspaceDir, sessionKey })
    expect(listed.success).toBe(true)
    expect((listed.data as { tasks: Array<{ id: string }> }).tasks.map(task => task.id)).toEqual(['1'])

    const got = await harness.callGateway('TaskGet', { workspaceDir, sessionKey, taskId: '1' })
    expect(got.success).toBe(true)
    expect((got.data as { task: { subject: string } }).task.subject).toBe('整理 spec')

    const updated = await harness.callGateway('TaskUpdate', {
      workspaceDir,
      sessionKey,
      taskId: '1',
      status: 'in_progress',
      metadata: { phase: 'coding' },
      addBlockedBy: ['0'],
    })
    expect(updated.success).toBe(true)
    expect((updated.data as { task: { status: string; metadata?: Record<string, unknown>; blockedBy: string[] } }).task).toMatchObject({
      status: 'in_progress',
      metadata: { phase: 'coding' },
      blockedBy: ['0'],
    })
  })

  it('TaskUpdate deleted removes the task and keeps stored todos separate from tasks', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-delete-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const sessionKey = 'session-delete'

    await harness.callGateway('TaskCreate', {
      workspaceDir,
      sessionKey,
      subject: '删除任务',
      description: '验证 deleted 语义',
    })
    await harness.callGateway('TodoWrite', {
      workspaceDir,
      sessionKey,
      newTodos: [{ content: '保留 todo', status: 'pending' }],
    })

    const deleted = await harness.callGateway('TaskUpdate', {
      workspaceDir,
      sessionKey,
      taskId: '1',
      status: 'deleted',
    })
    expect(deleted.success).toBe(true)
    expect(deleted.data).toMatchObject({
      taskId: '1',
      deleted: true,
      todos: [{ content: '保留 todo', status: 'pending' }],
    })

    const listed = await harness.callGateway('TaskList', { workspaceDir, sessionKey })
    expect((listed.data as { tasks: unknown[] }).tasks).toEqual([])
    expect((listed.data as { todos: unknown[] }).todos).toEqual([{ content: '保留 todo', status: 'pending' }])
  })

  it('metadata null deletes keys instead of replacing the whole object', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-metadata-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const sessionKey = 'session-metadata'

    await harness.callGateway('TaskCreate', {
      workspaceDir,
      sessionKey,
      subject: '元数据',
      description: '验证 merge',
      metadata: { keep: true, remove: true },
    })

    const updated = await harness.callGateway('TaskUpdate', {
      workspaceDir,
      sessionKey,
      taskId: '1',
      metadata: { remove: null, next: 2 },
    })

    expect((updated.data as { task: { metadata?: Record<string, unknown> } }).task.metadata).toEqual({
      keep: true,
      next: 2,
    })
  })

  it('TodoWrite persists todos per session', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-todos-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const todoWrite = harness.getTool('TodoWrite', { workspaceDir, sessionKey: 'session-todo' })

    const result = await todoWrite.execute('call-1', {
      newTodos: [
        { id: 'a', content: '读代码', activeForm: 'Reading code', status: 'in_progress', owner: 'main' },
        { id: 'b', content: '写实现', status: 'pending' },
      ],
    })

    expect(result.details).toMatchObject({
      todos: [
        { id: 'a', content: '读代码', activeForm: 'Reading code', status: 'in_progress', owner: 'main' },
        { id: 'b', content: '写实现', status: 'pending' },
      ],
    })
    expect(result.renderer).toEqual({ type: 'todo' })

    const listed = await harness.callGateway('TaskList', { workspaceDir, sessionKey: 'session-todo' })
    expect((listed.data as { todos: unknown[] }).todos).toEqual([
      { id: 'a', content: '读代码', activeForm: 'Reading code', status: 'in_progress', owner: 'main' },
      { id: 'b', content: '写实现', status: 'pending' },
    ])
  })

  it('TodoWrite rejects missing newTodos instead of treating it as clearing', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-todos-missing-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const todoWrite = harness.getTool('TodoWrite', { workspaceDir, sessionKey: 'session-todo-missing' })

    await expect(todoWrite.execute('call-missing', {})).rejects.toThrow('newTodos is required')

    const gatewayResult = await harness.callGateway('TodoWrite', {
      workspaceDir,
      sessionKey: 'session-todo-missing',
    })
    expect(gatewayResult).toEqual({
      success: false,
      data: undefined,
      error: {
        code: 'invalid_params',
        message: 'newTodos is required',
      },
    })
  })

  it('TodoWrite rejects malformed todo items instead of filtering or defaulting them', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-todos-invalid-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const todoWrite = harness.getTool('TodoWrite', { workspaceDir, sessionKey: 'session-todo-invalid' })

    await expect(todoWrite.execute('call-invalid-item', {
      newTodos: [{}],
    })).rejects.toThrow('newTodos[0].content is required')

    await expect(todoWrite.execute('call-invalid-status', {
      newTodos: [{ content: '状态错误', status: 'running' }],
    })).rejects.toThrow('newTodos[0].status must be one of: pending, in_progress, completed')

    await expect(harness.callGateway('TodoWrite', {
      workspaceDir,
      sessionKey: 'session-todo-invalid',
      newTodos: 'not-an-array',
    })).resolves.toEqual({
      success: false,
      data: undefined,
      error: {
        code: 'invalid_params',
        message: 'newTodos must be an array',
      },
    })
  })

  it('TodoWrite treats an explicit empty newTodos array as clearing the todo list', async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), 'task-manager-plugin-todos-clear-'))
    tempDirs.push(workspaceDir)
    const harness = createPluginHarness()
    const sessionKey = 'session-todo-clear'
    const todoWrite = harness.getTool('TodoWrite', { workspaceDir, sessionKey })

    await todoWrite.execute('call-write', {
      newTodos: [{ content: '保留到清空前', status: 'pending' }],
    })

    const cleared = await todoWrite.execute('call-clear', { newTodos: [] })
    expect(cleared.details).toMatchObject({ todos: [] })

    const listed = await harness.callGateway('TaskList', { workspaceDir, sessionKey })
    expect((listed.data as { todos: unknown[] }).todos).toEqual([])
  })

  it('TaskOutput and TaskStop read and cancel OpenClaw background task runs', async () => {
    const harness = createPluginHarness()
    const taskOutput = harness.getTool('TaskOutput', { sessionKey: 'session-background' })

    const output = await taskOutput.execute('call-output', { taskId: 'task-run-1' })
    expect(output.details).toMatchObject({
      success: true,
      taskId: 'task-run-1',
      task: {
        id: 'task-run-1',
        status: 'running',
        progressSummary: '分析中',
      },
      message: 'Task is still running. Call TaskOutput again to read later output.',
    })

    const stopped = await harness.callGateway('TaskStop', {
      sessionKey: 'session-background',
      taskId: 'task-run-1',
    })
    expect(stopped).toMatchObject({
      success: true,
      data: {
        success: true,
        taskId: 'task-run-1',
        found: true,
        cancelled: true,
        task: {
          id: 'task-run-1',
          status: 'cancelled',
        },
      },
    })
  })
})
