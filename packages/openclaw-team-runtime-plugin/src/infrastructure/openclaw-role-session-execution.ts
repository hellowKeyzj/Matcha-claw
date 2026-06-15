import { buildRoleSessionKey, buildTaskSessionKey } from '../domain/team-dispatch-queue.js'
import type { RoleSessionExecutionPort, TeamDispatchExecutionResult, TeamLeaderExecutionInput, TeamMessageDeliveryInput, TeamRoleExecutionInput, TeamRunSessionCancellationInput } from '../ports/role-session-execution-port.js'

export interface OpenClawRoleSessionRuntimePort {
  run(input: {
    sessionKey: string
    message: string
    idempotencyKey: string
    lane: string
    deliver: boolean
    channel?: string
  }): Promise<{
    runId: string
  }>
  deleteSession(input: { sessionKey: string; deleteTranscript?: boolean }): Promise<unknown>
}

export class OpenClawRoleSessionExecution implements RoleSessionExecutionPort {
  constructor(private readonly runtimePort: OpenClawRoleSessionRuntimePort) {}

  async cancelRunSessions(input: TeamRunSessionCancellationInput): Promise<void> {
    const sessionKeys = sessionKeysForCancellation(input.executions)
    if (sessionKeys.length === 0) {
      return
    }
    if (!this.runtimePort.deleteSession) {
      throw new Error('OpenClaw subagent deleteSession is required to cancel TeamRun native sessions')
    }
    for (const sessionKey of sessionKeys) {
      await this.runtimePort.deleteSession({ sessionKey })
    }
  }

  async executeLeader(input: TeamLeaderExecutionInput): Promise<TeamDispatchExecutionResult> {
    const sessionKey = buildRoleSessionKey(input.role.agentId)
    let run: Awaited<ReturnType<OpenClawRoleSessionRuntimePort['run']>>
    try {
      run = await this.runtimePort.run({
        sessionKey,
        message: input.prompt,
        idempotencyKey: input.dispatch.idempotencyKey,
        lane: 'agent',
        deliver: true,
      })
    } catch (error) {
      if (isGatewayRequestOnlySubagentError(error)) {
        throw new Error('Team leader bootstrap requires an OpenClaw gateway request context. Retry the TeamRun start from the Team gateway so the runtime owns the native leader session.')
      }
      throw error
    }
    return {
      executionId: run.runId,
      childSessionKey: sessionKey,
      spawnMode: 'run',
      status: 'queued',
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }
  }

  async executeRole(input: TeamRoleExecutionInput): Promise<TeamDispatchExecutionResult> {
    const sessionKey = buildTaskSessionKey(input.role.agentId, input.taskId)
    const run = await this.runtimePort.run({
      sessionKey,
      message: input.prompt,
      idempotencyKey: input.dispatch.idempotencyKey,
      lane: 'agent',
      deliver: false,
    })
    return {
      executionId: run.runId,
      childSessionKey: sessionKey,
      spawnMode: 'session',
      status: 'queued',
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }
  }

  async sendMessage(input: TeamMessageDeliveryInput): Promise<{ sessionKey: string; runId: string }> {
    const sessionKey = input.taskId
      ? buildTaskSessionKey(input.agentId, input.taskId)
      : buildRoleSessionKey(input.agentId)
    const run = await this.runtimePort.run({
      sessionKey,
      message: input.body,
      idempotencyKey: input.idempotencyKey,
      lane: 'agent',
      deliver: false,
    })
    return { sessionKey, runId: run.runId }
  }
}

function sessionKeysForCancellation(executions: TeamRunSessionCancellationInput['executions']): string[] {
  return Array.from(new Set(executions.flatMap((execution) => isCancellableExecutionSession(execution) ? [execution.childSessionKey] : [])))
}

function isCancellableExecutionSession(execution: TeamRunSessionCancellationInput['executions'][number]): execution is TeamRunSessionCancellationInput['executions'][number] & { childSessionKey: string } {
  return (execution.status === 'claimed' || execution.status === 'queued') && Boolean(execution.childSessionKey)
}

function isGatewayRequestOnlySubagentError(error: unknown): boolean {
  return error instanceof Error && isGatewayRequestOnlySubagentMessage(error.message)
}

function isGatewayRequestOnlySubagentMessage(message: string): boolean {
  return message.includes('Plugin runtime subagent methods are only available during a gateway request')
}
