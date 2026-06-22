import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerTeamArtifactTools, type TeamToolContext } from '../../packages/openclaw-team-runtime-plugin/src/tools/team-artifact-tools'

type RegisteredTeamTool = {
  execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ rawResponse: Record<string, unknown> }>
}

type RuntimeLifecycle = {
  cleanup: () => void
}

const runtimeLifecycles: RuntimeLifecycle[] = []

afterEach(() => {
  while (runtimeLifecycles.length > 0) {
    runtimeLifecycles.pop()?.cleanup()
  }
})

async function withRegisteredTeamTools<T>(run: (tools: Map<string, (toolCtx: TeamToolContext) => RegisteredTeamTool>) => Promise<T>): Promise<T> {
  const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-artifact-tools-'))
  const tools = new Map<string, (toolCtx: TeamToolContext) => RegisteredTeamTool>()
  const api = {
    pluginConfig: { storageRoot },
    logger: { warn: () => undefined },
    lifecycle: {
      registerRuntimeLifecycle(lifecycle: RuntimeLifecycle) {
        runtimeLifecycles.push(lifecycle)
      },
    },
    registerTool(factory: (toolCtx: TeamToolContext) => RegisteredTeamTool, options: { name: string }) {
      tools.set(options.name, factory)
    },
  }

  try {
    registerTeamArtifactTools(api as never)
    return await run(tools)
  } finally {
    while (runtimeLifecycles.length > 0) {
      runtimeLifecycles.pop()?.cleanup()
    }
    await rm(storageRoot, { recursive: true, force: true })
  }
}

function teamToolContext(overrides: Partial<TeamToolContext> = {}): TeamToolContext {
  return {
    agentId: 'agent-1',
    sessionKey: 'agent:agent-1:team-role:run-1:leader',
    ...overrides,
  }
}

describe('team artifact tools', () => {
  it('returns the durable existing envelope when idempotency reuses an outbox record', async () => {
    await withRegisteredTeamTools(async (tools) => {
      const tool = tools.get('team_submit_workflow_plan')?.(teamToolContext())
      expect(tool).toBeDefined()

      const first = await tool!.execute('tool-call-1', {
        title: 'Original plan',
        groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
        tasks: [{ taskId: 'task-1', roleId: 'leader', title: 'Task 1', prompt: 'Do task 1' }],
        idempotencyKey: 'plan-1',
      })
      const duplicate = await tool!.execute('tool-call-2', {
        title: 'Duplicate plan should not leak',
        groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
        tasks: [{ taskId: 'task-1', roleId: 'leader', title: 'Task 1', prompt: 'Do task 1' }],
        idempotencyKey: 'plan-1',
      })

      expect(duplicate.rawResponse.envelope).toEqual(first.rawResponse.envelope)
      expect(duplicate.rawResponse.envelope).toMatchObject({ title: 'Original plan' })
    })
  })

  it('requires kickback messages to include a failure item and a related work reference', async () => {
    await withRegisteredTeamTools(async (tools) => {
      const tool = tools.get('team_send_message')?.(teamToolContext({ sessionKey: 'agent:agent-1:team-role:run-1:reviewer' }))
      expect(tool).toBeDefined()

      await expect(tool!.execute('tool-call-1', {
        kind: 'kickback',
        fromRoleId: 'reviewer',
        toRoleId: 'implementer',
        summary: 'Needs rework',
        body: 'Fix the failing item.',
        failureItems: [{ code: 'missing-context', message: 'No related work reference was provided.' }],
        idempotencyKey: 'message-1',
      })).rejects.toThrow(/relatedTaskId, relatedArtifactId, or relatedGateId/)
    })
  })

  it('accepts inline task evidence up to the bounded 20000 character limit', async () => {
    await withRegisteredTeamTools(async (tools) => {
      const tool = tools.get('team_complete_task')?.(teamToolContext({ sessionKey: 'agent:agent-1:team-role:run-1:analyst' }))
      expect(tool).toBeDefined()

      const acceptedEvidence = 'x'.repeat(20000)
      const result = await tool!.execute('tool-call-1', {
        workflowTaskId: 'task-1',
        roleId: 'analyst',
        summary: 'done',
        evidenceRefs: [{ type: 'inlineText', text: acceptedEvidence }],
        idempotencyKey: 'complete-1',
      })

      expect(result.rawResponse.envelope).toMatchObject({ evidenceRefs: [{ type: 'inlineText', text: acceptedEvidence }] })
      await expect(tool!.execute('tool-call-2', {
        workflowTaskId: 'task-2',
        roleId: 'analyst',
        summary: 'done',
        evidenceRefs: [{ type: 'inlineText', text: `${acceptedEvidence}x` }],
        idempotencyKey: 'complete-2',
      })).rejects.toThrow(/20000 character inlineText limit/)
    })
  })

  it('rejects mismatched tool caller agentId and Team role session agentId', async () => {
    await withRegisteredTeamTools(async (tools) => {
      const tool = tools.get('team_complete_task')?.(teamToolContext({ agentId: 'agent-2' }))
      expect(tool).toBeDefined()

      await expect(tool!.execute('tool-call-1', {
        workflowTaskId: 'task-1',
        roleId: 'leader',
        summary: 'done',
        idempotencyKey: 'complete-1',
      })).rejects.toThrow(/agentId must match/)
    })
  })
})
