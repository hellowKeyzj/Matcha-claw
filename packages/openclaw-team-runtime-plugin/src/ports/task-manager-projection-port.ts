import type { TeamRun } from '../domain/team-run.js'
import type { TeamDispatchTaskRecord } from '../domain/team-workflow.js'

const TEAM_RUNTIME_PROJECTION_SOURCE = 'matchaclaw.team-runtime'

type TeamTaskProjectionRunStatus = 'created' | 'provisioning' | 'waiting_for_user' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled'

export interface TeamTaskProjectionRunModel {
  runId: string
  packageName: string
  packageVersion: string
  status: TeamTaskProjectionRunStatus
  currentStageId?: string
  revision: number
}

export interface TeamTaskProjectionRow {
  id: string
  metadata: Record<string, unknown>
}

export interface TeamTaskProjectionModel {
  identity: string
  revision: number
  params: {
    subject: string
    description: string
    activeForm: string
    owner: string
    status: 'pending' | 'in_progress' | 'completed'
    metadata: Record<string, unknown>
  }
}

export type TeamTaskProjectionTarget =
  | { action: 'create' }
  | { action: 'update'; task: TeamTaskProjectionRow }
  | { action: 'skip'; task: TeamTaskProjectionRow; reason: 'stale_revision' }

export interface TeamTaskManagerProjectionInput {
  run: TeamRun
  dispatchTasks: TeamDispatchTaskRecord[]
  reason: string
}

export interface TaskManagerProjectionPort {
  projectTeamRun(input: TeamTaskManagerProjectionInput): Promise<void>
}

export function buildTeamTaskProjectionModel(input: {
  run: TeamTaskProjectionRunModel
  task: TeamDispatchTaskRecord
  reason: string
}): TeamTaskProjectionModel {
  const identity = teamTaskProjectionIdentity(input.run.runId, input.task.taskId)
  return {
    identity,
    revision: input.run.revision,
    params: {
      subject: `${input.run.packageName}: ${input.task.taskId}`,
      description: `TeamRun ${input.run.runId} task ${input.task.taskId}`,
      activeForm: `Running ${input.task.taskId}`,
      owner: input.task.roleId,
      status: taskStatusForDispatchTask(input.run, input.task),
      metadata: {
        source: TEAM_RUNTIME_PROJECTION_SOURCE,
        projectionIdentity: identity,
        projectionRevision: input.run.revision,
        teamRunId: input.run.runId,
        teamTaskId: input.task.taskId,
        teamRunStatus: input.run.status,
        teamRunRevision: input.run.revision,
        dispatchTaskStatus: input.task.status,
        packageName: input.run.packageName,
        packageVersion: input.run.packageVersion,
        currentStageId: input.run.currentStageId ?? null,
        projectionReason: input.reason,
      },
    },
  }
}

export function selectTeamTaskProjectionTarget(tasks: readonly TeamTaskProjectionRow[], model: TeamTaskProjectionModel): TeamTaskProjectionTarget {
  const candidates = tasks
    .filter((task) => isSameProjection(task.metadata, model.identity, model.params.metadata.teamRunId, model.params.metadata.teamTaskId))
    .sort((left, right) => compareProjectionRows(right, left, model.identity))
  const task = candidates[0]
  if (!task) {
    return { action: 'create' }
  }
  const currentRevision = projectionRevision(task.metadata)
  if (currentRevision !== null && currentRevision > model.revision) {
    return { action: 'skip', task, reason: 'stale_revision' }
  }
  return { action: 'update', task }
}

export function teamTaskProjectionIdentity(runId: string, taskId: string): string {
  return `${TEAM_RUNTIME_PROJECTION_SOURCE}:${runId}:${taskId}`
}

function taskStatusForDispatchTask(run: TeamTaskProjectionRunModel, task: TeamDispatchTaskRecord): 'pending' | 'in_progress' | 'completed' {
  if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale') {
    return 'completed'
  }
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
    return 'completed'
  }
  return task.status === 'queued' ? 'in_progress' : 'pending'
}

function isSameProjection(metadata: Record<string, unknown>, identity: string, runId: unknown, taskId: unknown): boolean {
  if (metadata.projectionIdentity === identity) {
    return true
  }
  return metadata.teamRunId === runId && metadata.teamTaskId === taskId
}

function compareProjectionRows(left: TeamTaskProjectionRow, right: TeamTaskProjectionRow, identity: string): number {
  const leftExact = left.metadata.projectionIdentity === identity ? 1 : 0
  const rightExact = right.metadata.projectionIdentity === identity ? 1 : 0
  if (leftExact !== rightExact) {
    return leftExact - rightExact
  }
  const leftRevision = projectionRevision(left.metadata) ?? -1
  const rightRevision = projectionRevision(right.metadata) ?? -1
  if (leftRevision !== rightRevision) {
    return leftRevision - rightRevision
  }
  return numericTaskId(left.id) - numericTaskId(right.id)
}

function projectionRevision(metadata: Record<string, unknown>): number | null {
  if (typeof metadata.projectionRevision === 'number' && Number.isFinite(metadata.projectionRevision)) {
    return metadata.projectionRevision
  }
  if (typeof metadata.teamRunRevision === 'number' && Number.isFinite(metadata.teamRunRevision)) {
    return metadata.teamRunRevision
  }
  return null
}

function numericTaskId(taskId: string): number {
  const parsed = Number.parseInt(taskId, 10)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}
