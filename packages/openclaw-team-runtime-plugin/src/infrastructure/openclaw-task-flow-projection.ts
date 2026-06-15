import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry'
import { buildTeamManagedAgentId } from '../domain/team-role.js'
import type { TeamRun, TeamRunStatus } from '../domain/team-run.js'
import type { TaskFlowProjectionPort, TeamTaskFlowProjectionInput, TeamTaskUpdateProjectionInput } from '../ports/task-flow-projection-port.js'
import { FileTaskFlowProjectionStore } from './file-task-flow-projection-store.js'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type TaskFlowStatus = 'queued' | 'running' | 'waiting' | 'blocked' | 'succeeded' | 'failed' | 'cancelled' | 'lost'

interface ManagedTaskFlowRecord {
  flowId: string
  syncMode: 'managed'
  controllerId: string
  revision: number
  status: TaskFlowStatus
  updatedAt: number
  endedAt?: number
}

interface TaskFlowRecord {
  flowId: string
  syncMode: 'task_mirrored' | 'managed'
  controllerId?: string
  revision: number
  status: TaskFlowStatus
  updatedAt: number
  stateJson?: JsonValue | null
}

type ManagedTaskFlowMutationResult =
  | { applied: true; flow: ManagedTaskFlowRecord }
  | { applied: false; code: 'not_found' | 'not_managed' | 'revision_conflict' | 'cancel_failed'; current?: TaskFlowRecord }

interface BoundTaskFlowRuntime {
  createManaged(params: {
    controllerId: string
    goal: string
    status?: 'queued' | 'running'
    currentStep?: string | null
    stateJson?: JsonValue | null
    createdAt?: number
    updatedAt?: number
  }): ManagedTaskFlowRecord
  get(flowId: string): TaskFlowRecord | undefined
  findLatest(): TaskFlowRecord | undefined
  setWaiting(params: {
    flowId: string
    expectedRevision: number
    currentStep?: string | null
    stateJson?: JsonValue | null
    waitJson?: JsonValue | null
    updatedAt?: number
  }): ManagedTaskFlowMutationResult
  resume(params: {
    flowId: string
    expectedRevision: number
    status?: 'queued' | 'running'
    currentStep?: string | null
    stateJson?: JsonValue | null
    updatedAt?: number
  }): ManagedTaskFlowMutationResult
  finish(params: { flowId: string; expectedRevision: number; stateJson?: JsonValue | null; updatedAt?: number; endedAt?: number }): ManagedTaskFlowMutationResult
  fail(params: { flowId: string; expectedRevision: number; stateJson?: JsonValue | null; blockedSummary?: string | null; updatedAt?: number; endedAt?: number }): ManagedTaskFlowMutationResult
  requestCancel(params: { flowId: string; expectedRevision: number; cancelRequestedAt?: number }): ManagedTaskFlowMutationResult
  cancel(params: { flowId: string; cfg: OpenClawConfig }): Promise<{ found: boolean; cancelled: boolean; reason?: string; flow?: TaskFlowRecord }>
  runTask(params: {
    flowId: string
    runtime: string
    sourceId?: string
    childSessionKey?: string
    agentId?: string
    runId?: string
    label?: string
    task: string
    preferMetadata?: boolean
    status?: 'queued' | 'running'
    progressSummary?: string | null
  }): { created: true; flow: ManagedTaskFlowRecord; task: unknown } | { created: false; reason: string; found: boolean; flow?: TaskFlowRecord }
}

export interface PluginRuntimeTaskFlowsPort {
  bindSession(params: { sessionKey: string }): BoundTaskFlowRuntime
}

export interface OpenClawTaskFlowProjectionDeps {
  taskFlows: PluginRuntimeTaskFlowsPort
  config: OpenClawConfig
  storageRoot: string
  store?: FileTaskFlowProjectionStore
  controllerId?: string
  nowMs?: () => number
}

const DEFAULT_CONTROLLER_ID = 'matchaclaw.team-runtime'

export class OpenClawTaskFlowProjection implements TaskFlowProjectionPort {
  private readonly store: FileTaskFlowProjectionStore
  private readonly controllerId: string
  private readonly nowMs: () => number

  constructor(private readonly deps: OpenClawTaskFlowProjectionDeps) {
    this.store = deps.store ?? new FileTaskFlowProjectionStore()
    this.controllerId = deps.controllerId ?? DEFAULT_CONTROLLER_ID
    this.nowMs = deps.nowMs ?? Date.now
  }

  async projectTeamRun(input: TeamTaskFlowProjectionInput): Promise<void> {
    const runtimeRoot = this.runtimeRoot(input.run.runId)
    const flowRuntime = this.bind(input.run.runId)
    const stateJson = buildStateJson(input)
    const flow = await this.ensureFlow({ runtimeRoot, flowRuntime, input, stateJson })
    const mutation = await this.applyRunMutation({ flowRuntime, flow, run: input.run, stateJson })
    const applied = mutation.applied ? mutation : await this.retryRunMutation({ flowRuntime, mutation, run: input.run, stateJson })
    if (!applied.applied) {
      throw new Error(`Task Flow projection failed: ${applied.code}`)
    }
    await this.store.write(runtimeRoot, {
      runId: input.run.runId,
      flowId: applied.flow.flowId,
      revision: applied.flow.revision,
      updatedAt: applied.flow.updatedAt,
    })
  }

  async projectTaskUpdate(input: TeamTaskUpdateProjectionInput): Promise<void> {
    const runtimeRoot = this.runtimeRoot(input.run.runId)
    const flowRuntime = this.bind(input.run.runId)
    const flow = await this.findProjectedFlow({ runtimeRoot, flowRuntime, runId: input.run.runId })
    if (!flow) {
      throw new Error(`Task Flow projection not found for TeamRun: ${input.run.runId}`)
    }
    const summary = input.detail ? `${input.summary}\n\n${input.detail}` : input.summary
    const stateJson = buildTaskUpdateStateJson(input)
    const result = flowRuntime.runTask({
      flowId: flow.flowId,
      runtime: 'agent',
      sourceId: `${input.run.runId}:${input.taskId}:${input.roleId}`,
      childSessionKey: `${this.sessionKey(input.run.runId)}:${input.roleId}`,
      agentId: buildTeamManagedAgentId(input.run.runId, input.roleId),
      runId: input.run.runId,
      label: `${input.roleId}: ${input.taskId}`,
      task: summary,
      status: taskRunStatus(input.status),
      progressSummary: input.summary,
      preferMetadata: true,
    })
    if (!result.created) {
      throw new Error(`Task Flow task update failed: ${result.reason}`)
    }
    const resumed = flowRuntime.resume({
      flowId: result.flow.flowId,
      expectedRevision: result.flow.revision,
      status: 'running',
      currentStep: input.taskId,
      stateJson,
      updatedAt: this.nowMs(),
    })
    if (!resumed.applied) {
      throw new Error(`Task Flow task update resume failed: ${resumed.code}`)
    }
    await this.store.write(runtimeRoot, {
      runId: input.run.runId,
      flowId: resumed.flow.flowId,
      revision: resumed.flow.revision,
      updatedAt: resumed.flow.updatedAt,
    })
  }

  private async ensureFlow(input: {
    runtimeRoot: string
    flowRuntime: BoundTaskFlowRuntime
    input: TeamTaskFlowProjectionInput
    stateJson: JsonValue
  }): Promise<ManagedTaskFlowRecord> {
    const existing = await this.findProjectedFlow({ runtimeRoot: input.runtimeRoot, flowRuntime: input.flowRuntime, runId: input.input.run.runId })
    if (existing && existing.syncMode === 'managed' && existing.controllerId === this.controllerId) {
      return existing
    }
    const created = input.flowRuntime.createManaged({
      controllerId: this.controllerId,
      goal: `${input.input.run.packageName} ${input.input.run.runId}`,
      status: flowStatusForRun(input.input.run.status),
      currentStep: input.input.run.currentStageId ?? null,
      stateJson: input.stateJson,
      createdAt: this.nowMs(),
      updatedAt: this.nowMs(),
    })
    await this.store.write(input.runtimeRoot, {
      runId: input.input.run.runId,
      flowId: created.flowId,
      revision: created.revision,
      updatedAt: created.updatedAt,
    })
    return created
  }

  private async applyRunMutation(input: { flowRuntime: BoundTaskFlowRuntime; flow: ManagedTaskFlowRecord; run: TeamRun; stateJson: JsonValue }): Promise<ManagedTaskFlowMutationResult> {
    const common = {
      flowId: input.flow.flowId,
      expectedRevision: input.flow.revision,
      stateJson: input.stateJson,
      updatedAt: this.nowMs(),
    }
    if (input.run.status === 'created' || input.run.status === 'running') {
      return input.flowRuntime.resume({
        ...common,
        status: flowStatusForRun(input.run.status),
        currentStep: input.run.currentStageId ?? null,
      })
    }
    if (input.run.status === 'waiting_for_user') {
      return input.flowRuntime.setWaiting({
        ...common,
        currentStep: input.run.currentStageId ?? null,
        waitJson: { teamRunId: input.run.runId, currentStageId: input.run.currentStageId ?? null },
      })
    }
    if (input.run.status === 'completed') {
      return input.flowRuntime.finish({ ...common, endedAt: this.nowMs() })
    }
    if (input.run.status === 'failed') {
      return input.flowRuntime.fail({ ...common, blockedSummary: 'TeamRun failed', endedAt: this.nowMs() })
    }
    const requested = input.flowRuntime.requestCancel({
      flowId: input.flow.flowId,
      expectedRevision: input.flow.revision,
      cancelRequestedAt: this.nowMs(),
    })
    if (!requested.applied) {
      return requested
    }
    const cancelled = await input.flowRuntime.cancel({ flowId: requested.flow.flowId, cfg: this.deps.config })
    if (!cancelled.found) {
      return { applied: false, code: 'not_found' }
    }
    if (!cancelled.cancelled) {
      return { applied: false, code: 'cancel_failed', current: cancelled.flow ?? requested.flow }
    }
    return { applied: true, flow: { ...requested.flow, status: 'cancelled', endedAt: this.nowMs(), updatedAt: this.nowMs() } }
  }

  private async findProjectedFlow(input: { runtimeRoot: string; flowRuntime: BoundTaskFlowRuntime; runId: string }): Promise<TaskFlowRecord | undefined> {
    const stored = await this.store.read(input.runtimeRoot)
    const storedFlow = stored && stored.runId === input.runId ? input.flowRuntime.get(stored.flowId) : undefined
    if (storedFlow && this.isProjectedFlowForRun(storedFlow, input.runId)) {
      return storedFlow
    }
    const latest = input.flowRuntime.findLatest()
    return latest && this.isProjectedFlowForRun(latest, input.runId) ? latest : undefined
  }

  private isProjectedFlowForRun(flow: TaskFlowRecord, runId: string): boolean {
    const state = jsonObject(flow.stateJson)
    return flow.syncMode === 'managed' &&
      flow.controllerId === this.controllerId &&
      state.source === 'matchaclaw.team-runtime' &&
      state.teamRunId === runId
  }

  private async retryRunMutation(input: { flowRuntime: BoundTaskFlowRuntime; mutation: ManagedTaskFlowMutationResult; run: TeamRun; stateJson: JsonValue }): Promise<ManagedTaskFlowMutationResult> {
    if (input.mutation.applied || input.mutation.code !== 'revision_conflict' || !input.mutation.current || input.mutation.current.syncMode !== 'managed') {
      return input.mutation
    }
    return await this.applyRunMutation({
      flowRuntime: input.flowRuntime,
      flow: input.mutation.current as ManagedTaskFlowRecord,
      run: input.run,
      stateJson: input.stateJson,
    })
  }

  private bind(runId: string): BoundTaskFlowRuntime {
    return this.deps.taskFlows.bindSession({ sessionKey: this.sessionKey(runId) })
  }

  private sessionKey(runId: string): string {
    return `matchaclaw-team:${runId}`
  }

  private runtimeRoot(runId: string): string {
    return `${this.deps.storageRoot}/runs/${sanitizePathSegment(runId)}`
  }
}

function buildStateJson(input: TeamTaskFlowProjectionInput): JsonValue {
  return {
    source: 'matchaclaw.team-runtime',
    teamRunId: input.run.runId,
    packageName: input.run.packageName,
    packageVersion: input.run.packageVersion,
    teamRunStatus: input.run.status,
    teamRunRevision: input.run.revision,
    currentStageId: input.run.currentStageId ?? null,
    projectionReason: input.reason,
    dispatchTasks: input.dispatchTasks.map((task) => ({
      dispatchTaskId: task.dispatchTaskId,
      workflowPlanId: task.workflowPlanId,
      dispatchGroupId: task.dispatchGroupId,
      groupId: task.groupId,
      taskId: task.taskId,
      roleId: task.roleId,
      dispatchId: task.dispatchId,
      status: task.status,
      artifactId: task.artifactId ?? null,
      statusReason: task.statusReason ?? null,
    })),
  }
}

function buildTaskUpdateStateJson(input: TeamTaskUpdateProjectionInput): JsonValue {
  return {
    source: 'matchaclaw.team-runtime',
    teamRunId: input.run.runId,
    teamRunStatus: input.run.status,
    teamRunRevision: input.run.revision,
    stageId: input.taskId,
    roleId: input.roleId,
    taskUpdateStatus: input.status,
    summary: input.summary,
    detail: input.detail ?? null,
    progress: input.progress ?? null,
    metadata: jsonRecord(input.metadata),
  }
}

function flowStatusForRun(status: TeamRunStatus): 'queued' | 'running' {
  return status === 'created' ? 'queued' : 'running'
}

function taskRunStatus(status: TeamTaskUpdateProjectionInput['status']): 'queued' | 'running' {
  return status === 'waiting' ? 'queued' : 'running'
}

function jsonRecord(value: Record<string, unknown> | undefined): JsonValue {
  if (!value) {
    return null
  }
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_')
}
