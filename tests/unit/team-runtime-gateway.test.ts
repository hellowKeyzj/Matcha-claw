import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin from '../../packages/openclaw-team-runtime-plugin/src/index'

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0')
const workflowStageIds = [
  'step-0-pre-flight-dependency-check',
  'step-1-design-operator-blueprint',
  'step-2-code-kernel-implementation',
  'step-3-adversarial-review-defect-hunting',
  'step-4-precision-validation-accuracy-verification',
  'step-5-performance-optimization-bottleneck-elimination',
  'step-6-final-emit-operator-dev-optimize-report',
]

type GatewayHandler = (options: {
  params: Record<string, unknown>
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}) => Promise<void>

type ToolFactory = (context: { workspaceDir?: string; sessionKey?: string }) => {
  name: string
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

function designCompleteReport(): string {
  return [
    '# Operator Design Report',
    '',
    '## Tiling Strategy',
    '- Split M dimension into 128-row tiles.',
    '- Use double buffering for input tiles.',
    '- Align tail handling to vector block size.',
    '',
    '## Memory Layout',
    '- Store input A in global memory contiguous by row.',
    '- Stage input B tiles into UB with 32-byte alignment.',
    '- Reuse output buffer across pipeline iterations.',
    '',
    '## Data Flow',
    '- Load shape metadata before kernel loop.',
    '- Copy input tiles from GM to UB.',
    '- Compute tile output and copy result back to GM.',
    '',
    '## Interface Specification',
    '- Accept GM pointers for input, output, and tiling data.',
    '- Validate dtype support for float16 and bfloat16.',
    '- Expose blockDim derived from tiling key.',
    '',
    '## Performance Estimation',
    '- Expected memory bandwidth utilization is 70%.',
    '- Expected vector utilization is 65%.',
    '- Tail tiles add less than 5% overhead.',
    '',
    'Verdict: DESIGN-COMPLETE',
  ].join('\n')
}

async function createRunAndSubmitArtifact(input: {
  harness: ReturnType<typeof createHarness>
  storageRoot: string
  runId: string
  roleId: string
  stageId: string
  kind: string
  content: string
  artifactKey: string
}): Promise<string> {
  await input.harness.call('matchaclaw.team.run.create', {
    packagePath: fixturePath,
    runId: input.runId,
    idempotencyKey: `create-${input.runId}`,
  })
  await input.harness.call('matchaclaw.team.run.start', {
    runId: input.runId,
    idempotencyKey: `start-${input.runId}`,
  })
  await advanceToStage(input.harness, input.storageRoot, input.runId, input.stageId)
  const submitted = await input.harness.tool('team_submit_artifact', {
    workspaceDir: path.join(input.storageRoot, 'runs', input.runId, 'roles', input.roleId),
  }).execute(`tool-${input.artifactKey}`, {
    runId: input.runId,
    stageId: input.stageId,
    roleId: input.roleId,
    kind: input.kind,
    title: input.kind,
    content: input.content,
    idempotencyKey: input.artifactKey,
  })
  return (submitted as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId
}

async function advanceToStage(harness: ReturnType<typeof createHarness>, storageRoot: string, runId: string, stageId: string): Promise<void> {
  const targetIndex = workflowStageIds.indexOf(stageId)
  if (targetIndex < 0) {
    throw new Error(`Unknown workflow stage: ${stageId}`)
  }
  for (const currentStageId of workflowStageIds.slice(1, targetIndex)) {
    const roleId = roleIdForStage(currentStageId)
    await harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', runId, 'roles', roleId),
    }).execute(`advance-${runId}-${currentStageId}`, {
      runId,
      stageId: currentStageId,
      roleId,
      kind: `${gateTypeForStage(currentStageId)}_report`,
      title: `Advance ${currentStageId}`,
      content: passingContentForStage(currentStageId),
      idempotencyKey: `advance-${runId}-${currentStageId}`,
    })
  }
}

function roleIdForStage(stageId: string): string {
  if (stageId.includes('design')) return 'operator-designer'
  if (stageId.includes('code')) return 'kernel-coder'
  if (stageId.includes('adversarial')) return 'code-adversary'
  if (stageId.includes('precision')) return 'precision-validator'
  if (stageId.includes('performance')) return 'performance-optimizer'
  throw new Error(`Stage has no role: ${stageId}`)
}

function gateTypeForStage(stageId: string): string {
  if (stageId.includes('design')) return 'design'
  if (stageId.includes('code')) return 'compile'
  if (stageId.includes('adversarial')) return 'adversary'
  if (stageId.includes('precision')) return 'precision'
  if (stageId.includes('performance')) return 'performance'
  throw new Error(`Stage has no gate: ${stageId}`)
}

function passingContentForStage(stageId: string): string {
  const gateType = gateTypeForStage(stageId)
  if (gateType === 'design') return designCompleteReport()
  if (gateType === 'compile') return 'Compilation succeeded. Verdict: CODE-COMPILABLE'
  if (gateType === 'adversary') return 'Review completed. Verdict: ACCEPTABLE-RISK'
  if (gateType === 'precision') return 'All cases passed. Verdict: PRECISION-PASS'
  if (gateType === 'performance') return 'Optimization reached target. Verdict: PERFORMANCE-TARGET-MET'
  throw new Error(`Stage has no passing content: ${stageId}`)
}

function createHarness(storageRoot: string, options: { spawn?: ReturnType<typeof vi.fn>; managedFlows?: unknown } = {}) {
  const gatewayMethods = new Map<string, GatewayHandler>()
  const toolFactories: ToolFactory[] = []
  const spawn = options.spawn ?? vi.fn().mockResolvedValue({
    status: 'accepted',
    runId: 'openclaw-run-1',
    childSessionKey: 'agent:matchaclaw-team:run:role:subagent:child',
    mode: 'run',
  })
  const deleteSession = vi.fn().mockResolvedValue(undefined)
  plugin.register({
    config: {},
    pluginConfig: {
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
    registerTool: (factory: ToolFactory) => {
      toolFactories.push(factory)
    },
    registerHttpRoute: () => {},
    on: () => {},
    runtime: {
      subagent: { spawn, deleteSession },
      ...(options.managedFlows ? { tasks: { managedFlows: options.managedFlows } } : {}),
    },
  } as Parameters<typeof plugin.register>[0])

  return {
    async call(name: string, params: Record<string, unknown>) {
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
      return response
    },
    tool(name: string, context: { workspaceDir?: string; sessionKey?: string } = {}) {
      const tool = toolFactories.map((factory) => factory(context)).find((candidate) => candidate.name === name)
      if (!tool) {
        throw new Error(`Tool not registered: ${name}`)
      }
      return tool
    },
    gatewayMethods,
    toolFactories,
    spawn,
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
          spawn: vi.fn(),
          deleteSession: vi.fn(),
        },
      },
    } as Parameters<typeof plugin.register>[0])).toThrow('Team runtime pluginConfig.availableSkills must be an array of non-empty strings.')
  })

  it('registers TeamRun lifecycle gateway methods and tools', () => {
    const harness = createHarness(storageRoot)

    expect(Array.from(harness.gatewayMethods.keys()).sort()).toEqual([
      'matchaclaw.team.approval.resolve',
      'matchaclaw.team.dispatch.execute',
      'matchaclaw.team.dispatch.prepare',
      'matchaclaw.team.gate.evaluate',
      'matchaclaw.team.package.validate',
      'matchaclaw.team.run.cancel',
      'matchaclaw.team.run.create',
      'matchaclaw.team.run.decision.submit',
      'matchaclaw.team.run.diagnostics',
      'matchaclaw.team.run.snapshot',
      'matchaclaw.team.run.start',
      'matchaclaw.team.run.tick',
      'matchaclaw.team.stage.complete',
    ])
    expect(harness.tool('team_submit_artifact').name).toBe('team_submit_artifact')
    expect(harness.tool('team_update_task').name).toBe('team_update_task')
    expect(harness.tool('team_request_approval').name).toBe('team_request_approval')
    expect(harness.tool('team_send_message').name).toBe('team_send_message')
  })

  it('returns diagnostics through the Team runtime gateway', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-diagnostics',
      idempotencyKey: 'create-diagnostics',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-diagnostics',
      idempotencyKey: 'start-diagnostics',
    })

    await expect(harness.call('matchaclaw.team.run.diagnostics', {
      runId: 'run-diagnostics',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        runId: 'run-diagnostics',
        recoveredFromStorage: true,
        budgets: expect.objectContaining({
          totalWallClockBudgetMs: 2_700_000,
          totalTokenBudget: 300_000,
          roleTokenBudget: expect.objectContaining({ 'operator-designer': 40_000 }),
        }),
        limits: expect.objectContaining({
          maxArtifactContentBytes: 2 * 1024 * 1024,
          maxMessageBodyBytes: 256 * 1024,
        }),
      }),
    }))
  })

  it('passes preflight using the explicit production dependency inventory', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-configured-preflight',
      idempotencyKey: 'create-configured-preflight',
    })

    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-configured-preflight',
      idempotencyKey: 'start-configured-preflight',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ status: 'running' }),
    }))
    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-configured-preflight',
      eventCursor: 0,
      eventLimit: 20,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running' }),
        ]),
      }),
    }))
  })

  it('auto-advances preflight on start and finishes the TeamRun on final stage completion', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-stage-complete',
      idempotencyKey: 'create-stage-complete',
    })

    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-stage-complete',
      idempotencyKey: 'start-stage-complete',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        runId: 'run-stage-complete',
        status: 'running',
      }),
    }))

    await expect(harness.call('matchaclaw.team.stage.complete', {
      runId: 'run-stage-complete',
      stageId: 'step-0-pre-flight-dependency-check',
      idempotencyKey: 'complete-preflight',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        runId: 'run-stage-complete',
        status: 'running',
        currentStageId: 'step-1-design-operator-blueprint',
      }),
    }))

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-stage-complete',
      eventCursor: 0,
      eventLimit: 20,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'passed', attempt: 1 }),
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running', attempt: 1 }),
        ]),
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'run:started', payload: expect.objectContaining({ currentStageId: 'step-0-pre-flight-dependency-check' }) }),
          expect.objectContaining({ type: 'stage:completed', payload: expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', nextStageId: 'step-1-design-operator-blueprint' }) }),
        ]),
      }),
    }))

    await advanceToStage(harness, storageRoot, 'run-stage-complete', 'step-6-final-emit-operator-dev-optimize-report')
    await harness.call('matchaclaw.team.stage.complete', {
      runId: 'run-stage-complete',
      stageId: 'step-6-final-emit-operator-dev-optimize-report',
      idempotencyKey: 'complete-step-6-final-emit-operator-dev-optimize-report',
    })

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-stage-complete',
      eventCursor: 0,
      eventLimit: 50,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'completed', currentStageId: 'step-6-final-emit-operator-dev-optimize-report' }),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-6-final-emit-operator-dev-optimize-report', status: 'passed' }),
        ]),
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'run:completed', payload: expect.objectContaining({ stageId: 'step-6-final-emit-operator-dev-optimize-report' }) }),
        ]),
      }),
    }))
  })

  it('returns native spawn failures from dispatch execution', async () => {
    const spawn = vi.fn().mockResolvedValue({ status: 'forbidden', error: 'subagent target is not allowed' })
    const harness = createHarness(storageRoot, { spawn })
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-execute-forbidden',
      idempotencyKey: 'create-execute-forbidden',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-execute-forbidden',
      idempotencyKey: 'start-execute-forbidden',
    })
    await advanceToStage(harness, storageRoot, 'run-execute-forbidden', 'step-1-design-operator-blueprint')
    const prepared = await harness.call('matchaclaw.team.dispatch.prepare', {
      runId: 'run-execute-forbidden',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-execute-forbidden',
    })
    const dispatchId = (prepared?.data as { dispatch: { dispatchId: string } }).dispatch.dispatchId

    await expect(harness.call('matchaclaw.team.dispatch.execute', {
      runId: 'run-execute-forbidden',
      dispatchId,
      idempotencyKey: 'execute-forbidden',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ message: 'subagent target is not allowed' }),
    }))
  })

  it('auto-queues first role dispatch on start and keeps tick idempotent for queued work', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-tick',
      idempotencyKey: 'create-tick',
    })

    await expect(harness.call('matchaclaw.team.run.tick', {
      runId: 'run-tick',
      idempotencyKey: 'tick-before-start',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        action: 'noop',
        status: 'created',
        reason: 'TeamRun is not running: created',
      }),
    }))

    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-tick',
      idempotencyKey: 'start-tick',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        runId: 'run-tick',
        status: 'running',
      }),
    }))

    await expect(harness.call('matchaclaw.team.run.tick', {
      runId: 'run-tick',
      idempotencyKey: 'tick-design',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        action: 'dispatch_execution_queued',
        status: 'running',
        currentStageId: 'step-1-design-operator-blueprint',
        created: false,
        dispatch: expect.objectContaining({
          stageId: 'step-1-design-operator-blueprint',
          roleId: 'operator-designer',
        }),
        execution: expect.objectContaining({
          executionId: 'openclaw-run-1',
          childSessionKey: 'agent:matchaclaw-team:run:role:subagent:child',
          spawnMode: 'run',
        }),
      }),
    }))
    await expect(harness.call('matchaclaw.team.run.tick', {
      runId: 'run-tick',
      idempotencyKey: 'tick-design',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        action: 'dispatch_execution_queued',
        created: false,
      }),
    }))

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-tick',
      eventCursor: 0,
      eventLimit: 30,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running' }),
        ]),
        dispatches: [
          expect.objectContaining({
            stageId: 'step-1-design-operator-blueprint',
            roleId: 'operator-designer',
          }),
        ],
        dispatchExecutions: [expect.objectContaining({
          executionId: 'openclaw-run-1',
          childSessionKey: 'agent:matchaclaw-team:run:role:subagent:child',
          spawnMode: 'run',
        })],
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'stage:completed', payload: expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check' }) }),
          expect.objectContaining({ type: 'dispatch:prepared', payload: expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', roleId: 'operator-designer' }) }),
          expect.objectContaining({ type: 'dispatch:execution_queued', payload: expect.objectContaining({ executionId: 'openclaw-run-1' }) }),
        ]),
      }),
    }))
  })

  it('reports role task updates without completing the active stage', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-task-update',
      idempotencyKey: 'create-task-update',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-task-update',
      idempotencyKey: 'start-task-update',
    })
    await advanceToStage(harness, storageRoot, 'run-task-update', 'step-1-design-operator-blueprint')

    const tool = harness.tool('team_update_task', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-task-update', 'roles', 'operator-designer'),
    })
    await expect(tool.execute('tool-task-update-1', {
      runId: 'run-task-update',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Need design input clarification.',
      detail: 'The tiling boundary condition is ambiguous.',
      progress: 0.4,
      idempotencyKey: 'task-update-1',
    })).resolves.toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({
        update: expect.objectContaining({ status: 'blocked', summary: 'Need design input clarification.' }),
      }),
    }))
    await expect(tool.execute('tool-task-update-complete', {
      runId: 'run-task-update',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      status: 'completed',
      summary: 'Done.',
      idempotencyKey: 'task-update-complete',
    })).rejects.toThrow('team_update_task status must be in_progress, waiting, or blocked')

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-task-update',
      eventCursor: 0,
      eventLimit: 30,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running' }),
        ]),
        events: expect.arrayContaining([
          expect.objectContaining({
            type: 'task:update_submitted',
            payload: expect.objectContaining({
              stageId: 'step-1-design-operator-blueprint',
              roleId: 'operator-designer',
              status: 'blocked',
              summary: 'Need design input clarification.',
            }),
          }),
        ]),
      }),
    }))
  })

  it('rejects Team role tools when caller context lacks workspaceDir', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-tool-context-required',
      idempotencyKey: 'create-tool-context-required',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-tool-context-required',
      idempotencyKey: 'start-tool-context-required',
    })
    await advanceToStage(harness, storageRoot, 'run-tool-context-required', 'step-1-design-operator-blueprint')

    await expect(harness.tool('team_update_task').execute('tool-context-missing-task', {
      runId: 'run-tool-context-required',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Need clarification.',
      idempotencyKey: 'tool-context-missing-task',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer')
    await expect(harness.tool('team_request_approval').execute('tool-context-missing-approval', {
      runId: 'run-tool-context-required',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      reason: 'Need user authorization.',
      requestedAction: 'Run external validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'tool-context-missing-approval',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer')
    await expect(harness.tool('team_send_message').execute('tool-context-missing-message', {
      runId: 'run-tool-context-required',
      fromRoleId: 'operator-designer',
      toRoleId: 'leader',
      summary: 'Blocked',
      body: 'Need clarification.',
      idempotencyKey: 'tool-context-missing-message',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer')
    await expect(harness.tool('team_submit_artifact').execute('tool-context-missing-artifact', {
      runId: 'run-tool-context-required',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'tool-context-missing-artifact',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer')
  })

  it('rejects artifact submission outside the active assigned role stage', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-artifact-boundary',
      idempotencyKey: 'create-artifact-boundary',
    })

    await expect(harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-artifact-boundary', 'roles', 'operator-designer'),
    }).execute('tool-artifact-not-running', {
      runId: 'run-artifact-boundary',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Design before start',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-not-running',
    })).rejects.toThrow('TeamRun is not running: run-artifact-boundary')

    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-artifact-boundary',
      idempotencyKey: 'start-artifact-boundary',
    })
    await advanceToStage(harness, storageRoot, 'run-artifact-boundary', 'step-1-design-operator-blueprint')

    await expect(harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-artifact-boundary', 'roles', 'kernel-coder'),
    }).execute('tool-artifact-pending-stage', {
      runId: 'run-artifact-boundary',
      stageId: 'step-2-code-kernel-implementation',
      roleId: 'kernel-coder',
      kind: 'compile_report',
      title: 'Code before stage',
      content: 'Compilation succeeded. Verdict: CODE-COMPILABLE',
      idempotencyKey: 'artifact-pending-stage',
    })).rejects.toThrow('TeamRun current stage is step-1-design-operator-blueprint, got step-2-code-kernel-implementation')

    await expect(harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-artifact-boundary', 'roles', 'kernel-coder'),
    }).execute('tool-artifact-wrong-role', {
      runId: 'run-artifact-boundary',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'kernel-coder',
      kind: 'design_report',
      title: 'Wrong role',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-wrong-role',
    })).rejects.toThrow('Team stage step-1-design-operator-blueprint expects role operator-designer, got kernel-coder')
  })

  it('rejects gate evaluation outside the active expected gate', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-gate-boundary',
      idempotencyKey: 'create-gate-boundary',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-gate-boundary',
      idempotencyKey: 'start-gate-boundary',
    })
    await advanceToStage(harness, storageRoot, 'run-gate-boundary', 'step-1-design-operator-blueprint')

    const submittedArtifact = await harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-gate-boundary', 'roles', 'operator-designer'),
    }).execute('tool-gate-boundary-artifact', {
      runId: 'run-gate-boundary',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-gate-boundary',
    })
    const artifactId = (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId

    await expect(harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-gate-boundary',
      artifactId,
      gateType: 'compile',
      idempotencyKey: 'gate-boundary-wrong-type',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ message: 'Team stage is not running: step-1-design-operator-blueprint' }),
    }))

    await expect(harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-gate-boundary',
      artifactId,
      gateType: 'design',
      idempotencyKey: 'gate-boundary-pass',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ created: false }),
    }))
    await expect(harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-gate-boundary',
      artifactId,
      gateType: 'design',
      idempotencyKey: 'gate-boundary-after-pass',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ created: false }),
    }))
  })

  it('creates, starts, snapshots, and cancels a TeamRun', async () => {
    const harness = createHarness(storageRoot)

    await expect(harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-1',
      idempotencyKey: 'create-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ runId: 'run-1', status: 'created', revision: 1 }),
    }))

    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-1',
      idempotencyKey: 'start-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ runId: 'run-1', status: 'running' }),
    }))
    await advanceToStage(harness, storageRoot, 'run-1', 'step-1-design-operator-blueprint')

    const submitArtifactTool = harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-1', 'roles', 'operator-designer'),
    })
    const submittedArtifact = await submitArtifactTool.execute('tool-call-1', {
      runId: 'run-1',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      summary: 'Design ready.',
      idempotencyKey: 'artifact-1',
    })
    await expect(submitArtifactTool.execute('tool-call-2', {
      runId: 'run-1',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      summary: 'Design ready.',
      idempotencyKey: 'artifact-1',
    })).resolves.toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({ created: false }),
    }))
    expect(submittedArtifact).toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({
        created: true,
        artifact: expect.objectContaining({ roleId: 'operator-designer', kind: 'design_report' }),
      }),
    }))

    const sendMessageTool = harness.tool('team_send_message', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-1', 'roles', 'operator-designer'),
    })
    const sentMessage = await sendMessageTool.execute('tool-call-4', {
      runId: 'run-1',
      fromRoleId: 'operator-designer',
      toRoleId: 'leader',
      summary: 'Design output is ready',
      body: 'The design report has been submitted and is ready for gate evaluation.',
      idempotencyKey: 'message-1',
    })
    await expect(sendMessageTool.execute('tool-call-5', {
      runId: 'run-1',
      fromRoleId: 'operator-designer',
      toRoleId: 'leader',
      summary: 'Design output is ready',
      body: 'The design report has been submitted and is ready for gate evaluation.',
      idempotencyKey: 'message-1',
    })).resolves.toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({ created: false }),
    }))
    expect(sentMessage).toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({
        created: true,
        message: expect.objectContaining({
          fromRoleId: 'operator-designer',
          toRoleId: 'leader',
          summary: 'Design output is ready',
        }),
      }),
    }))

    const artifactId = (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId
    await expect(harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-1',
      artifactId,
      gateType: 'design',
      idempotencyKey: 'gate-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        created: false,
        gate: expect.objectContaining({
          artifactId,
          gateType: 'design',
          verdict: 'DESIGN-COMPLETE',
          passed: true,
          failureItems: [],
        }),
      }),
    }))

    const snapshot = await harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-1',
      eventCursor: 0,
      eventLimit: 20,
    })

    expect(snapshot).toEqual(expect.objectContaining({ success: true }))
    const snapshotData = (snapshot as { data: any }).data
    expect(snapshotData.run).toEqual(expect.objectContaining({ runId: 'run-1', status: 'running', currentStageId: 'step-2-code-kernel-implementation' }))
    expect(snapshotData.roles).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'operator-designer', agentId: 'matchaclaw-team:run-1:operator-designer', status: 'provisioned' }),
      expect.objectContaining({ roleId: 'kernel-coder' }),
      expect.objectContaining({ roleId: 'code-adversary' }),
      expect.objectContaining({ roleId: 'precision-validator' }),
      expect.objectContaining({ roleId: 'performance-optimizer' }),
    ]))
    expect(snapshotData.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'passed', attempt: 1, maxAttempts: 1 }),
      expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'passed', attempt: 1, outputArtifactIds: [artifactId] }),
      expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'running', attempt: 1, inputArtifactIds: [artifactId] }),
      expect.objectContaining({ stageId: 'step-3-adversarial-review-defect-hunting' }),
      expect.objectContaining({ stageId: 'step-4-precision-validation-accuracy-verification' }),
      expect.objectContaining({ stageId: 'step-5-performance-optimization-bottleneck-elimination' }),
      expect.objectContaining({ stageId: 'step-6-final-emit-operator-dev-optimize-report' }),
    ]))
    expect(snapshotData.approvals).toEqual([])
    expect(snapshotData.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        roleId: 'operator-designer',
        stageId: 'step-1-design-operator-blueprint',
        kind: 'design_report',
        title: 'Operator blueprint',
        summary: 'Design ready.',
        contentRef: expect.stringMatching(/^artifacts[\\/]blobs[\\/].+\.md$/),
      }),
    ]))
    expect(snapshotData.dispatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'kernel-coder', stageId: 'step-2-code-kernel-implementation', inputArtifactIds: [artifactId] }),
    ]))
    expect(snapshotData.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromRoleId: 'operator-designer',
        toRoleId: 'leader',
        summary: 'Design output is ready',
        body: 'The design report has been submitted and is ready for gate evaluation.',
      }),
    ]))
    expect(snapshotData.gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ artifactId, gateType: 'design', verdict: 'DESIGN-COMPLETE', passed: true, failureItems: [] }),
    ]))
    expect(snapshotData.kickbacks).toEqual([])
    expect(snapshotData.decisions).toEqual([])
    expect(snapshotData.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'run:created', revision: 1 }),
      expect.objectContaining({ type: 'roles:provisioned', revision: 1 }),
      expect.objectContaining({ type: 'stages:initialized', revision: 1 }),
      expect.objectContaining({ type: 'run:started', revision: 2 }),
      expect.objectContaining({ type: 'stage:completed', revision: 3 }),
      expect.objectContaining({ type: 'artifact:submitted', revision: 3 }),
      expect.objectContaining({ type: 'message:sent' }),
      expect.objectContaining({ type: 'gate:evaluated', revision: 3 }),
      expect.objectContaining({ type: 'stage:gate_transitioned', revision: 4 }),
      expect.objectContaining({ type: 'dispatch:prepared', revision: 4 }),
    ]))

    const agentsMd = await readFile(
      path.join(storageRoot, 'runs', 'run-1', 'roles', 'operator-designer', 'AGENTS.md'),
      'utf8',
    )
    expect(agentsMd).toContain('# Role: Operator Designer')
    expect(agentsMd).not.toContain('step-1-design-operator-blueprint')
    expect(agentsMd).not.toContain('max_parallel_teammates')

    const leaderAgentsMd = await readFile(
      path.join(storageRoot, 'runs', 'run-1', 'leader', 'AGENTS.md'),
      'utf8',
    )
    expect(leaderAgentsMd).toContain('# Team Leader: ascendc-operator-dev-optimize-team')
    expect(leaderAgentsMd).toContain('matchaclaw-team:run-1:operator-designer')
    const leaderWorkflow = await readFile(
      path.join(storageRoot, 'runs', 'run-1', 'leader', 'workflow.md'),
      'utf8',
    )
    const leaderBind = await readFile(
      path.join(storageRoot, 'runs', 'run-1', 'leader', 'bind.md'),
      'utf8',
    )
    expect(leaderWorkflow).toContain('### Step 1 — Design: operator blueprint')
    expect(leaderBind).toContain('max_parallel_teammates')

    const managedConfig = JSON.parse(await readFile(
      path.join(storageRoot, 'runs', 'run-1', 'managed', 'openclaw-agents.json'),
      'utf8',
    ))
    const roleAgentIds = [
      'matchaclaw-team:run-1:operator-designer',
      'matchaclaw-team:run-1:kernel-coder',
      'matchaclaw-team:run-1:code-adversary',
      'matchaclaw-team:run-1:precision-validator',
      'matchaclaw-team:run-1:performance-optimizer',
    ]
    const leaderConfig = managedConfig.agents.find((config: { id?: string }) => config.id === 'matchaclaw-team:run-1:leader')
    expect(managedConfig).toEqual(expect.objectContaining({
      kind: 'matchaclaw-team-managed-openclaw-agents',
      source: 'matchaclaw.team-runtime',
      runId: 'run-1',
      leaderAgentId: 'matchaclaw-team:run-1:leader',
    }))
    expect(managedConfig.agents).toHaveLength(6)
    expect(leaderConfig).toEqual(expect.objectContaining({
      workspace: path.join(storageRoot, 'runs', 'run-1', 'leader'),
      agentDir: path.join(storageRoot, 'agents', 'run-1', 'leader', 'agent'),
      managedBy: 'matchaclaw.team-runtime',
      managedRunId: 'run-1',
      managedRoleId: 'leader',
      managedKind: 'team-role-agent',
      tools: expect.objectContaining({
        alsoAllow: ['sessions_spawn', 'sessions_yield', 'subagents'],
        deny: [],
      }),
      subagents: {
        allowAgents: roleAgentIds,
        requireAgentId: true,
      },
    }))

    const operatorDesignerConfig = managedConfig.agents.find((config: { id?: string }) => config.id === 'matchaclaw-team:run-1:operator-designer')
    expect(operatorDesignerConfig).toEqual(expect.objectContaining({
      workspace: path.join(storageRoot, 'runs', 'run-1', 'roles', 'operator-designer'),
      managedBy: 'matchaclaw.team-runtime',
      managedRunId: 'run-1',
      managedRoleId: 'operator-designer',
      managedKind: 'team-role-agent',
    }))
    expect(operatorDesignerConfig.subagents).toBeUndefined()
    expect(operatorDesignerConfig.tools.allow).toContain('team_update_task')
    expect(operatorDesignerConfig.tools.allow).not.toContain('sessions_spawn')

    await expect(harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-1', 'roles', 'kernel-coder'),
    }).execute('tool-call-3', {
      runId: 'run-1',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Wrong workspace',
      content: 'Invalid',
      idempotencyKey: 'artifact-wrong-workspace',
    })).rejects.toThrow('Tool caller workspace does not match role: operator-designer')
    await expect(harness.tool('team_send_message', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-1', 'roles', 'kernel-coder'),
    }).execute('tool-call-6', {
      runId: 'run-1',
      fromRoleId: 'operator-designer',
      toRoleId: 'leader',
      summary: 'Wrong workspace',
      body: 'Invalid',
      idempotencyKey: 'message-wrong-workspace',
    })).rejects.toThrow('Tool caller workspace does not match role: operator-designer')

    await expect(harness.call('matchaclaw.team.run.cancel', {
      runId: 'run-1',
      reason: 'user requested',
      idempotencyKey: 'cancel-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ runId: 'run-1', status: 'cancelled', revision: 5 }),
    }))
    await expect(harness.call('matchaclaw.team.run.cancel', {
      runId: 'run-1',
      reason: 'user requested again',
      idempotencyKey: 'cancel-terminal',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ message: 'TeamRun cannot be cancelled from terminal status cancelled: run-1' }),
    }))
    await expect(harness.tool('team_send_message', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-1', 'roles', 'operator-designer'),
    }).execute('tool-call-terminal-message', {
      runId: 'run-1',
      fromRoleId: 'operator-designer',
      toRoleId: 'leader',
      summary: 'Stale message',
      body: 'A stale role process attempted to write after cancellation.',
      idempotencyKey: 'message-after-terminal',
    })).rejects.toThrow('TeamRun cannot accept messages from terminal status cancelled: run-1')
    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-1',
      idempotencyKey: 'restart-terminal',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ message: 'TeamRun cannot be started from status cancelled: run-1' }),
    }))
  })

  it.each([
    { gateType: 'compile', stageId: 'step-2-code-kernel-implementation', passContent: 'Compilation succeeded. Verdict: CODE-COMPILABLE', passVerdict: 'CODE-COMPILABLE', failVerdict: 'CODE-HAS-ERRORS' },
    { gateType: 'adversary', stageId: 'step-3-adversarial-review-defect-hunting', passContent: 'Review completed. Verdict: ACCEPTABLE-RISK', passVerdict: 'ACCEPTABLE-RISK', failVerdict: 'BLOCK' },
    { gateType: 'precision', stageId: 'step-4-precision-validation-accuracy-verification', passContent: 'All cases passed. Verdict: PRECISION-PASS', passVerdict: 'PRECISION-PASS', failVerdict: 'PRECISION-FAIL' },
    { gateType: 'performance', stageId: 'step-5-performance-optimization-bottleneck-elimination', passContent: 'Optimization reached target. Verdict: PERFORMANCE-TARGET-MET', passVerdict: 'PERFORMANCE-TARGET-MET', failVerdict: 'PERFORMANCE-NO-GAIN' },
  ])('evaluates $gateType gate verdicts deterministically', async ({ gateType, stageId, passContent, passVerdict, failVerdict }) => {
    const harness = createHarness(storageRoot)
    const passArtifactId = await createRunAndSubmitArtifact({
      harness,
      storageRoot,
      runId: `run-${gateType}-pass`,
      roleId: roleIdForStage(stageId),
      stageId,
      kind: `${gateType}_report`,
      content: passContent,
      artifactKey: `artifact-${gateType}-pass`,
    })
    const failArtifactId = await createRunAndSubmitArtifact({
      harness,
      storageRoot,
      runId: `run-${gateType}-fail`,
      roleId: roleIdForStage(stageId),
      stageId,
      kind: `${gateType}_report`,
      content: 'No passing verdict here.',
      artifactKey: `artifact-${gateType}-fail`,
    })

    await expect(harness.call('matchaclaw.team.gate.evaluate', {
      runId: `run-${gateType}-pass`,
      artifactId: passArtifactId,
      gateType,
      idempotencyKey: `gate-${gateType}-pass`,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        created: false,
        gate: expect.objectContaining({ gateType, verdict: passVerdict, passed: true, failureItems: [] }),
      }),
    }))
    await expect(harness.call('matchaclaw.team.gate.evaluate', {
      runId: `run-${gateType}-fail`,
      artifactId: failArtifactId,
      gateType,
      idempotencyKey: `gate-${gateType}-fail`,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        created: false,
        gate: expect.objectContaining({
          gateType,
          verdict: failVerdict,
          passed: false,
          failureItems: [expect.objectContaining({ code: 'verdict_missing' })],
        }),
      }),
    }))
  })

  it('returns DESIGN-INCOMPLETE when the design artifact misses required sections', async () => {
    const harness = createHarness(storageRoot)

    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-gate-fail',
      idempotencyKey: 'create-gate-fail',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-gate-fail',
      idempotencyKey: 'start-gate-fail',
    })
    await advanceToStage(harness, storageRoot, 'run-gate-fail', 'step-1-design-operator-blueprint')
    const submitArtifactTool = harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-gate-fail', 'roles', 'operator-designer'),
    })
    const submittedArtifact = await submitArtifactTool.execute('tool-call-fail-1', {
      runId: 'run-gate-fail',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Incomplete blueprint',
      content: '# Design\n\n## Tiling Strategy\n- one item\n\nVerdict: DESIGN-COMPLETE',
      idempotencyKey: 'artifact-gate-fail',
    })
    const artifactId = (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId

    const gateResult = await harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-gate-fail',
      artifactId,
      gateType: 'design',
      idempotencyKey: 'gate-fail',
    })
    expect(gateResult).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        created: false,
        gate: expect.objectContaining({
          gateType: 'design',
          verdict: 'DESIGN-INCOMPLETE',
          passed: false,
          failureItems: expect.arrayContaining([
            expect.objectContaining({ code: 'section_too_thin' }),
            expect.objectContaining({ code: 'section_missing' }),
          ]),
        }),
      }),
    }))

    const snapshot = await harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-gate-fail',
      eventCursor: 0,
      eventLimit: 20,
    })
    const gateId = (gateResult as { data: { gate: { gateId: string } } }).data.gate.gateId
    expect(snapshot).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running', attempt: 2, outputArtifactIds: [artifactId] }),
          expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'pending', inputArtifactIds: [] }),
        ]),
        kickbacks: [expect.objectContaining({
          stageId: 'step-1-design-operator-blueprint',
          gateId,
          failureItems: expect.arrayContaining([
            expect.objectContaining({ code: 'section_too_thin' }),
            expect.objectContaining({ code: 'section_missing' }),
          ]),
        })],
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'stage:gate_transitioned' }),
          expect.objectContaining({ type: 'kickback:issued' }),
        ]),
      }),
    }))
    expect(JSON.stringify((snapshot as { data: { kickbacks: unknown[] } }).data.kickbacks)).not.toContain('Verdict: DESIGN-COMPLETE')

    const secondSubmittedArtifact = await submitArtifactTool.execute('tool-call-fail-2', {
      runId: 'run-gate-fail',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Still incomplete blueprint',
      content: '# Design\n\n## Memory Layout\n- one item\n\nVerdict: DESIGN-COMPLETE',
      idempotencyKey: 'artifact-gate-fail-2',
    })
    const secondArtifactId = (secondSubmittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId
    await expect(harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-gate-fail',
      artifactId: secondArtifactId,
      gateType: 'design',
      idempotencyKey: 'gate-fail-2',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        created: false,
        gate: expect.objectContaining({ passed: false, verdict: 'DESIGN-INCOMPLETE' }),
      }),
    }))

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-gate-fail',
      eventCursor: 0,
      eventLimit: 30,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'waiting_for_user', currentStageId: 'step-1-design-operator-blueprint' }),
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: 'step-1-design-operator-blueprint',
            status: 'waiting_for_user',
            attempt: 2,
            maxAttempts: 2,
            outputArtifactIds: expect.arrayContaining([artifactId, secondArtifactId]),
          }),
        ]),
        kickbacks: [
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint' }),
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint' }),
        ],
        decisions: [],
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'stage:gate_transitioned', payload: expect.objectContaining({ exhausted: true }) }),
        ]),
      }),
    }))
  })

  it('requests approval from a role tool and resumes after approval', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-approval',
      idempotencyKey: 'create-approval',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-approval',
      idempotencyKey: 'start-approval',
    })
    await advanceToStage(harness, storageRoot, 'run-approval', 'step-1-design-operator-blueprint')
    const submittedArtifact = await harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-approval', 'roles', 'operator-designer'),
    }).execute('tool-call-approval-design', {
      runId: 'run-approval',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-approval-design',
    })
    await harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-approval',
      artifactId: (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId,
      gateType: 'design',
      idempotencyKey: 'gate-approval-design',
    })

    const approvalResult = await harness.tool('team_request_approval', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-approval', 'roles', 'kernel-coder'),
    }).execute('tool-call-approval-request', {
      runId: 'run-approval',
      stageId: 'step-2-code-kernel-implementation',
      roleId: 'kernel-coder',
      reason: 'Live NPU compile validation requires explicit user authorization.',
      requestedAction: 'Run NPU-backed compile validation.',
      risk: 'Uses external NPU hardware and may consume quota.',
      idempotencyKey: 'approval-request-1',
    })
    await expect(harness.tool('team_request_approval', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-approval', 'roles', 'kernel-coder'),
    }).execute('tool-call-approval-request-2', {
      runId: 'run-approval',
      stageId: 'step-2-code-kernel-implementation',
      roleId: 'kernel-coder',
      reason: 'Live NPU compile validation requires explicit user authorization.',
      requestedAction: 'Run NPU-backed compile validation.',
      risk: 'Uses external NPU hardware and may consume quota.',
      idempotencyKey: 'approval-request-1',
    })).resolves.toEqual(expect.objectContaining({
      rawResponse: expect.objectContaining({ created: false }),
    }))
    const approvalId = (approvalResult as { rawResponse: { approval: { approvalId: string } } }).rawResponse.approval.approvalId

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-approval',
      eventCursor: 0,
      eventLimit: 30,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'waiting_for_user', currentStageId: 'step-2-code-kernel-implementation' }),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'waiting_for_user' }),
        ]),
        approvals: [expect.objectContaining({
          approvalId,
          roleId: 'kernel-coder',
          status: 'pending',
          requestedAction: 'Run NPU-backed compile validation.',
        })],
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'approval:requested', payload: expect.objectContaining({ approvalId }) }),
        ]),
      }),
    }))

    await expect(harness.call('matchaclaw.team.approval.resolve', {
      runId: 'run-approval',
      approvalId,
      decision: 'approve',
      note: 'Approved for this run only.',
      idempotencyKey: 'approval-resolve-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        approval: expect.objectContaining({ status: 'approved', note: 'Approved for this run only.' }),
      }),
    }))
    await expect(harness.call('matchaclaw.team.approval.resolve', {
      runId: 'run-approval',
      approvalId,
      decision: 'approve',
      note: 'Approved for this run only.',
      idempotencyKey: 'approval-resolve-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ approval: expect.objectContaining({ status: 'approved' }) }),
    }))

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-approval',
      eventCursor: 0,
      eventLimit: 40,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'running', currentStageId: 'step-2-code-kernel-implementation' }),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'running' }),
        ]),
        approvals: [expect.objectContaining({ approvalId, status: 'approved' })],
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'approval:resolved', payload: expect.objectContaining({ approvalId, decision: 'approve' }) }),
        ]),
      }),
    }))
  })

  it('prepares durable dispatch prompts with artifacts and idempotency', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-dispatch',
      idempotencyKey: 'create-dispatch',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-dispatch',
      idempotencyKey: 'start-dispatch',
    })
    await advanceToStage(harness, storageRoot, 'run-dispatch', 'step-1-design-operator-blueprint')
    const submittedArtifact = await harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-dispatch', 'roles', 'operator-designer'),
    }).execute('tool-call-dispatch-artifact', {
      runId: 'run-dispatch',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-dispatch',
    })
    const artifactId = (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId

    const prepared = await harness.call('matchaclaw.team.dispatch.prepare', {
      runId: 'run-dispatch',
      stageId: 'step-2-code-kernel-implementation',
      idempotencyKey: 'dispatch-1',
    })
    expect(prepared).toEqual(expect.objectContaining({ success: true }))
    const preparedData = (prepared as { data: any }).data
    expect(preparedData).toEqual(expect.objectContaining({
      created: false,
      dispatch: expect.objectContaining({
        stageId: 'step-2-code-kernel-implementation',
        roleId: 'kernel-coder',
        inputArtifactIds: [artifactId],
        kickbackIds: [],
        promptRef: expect.stringMatching(/^dispatches[\\/]prompts[\\/].+\.md$/),
      }),
      prompt: expect.stringContaining('ROLE: Kernel Coder in a Teamskill.'),
    }))
    expect(preparedData.prompt).toContain('Verdict: DESIGN-COMPLETE')
    expect(preparedData.prompt).toContain('## NPU Authorization Guardrail')
    expect(preparedData.prompt).toContain('team_request_approval')
    await expect(harness.call('matchaclaw.team.dispatch.prepare', {
      runId: 'run-dispatch',
      stageId: 'step-2-code-kernel-implementation',
      idempotencyKey: 'dispatch-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ created: false }),
    }))

    const dispatchSnapshot = await harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-dispatch',
      eventCursor: 0,
      eventLimit: 30,
    })
    expect(dispatchSnapshot).toEqual(expect.objectContaining({ success: true }))
    const dispatchSnapshotData = (dispatchSnapshot as { data: any }).data
    expect(dispatchSnapshotData.dispatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ roleId: 'kernel-coder', stageId: 'step-2-code-kernel-implementation' }),
    ]))
    expect(dispatchSnapshotData.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'dispatch:prepared', payload: expect.objectContaining({ roleId: 'kernel-coder' }) }),
    ]))
  })

  it('runs the full role pipeline through artifact submissions without manual gate or stage completion', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-full-auto',
      idempotencyKey: 'create-full-auto',
    })
    await expect(harness.call('matchaclaw.team.run.start', {
      runId: 'run-full-auto',
      idempotencyKey: 'start-full-auto',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ runId: 'run-full-auto', status: 'running' }),
    }))

    const submissions = [
      {
        stageId: 'step-1-design-operator-blueprint',
        roleId: 'operator-designer',
        kind: 'design_report',
        title: 'Operator blueprint',
        content: designCompleteReport(),
      },
      {
        stageId: 'step-2-code-kernel-implementation',
        roleId: 'kernel-coder',
        kind: 'compile_report',
        title: 'Kernel implementation',
        content: 'Compilation succeeded. Verdict: CODE-COMPILABLE',
      },
      {
        stageId: 'step-3-adversarial-review-defect-hunting',
        roleId: 'code-adversary',
        kind: 'adversary_report',
        title: 'Adversarial review',
        content: 'Review completed. Verdict: ACCEPTABLE-RISK',
      },
      {
        stageId: 'step-4-precision-validation-accuracy-verification',
        roleId: 'precision-validator',
        kind: 'precision_report',
        title: 'Precision validation',
        content: 'All cases passed. Verdict: PRECISION-PASS',
      },
      {
        stageId: 'step-5-performance-optimization-bottleneck-elimination',
        roleId: 'performance-optimizer',
        kind: 'performance_report',
        title: 'Performance optimization',
        content: 'Optimization reached target. Verdict: PERFORMANCE-TARGET-MET',
      },
    ]

    for (const [index, submission] of submissions.entries()) {
      await expect(harness.tool('team_submit_artifact', {
        workspaceDir: path.join(storageRoot, 'runs', 'run-full-auto', 'roles', submission.roleId),
      }).execute(`tool-full-auto-${index}`, {
        runId: 'run-full-auto',
        stageId: submission.stageId,
        roleId: submission.roleId,
        kind: submission.kind,
        title: submission.title,
        content: submission.content,
        idempotencyKey: `artifact-full-auto-${index}`,
      })).resolves.toEqual(expect.objectContaining({
        rawResponse: expect.objectContaining({ created: true }),
      }))
    }

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-full-auto',
      eventCursor: 0,
      eventLimit: 80,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'completed', currentStageId: 'step-6-final-emit-operator-dev-optimize-report' }),
        artifacts: expect.arrayContaining(submissions.map((submission) => expect.objectContaining({ stageId: submission.stageId, roleId: submission.roleId }))),
        gates: expect.arrayContaining([
          expect.objectContaining({ gateType: 'design', passed: true }),
          expect.objectContaining({ gateType: 'compile', passed: true }),
          expect.objectContaining({ gateType: 'adversary', passed: true }),
          expect.objectContaining({ gateType: 'precision', passed: true }),
          expect.objectContaining({ gateType: 'performance', passed: true }),
        ]),
        stages: expect.arrayContaining([
          expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-3-adversarial-review-defect-hunting', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-4-precision-validation-accuracy-verification', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-5-performance-optimization-bottleneck-elimination', status: 'passed' }),
          expect.objectContaining({ stageId: 'step-6-final-emit-operator-dev-optimize-report', status: 'passed' }),
        ]),
        dispatchExecutions: expect.arrayContaining(submissions.map((submission) => expect.objectContaining({ stageId: submission.stageId, roleId: submission.roleId, status: 'completed' }))),
      }),
    }))
  })

  it('prepares kickback dispatch prompts without leaking submitted artifact bodies', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-dispatch-kickback',
      idempotencyKey: 'create-dispatch-kickback',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-dispatch-kickback',
      idempotencyKey: 'start-dispatch-kickback',
    })
    await advanceToStage(harness, storageRoot, 'run-dispatch-kickback', 'step-1-design-operator-blueprint')
    const submittedArtifact = await harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-dispatch-kickback', 'roles', 'operator-designer'),
    }).execute('tool-call-dispatch-kickback-artifact', {
      runId: 'run-dispatch-kickback',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Incomplete blueprint',
      content: '# Design\n\n## Tiling Strategy\n- one item\n\nVerdict: DESIGN-COMPLETE\nSECRET-DOWNSTREAM-BODY',
      idempotencyKey: 'artifact-dispatch-kickback',
    })
    await harness.call('matchaclaw.team.gate.evaluate', {
      runId: 'run-dispatch-kickback',
      artifactId: (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId,
      gateType: 'design',
      idempotencyKey: 'gate-dispatch-kickback',
    })

    const prepared = await harness.call('matchaclaw.team.dispatch.prepare', {
      runId: 'run-dispatch-kickback',
      stageId: 'step-1-design-operator-blueprint',
      idempotencyKey: 'dispatch-kickback-1',
    })
    expect(prepared).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        dispatch: expect.objectContaining({
          roleId: 'operator-designer',
          inputArtifactIds: [],
          kickbackIds: [expect.any(String)],
        }),
        prompt: expect.stringContaining('section_too_thin'),
      }),
    }))
    expect((prepared as { data: { prompt: string } }).data.prompt).not.toContain('SECRET-DOWNSTREAM-BODY')
    expect((prepared as { data: { prompt: string } }).data.prompt).not.toContain('Verdict: DESIGN-COMPLETE')
  })

  it('persists retry decisions and resumes waiting TeamRuns', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-decision-retry',
      idempotencyKey: 'create-decision-retry',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-decision-retry',
      idempotencyKey: 'start-decision-retry',
    })
    await advanceToStage(harness, storageRoot, 'run-decision-retry', 'step-1-design-operator-blueprint')
    const submitArtifactTool = harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-decision-retry', 'roles', 'operator-designer'),
    })

    for (const suffix of ['1', '2']) {
      const submittedArtifact = await submitArtifactTool.execute(`tool-call-decision-retry-${suffix}`, {
        runId: 'run-decision-retry',
        stageId: 'step-1-design-operator-blueprint',
        roleId: 'operator-designer',
        kind: 'design_report',
        title: `Incomplete blueprint ${suffix}`,
        content: '# Design\n\n## Tiling Strategy\n- one item\n\nVerdict: DESIGN-COMPLETE',
        idempotencyKey: `artifact-decision-retry-${suffix}`,
      })
      await harness.call('matchaclaw.team.gate.evaluate', {
        runId: 'run-decision-retry',
        artifactId: (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId,
        gateType: 'design',
        idempotencyKey: `gate-decision-retry-${suffix}`,
      })
    }

    await expect(harness.call('matchaclaw.team.run.decision.submit', {
      runId: 'run-decision-retry',
      decision: 'retry',
      note: 'Try the design stage again.',
      idempotencyKey: 'decision-retry-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        created: true,
        decision: expect.objectContaining({
          stageId: 'step-1-design-operator-blueprint',
          decision: 'retry',
          note: 'Try the design stage again.',
        }),
      }),
    }))
    await expect(harness.call('matchaclaw.team.run.decision.submit', {
      runId: 'run-decision-retry',
      decision: 'retry',
      note: 'Try the design stage again.',
      idempotencyKey: 'decision-retry-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ created: false }),
    }))

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-decision-retry',
      eventCursor: 0,
      eventLimit: 40,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: 'step-1-design-operator-blueprint',
            status: 'running',
            attempt: 2,
          }),
        ]),
        decisions: [expect.objectContaining({ decision: 'retry', idempotencyKey: 'decision-retry-1' })],
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'decision:submitted', payload: expect.objectContaining({ decision: 'retry' }) }),
        ]),
      }),
    }))
  })

  it('persists abort decisions and fails waiting TeamRuns', async () => {
    const harness = createHarness(storageRoot)
    await harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
      runId: 'run-decision-abort',
      idempotencyKey: 'create-decision-abort',
    })
    await harness.call('matchaclaw.team.run.start', {
      runId: 'run-decision-abort',
      idempotencyKey: 'start-decision-abort',
    })
    await advanceToStage(harness, storageRoot, 'run-decision-abort', 'step-1-design-operator-blueprint')
    const submitArtifactTool = harness.tool('team_submit_artifact', {
      workspaceDir: path.join(storageRoot, 'runs', 'run-decision-abort', 'roles', 'operator-designer'),
    })

    for (const suffix of ['1', '2']) {
      const submittedArtifact = await submitArtifactTool.execute(`tool-call-decision-abort-${suffix}`, {
        runId: 'run-decision-abort',
        stageId: 'step-1-design-operator-blueprint',
        roleId: 'operator-designer',
        kind: 'design_report',
        title: `Incomplete blueprint ${suffix}`,
        content: '# Design\n\n## Memory Layout\n- one item\n\nVerdict: DESIGN-COMPLETE',
        idempotencyKey: `artifact-decision-abort-${suffix}`,
      })
      await harness.call('matchaclaw.team.gate.evaluate', {
        runId: 'run-decision-abort',
        artifactId: (submittedArtifact as { rawResponse: { artifact: { artifactId: string } } }).rawResponse.artifact.artifactId,
        gateType: 'design',
        idempotencyKey: `gate-decision-abort-${suffix}`,
      })
    }

    await expect(harness.call('matchaclaw.team.run.decision.submit', {
      runId: 'run-decision-abort',
      decision: 'abort',
      note: 'Stop after exhausted design attempts.',
      idempotencyKey: 'decision-abort-1',
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        created: true,
        decision: expect.objectContaining({ decision: 'abort', note: 'Stop after exhausted design attempts.' }),
      }),
    }))

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-decision-abort',
      eventCursor: 0,
      eventLimit: 40,
    })).resolves.toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({
        run: expect.objectContaining({ status: 'failed', currentStageId: 'step-1-design-operator-blueprint' }),
        stages: expect.arrayContaining([
          expect.objectContaining({
            stageId: 'step-1-design-operator-blueprint',
            status: 'failed',
            attempt: 2,
          }),
        ]),
        decisions: [expect.objectContaining({ decision: 'abort', idempotencyKey: 'decision-abort-1' })],
        events: expect.arrayContaining([
          expect.objectContaining({ type: 'decision:submitted', payload: expect.objectContaining({ decision: 'abort' }) }),
        ]),
      }),
    }))
  })

  it('returns an error for invalid create input', async () => {
    const harness = createHarness(storageRoot)

    await expect(harness.call('matchaclaw.team.run.create', {
      packagePath: fixturePath,
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'invalid_request', message: 'idempotencyKey is required' }),
    }))
  })

  it('rejects unexpected gateway params before dispatching to services', async () => {
    const harness = createHarness(storageRoot)

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-1',
      eventCursor: 0,
      prototype: 'polluted',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'invalid_request', message: 'Unexpected parameter: prototype' }),
    }))
  })

  it('rejects invalid gateway param types before dispatching to services', async () => {
    const harness = createHarness(storageRoot)

    await expect(harness.call('matchaclaw.team.run.snapshot', {
      runId: 'run-1',
      eventCursor: '0',
    })).resolves.toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({ code: 'invalid_request', message: 'eventCursor must be a finite number' }),
    }))
  })
})
