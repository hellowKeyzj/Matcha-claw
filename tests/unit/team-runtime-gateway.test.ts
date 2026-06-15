import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin from '../../packages/openclaw-team-runtime-plugin/src/index'

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0')

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

function createHarness(storageRoot: string, options: { run?: ReturnType<typeof vi.fn>; managedFlows?: unknown; pluginConfig?: Record<string, unknown> } = {}) {
  const gatewayMethods = new Map<string, GatewayHandler>()
  const gatewayRequests: Array<{ method: string; params: Record<string, unknown> }> = []
  const toolFactories: ToolFactory[] = []
  const toolRegistrationOptions: ToolRegistrationOptions[] = []
  const agentEventSubscriptions: Array<{ id: string; handle: (event: any, ctx: any) => void | Promise<void> }> = []
  const runContextByRunId = new Map<string, Map<string, unknown>>()
  const run = options.run ?? vi.fn().mockResolvedValue({
    runId: 'openclaw-run-1',
  })
  const deleteSession = vi.fn().mockResolvedValue(undefined)

  async function invokeGateway(name: string, params: Record<string, unknown>) {
    const handler = gatewayMethods.get(name)
    if (!handler) {
      throw new Error(`Gateway method not registered: ${name}`)
    }
    let response: { success: boolean; data?: unknown; error?: { code: string; message: string } } | undefined
    await handler({
      params,
      respond: (success, data, error) => {
        response = { success, data, error }
      },
    })
    if (!response) {
      throw new Error(`Gateway method did not respond: ${name}`)
    }
    return response
  }

  plugin.register({
    config: {},
    pluginConfig: options.pluginConfig ?? {
      storageRoot,
      availableSkills: [
        'ascendc-operator-design',
        'ascendc-operator-code-gen',
        'ascendc-operator-code-review',
        'ascendc-operator-precision-eval',
        'ascendc-operator-performance-optim',
      ],
      availableTools: ['bash', 'code', 'read_file', 'write_file', 'edit_file'],
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
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
    agent: {
      events: {
        registerAgentEventSubscription: (subscription) => {
          agentEventSubscriptions.push(subscription)
        },
      },
    },
    runContext: {
      setRunContext: ({ runId, namespace, value, unset }) => {
        const namespaces = runContextByRunId.get(runId) ?? new Map<string, unknown>()
        if (unset) {
          namespaces.delete(namespace)
        } else {
          namespaces.set(namespace, value)
        }
        runContextByRunId.set(runId, namespaces)
        return true
      },
      getRunContext: ({ runId, namespace }) => runContextByRunId.get(runId)?.get(namespace),
      clearRunContext: ({ runId, namespace }) => {
        if (!namespace) {
          runContextByRunId.delete(runId)
          return
        }
        runContextByRunId.get(runId)?.delete(namespace)
      },
    },
    runtime: {
      llm: {
        complete: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            required: {
              leaderOnlySteps: [],
              roleOwnedSteps: [],
              finalSynthesisStep: {
                stepId: 'final-synthesis',
                title: 'Final synthesis',
                kind: 'leader_only',
                phase: 'finalize',
                dependsOnStepIds: [],
                evidence: ['workflow.md'],
              },
              finalDeliverableSections: [],
            },
            optional: {
              qualityGates: [],
              bindPolicies: {
                maxParallel: 1,
                evidence: ['bind.md'],
              },
            },
            roleContracts: [],
            diagnostics: {
              missingRequired: [],
              missingOptional: [],
              lowConfidence: [],
              evidence: ['workflow.md', 'bind.md'],
            },
          }),
        }),
      },
      subagent: { run, deleteSession },
      gateway: {
        request: async ({ method, params }: { method: string; params?: Record<string, unknown> }) => {
          gatewayRequests.push({ method, params: params ?? {} })
          const response = await invokeGateway(method, params ?? {})
          if (!response.success) {
            throw new Error(response.error?.message ?? `Gateway request failed: ${method}`)
          }
          return response.data
        },
      },
      ...(options.managedFlows ? { tasks: { managedFlows: options.managedFlows } } : {}),
    },
  } as Parameters<typeof plugin.register>[0])

  return {
    async call(name: string, params: Record<string, unknown>) {
      return await invokeGateway(name, params)
    },
    tool(name: string, context: { workspaceDir?: string; agentId?: string; sessionKey?: string } = {}) {
      const tool = toolFactories.map((factory) => factory(context)).find((candidate) => candidate.name === name)
      if (!tool) {
        throw new Error(`Tool not registered: ${name}`)
      }
      return tool
    },
    gatewayMethods,
    toolFactories,
    toolRegistrationOptions,
    agentEventSubscriptions,
    gatewayRequests,
    run,
    setRunContext(runId: string, namespace: string, value: unknown) {
      const namespaces = runContextByRunId.get(runId) ?? new Map<string, unknown>()
      namespaces.set(namespace, value)
      runContextByRunId.set(runId, namespaces)
    },
    async emitAgentEvent(event: { runId: string; stream: string; data: Record<string, unknown> }) {
      for (const subscription of agentEventSubscriptions) {
        await subscription.handle(event, {
          getRunContext: (namespace: string) => runContextByRunId.get(event.runId)?.get(namespace) as never,
          setRunContext: (namespace: string, value: unknown) => {
            const namespaces = runContextByRunId.get(event.runId) ?? new Map<string, unknown>()
            namespaces.set(namespace, value)
            runContextByRunId.set(event.runId, namespaces)
          },
          clearRunContext: (namespace?: string) => {
            if (!namespace) {
              runContextByRunId.delete(event.runId)
              return
            }
            runContextByRunId.get(event.runId)?.delete(namespace)
          },
        })
      }
    },
  }
}

describe('team-runtime gateway', () => {
  let storageRoot = ''

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-runtime-gateway-'))
  })

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true })
  })

  it('requires explicit dependency availability config instead of defaulting to an empty inventory', () => {
    expect(() => plugin.register({
      config: {},
      pluginConfig: { storageRoot },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      registerGatewayMethod: () => {},
      registerTool: () => {},
      registerHttpRoute: () => {},
      on: () => {},
      runtime: {
        subagent: {
          run: vi.fn(),
          deleteSession: vi.fn(),
        },
        gateway: {
          request: vi.fn(),
        },
      },
    } as Parameters<typeof plugin.register>[0])).toThrow('Team runtime pluginConfig.availableSkills must be an array of non-empty strings.')
  })

  it('registers TeamRun gateway methods and leader workflow tools', () => {
    const harness = createHarness(storageRoot)

    expect(Array.from(harness.gatewayMethods.keys()).sort()).toEqual([
      'matchaclaw.team.approval.resolve',
      'matchaclaw.team.dependency.plan',
      'matchaclaw.team.dispatch.process',
      'matchaclaw.team.leader.synthesis.process',
      'matchaclaw.team.package.validate',
      'matchaclaw.team.run.cancel',
      'matchaclaw.team.run.create',
      'matchaclaw.team.run.decision.submit',
      'matchaclaw.team.run.delete',
      'matchaclaw.team.run.diagnostics',
      'matchaclaw.team.run.snapshot',
      'matchaclaw.team.run.start',
      'matchaclaw.team.run.tick',
      'matchaclaw.team.workflow.plan',
    ])
    const toolNames = [
      'team_plan_workflow',
      'team_submit_artifact',
      'team_update_task',
      'team_request_approval',
      'team_send_message',
    ]
    expect(harness.toolRegistrationOptions.map((options) => options.name)).toEqual(toolNames)
    for (const toolName of toolNames) {
      expect(harness.tool(toolName).name).toBe(toolName)
    }
    expect(harness.tool('team_plan_workflow').parameters).toEqual(expect.objectContaining({
      properties: expect.objectContaining({
        tasks: expect.objectContaining({
          items: expect.objectContaining({
            required: ['taskId', 'roleId', 'title', 'prompt'],
            properties: expect.objectContaining({
              roleId: expect.objectContaining({ description: expect.stringContaining('never the managed OpenClaw agent id') }),
              prompt: expect.objectContaining({ description: expect.stringContaining('Concrete instructions') }),
            }),
          }),
        }),
        groups: expect.objectContaining({
          items: expect.objectContaining({
            required: ['groupId', 'title', 'taskIds', 'join'],
            properties: expect.objectContaining({
              join: expect.objectContaining({ required: ['requireCompleted', 'allowFailed', 'retryLimit'] }),
            }),
          }),
        }),
      }),
    }))
    expect(harness.tool('team_submit_artifact').parameters?.properties).toEqual(expect.objectContaining({
      stageId: expect.objectContaining({ description: expect.stringContaining('Workflow taskId used as stageId') }),
    }))
    expect(harness.tool('team_send_message').description).toContain('mailbox/audit only, not teammate dispatch')
  })

  it('returns dependency preparation plan with skill installers and tool blockers', async () => {
    const harness = createHarness(storageRoot, {
      pluginConfig: {
        storageRoot,
        availableSkills: ['ascendc-operator-design'],
        availableTools: ['bash'],
      },
    })

    await expect(harness.call('matchaclaw.team.dependency.plan', {
      packagePath: fixturePath,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        packageName: 'ascendc-operator-dev-optimize-team',
        canProceed: false,
        items: expect.arrayContaining([
          expect.objectContaining({ kind: 'skill', name: 'ascendc-operator-code-gen', status: 'missing', severity: 'blocker', installable: true }),
          expect.objectContaining({ kind: 'tool', name: 'code', status: 'missing', severity: 'blocker', installable: false }),
        ]),
        missingRequiredSkills: expect.arrayContaining([expect.objectContaining({ name: 'ascendc-operator-code-gen' })]),
        missingRequiredTools: expect.arrayContaining([expect.objectContaining({ name: 'code' })]),
      }),
    }))
  })

  it('validates workflow plan gateway params before dispatching to services', async () => {
    const harness = createHarness(storageRoot)

    await expect(harness.call('matchaclaw.team.workflow.plan', {
      runId: 'run-1',
      title: 'Plan',
      groups: [{ groupId: 'group-1', taskIds: ['task-1'] }],
      tasks: [{ taskId: 'task-1', roleId: 'operator-designer', title: 'Design' }],
      idempotencyKey: 'plan-1',
      status: 'running',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'invalid_request', message: 'Unexpected parameter: status' }),
    }))
    await expect(harness.call('matchaclaw.team.workflow.plan', {
      runId: 'run-1',
      title: 'Plan',
      groups: [],
      idempotencyKey: 'plan-1',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'invalid_request', message: 'tasks is required' }),
    }))
  })

  it('returns terminal do-not-retry result when a role tool targets a missing TeamRun', async () => {
    const harness = createHarness(storageRoot)
    const tool = harness.tool('team_update_task', { sessionKey: 'agent:matchaclaw-team:run:role:mct-orphan' })

    const result = await tool.execute('tool-call-1', {
      runId: 'missing-run',
      stageId: 'stage-1',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Still working',
      idempotencyKey: 'update-1',
    })
    const expectedPayload = {
      success: false,
      teamRunState: 'terminal',
      reason: 'team_run_not_found',
      retryPolicy: 'do_not_retry_team_tools',
      message: 'TeamRun not found: missing-run',
      instruction: 'The TeamRun is no longer active. Stop using TeamRun tools for this session.',
    }

    expect(result).toEqual(expect.objectContaining({
      rawResponse: expectedPayload,
      details: expectedPayload,
      renderer: { type: 'text' },
      content: [{ type: 'text', text: JSON.stringify(expectedPayload, null, 2) }],
    }))
  })

  it('auto-dispatches the first role task after team_plan_workflow without requiring run.tick', async () => {
    const run = vi.fn()
      .mockResolvedValueOnce({ runId: 'openclaw-run-leader' })
      .mockResolvedValueOnce({ runId: 'openclaw-run-role' })
    const harness = createHarness(storageRoot, { run })

    await expect(harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-auto-dispatch',
      idempotencyKey: 'create-auto-dispatch',
    })).resolves.toEqual(expect.objectContaining({ success: true }))
    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-auto-dispatch',
      idempotencyKey: 'start-auto-dispatch',
    })).resolves.toEqual(expect.objectContaining({ success: true }))

    expect(run).toHaveBeenCalledTimes(1)
    const leaderRunInput = run.mock.calls[0]?.[0]
    expect(leaderRunInput).toEqual(expect.objectContaining({
      lane: 'agent',
      deliver: true,
      sessionKey: expect.any(String),
      message: expect.stringContaining('<team_workflow_orchestration>'),
    }))

    const planTool = harness.tool('team_plan_workflow', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-auto-dispatch', 'leader'),
    })
    await expect(planTool.execute('tool-call-plan', {
      runId: 'run-auto-dispatch',
      title: 'Plan',
      groups: [{
        groupId: 'group-1',
        title: 'Group 1',
        taskIds: ['task-1'],
        join: { requireCompleted: true, allowFailed: false, retryLimit: 0 },
      }],
      tasks: [{
        taskId: 'task-1',
        roleId: 'operator-designer',
        title: 'Task 1',
        prompt: 'Do task 1',
      }],
      idempotencyKey: 'plan-auto-dispatch',
    })).resolves.toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({ success: true, created: true }),
    }))

    await expect.poll(() => run.mock.calls.length).toBe(2)
    expect(harness.gatewayRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'matchaclaw.team.dispatch.process',
        params: { runId: 'run-auto-dispatch' },
      }),
    ]))

    const snapshot = await harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-auto-dispatch',
      eventCursor: 0,
      eventLimit: 80,
    })
    const snapshotData = snapshot?.data as {
      roles?: Array<{ roleId: string; agentId: string }>
      dispatches?: Array<{ stageId: string; roleId: string }>
      dispatchExecutions?: Array<{ stageId: string; roleId: string; status: string; childSessionKey?: string }>
      dispatchTasks?: Array<{ taskId: string; roleId: string; status: string }>
      events?: Array<{ type: string }>
    }
    const operatorRoleAgentId = snapshotData.roles?.find((role) => role.roleId === 'operator-designer')?.agentId
    const roleExecution = snapshotData.dispatchExecutions?.find((execution) => (
      execution.stageId === 'task-1' && execution.roleId === 'operator-designer'
    ))

    expect(operatorRoleAgentId).toBeTruthy()
    expect(snapshot?.success).toBe(true)
    expect(snapshotData.dispatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'leader', roleId: 'leader' }),
      expect.objectContaining({ stageId: 'task-1', roleId: 'operator-designer' }),
    ]))
    expect(snapshotData.dispatchTasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'task-1', roleId: 'operator-designer', status: 'queued' }),
    ]))
    expect(snapshotData.dispatchExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'task-1', roleId: 'operator-designer', status: 'queued' }),
    ]))
    expect(snapshotData.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'workflow:planned' }),
      expect.objectContaining({ type: 'dispatch:group_queued' }),
      expect.objectContaining({ type: 'dispatch:task_queued' }),
      expect.objectContaining({ type: 'dispatch:execution_queued' }),
    ]))

    const roleRunInput = run.mock.calls[1]?.[0]
    expect(roleExecution?.childSessionKey).toBeTruthy()
    expect(roleRunInput).toEqual(expect.objectContaining({
      lane: 'agent',
      deliver: false,
      sessionKey: roleExecution?.childSessionKey,
      message: expect.stringContaining('# Team Workflow Task: task-1'),
    }))
    expect(roleRunInput.sessionKey).not.toBe(leaderRunInput.sessionKey)
    expect(roleRunInput.sessionKey).toContain(`agent:${operatorRoleAgentId}:`)
  })

  it('records ignored synthesis terminal events when tracked context is incomplete', async () => {
    const harness = createHarness(storageRoot)

    await expect(harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-synthesis-ignored',
      idempotencyKey: 'create-synthesis-ignored',
    })).resolves.toEqual(expect.objectContaining({ success: true }))
    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-synthesis-ignored',
      idempotencyKey: 'start-synthesis-ignored',
    })).resolves.toEqual(expect.objectContaining({ success: true }))

    harness.setRunContext('openclaw-run-1', 'matchaclaw.team-runtime.leader-synthesis', {
      teamRunId: 'run-synthesis-ignored',
    })
    await harness.emitAgentEvent({
      runId: 'openclaw-run-1',
      stream: 'lifecycle',
      data: { phase: 'final', message: 'terminal but incomplete' },
    })

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-synthesis-ignored',
      eventCursor: 0,
      eventLimit: 40,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'running' }),
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'leader:synthesis_terminal_ignored',
            payload: expect.objectContaining({
              reason: 'tracked_context_incomplete',
              message: 'terminal but incomplete',
            }),
          }),
        ]),
      }),
    }))
  })

  it('terminalizes TeamRun when leader synthesis lifecycle reaches final', async () => {
    const harness = createHarness(storageRoot)

    await expect(harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-synthesis-final',
      idempotencyKey: 'create-synthesis-final',
    })).resolves.toEqual(expect.objectContaining({ success: true }))
    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-synthesis-final',
      idempotencyKey: 'start-synthesis-final',
    })).resolves.toEqual(expect.objectContaining({ success: true }))

    const planTool = harness.tool('team_plan_workflow', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-synthesis-final', 'leader'),
    })
    await expect(planTool.execute('tool-call-plan', {
      runId: 'run-synthesis-final',
      title: 'Plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [{ taskId: 'task-1', roleId: 'operator-designer', title: 'Task 1', prompt: 'Do task 1' }],
      idempotencyKey: 'plan-synthesis-final',
    })).resolves.toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({ success: true }),
    }))

    const snapshotBefore = await harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-synthesis-final',
      eventCursor: 0,
      eventLimit: 40,
    })
    const snapshotData = snapshotBefore?.data as { workflowPlan?: { workflowPlanId: string }; roles?: Array<{ roleId: string; agentId: string }> }
    const workflowPlanId = snapshotData.workflowPlan?.workflowPlanId
    const operatorDesignerAgentId = snapshotData.roles?.find((role) => role.roleId === 'operator-designer')?.agentId
    expect(workflowPlanId).toBeTruthy()
    expect(operatorDesignerAgentId).toBeTruthy()
    const artifactTool = harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-synthesis-final', 'roles', 'operator-designer'),
      agentId: operatorDesignerAgentId,
      sessionKey: `agent:${operatorDesignerAgentId}:task:task-1`,
    })
    await expect(artifactTool.execute('tool-call-artifact', {
      runId: 'run-synthesis-final',
      stageId: 'task-1',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Task 1 artifact',
      content: 'Task 1 complete.',
      idempotencyKey: 'artifact-synthesis-final-task-1',
    })).resolves.toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({ success: true }),
    }))
    expect(harness.agentEventSubscriptions.map((item) => item.id)).toContain('team-runtime-leader-synthesis-terminalization')

    harness.setRunContext('openclaw-run-1', 'matchaclaw.team-runtime.leader-synthesis', {
      teamRunId: 'run-synthesis-final',
      workflowPlanId,
    })
    await harness.emitAgentEvent({
      runId: 'openclaw-run-1',
      stream: 'lifecycle',
      data: { phase: 'final' },
    })
    expect(harness.gatewayRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'matchaclaw.team.dispatch.process',
        params: { runId: 'run-synthesis-final' },
      }),
    ]))

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-synthesis-final',
      eventCursor: 0,
      eventLimit: 40,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'completed', currentStageId: 'leader' }),
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'run:completed' }),
        ]),
      }),
    }))
  })

})
