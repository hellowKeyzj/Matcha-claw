import {
  buildTeamTaskProjectionModel,
  selectTeamTaskProjectionTarget,
  type TaskManagerProjectionPort,
  type TeamTaskManagerProjectionInput,
  type TeamTaskProjectionRow,
} from '../ports/task-manager-projection-port.js'

export interface TaskManagerGatewayClientPort {
  call(method: 'TaskList' | 'TaskCreate' | 'TaskUpdate', params: Record<string, unknown>): Promise<unknown>
}

export interface TaskManagerGatewayProjectionDeps {
  client: TaskManagerGatewayClientPort
  teamKeyPrefix?: string
}

export class TaskManagerGatewayProjection implements TaskManagerProjectionPort {
  constructor(private readonly deps: TaskManagerGatewayProjectionDeps) {}

  async projectTeamRun(input: TeamTaskManagerProjectionInput): Promise<void> {
    const teamKey = this.teamKey(input.run.runId)
    const listed = await this.deps.client.call('TaskList', { teamKey })
    const existingTasks = readTasks(listed)

    for (const stage of input.stages) {
      const model = buildTeamTaskProjectionModel({ run: input.run, stage, reason: input.reason })
      const target = selectTeamTaskProjectionTarget(existingTasks, model)
      if (target.action === 'skip') {
        continue
      }
      const params = { teamKey, ...model.params }
      if (target.action === 'update') {
        await this.deps.client.call('TaskUpdate', { taskId: target.task.id, ...params })
      } else {
        await this.deps.client.call('TaskCreate', params)
      }
    }
  }

  private teamKey(runId: string): string {
    return `${this.deps.teamKeyPrefix ?? 'matchaclaw-team'}:${runId}`
  }
}

function readTasks(value: unknown): TeamTaskProjectionRow[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return []
  }
  const tasks = (value as { tasks?: unknown }).tasks
  if (!Array.isArray(tasks)) {
    return []
  }
  return tasks.flatMap((task): TeamTaskProjectionRow[] => {
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      return []
    }
    const row = task as Record<string, unknown>
    if (typeof row.id !== 'string') {
      return []
    }
    const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown>
      : {}
    return [{ id: row.id, metadata }]
  })
}
