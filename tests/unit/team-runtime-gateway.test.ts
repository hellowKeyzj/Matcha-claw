import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import plugin from '../../packages/openclaw-team-runtime-plugin/src/index'
import { SqliteTeamOutboxStore } from '../../runtime-host/application/team-runtime/infrastructure/worker/local-sqlite/sqlite-team-outbox-store'

type GatewayHandler = (options: {
  params: Record<string, unknown>
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}) => Promise<void>

type ToolFactory = (context: { workspaceDir?: string; agentId?: string; sessionKey?: string }) => {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

type ToolRegistrationOptions = { name?: string; names?: string[] }
type HarnessRegistrationMode = 'full' | 'tool-discovery'

function createHarness(storageRoot: string, registrationMode: HarnessRegistrationMode = 'full', apiIdentity: Partial<{ source: string; rootDir: string }> = {}) {
  const gatewayMethods = new Map<string, GatewayHandler>()
  const toolFactories: ToolFactory[] = []
  const toolRegistrationOptions: ToolRegistrationOptions[] = []
  const emittedAgentEvents: Record<string, unknown>[] = []
  const runtimeLifecycles: Array<{ cleanup?: () => void }> = []

  plugin.register({
    id: 'team-runtime',
    config: {},
    pluginConfig: { storageRoot },
    registrationMode,
    source: apiIdentity.source ?? 'team-runtime-source',
    rootDir: apiIdentity.rootDir ?? 'team-runtime-root',
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    lifecycle: {
      registerRuntimeLifecycle: (lifecycle: { cleanup?: () => void }) => {
        runtimeLifecycles.push(lifecycle)
      },
    },
    registerGatewayMethod: (name: string, handler: GatewayHandler) => {
      gatewayMethods.set(name, handler)
    },
    registerTool: (factory: ToolFactory, options?: ToolRegistrationOptions) => {
      toolFactories.push(factory)
      toolRegistrationOptions.push(options ?? {})
    },
    registerHttpRoute: () => {},
    on: () => {},
    runtime: {
      subagent: {
        run: async () => ({ runId: 'openclaw-run-1' }),
        deleteSession: async () => {},
      },
      gateway: {
        request: async () => undefined,
      },
    },
    agent: {
      events: {
        emitAgentEvent: (event: Record<string, unknown>) => {
          emittedAgentEvents.push(event)
          return { emitted: true, stream: event.stream }
        },
      },
    },
  } as Parameters<typeof plugin.register>[0])

  return {
    tool(name: string, context: { workspaceDir?: string; agentId?: string; sessionKey?: string } = {}) {
      const tool = toolFactories.map((factory) => factory(context)).find((candidate) => candidate.name === name)
      if (!tool) {
        throw new Error(`Tool not registered: ${name}`)
      }
      return tool
    },
    close() {
      for (const lifecycle of runtimeLifecycles) {
        lifecycle.cleanup?.()
      }
    },
    gatewayMethods,
    toolRegistrationOptions,
    emittedAgentEvents,
  }
}

async function createReaderStore(storageRoot: string): Promise<SqliteTeamOutboxStore> {
  const databasePath = path.join(storageRoot, 'team-runtime', 'outbox.sqlite')
  return await SqliteTeamOutboxStore.open({
    databasePath,
    ensureDatabaseDirectory: async () => { await mkdir(path.dirname(databasePath), { recursive: true }) },
    nowMs: () => 1000,
    randomId: () => 'reader',
  })
}

describe('team-runtime plugin tools', () => {
  let storageRoot = ''
  let harness: ReturnType<typeof createHarness> | null = null

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-runtime-gateway-'))
  })

  afterEach(async () => {
    harness?.close()
    harness = null
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('registers final Team Runtime tools without outbox gateway methods', () => {
    harness = createHarness(storageRoot)

    expect(Array.from(harness.gatewayMethods.keys()).sort()).toEqual([])
    expect(harness.toolRegistrationOptions.map((options) => options.name)).toEqual([
      'team_submit_workflow_plan',
      'team_complete_task',
      'team_request_approval',
      'team_send_message',
    ])
    expect(harness.tool('team_submit_workflow_plan').parameters).toEqual(expect.objectContaining({
      required: ['title', 'groups', 'tasks', 'idempotencyKey'],
    }))
    expect(harness.tool('team_complete_task').parameters).toEqual(expect.objectContaining({
      required: ['workflowTaskId', 'roleId', 'summary', 'idempotencyKey'],
    }))
    expect(harness.tool('team_request_approval').parameters).toEqual(expect.objectContaining({
      required: ['workflowTaskId', 'roleId', 'reason', 'requestedAction', 'risk', 'idempotencyKey'],
    }))
    expect(harness.tool('team_send_message').parameters).toEqual(expect.objectContaining({
      required: ['kind', 'fromRoleId', 'toRoleId', 'summary', 'body', 'idempotencyKey'],
    }))
    for (const toolName of ['team_submit_workflow_plan', 'team_complete_task', 'team_request_approval', 'team_send_message']) {
      expect((harness.tool(toolName).parameters?.properties as Record<string, unknown> | undefined)?.runId).toBeUndefined()
    }
  })

  it('stores final tool envelopes in SQLite outbox', async () => {
    harness = createHarness(storageRoot)
    const tool = harness.tool('team_complete_task', {
      agentId: 'role-agent-1',
      sessionKey: 'agent:role-agent-1:team-role:run-1:designer',
    })

    const result = await tool.execute('tool-call-1', {
      workflowTaskId: 'task-1',
      roleId: 'designer',
      summary: 'Completed the assigned design task.',
      evidenceRefs: [{ type: 'inlineText', text: 'Evidence', label: 'short evidence' }],
      idempotencyKey: 'complete-1',
    }) as { rawResponse: { success: boolean; outbox: { runId: string; sequence: number; status: string } } }

    expect(result.rawResponse).toEqual(expect.objectContaining({
      success: true,
      outbox: expect.objectContaining({ runId: 'run-1', sequence: 1, status: 'pending' }),
    }))
    expect(harness.emittedAgentEvents).toEqual([])

    const reader = await createReaderStore(storageRoot)
    try {
      await expect(reader.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      })).resolves.toEqual(expect.objectContaining({
        runId: 'run-1',
        records: [expect.objectContaining({ sequence: 1, status: 'claimed' })],
        hasMore: false,
      }))
    } finally {
      reader.close()
    }
  })

  it('rejects Team tools outside Team run sessions', async () => {
    harness = createHarness(storageRoot)
    const params = {
      workflowTaskId: 'task-1',
      roleId: 'designer',
      summary: 'Completed the assigned design task.',
      idempotencyKey: 'complete-1',
    }

    await expect(harness.tool('team_complete_task', { agentId: 'role-agent-1' }).execute('tool-call-missing-session', params))
      .rejects.toThrow('Team tools must be called from a Team run session')
    await expect(harness.tool('team_complete_task', { agentId: 'role-agent-1', sessionKey: 'agent:role-agent-1:task:task-1' }).execute('tool-call-invalid-session', params))
      .rejects.toThrow('Expected toolCtx.sessionKey format agent:{agentId}:team-role:{runId}:{roleId}')
  })

  it('rejects role-scoped tools when params roleId does not match the active Team role session', async () => {
    harness = createHarness(storageRoot)
    const completeTask = harness.tool('team_complete_task', {
      agentId: 'role-agent-1',
      sessionKey: 'agent:role-agent-1:team-role:run-1:designer',
    })
    const sendMessage = harness.tool('team_send_message', {
      agentId: 'role-agent-1',
      sessionKey: 'agent:role-agent-1:team-role:run-1:designer',
    })

    await expect(completeTask.execute('tool-call-role-mismatch', {
      workflowTaskId: 'task-1',
      roleId: 'developer',
      summary: 'done',
      idempotencyKey: 'complete-1',
    })).rejects.toThrow('roleId must match the active Team role session')
    await expect(sendMessage.execute('tool-call-from-role-mismatch', {
      fromRoleId: 'developer',
      toRoleId: 'leader',
      summary: 'hello',
      body: 'hello',
      idempotencyKey: 'message-1',
    })).rejects.toThrow('roleId must match the active Team role session')
  })

  it('validates workflow plan canonical shape before writing outbox records', async () => {
    harness = createHarness(storageRoot)
    const tool = harness.tool('team_submit_workflow_plan', {
      agentId: 'leader-agent-1',
      sessionKey: 'agent:leader-agent-1:team-role:run-1:leader',
    })
    const validPlan = {
      title: 'Plan',
      groups: [{ groupId: 'group-1', title: 'Group', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [{ taskId: 'task-1', roleId: 'designer', title: 'Task', prompt: 'Do task' }],
      idempotencyKey: 'plan-1',
    }

    await expect(tool.execute('tool-call-missing-field', {
      ...validPlan,
      tasks: [{ taskId: 'task-1', roleId: 'designer', title: 'Task' }],
    })).rejects.toThrow('tasks[0].prompt')
    await expect(tool.execute('tool-call-stage-id', {
      ...validPlan,
      tasks: [{ ...validPlan.tasks[0], stageId: 'stage-1' }],
    })).rejects.toThrow('tasks[0].stageId')
    await expect(tool.execute('tool-call-bad-retry', {
      ...validPlan,
      groups: [{ ...validPlan.groups[0], join: { requireCompleted: true, allowFailed: false, retryLimit: 0.5 } }],
    })).rejects.toThrow('groups[0].join.retryLimit')

    const reader = await createReaderStore(storageRoot)
    try {
      await expect(reader.pull({
        runId: 'run-1',
        afterSequence: 0,
        limit: 10,
        consumerId: 'consumer-1',
        leaseMs: 30_000,
      })).resolves.toEqual(expect.objectContaining({ runId: 'run-1', records: [] }))
    } finally {
      reader.close()
    }
  })
})
