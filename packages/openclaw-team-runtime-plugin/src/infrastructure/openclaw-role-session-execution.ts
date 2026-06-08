import type { RoleSessionExecutionPort, TeamDispatchCancellationResult, TeamDispatchExecutionInput, TeamDispatchExecutionResult } from '../ports/role-session-execution-port.js'

export interface OpenClawRoleSessionSpawnPort {
  spawn(input: {
    task: string
    taskName: string
    label: string
    agentId: string
    requesterAgentId: string
    requesterSessionKey: string
    workspaceDir: string
    mode: 'run'
    cleanup: 'keep'
    context: 'isolated'
  }): Promise<{
    status: 'accepted' | 'forbidden' | 'error'
    runId?: string
    childSessionKey?: string
    mode?: 'run' | 'session'
    error?: string
  }>
  deleteSession(input: { sessionKey: string; deleteTranscript?: boolean }): Promise<void>
}

export class OpenClawRoleSessionExecution implements RoleSessionExecutionPort {
  constructor(private readonly spawnPort: OpenClawRoleSessionSpawnPort) {}

  async executeDispatch(input: TeamDispatchExecutionInput): Promise<TeamDispatchExecutionResult> {
    const requesterAgentId = `matchaclaw-team:${input.runId}:leader`
    const spawned = await this.spawnPort.spawn({
      task: input.prompt,
      taskName: `${input.dispatch.stageId}:${input.dispatch.roleId}`,
      label: input.dispatch.roleId,
      agentId: input.role.agentId,
      requesterAgentId,
      requesterSessionKey: `agent:${requesterAgentId}:main`,
      workspaceDir: input.role.workspaceDir,
      mode: 'run',
      cleanup: 'keep',
      context: 'isolated',
    })
    if (spawned.status !== 'accepted' || !spawned.runId) {
      throw new Error(spawned.error || `Team role session spawn failed: ${spawned.status}`)
    }
    return {
      executionId: spawned.runId,
      childSessionKey: spawned.childSessionKey,
      spawnMode: spawned.mode,
      status: 'queued',
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }
  }

  async cancelDispatchExecution(input: Parameters<RoleSessionExecutionPort['cancelDispatchExecution']>[0]): Promise<TeamDispatchCancellationResult> {
    const { execution } = input
    if (!execution.childSessionKey) {
      return {
        executionRecordId: execution.executionRecordId,
        executionId: execution.executionId,
        cancelled: false,
        reason: 'Dispatch execution has no child session key',
      }
    }
    await this.spawnPort.deleteSession({ sessionKey: execution.childSessionKey, deleteTranscript: false })
    return {
      executionRecordId: execution.executionRecordId,
      executionId: execution.executionId,
      childSessionKey: execution.childSessionKey,
      cancelled: true,
    }
  }
}
