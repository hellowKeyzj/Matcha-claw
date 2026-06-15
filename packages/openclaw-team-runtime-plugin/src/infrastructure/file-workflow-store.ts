import path from 'node:path'
import type { TeamDispatchGroupRecord, TeamDispatchGroupStatus, TeamDispatchTaskRecord, TeamDispatchTaskStatus, TeamRunWorkflowPlan } from '../domain/team-workflow.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { atomicWriteJson, readJsonFile } from './atomic-json.js'
import { withFileLock } from './file-lock.js'

export interface FileWorkflowStoreDeps {
  clock: ClockPort
  idGenerator: IdGeneratorPort
}

export class FileWorkflowStore {
  constructor(private readonly deps: FileWorkflowStoreDeps) {}

  async savePlan(input: {
    runtimeRoot: string
    runId: string
    title: string
    summary?: string
    groups: TeamRunWorkflowPlan['groups']
    tasks: TeamRunWorkflowPlan['tasks']
    idempotencyKey: string
  }): Promise<{ plan: TeamRunWorkflowPlan; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'workflow.lock'), async () => {
      const existing = await this.readPlan(input.runtimeRoot)
      if (existing) {
        if (existing.idempotencyKey !== input.idempotencyKey) {
          throw new Error(`TeamRun workflow is already planned: ${existing.workflowPlanId}`)
        }
        return { plan: existing, created: false }
      }
      const plan: TeamRunWorkflowPlan = {
        workflowPlanId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        title: input.title,
        ...(input.summary ? { summary: input.summary } : {}),
        status: 'planned',
        groups: input.groups,
        tasks: input.tasks,
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.planPath(input.runtimeRoot), plan)
      return { plan, created: true }
    })
  }

  async readPlan(runtimeRoot: string): Promise<TeamRunWorkflowPlan | null> {
    return await readJsonFile<TeamRunWorkflowPlan>(this.planPath(runtimeRoot))
  }

  async updatePlanStatus(input: {
    runtimeRoot: string
    status: TeamRunWorkflowPlan['status']
  }): Promise<{ plan: TeamRunWorkflowPlan; changed: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'workflow.lock'), async () => {
      const current = await this.readPlan(input.runtimeRoot)
      if (!current) {
        throw new Error('TeamRun workflow is not planned')
      }
      if (current.status === input.status) {
        return { plan: current, changed: false }
      }
      const next: TeamRunWorkflowPlan = {
        ...current,
        status: input.status,
      }
      await atomicWriteJson(this.planPath(input.runtimeRoot), next)
      return { plan: next, changed: true }
    })
  }

  async saveGroup(input: {
    runtimeRoot: string
    runId: string
    workflowPlanId: string
    groupId: string
    taskIds: string[]
    idempotencyKey: string
  }): Promise<{ group: TeamDispatchGroupRecord; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'workflow-groups.lock'), async () => {
      const groups = await this.readGroups(input.runtimeRoot)
      const existing = groups.find((group) => group.idempotencyKey === input.idempotencyKey)
        ?? groups.find((group) => group.workflowPlanId === input.workflowPlanId && group.groupId === input.groupId)
      if (existing) {
        return { group: existing, created: false }
      }
      const group: TeamDispatchGroupRecord = {
        dispatchGroupId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        workflowPlanId: input.workflowPlanId,
        groupId: input.groupId,
        taskIds: input.taskIds,
        status: 'queued',
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
      }
      await atomicWriteJson(this.groupsPath(input.runtimeRoot), [...groups, group])
      return { group, created: true }
    })
  }

  async readGroups(runtimeRoot: string): Promise<TeamDispatchGroupRecord[]> {
    return await readJsonFile<TeamDispatchGroupRecord[]>(this.groupsPath(runtimeRoot)) ?? []
  }

  async saveTask(input: {
    runtimeRoot: string
    runId: string
    workflowPlanId: string
    dispatchGroupId: string
    groupId: string
    taskId: string
    roleId: string
    dispatchId: string
    idempotencyKey: string
  }): Promise<{ task: TeamDispatchTaskRecord; created: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'workflow-tasks.lock'), async () => {
      const tasks = await this.readTasks(input.runtimeRoot)
      const existing = tasks.find((task) => task.idempotencyKey === input.idempotencyKey)
        ?? tasks.find((task) => task.workflowPlanId === input.workflowPlanId && task.dispatchGroupId === input.dispatchGroupId && task.taskId === input.taskId)
      if (existing) {
        return { task: existing, created: false }
      }
      const task: TeamDispatchTaskRecord = {
        dispatchTaskId: this.deps.idGenerator.randomId(),
        runId: input.runId,
        workflowPlanId: input.workflowPlanId,
        dispatchGroupId: input.dispatchGroupId,
        groupId: input.groupId,
        taskId: input.taskId,
        roleId: input.roleId,
        dispatchId: input.dispatchId,
        status: 'queued',
        idempotencyKey: input.idempotencyKey,
        createdAt: this.deps.clock.nowMs(),
        attemptCount: 1,
      }
      await atomicWriteJson(this.tasksPath(input.runtimeRoot), [...tasks, task])
      return { task, created: true }
    })
  }

  async readTasks(runtimeRoot: string): Promise<TeamDispatchTaskRecord[]> {
    return await readJsonFile<TeamDispatchTaskRecord[]>(this.tasksPath(runtimeRoot)) ?? []
  }

  async updateTaskStatus(input: {
    runtimeRoot: string
    dispatchTaskId: string
    status: TeamDispatchTaskStatus
    artifactId?: string
    statusReason?: string
    dispatchId?: string
    incrementAttemptCount?: boolean
  }): Promise<{ task: TeamDispatchTaskRecord; changed: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'workflow-tasks.lock'), async () => {
      const tasks = await this.readTasks(input.runtimeRoot)
      const index = tasks.findIndex((task) => task.dispatchTaskId === input.dispatchTaskId)
      if (index < 0) {
        throw new Error(`Team dispatch task not found: ${input.dispatchTaskId}`)
      }
      const current = tasks[index]
      const currentAttemptCount = current.attemptCount ?? 1
      const nextAttemptCount = input.incrementAttemptCount ? currentAttemptCount + 1 : currentAttemptCount
      const nextStatusReason = input.statusReason ?? undefined
      const nextArtifactId = input.artifactId ?? current.artifactId
      const nextDispatchId = input.dispatchId ?? current.dispatchId
      const nextCompletedAt = input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled' || input.status === 'stale'
        ? current.completedAt ?? this.deps.clock.nowMs()
        : undefined
      if (
        current.status === input.status
        && current.artifactId === nextArtifactId
        && current.statusReason === nextStatusReason
        && current.dispatchId === nextDispatchId
        && currentAttemptCount === nextAttemptCount
        && current.completedAt === nextCompletedAt
      ) {
        return { task: { ...current, attemptCount: currentAttemptCount }, changed: false }
      }
      const next: TeamDispatchTaskRecord = {
        ...current,
        status: input.status,
        dispatchId: nextDispatchId,
        attemptCount: nextAttemptCount,
        ...(nextArtifactId ? { artifactId: nextArtifactId } : {}),
        ...(nextStatusReason ? { statusReason: nextStatusReason } : {}),
        ...(nextCompletedAt ? { completedAt: nextCompletedAt } : {}),
      }
      if (!nextArtifactId) {
        delete next.artifactId
      }
      if (!nextStatusReason) {
        delete next.statusReason
      }
      if (!nextCompletedAt) {
        delete next.completedAt
      }
      const nextTasks = [...tasks]
      nextTasks[index] = next
      await atomicWriteJson(this.tasksPath(input.runtimeRoot), nextTasks)
      return { task: next, changed: true }
    })
  }

  async updateGroupStatus(input: {
    runtimeRoot: string
    dispatchGroupId: string
    status: TeamDispatchGroupStatus
  }): Promise<{ group: TeamDispatchGroupRecord; changed: boolean }> {
    return await withFileLock(path.join(input.runtimeRoot, 'locks', 'workflow-groups.lock'), async () => {
      const groups = await this.readGroups(input.runtimeRoot)
      const index = groups.findIndex((group) => group.dispatchGroupId === input.dispatchGroupId)
      if (index < 0) {
        throw new Error(`Team dispatch group not found: ${input.dispatchGroupId}`)
      }
      const current = groups[index]
      if (current.status === input.status) {
        return { group: current, changed: false }
      }
      const next: TeamDispatchGroupRecord = {
        ...current,
        status: input.status,
        ...(input.status === 'completed' || input.status === 'failed' || input.status === 'cancelled' ? { completedAt: this.deps.clock.nowMs() } : {}),
      }
      const nextGroups = [...groups]
      nextGroups[index] = next
      await atomicWriteJson(this.groupsPath(input.runtimeRoot), nextGroups)
      return { group: next, changed: true }
    })
  }

  private planPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'workflow', 'plan.json')
  }

  private groupsPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'workflow', 'dispatch-groups.json')
  }

  private tasksPath(runtimeRoot: string): string {
    return path.join(runtimeRoot, 'workflow', 'dispatch-tasks.json')
  }
}
