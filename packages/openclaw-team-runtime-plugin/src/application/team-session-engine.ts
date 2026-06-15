import type { TeamRun } from '../domain/team-run.js'
import type { TeamRunWorkflowPlan, TeamWorkflowTaskPlan } from '../domain/team-workflow.js'
import type { TeamDispatchExecutionRecord } from '../domain/team-dispatch-execution.js'
import type { TeamSkillPackageService } from './team-skill-package-service.js'
import type { SqliteDispatchStore } from '../infrastructure/sqlite-dispatch-store.js'
import type { FileWorkflowStore } from '../infrastructure/file-workflow-store.js'
import type { TeamEventBus } from '../domain/team-event-bus.js'

export interface TeamSessionEngineDeps {
  workflowStore: Pick<FileWorkflowStore, 'readTasks' | 'readPlan'>
  dispatchQueueStore: Pick<SqliteDispatchStore, 'enqueue' | 'read'>
  dispatchExecutionStore: Pick<{ read(runtimeRoot: string): Promise<TeamDispatchExecutionRecord[]> }, 'read'>
  packageService: Pick<TeamSkillPackageService, 'validate'>
  eventBus: Pick<TeamEventBus, 'enqueue'>
}

export class TeamSessionEngine {
  constructor(private readonly deps: TeamSessionEngineDeps) {}

  async onWorkflowPlanned(input: {
    runtimeRoot: string
    run: TeamRun
    plan: TeamRunWorkflowPlan
  }): Promise<{ releasedTaskIds: string[] }> {
    return await this.releaseRunnableTasks(input)
  }

  async onWorkflowProgressed(input: {
    runtimeRoot: string
    run: TeamRun
    plan: TeamRunWorkflowPlan
  }): Promise<{ releasedTaskIds: string[] }> {
    return await this.releaseRunnableTasks(input)
  }

  private async releaseRunnableTasks(input: {
    runtimeRoot: string
    run: TeamRun
    plan: TeamRunWorkflowPlan
  }): Promise<{ releasedTaskIds: string[] }> {
    const [existingTasks, existingExecutions, queueItems, packageResult] = await Promise.all([
      this.deps.workflowStore.readTasks(input.runtimeRoot),
      this.deps.dispatchExecutionStore.read(input.runtimeRoot),
      this.deps.dispatchQueueStore.read(input.run.runId),
      this.deps.packageService.validate(input.run.sourcePath),
    ])
    const plannedTaskIds = new Set(input.plan.tasks.map((task) => task.taskId))
    const completedTaskIds = new Set(existingTasks.filter((task) => task.status === 'completed').map((task) => task.taskId))
    const failedTaskIds = new Set(existingTasks.filter((task) => task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale').map((task) => task.taskId))
    const settledTaskIds = new Set(existingTasks.filter((task) => task.status !== 'queued').map((task) => task.taskId))
    const activeTaskIds = new Set(existingTasks.filter((task) => task.status === 'queued').map((task) => task.taskId))
    const activeExecutionTaskIds = new Set(existingExecutions.filter((execution) => (execution.status === 'claimed' || execution.status === 'queued') && plannedTaskIds.has(execution.stageId)).map((execution) => execution.stageId))
    const queuedTaskIds = new Set(queueItems.filter((item) => item.status !== 'failed' && item.status !== 'cancelled' && item.taskId && plannedTaskIds.has(item.taskId)).map((item) => item.taskId as string))
    const maxParallelTeammates = packageResult.valid ? packageResult.package?.bind.maxParallelTeammates : undefined
    const activeParallelCount = countActiveParallelTasks({ activeTaskIds, activeExecutionTaskIds, queuedTaskIds })
    const remainingParallelSlots = maxParallelTeammates && maxParallelTeammates > 0
      ? Math.max(0, maxParallelTeammates - activeParallelCount)
      : Number.POSITIVE_INFINITY

    const releasedTaskIds: string[] = []
    for (const taskPlan of input.plan.tasks) {
      if (releasedTaskIds.length >= remainingParallelSlots) {
        break
      }
      if (terminalOrActive(taskPlan.taskId, { completedTaskIds, failedTaskIds, activeTaskIds, activeExecutionTaskIds, queuedTaskIds })) {
        continue
      }
      if (!isTaskRunnable(taskPlan, input.plan, completedTaskIds, failedTaskIds, settledTaskIds)) {
        continue
      }
      const { created } = await this.deps.dispatchQueueStore.enqueue({
        runId: input.run.runId,
        toRoleId: taskPlan.roleId,
        taskId: taskPlan.taskId,
        prompt: taskPlan.prompt,
        idempotencyKey: `orchestrate:${input.run.runId}:${taskPlan.taskId}:${input.plan.workflowPlanId}`,
      })
      if (created) {
        releasedTaskIds.push(taskPlan.taskId)
      }
    }

    if (releasedTaskIds.length > 0) {
      this.deps.eventBus.enqueue({ type: 'task:created', runId: input.run.runId, timestamp: Date.now() })
    }

    return { releasedTaskIds }
  }
}

function terminalOrActive(taskId: string, input: {
  completedTaskIds: Set<string>
  failedTaskIds: Set<string>
  activeTaskIds: Set<string>
  activeExecutionTaskIds: Set<string>
  queuedTaskIds: Set<string>
}): boolean {
  return input.completedTaskIds.has(taskId)
    || input.failedTaskIds.has(taskId)
    || input.activeTaskIds.has(taskId)
    || input.activeExecutionTaskIds.has(taskId)
    || input.queuedTaskIds.has(taskId)
}

function isTaskRunnable(
  task: TeamWorkflowTaskPlan,
  plan: TeamRunWorkflowPlan,
  completedTaskIds: Set<string>,
  failedTaskIds: Set<string>,
  settledTaskIds: Set<string>,
): boolean {
  if (task.dependsOnTaskIds.length === 0) {
    return true
  }
  const dependencyGroups = new Map<string, string[]>()
  for (const dependencyTaskId of task.dependsOnTaskIds) {
    const group = plan.groups.find((candidate) => candidate.taskIds.includes(dependencyTaskId))
    if (!group) {
      return false
    }
    const existing = dependencyGroups.get(group.groupId)
    if (existing) {
      existing.push(dependencyTaskId)
    } else {
      dependencyGroups.set(group.groupId, [dependencyTaskId])
    }
  }
  for (const [groupId, dependencyTaskIds] of dependencyGroups) {
    const group = plan.groups.find((candidate) => candidate.groupId === groupId)
    if (!group) {
      return false
    }
    const completedDependencies = dependencyTaskIds.filter((taskId) => completedTaskIds.has(taskId))
    const failedDependencies = dependencyTaskIds.filter((taskId) => failedTaskIds.has(taskId))
    if (group.join.requireCompleted) {
      if (completedDependencies.length !== dependencyTaskIds.length) {
        return false
      }
      continue
    }
    if (settledTaskIdsIntersectionCount(group.taskIds, settledTaskIds) !== group.taskIds.length) {
      return false
    }
    if (!group.join.allowFailed && failedDependencies.length > 0) {
      return false
    }
    if (completedDependencies.length === 0 && (!group.join.allowFailed || failedDependencies.length === dependencyTaskIds.length)) {
      return false
    }
  }
  return true
}

function settledTaskIdsIntersectionCount(taskIds: string[], settledTaskIds: Set<string>): number {
  return taskIds.filter((taskId) => settledTaskIds.has(taskId)).length
}

function countActiveParallelTasks(input: {
  activeTaskIds: Set<string>
  activeExecutionTaskIds: Set<string>
  queuedTaskIds: Set<string>
}): number {
  return new Set([...input.activeTaskIds, ...input.activeExecutionTaskIds, ...input.queuedTaskIds]).size
}
