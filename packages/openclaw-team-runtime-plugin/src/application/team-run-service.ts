import { readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import type { TeamApproval } from '../domain/team-approval.js'
import type { TeamArtifact } from '../domain/team-artifact.js'
import type { TeamDecision, TeamDecisionType } from '../domain/team-decision.js'
import type { TeamDispatchEnvelope } from '../domain/team-dispatch.js'
import type { TeamDispatchExecutionRecord } from '../domain/team-dispatch-execution.js'
import type { TeamEvent } from '../domain/team-event.js'
import type { TeamGateResult } from '../domain/team-gate.js'
import type { TeamKickback } from '../domain/team-kickback.js'
import type { TeamMessage } from '../domain/team-message.js'
import { buildTeamManagedAgentId, TEAM_LEADER_ROLE_ID, type TeamManagedAgentConfigProjection, type TeamRoleBinding } from '../domain/team-role.js'
import type { TeamRun, TeamRunStatus } from '../domain/team-run.js'
import type { TeamSkillDependencies, TeamSkillDependencyEntry } from '../domain/team-skill-package.js'
import type { TeamDispatchGroupRecord, TeamDispatchTaskRecord, TeamRunWorkflowPlan, TeamWorkflowGroupPlan, TeamWorkflowJoinPolicy, TeamWorkflowTaskPlan } from '../domain/team-workflow.js'
import { FileApprovalStore } from '../infrastructure/file-approval-store.js'
import { FileArtifactStore } from '../infrastructure/file-artifact-store.js'
import { FileDecisionStore } from '../infrastructure/file-decision-store.js'
import { FileDispatchExecutionStore } from '../infrastructure/file-dispatch-execution-store.js'
import { FileDispatchStore } from '../infrastructure/file-dispatch-store.js'
import { FileEventStore } from '../infrastructure/file-event-store.js'
import { FileGateStore } from '../infrastructure/file-gate-store.js'
import { FileKickbackStore } from '../infrastructure/file-kickback-store.js'
import { FileMessageStore } from '../infrastructure/file-message-store.js'
import { FileRoleBindingStore } from '../infrastructure/file-role-binding-store.js'
import { FileTeamRunStore } from '../infrastructure/file-team-run-store.js'
import { SqliteDispatchStore } from '../infrastructure/sqlite-dispatch-store.js'
import { TeamEventBus } from '../domain/team-event-bus.js'
import { DispatchHandler, LeaderSynthesisHandler, type DispatchHandlerDeps } from '../domain/team-handlers.js'
import type { TeamGatewayRequestPort } from '../gateway/team-gateway-methods.js'
import { FileWorkflowStore } from '../infrastructure/file-workflow-store.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { missingAllDependencyChecker, type TeamDependencyCheckerPort } from '../ports/dependency-checker-port.js'
import type { RoleSessionExecutionPort } from '../ports/role-session-execution-port.js'
import type { TaskFlowProjectionPort, TeamTaskUpdateProjectionInput } from '../ports/task-flow-projection-port.js'
import type { TaskManagerProjectionPort } from '../ports/task-manager-projection-port.js'
import { TeamProvisioningService } from './team-provisioning-service.js'
import { TeamSessionEngine } from './team-session-engine.js'
import { TeamSkillPackageService } from './team-skill-package-service.js'

export interface TeamRunContextPort {
  setRunContext(input: { runId: string; namespace: string; value: unknown; unset?: boolean }): Promise<boolean> | boolean
}

export interface TeamRunServiceDeps {
  storageRoot: string
  clock: ClockPort
  idGenerator: IdGeneratorPort
  packageService?: TeamSkillPackageService
  taskManagerProjection?: TaskManagerProjectionPort
  taskFlowProjection?: TaskFlowProjectionPort
  roleSessionExecution?: RoleSessionExecutionPort
  teamGatewayRequest?: TeamGatewayRequestPort
  runContext?: TeamRunContextPort
  dependencyChecker?: TeamDependencyCheckerPort
  maxArtifactContentBytes?: number
  maxMessageBodyBytes?: number
  staleDispatchExecutionMs?: number
  disableAutoDispatch?: boolean
}

type EmptyTeamStages = []

export interface TeamRunSnapshot {
  run: TeamRun | null
  roles: TeamRoleBinding[]
  stages: EmptyTeamStages
  approvals: TeamApproval[]
  artifacts: TeamArtifact[]
  dispatches: TeamDispatchEnvelope[]
  dispatchExecutions: TeamDispatchExecutionRecord[]
  workflowPlan: TeamRunWorkflowPlan | null
  dispatchGroups: TeamDispatchGroupRecord[]
  dispatchTasks: TeamDispatchTaskRecord[]
  messages: TeamMessage[]
  gates: TeamGateResult[]
  kickbacks: TeamKickback[]
  decisions: TeamDecision[]
  diagnostics: TeamRunDiagnostics
  events: TeamEvent[]
  nextEventCursor: number
}

export type TeamDependencyPlanItemKind = 'skill' | 'tool'
export type TeamDependencyPlanItemStatus = 'available' | 'missing'
export type TeamDependencyPlanItemSeverity = 'ok' | 'warning' | 'blocker'

export interface TeamDependencyPlanItem extends TeamSkillDependencyEntry {
  kind: TeamDependencyPlanItemKind
  status: TeamDependencyPlanItemStatus
  severity: TeamDependencyPlanItemSeverity
  installable: boolean
}

export interface TeamDependencyPreparationPlan {
  packageName: string
  packageVersion: string
  sourcePath: string
  items: TeamDependencyPlanItem[]
  missingRequiredSkills: TeamSkillDependencyEntry[]
  missingOptionalSkills: TeamSkillDependencyEntry[]
  missingRequiredTools: TeamSkillDependencyEntry[]
  missingOptionalTools: TeamSkillDependencyEntry[]
  canProceed: boolean
}

export interface TeamRunDiagnostics {
  runId: string
  recoveredFromStorage: boolean
  storageRoot: string
  budgets: {
    totalWallClockBudgetMs?: number
    totalTokenBudget?: number
    roleWallClockBudgetMs: Record<string, number>
    roleTokenBudget: Record<string, number>
    elapsedMs?: number
    wallClockExceeded: boolean
  }
  limits: {
    maxArtifactContentBytes: number
    maxMessageBodyBytes: number
    staleDispatchExecutionMs: number
  }
  staleDispatchExecutions: TeamDispatchExecutionRecord[]
  counts: {
    roles: number
    stages: number
    approvals: number
    artifacts: number
    dispatches: number
    dispatchExecutions: number
    dispatchGroups: number
    dispatchTasks: number
    messages: number
    gates: number
    kickbacks: number
    decisions: number
    events: number
  }
}

export const TEAM_LEADER_SYNTHESIS_RUN_CONTEXT_NAMESPACE = 'matchaclaw.team-runtime.leader-synthesis'

const DEFAULT_MAX_ARTIFACT_CONTENT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_MESSAGE_BODY_BYTES = 256 * 1024
const DEFAULT_STALE_DISPATCH_EXECUTION_MS = 30 * 60_000
const STARTABLE_RUN_STATUSES = new Set<TeamRunStatus>(['created', 'paused'])
const TERMINAL_RUN_STATUSES = new Set<TeamRunStatus>(['completed', 'failed', 'cancelled'])

export type TeamRunTickResult =
  | {
    action: 'dispatch_prepared'
    runId: string
    status: TeamRunStatus
    revision: number
    currentStageId: string
    dispatch: TeamDispatchEnvelope
    prompt: string
    created: boolean
  }
  | {
    action: 'dispatch_execution_queued'
    runId: string
    status: TeamRunStatus
    revision: number
    currentStageId: string
    dispatch: TeamDispatchEnvelope
    execution: TeamDispatchExecutionRecord
    created: boolean
  }
  | {
    action: 'stage_completed'
    runId: string
    status: TeamRunStatus
    revision: number
    currentStageId?: string
  }
  | {
    action: 'dependency_missing'
    runId: string
    status: TeamRunStatus
    revision: number
    currentStageId: string
    missingRequiredSkills: TeamSkillDependencyEntry[]
    missingOptionalSkills: TeamSkillDependencyEntry[]
    missingRequiredTools: TeamSkillDependencyEntry[]
    missingOptionalTools: TeamSkillDependencyEntry[]
  }
  | {
    action: 'noop'
    runId: string
    status: TeamRunStatus
    revision: number
    reason: string
    currentStageId?: string
  }

export class TeamRunService {
  private readonly packageService: TeamSkillPackageService
  private readonly runStore: FileTeamRunStore
  private readonly decisionStore: FileDecisionStore
  private readonly dispatchStore: FileDispatchStore
  private readonly dispatchExecutionStore: FileDispatchExecutionStore
  private readonly workflowStore: FileWorkflowStore
  private readonly approvalStore: FileApprovalStore
  private readonly eventStore: FileEventStore
  private readonly roleStore: FileRoleBindingStore
  private readonly artifactStore: FileArtifactStore
  private readonly messageStore: FileMessageStore
  private readonly gateStore: FileGateStore
  private readonly kickbackStore: FileKickbackStore
  private readonly dispatchQueueStore: SqliteDispatchStore
  private readonly eventBus: TeamEventBus
  private readonly provisioningService: TeamProvisioningService
  private readonly sessionEngine!: TeamSessionEngine
  private readonly taskManagerProjection?: TaskManagerProjectionPort
  private readonly taskFlowProjection?: TaskFlowProjectionPort
  private readonly roleSessionExecution?: RoleSessionExecutionPort
  private readonly teamGatewayRequest?: TeamGatewayRequestPort
  private readonly runContext?: TeamRunContextPort
  private readonly dependencyChecker: TeamDependencyCheckerPort
  private readonly disableAutoDispatch: boolean

  constructor(private readonly deps: TeamRunServiceDeps) {
    this.packageService = deps.packageService ?? new TeamSkillPackageService()
    this.runStore = new FileTeamRunStore({ clock: deps.clock })
    this.decisionStore = new FileDecisionStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.dispatchStore = new FileDispatchStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.dispatchExecutionStore = new FileDispatchExecutionStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.workflowStore = new FileWorkflowStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.approvalStore = new FileApprovalStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.eventStore = new FileEventStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.roleStore = new FileRoleBindingStore()
    this.artifactStore = new FileArtifactStore({
      clock: deps.clock,
      idGenerator: deps.idGenerator,
      maxContentBytes: deps.maxArtifactContentBytes ?? DEFAULT_MAX_ARTIFACT_CONTENT_BYTES,
    })
    this.messageStore = new FileMessageStore({
      clock: deps.clock,
      idGenerator: deps.idGenerator,
      maxBodyBytes: deps.maxMessageBodyBytes ?? DEFAULT_MAX_MESSAGE_BODY_BYTES,
    })
    this.gateStore = new FileGateStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.kickbackStore = new FileKickbackStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.dispatchQueueStore = new SqliteDispatchStore({ clock: deps.clock, idGenerator: deps.idGenerator, storageRoot: deps.storageRoot })
    this.eventBus = new TeamEventBus()
    const handlerDeps: DispatchHandlerDeps = {
      requestTeamGateway: async (method, params) => await this.requestTeamBackgroundGateway(method, params),
      hasPending: async (runId) => await this.dispatchQueueStore.hasPending(runId),
    }
    this.eventBus.on('task:created', new DispatchHandler(handlerDeps))
    this.eventBus.on('message:created', new DispatchHandler(handlerDeps))
    this.eventBus.on('poll:task', new DispatchHandler(handlerDeps))
    this.eventBus.on('poll:message', new LeaderSynthesisHandler(handlerDeps))
    this.provisioningService = new TeamProvisioningService({ storageRoot: deps.storageRoot, roleStore: this.roleStore })
    this.sessionEngine = new TeamSessionEngine({
      workflowStore: this.workflowStore,
      dispatchQueueStore: this.dispatchQueueStore,
      dispatchExecutionStore: this.dispatchExecutionStore,
      packageService: this.packageService,
      eventBus: this.eventBus,
    })
    this.taskManagerProjection = deps.taskManagerProjection
    this.taskFlowProjection = deps.taskFlowProjection
    this.roleSessionExecution = deps.roleSessionExecution
    this.teamGatewayRequest = deps.teamGatewayRequest
    this.runContext = deps.runContext
    this.dependencyChecker = deps.dependencyChecker ?? missingAllDependencyChecker
    this.disableAutoDispatch = deps.disableAutoDispatch ?? false
  }

  async create(input: { packagePath: string; runId?: string; idempotencyKey: string }): Promise<{ runId: string; status: TeamRunStatus; revision: number; managedAgentConfig?: TeamManagedAgentConfigProjection }> {
    const packageResult = await this.packageService.validate(input.packagePath)
    if (!packageResult.valid || !packageResult.package) {
      throw new Error(`Invalid TeamSkill package: ${packageResult.errors.map((issue) => issue.message).join('; ')}`)
    }

    const runId = input.runId?.trim() || input.idempotencyKey.trim() || this.deps.idGenerator.randomId()
    const runtimeRoot = this.resolveRuntimeRoot(runId)
    const run = await this.runStore.create({
      runtimeRoot,
      runId,
      packageName: packageResult.package.name,
      packageVersion: packageResult.package.version,
      sourcePath: packageResult.package.sourcePath,
    })

    let managedAgentConfig: TeamManagedAgentConfigProjection | undefined

    if (run.revision === 1) {
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'run:created',
        payload: {
          packageName: run.packageName,
          packageVersion: run.packageVersion,
          sourcePath: run.sourcePath,
          idempotencyKey: input.idempotencyKey,
        },
      })
      const provisioned = await this.provisioningService.provisionRoleAgents({
        runtimeRoot,
        runId: run.runId,
        teamSkillPackage: packageResult.package,
      })
      managedAgentConfig = provisioned.managedConfigProjection
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'roles:provisioned',
        payload: { roleIds: provisioned.roles.map((role) => role.roleId) },
      })
    }

    return { runId: run.runId, status: run.status, revision: run.revision, ...(managedAgentConfig ? { managedAgentConfig } : {}) }
  }

  async start(input: { runId: string; idempotencyKey: string; initialPrompt?: string }): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const current = await this.runStore.read(runtimeRoot)
    if (!current) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }

    if (current.status === 'running') {
      await this.resumeRuntime({ runId: current.runId })
      await this.executeLeaderRun({ runtimeRoot, run: current, idempotencyKey: `${input.idempotencyKey}:leader`, initialPrompt: input.initialPrompt })
      return { runId: current.runId, status: current.status, revision: current.revision }
    }
    if (!STARTABLE_RUN_STATUSES.has(current.status)) {
      throw new Error(`TeamRun cannot be started from status ${current.status}: ${input.runId}`)
    }

    const run = await this.runStore.update({ runtimeRoot, status: 'running' })

    await this.resumeRuntime({ runId: run.runId })
    await this.eventStore.append({
      runtimeRoot,
      runId: run.runId,
      revision: run.revision,
      type: 'run:started',
      payload: { idempotencyKey: input.idempotencyKey },
    })
    await this.executeLeaderRun({ runtimeRoot, run, idempotencyKey: `${input.idempotencyKey}:leader`, initialPrompt: input.initialPrompt })
    await this.projectTeamRun({ runtimeRoot, run, reason: 'run:started' })
    return { runId: run.runId, status: run.status, revision: run.revision }
  }

  async resumeRuntime(input: { runId: string }): Promise<void> {
    await this.eventBus.start(input.runId)
  }

  async stopRuntime(input: { runId: string }): Promise<void> {
    if (!this.eventBus.isRunningForRun(input.runId)) {
      return
    }
    await this.eventBus.stop()
  }

  async cancel(input: { runId: string; reason?: string; idempotencyKey: string }): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const current = await this.runStore.read(runtimeRoot)
    if (!current) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    if (TERMINAL_RUN_STATUSES.has(current.status)) {
      throw new Error(`TeamRun cannot be cancelled from terminal status ${current.status}: ${input.runId}`)
    }

    const reason = input.reason ?? 'TeamRun cancelled'
    await this.stopRuntime({ runId: current.runId })
    const cancelledExecutions = await this.cancelDispatchExecutionsForRun({
      runtimeRoot,
      runId: current.runId,
      reason,
    })
    await this.cancelQueuedWorkflowState({
      runtimeRoot,
      run: current,
      reason,
      idempotencyKey: input.idempotencyKey,
    })
    const run = await this.runStore.update({ runtimeRoot, status: 'cancelled' })
    for (const execution of cancelledExecutions.executions) {
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'dispatch:execution_cancelled',
        payload: {
          executionRecordId: execution.executionRecordId,
          executionId: execution.executionId ?? null,
          dispatchId: execution.dispatchId,
          stageId: execution.stageId,
          roleId: execution.roleId,
          reason,
        },
      })
    }
    await this.eventStore.append({
      runtimeRoot,
      runId: run.runId,
      revision: run.revision,
      type: 'run:cancelled',
      payload: { reason: input.reason ?? null, idempotencyKey: input.idempotencyKey },
    })
    await this.projectTeamRun({ runtimeRoot, run, reason: 'run:cancelled' })
    return { runId: run.runId, status: run.status, revision: run.revision }
  }

  async delete(input: { runId: string }): Promise<{ runId: string; deleted: boolean; managedAgentConfig?: TeamManagedAgentConfigProjection }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const [run, runtimeRootExists, managedAgentConfig] = await Promise.all([
      this.runStore.read(runtimeRoot),
      directoryExists(runtimeRoot),
      this.readManagedAgentConfig(runtimeRoot),
    ])
    if (!run && !runtimeRootExists) {
      return { runId: input.runId, deleted: false }
    }

    await this.stopRuntime({ runId: run?.runId ?? input.runId })
    await this.cancelDispatchExecutionsForRun({
      runtimeRoot,
      runId: run?.runId ?? input.runId,
      reason: 'TeamRun deleted',
    })
    await rm(runtimeRoot, { recursive: true, force: true })
    return { runId: run?.runId ?? input.runId, deleted: true, ...(managedAgentConfig ? { managedAgentConfig } : {}) }
  }

  private async readManagedAgentConfig(runtimeRoot: string): Promise<TeamManagedAgentConfigProjection | undefined> {
    try {
      return JSON.parse(await readFile(path.join(runtimeRoot, 'managed', 'openclaw-agents.json'), 'utf8')) as TeamManagedAgentConfigProjection
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        return undefined
      }
      throw error
    }
  }

  private async requestTeamBackgroundGateway(method: import('../gateway/schemas.js').TeamBackgroundGatewayMethod, params: { runId: string }): Promise<void> {
    if (!this.teamGatewayRequest) {
      throw new Error('Team runtime background event consumption requires a runtime gateway request port.')
    }
    await this.teamGatewayRequest.request(method, params)
  }

  async snapshot(input: { runId: string; eventCursor?: number; eventLimit?: number }): Promise<TeamRunSnapshot> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    await this.refreshStaleDispatchExecutions(runtimeRoot)
    const [run, roles, approvals, artifacts, dispatches, dispatchExecutions, workflowPlan, dispatchGroups, dispatchTasks, messages, gates, kickbacks, decisions, events] = await Promise.all([
      this.runStore.read(runtimeRoot),
      this.roleStore.read(runtimeRoot),
      this.approvalStore.read(runtimeRoot),
      this.artifactStore.read(runtimeRoot),
      this.dispatchStore.read(runtimeRoot),
      this.dispatchExecutionStore.read(runtimeRoot),
      this.workflowStore.readPlan(runtimeRoot),
      this.workflowStore.readGroups(runtimeRoot),
      this.workflowStore.readTasks(runtimeRoot),
      this.messageStore.read(runtimeRoot),
      this.gateStore.read(runtimeRoot),
      this.kickbackStore.read(runtimeRoot),
      this.decisionStore.read(runtimeRoot),
      this.eventStore.read({ runtimeRoot, cursor: input.eventCursor, limit: input.eventLimit }),
    ])
    const diagnostics = await this.buildDiagnostics({
      runtimeRoot,
      run,
      roles,
      stages: [],
      approvals,
      artifacts,
      dispatches,
      dispatchExecutions,
      dispatchGroups,
      dispatchTasks,
      messages,
      gates,
      kickbacks,
      decisions,
      eventCount: events.nextCursor,
    })
    return {
      run,
      roles,
      stages: [],
      approvals,
      artifacts,
      dispatches,
      dispatchExecutions,
      workflowPlan,
      dispatchGroups,
      dispatchTasks,
      messages,
      gates,
      kickbacks,
      decisions,
      diagnostics,
      events: events.events,
      nextEventCursor: events.nextCursor,
    }
  }

  async diagnostics(input: { runId: string }): Promise<TeamRunDiagnostics> {
    return (await this.snapshot({ runId: input.runId, eventCursor: 0, eventLimit: 0 })).diagnostics
  }

  async planDependencies(input: { packagePath: string }): Promise<TeamDependencyPreparationPlan> {
    const packageResult = await this.packageService.validate(input.packagePath)
    if (!packageResult.valid || !packageResult.package) {
      throw new Error(`Invalid TeamSkill package: ${packageResult.errors.map((issue) => issue.message).join('; ')}`)
    }
    return await this.buildDependencyPreparationPlan({
      packageName: packageResult.package.name,
      packageVersion: packageResult.package.version,
      sourcePath: packageResult.package.sourcePath,
      dependencies: packageResult.package.dependencies,
    })
  }

  async planWorkflow(input: {
    runId: string
    title: string
    summary?: string
    groups: Record<string, unknown>[]
    tasks: Record<string, unknown>[]
    idempotencyKey: string
    workspaceDir?: string
  }): Promise<{ plan: TeamRunWorkflowPlan; created: boolean }> {

    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    await this.resumeRuntime({ runId: run.runId })
    this.assertLeaderToolCaller({ runtimeRoot, workspaceDir: input.workspaceDir })
    const roles = await this.roleStore.read(runtimeRoot)
    const roleIds = new Set(roles.map((role) => role.roleId))
    const tasks = input.tasks.map((task) => parseWorkflowTaskPlan(task, roleIds))
    const taskIds = new Set(tasks.map((task) => task.taskId))
    if (taskIds.size !== tasks.length) {
      throw new Error('Team workflow task ids must be unique')
    }
    for (const task of tasks) {
      for (const dependencyTaskId of task.dependsOnTaskIds) {
        if (!taskIds.has(dependencyTaskId)) {
          throw new Error(`Team workflow task dependency not found: ${dependencyTaskId}`)
        }
      }
    }
    const groups = input.groups.map((group) => parseWorkflowGroupPlan(group, taskIds))
    const groupIds = new Set(groups.map((group) => group.groupId))
    if (groupIds.size !== groups.length) {
      throw new Error('Team workflow group ids must be unique')
    }
    const plannedTaskIds = new Set(groups.flatMap((group) => group.taskIds))
    for (const task of tasks) {
      if (!plannedTaskIds.has(task.taskId)) {
        throw new Error(`Team workflow task is not assigned to a group: ${task.taskId}`)
      }
    }
    const saved = await this.workflowStore.savePlan({
      runtimeRoot,
      runId: run.runId,
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      groups,
      tasks,
      idempotencyKey: input.idempotencyKey,
    })
    const plan = saved.created
      ? (await this.workflowStore.updatePlanStatus({ runtimeRoot, status: 'running' })).plan
      : saved.plan
    if (saved.created) {
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'workflow:planned',
        payload: {
          workflowPlanId: plan.workflowPlanId,
          groupIds: plan.groups.map((group) => group.groupId),
          taskIds: plan.tasks.map((task) => task.taskId),
          idempotencyKey: input.idempotencyKey,
        },
      })
    }
    if (!this.disableAutoDispatch) {
      await this.sessionEngine.onWorkflowPlanned({ runtimeRoot, run, plan })
    }
    return { plan, created: saved.created }
  }

  async processDispatchQueue(input: {
    runId: string
  }): Promise<void> {
    if (!this.roleSessionExecution) {
      return
    }
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run || run.status !== 'running') {
      return
    }
    const pendingItems = await this.dispatchQueueStore.claimPending(input.runId)
    if (pendingItems.length === 0) {
      return
    }
    const roles = await this.roleStore.read(runtimeRoot)
    const roleByRoleId = new Map(roles.map((role) => [role.roleId, role]))
    const plan = await this.workflowStore.readPlan(runtimeRoot)

    for (const item of pendingItems) {
      const agentId = item.toRoleId === TEAM_LEADER_ROLE_ID
        ? buildTeamManagedAgentId(run.runId, TEAM_LEADER_ROLE_ID)
        : roleByRoleId.get(item.toRoleId)?.agentId
      if (!agentId) {
        await this.dispatchQueueStore.markFailed(runtimeRoot, item.queueItemId, `Role not found: ${item.toRoleId}`)
        continue
      }

      if (item.taskId) {
        const role = roleByRoleId.get(item.toRoleId)
        if (!role) {
          await this.dispatchQueueStore.markFailed(runtimeRoot, item.queueItemId, `Role not found: ${item.toRoleId}`)
          continue
        }
        await this.dispatchTask({ runtimeRoot, run, item, role, plan })
      } else {
        await this.dispatchMessage({ runtimeRoot, run, item, agentId })
      }
    }
  }

  private async dispatchTask(input: {
    runtimeRoot: string
    run: TeamRun
    item: { queueItemId: string; runId: string; toRoleId: string; taskId: string; prompt: string; idempotencyKey: string }
    role: import('../domain/team-role.js').TeamRoleBinding
    plan: import('../domain/team-workflow.js').TeamRunWorkflowPlan | null
  }): Promise<void> {
    const { runtimeRoot, run, item, role, plan } = input
    const taskPlan = plan?.tasks.find((t) => t.taskId === item.taskId)
    if (!taskPlan) {
      await this.dispatchQueueStore.markFailed(runtimeRoot, item.queueItemId, `Task not found in workflow plan: ${item.taskId}`)
      return
    }

    const groupPlan = this.resolveTaskGroupPlan(plan!, item.taskId)
    const dispatchPrompt = buildWorkflowTaskPrompt({ plan: plan!, group: groupPlan, task: taskPlan })
    const dispatch = await this.dispatchStore.save({
      runtimeRoot: runtimeRoot,
      runId: run.runId,
      stageId: item.taskId,
      roleId: item.toRoleId,
      prompt: dispatchPrompt,
      inputArtifactIds: [],
      kickbackIds: [],
      idempotencyKey: item.idempotencyKey,
    })
    if (!dispatch.created) {
      await this.dispatchQueueStore.markDispatched(runtimeRoot, item.queueItemId)
      return
    }
    const savedGroup = await this.workflowStore.saveGroup({
      runtimeRoot: runtimeRoot,
      runId: run.runId,
      workflowPlanId: plan!.workflowPlanId,
      groupId: groupPlan.groupId,
      taskIds: groupPlan.taskIds,
      idempotencyKey: `${plan!.workflowPlanId}:group:${groupPlan.groupId}`,
    })
    if (savedGroup.created) {
      await this.eventStore.append({
        runtimeRoot: runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'dispatch:group_queued',
        payload: {
          dispatchGroupId: savedGroup.group.dispatchGroupId,
          workflowPlanId: plan!.workflowPlanId,
          groupId: groupPlan.groupId,
          taskIds: groupPlan.taskIds,
          idempotencyKey: `${plan!.workflowPlanId}:group:${groupPlan.groupId}`,
        },
      })
    }
    const savedTask = await this.workflowStore.saveTask({
      runtimeRoot: runtimeRoot,
      runId: run.runId,
      workflowPlanId: plan!.workflowPlanId,
      dispatchGroupId: savedGroup.group.dispatchGroupId,
      groupId: groupPlan.groupId,
      taskId: item.taskId,
      roleId: item.toRoleId,
      dispatchId: dispatch.dispatch.dispatchId,
      idempotencyKey: `${plan!.workflowPlanId}:group:${groupPlan.groupId}:task:${item.taskId}`,
    })
    if (dispatch.created || savedTask.created) {
      await this.eventStore.append({
        runtimeRoot: runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'dispatch:task_queued',
        payload: {
          dispatchTaskId: savedTask.task.dispatchTaskId,
          dispatchId: savedTask.task.dispatchId,
          workflowPlanId: savedTask.task.workflowPlanId,
          dispatchGroupId: savedTask.task.dispatchGroupId,
          groupId: savedTask.task.groupId,
          taskId: savedTask.task.taskId,
          roleId: savedTask.task.roleId,
          idempotencyKey: `${item.idempotencyKey}:activation`,
        },
      })
    }

    try {
      const claimed = await this.dispatchExecutionStore.claim({
        runtimeRoot: runtimeRoot,
        runId: run.runId,
        dispatchId: dispatch.dispatch.dispatchId,
        stageId: item.taskId,
        roleId: item.toRoleId,
        idempotencyKey: `${item.idempotencyKey}:execution`,
      })
      const executed = await this.roleSessionExecution.executeRole({
        runId: run.runId,
        taskId: item.taskId,
        dispatch: dispatch.dispatch,
        role,
        prompt: dispatch.prompt,
      })
      await this.dispatchExecutionStore.attachQueuedExecution({
        runtimeRoot: runtimeRoot,
        executionRecordId: claimed.execution.executionRecordId,
        executionId: executed.executionId,
        childSessionKey: executed.childSessionKey,
        spawnMode: executed.spawnMode,
      })
      await this.dispatchQueueStore.markDispatched(runtimeRoot, item.queueItemId)
      await this.eventStore.append({
        runtimeRoot: runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'dispatch:execution_queued',
        payload: {
          executionRecordId: dispatch.dispatch.dispatchId,
          executionId: executed.executionId,
          childSessionKey: executed.childSessionKey,
          spawnMode: executed.spawnMode,
          dispatchId: executed.dispatchId,
          stageId: item.taskId,
          roleId: item.toRoleId,
          workflowPlanId: plan!.workflowPlanId,
          idempotencyKey: item.idempotencyKey,
        },
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.dispatchQueueStore.markFailed(runtimeRoot, item.queueItemId, reason)
      await this.markDispatchTaskFailed({ runtimeRoot: runtimeRoot, dispatchId: dispatch.dispatch.dispatchId, reason })
      await this.eventStore.append({
        runtimeRoot: runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'dispatch:execution_failed',
        payload: {
          dispatchId: dispatch.dispatch.dispatchId,
          stageId: item.taskId,
          roleId: item.toRoleId,
          reason,
        },
      })
    }
  }

  private async dispatchMessage(input: {
    runtimeRoot: string
    run: TeamRun
    item: { queueItemId: string; runId: string; toRoleId: string; taskId?: string; prompt: string; idempotencyKey: string }
    agentId: string
  }): Promise<void> {
    const { runtimeRoot, run, item } = input
    try {
      await this.roleSessionExecution.sendMessage({
        agentId,
        taskId: item.taskId,
        body: item.prompt,
        idempotencyKey: item.idempotencyKey,
      })
      await this.dispatchQueueStore.markDispatched(runtimeRoot, item.queueItemId)
      await this.eventStore.append({
        runtimeRoot: runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'message:delivered',
        payload: {
          queueItemId: item.queueItemId,
          toRoleId: item.toRoleId,
          taskId: item.taskId ?? null,
        },
      })
    } catch (error) {
      await this.dispatchQueueStore.markFailed(runtimeRoot, item.queueItemId, error instanceof Error ? error.message : String(error))
    }
  }

  async processLeaderSynthesis(input: {
    runId: string
  }): Promise<void> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      return
    }
    if (!this.roleSessionExecution) {
      await this.appendLeaderSynthesisSkippedOnce({ runtimeRoot, run, reason: 'role_session_execution_missing' })
      return
    }
    if (run.status !== 'running') {
      await this.appendLeaderSynthesisSkippedOnce({ runtimeRoot, run, reason: 'run_not_running', payload: { runStatus: run.status } })
      return
    }
    const plan = await this.workflowStore.readPlan(runtimeRoot)
    if (!plan) {
      await this.appendLeaderSynthesisSkippedOnce({ runtimeRoot, run, reason: 'workflow_plan_missing' })
      return
    }
    const planTasks = (await this.workflowStore.readTasks(runtimeRoot)).filter((task) => task.workflowPlanId === plan.workflowPlanId)
    const verdict = this.evaluateWorkflowPlanOutcome({ plan, tasks: planTasks })
    if (!verdict.readyForSynthesis || verdict.finalStatus !== 'completed') {
      await this.appendLeaderSynthesisSkippedOnce({
        runtimeRoot,
        run,
        reason: verdict.readyForSynthesis ? 'workflow_not_completed' : 'workflow_not_ready',
        workflowPlanId: plan.workflowPlanId,
        payload: verdict,
      })
      return
    }
    const synthesisKey = `leader:synthesis:${plan.workflowPlanId}`
    const existing = await this.dispatchStore.save({
      runtimeRoot,
      runId: run.runId,
      stageId: TEAM_LEADER_ROLE_ID,
      roleId: TEAM_LEADER_ROLE_ID,
      prompt: '',
      inputArtifactIds: [],
      kickbackIds: [],
      idempotencyKey: synthesisKey,
      workflowPlanId: plan.workflowPlanId,
    })
    if (!existing.created) {
      await this.appendLeaderSynthesisSkippedOnce({ runtimeRoot, run, reason: 'already_queued', workflowPlanId: plan.workflowPlanId })
      return
    }
    const summary = [
      `All ${planTasks.length} workflow tasks have settled.`,
      `${verdict.completedCount} succeeded, ${verdict.failedCount} did not complete successfully.`,
      '',
      'Review the artifacts produced by each role and produce the final integrated TeamRun output.',
    ].join('\n')
    const role = this.buildLeaderRoleBinding(run)
    try {
      const execution = await this.executeDispatchRecord({
        runtimeRoot,
        run,
        dispatch: existing.dispatch,
        role,
        prompt: summary,
        idempotencyKey: synthesisKey,
      })
      await this.bindLeaderSynthesisRunContext({
        runtimeRoot,
        run,
        workflowPlanId: plan.workflowPlanId,
        executionId: execution.execution.executionId,
      })
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'leader:synthesis_queued',
        payload: {
          workflowPlanId: plan.workflowPlanId,
          executionRecordId: execution.execution.executionRecordId,
          executionId: execution.execution.executionId ?? null,
        },
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'leader:synthesis_failed',
        payload: { workflowPlanId: plan.workflowPlanId, reason },
      })
    }
  }

  private async appendLeaderSynthesisSkippedOnce(input: {
    runtimeRoot: string
    run: TeamRun
    reason: string
    workflowPlanId?: string
    payload?: Record<string, unknown>
  }): Promise<void> {
    const events = await this.eventStore.read({ runtimeRoot: input.runtimeRoot, cursor: 0, limit: 2_000 })
    const alreadyRecorded = events.events.some((event) => (
      event.type === 'leader:synthesis_skipped'
      && event.payload.reason === input.reason
      && event.payload.workflowPlanId === (input.workflowPlanId ?? null)
    ))
    if (alreadyRecorded) {
      return
    }
    await this.eventStore.append({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      revision: input.run.revision,
      type: 'leader:synthesis_skipped',
      payload: {
        workflowPlanId: input.workflowPlanId ?? null,
        reason: input.reason,
        ...(input.payload ?? {}),
      },
    })
  }

  private async bindLeaderSynthesisRunContext(input: {
    runtimeRoot: string
    run: TeamRun
    workflowPlanId: string
    executionId?: string
  }): Promise<void> {
    if (!input.executionId) {
      await this.appendLeaderSynthesisTrackingFailed({
        runtimeRoot: input.runtimeRoot,
        run: input.run,
        workflowPlanId: input.workflowPlanId,
        executionId: null,
        reason: 'execution_id_missing',
      })
      return
    }
    if (!this.runContext) {
      await this.appendLeaderSynthesisTrackingFailed({
        runtimeRoot: input.runtimeRoot,
        run: input.run,
        workflowPlanId: input.workflowPlanId,
        executionId: input.executionId,
        reason: 'run_context_missing',
      })
      return
    }
    try {
      const bound = await this.runContext.setRunContext({
        runId: input.executionId,
        namespace: TEAM_LEADER_SYNTHESIS_RUN_CONTEXT_NAMESPACE,
        value: { teamRunId: input.run.runId, workflowPlanId: input.workflowPlanId },
      })
      if (!bound) {
        await this.appendLeaderSynthesisTrackingFailed({
          runtimeRoot: input.runtimeRoot,
          run: input.run,
          workflowPlanId: input.workflowPlanId,
          executionId: input.executionId,
          reason: 'set_run_context_rejected',
        })
      }
    } catch (error) {
      await this.appendLeaderSynthesisTrackingFailed({
        runtimeRoot: input.runtimeRoot,
        run: input.run,
        workflowPlanId: input.workflowPlanId,
        executionId: input.executionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async appendLeaderSynthesisTrackingFailed(input: {
    runtimeRoot: string
    run: TeamRun
    workflowPlanId: string
    executionId: string | null
    reason: string
  }): Promise<void> {
    await this.eventStore.append({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      revision: input.run.revision,
      type: 'leader:synthesis_tracking_failed',
      payload: {
        workflowPlanId: input.workflowPlanId,
        executionId: input.executionId,
        reason: input.reason,
      },
    })
  }

  async recordLeaderSynthesisTerminalIgnored(input: {
    teamRunId: string
    workflowPlanId?: string
    reason: string
    message?: string
  }): Promise<void> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamRunId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      return
    }
    await this.eventStore.append({
      runtimeRoot,
      runId: run.runId,
      revision: run.revision,
      type: 'leader:synthesis_terminal_ignored',
      payload: {
        workflowPlanId: input.workflowPlanId ?? null,
        reason: input.reason,
        message: input.message ?? null,
      },
    })
  }

  async completeStage(_input: {
    runId: string
    stageId: string
    outputArtifactIds?: string[]
    idempotencyKey: string
  }): Promise<{ runId: string; status: TeamRunStatus; revision: number; currentStageId?: string }> {
    throw new Error('TeamRun stage completion is not supported; roles complete workflow tasks by calling team_submit_artifact.')
  }

  async completeLeaderSynthesis(input: {
    teamRunId: string
    workflowPlanId: string
    succeeded: boolean
    reason?: string
  }): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamRunId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.teamRunId}`)
    }
    const plan = await this.workflowStore.readPlan(runtimeRoot)
    if (!plan || plan.workflowPlanId !== input.workflowPlanId) {
      throw new Error(`TeamRun workflow plan not found: ${input.workflowPlanId}`)
    }
    const synthesisDispatch = (await this.dispatchStore.read(runtimeRoot)).find((dispatch) => (
      dispatch.workflowPlanId === input.workflowPlanId
      && dispatch.roleId === TEAM_LEADER_ROLE_ID
      && dispatch.idempotencyKey === `leader:synthesis:${input.workflowPlanId}`
    ))
    if (synthesisDispatch) {
      if (input.succeeded) {
        await this.dispatchExecutionStore.markCompleted({
          runtimeRoot,
          dispatchId: synthesisDispatch.dispatchId,
          reason: input.reason ?? 'Leader synthesis completed',
        })
      } else {
        const execution = (await this.dispatchExecutionStore.read(runtimeRoot)).find((candidate) => (
          candidate.dispatchId === synthesisDispatch.dispatchId
          && (candidate.status === 'claimed' || candidate.status === 'queued')
        ))
        if (execution) {
          await this.dispatchExecutionStore.markFailed({
            runtimeRoot,
            executionRecordId: execution.executionRecordId,
            reason: input.reason ?? 'Leader synthesis failed',
          })
        }
      }
    }
    const verdict = this.evaluateWorkflowPlanOutcome({
      plan,
      tasks: (await this.workflowStore.readTasks(runtimeRoot)).filter((task) => task.workflowPlanId === plan.workflowPlanId),
    })
    const finalStatus = input.succeeded && verdict.finalStatus === 'completed' ? 'completed' : 'failed'
    await this.workflowStore.updatePlanStatus({ runtimeRoot, status: finalStatus })
    const nextRun = TERMINAL_RUN_STATUSES.has(run.status)
      ? run
      : await this.runStore.update({ runtimeRoot, status: finalStatus, currentStageId: TEAM_LEADER_ROLE_ID })
    await this.eventStore.append({
      runtimeRoot,
      runId: nextRun.runId,
      revision: nextRun.revision,
      type: finalStatus === 'completed' ? 'run:completed' : 'run:failed',
      payload: {
        workflowPlanId: input.workflowPlanId,
        reason: input.reason ?? null,
      },
    })
    await this.stopRuntime({ runId: nextRun.runId })
    await this.projectTeamRun({ runtimeRoot, run: nextRun, reason: finalStatus === 'completed' ? 'leader:synthesis_completed' : 'leader:synthesis_failed' })
    return { runId: nextRun.runId, status: nextRun.status, revision: nextRun.revision }
  }

  async requestApproval(input: {
    runId: string
    stageId: string
    roleId: string
    reason: string
    requestedAction: string
    risk: string
    idempotencyKey: string
    workspaceDir?: string
    callerAgentId?: string
    childSessionKey?: string
  }): Promise<{ approval: TeamApproval; created: boolean }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const roles = await this.roleStore.read(runtimeRoot)
    const role = roles.find((binding) => binding.roleId === input.roleId)
    if (!role) {
      throw new Error(`Team role not found: ${input.roleId}`)
    }
    this.assertRoleChildSessionToolCaller({ run, role, callerAgentId: input.callerAgentId, childSessionKey: input.childSessionKey })
    const existingApproval = (await this.approvalStore.read(runtimeRoot)).find((approval) => approval.idempotencyKey === input.idempotencyKey)
    if (existingApproval) {
      await this.reconcileRequestedApproval({ runtimeRoot, run, approval: existingApproval, idempotencyKey: input.idempotencyKey })
      return { approval: existingApproval, created: false }
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    const { task } = await this.ensureQueuedWorkflowTask({
      runtimeRoot,
      run,
      role,
      stageId: input.stageId,
      childSessionKey: input.childSessionKey,
      activationKey: input.idempotencyKey,
    })

    const requested = await this.approvalStore.request({
      runtimeRoot,
      runId: run.runId,
      stageId: task.taskId,
      roleId: role.roleId,
      reason: input.reason,
      requestedAction: input.requestedAction,
      risk: input.risk,
      idempotencyKey: input.idempotencyKey,
    })

    if (requested.created) {
      await this.reconcileRequestedApproval({ runtimeRoot, run, approval: requested.approval, idempotencyKey: input.idempotencyKey })
    }

    return requested
  }

  async resolveApproval(input: {
    runId: string
    approvalId: string
    decision: 'approve' | 'deny' | 'abort'
    note?: string
    idempotencyKey: string
  }): Promise<{ approval: TeamApproval }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const status = input.decision === 'approve' ? 'approved' : input.decision === 'deny' ? 'denied' : 'aborted'
    const resolved = await this.approvalStore.resolve({
      runtimeRoot,
      approvalId: input.approvalId,
      status,
      ...(input.note ? { note: input.note } : {}),
    })
    const approval = resolved.approval

    if (resolved.resolved || approval.status === status) {
      await this.reconcileResolvedApproval({ runtimeRoot, run, approval, decision: input.decision, idempotencyKey: input.idempotencyKey })
    }

    return { approval }
  }

  async submitArtifact(input: {
    runId: string
    stageId: string
    roleId: string
    kind: string
    title: string
    content: string
    summary?: string
    idempotencyKey: string
    workspaceDir?: string
    callerAgentId?: string
    childSessionKey?: string
  }): Promise<{ artifact: TeamArtifact; created: boolean }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const roles = await this.roleStore.read(runtimeRoot)
    const role = roles.find((binding) => binding.roleId === input.roleId)
    if (!role) {
      throw new Error(`Team role not found: ${input.roleId}`)
    }
    this.assertRoleChildSessionToolCaller({ run, role, callerAgentId: input.callerAgentId, childSessionKey: input.childSessionKey })

    const existingArtifact = (await this.artifactStore.read(runtimeRoot)).find((artifact) => artifact.idempotencyKey === input.idempotencyKey)
    if (existingArtifact) {
      const workflowTask = await this.findQueuedWorkflowTask({ runtimeRoot, stageId: existingArtifact.stageId, roleId: existingArtifact.roleId, childSessionKey: input.childSessionKey })
      if (workflowTask) {
        await this.closeQueuedWorkflowTask({ runtimeRoot, run, task: workflowTask.task, artifactId: existingArtifact.artifactId, idempotencyKey: input.idempotencyKey })
      }
      return { artifact: existingArtifact, created: false }
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    const workflowTask = await this.ensureQueuedWorkflowTask({
      runtimeRoot,
      run,
      role,
      stageId: input.stageId,
      childSessionKey: input.childSessionKey,
      activationKey: input.idempotencyKey,
    })

    const submitted = await this.artifactStore.submit({
      runtimeRoot,
      runId: run.runId,
      stageId: workflowTask.task.taskId,
      roleId: role.roleId,
      kind: input.kind,
      title: input.title,
      content: input.content,
      ...(input.summary ? { summary: input.summary } : {}),
      idempotencyKey: input.idempotencyKey,
    })

    if (submitted.created) {
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'artifact:submitted',
        payload: {
          artifactId: submitted.artifact.artifactId,
          stageId: submitted.artifact.stageId,
          roleId: submitted.artifact.roleId,
          kind: submitted.artifact.kind,
          title: submitted.artifact.title,
          idempotencyKey: input.idempotencyKey,
        },
      })
      await this.closeQueuedWorkflowTask({
        runtimeRoot,
        run,
        task: workflowTask.task,
        artifactId: submitted.artifact.artifactId,
        idempotencyKey: input.idempotencyKey,
      })
    }

    return submitted
  }

  async updateTask(input: {
    runId: string
    stageId: string
    roleId: string
    status: TeamTaskUpdateProjectionInput['status']
    summary: string
    detail?: string
    progress?: number
    metadata?: Record<string, unknown>
    idempotencyKey: string
    workspaceDir?: string
    callerAgentId?: string
    childSessionKey?: string
  }): Promise<{ runId: string; stageId: string; roleId: string; status: TeamTaskUpdateProjectionInput['status']; summary: string }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const roles = await this.roleStore.read(runtimeRoot)
    const role = roles.find((binding) => binding.roleId === input.roleId)
    if (!role) {
      throw new Error(`Team role not found: ${input.roleId}`)
    }
    this.assertRoleChildSessionToolCaller({ run, role, callerAgentId: input.callerAgentId, childSessionKey: input.childSessionKey })
    if (run.status !== 'running' && run.status !== 'waiting_for_user') {
      throw new Error(`TeamRun is not active: ${input.runId}`)
    }
    const { task } = await this.ensureQueuedWorkflowTask({
      runtimeRoot,
      run,
      role,
      stageId: input.stageId,
      childSessionKey: input.childSessionKey,
      activationKey: input.idempotencyKey,
    })

    await this.eventStore.append({
      runtimeRoot,
      runId: run.runId,
      revision: run.revision,
      type: 'task:update_submitted',
      payload: {
        stageId: task.taskId,
        dispatchTaskId: task.dispatchTaskId,
        workflowPlanId: task.workflowPlanId,
        dispatchGroupId: task.dispatchGroupId,
        groupId: task.groupId,
        roleId: role.roleId,
        status: input.status,
        summary: input.summary,
        detail: input.detail ?? null,
        progress: input.progress ?? null,
        metadata: input.metadata ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    })
    await this.projectTaskUpdate({
      runtimeRoot,
      run,
      taskId: task.taskId,
      roleId: role.roleId,
      status: input.status,
      summary: input.summary,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
    return { runId: run.runId, stageId: task.taskId, roleId: role.roleId, status: input.status, summary: input.summary }
  }

  async sendMessage(input: {
    runId: string
    fromRoleId: string
    toRoleId: string
    summary: string
    body: string
    idempotencyKey: string
    workspaceDir?: string
    callerAgentId?: string
    childSessionKey?: string
  }): Promise<{ message: TeamMessage; created: boolean }> {

    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`TeamRun cannot accept messages from terminal status ${run.status}: ${input.runId}`)
    }
    await this.resumeRuntime({ runId: run.runId })
    const roles = await this.roleStore.read(runtimeRoot)
    const fromRole = roles.find((binding) => binding.roleId === input.fromRoleId)
    if (!fromRole) {
      throw new Error(`Team role not found: ${input.fromRoleId}`)
    }
    if (input.toRoleId !== 'leader' && !roles.some((binding) => binding.roleId === input.toRoleId)) {
      throw new Error(`Team message target not found: ${input.toRoleId}`)
    }
    this.assertRoleChildSessionToolCaller({ run, role: fromRole, callerAgentId: input.callerAgentId, childSessionKey: input.childSessionKey })

    const sent = await this.messageStore.send({
      runtimeRoot,
      runId: run.runId,
      fromRoleId: fromRole.roleId,
      toRoleId: input.toRoleId,
      summary: input.summary,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
    })

    if (sent.created) {
      await this.dispatchQueueStore.enqueue({
        runId: run.runId,
        toRoleId: input.toRoleId,
        prompt: input.body,
        idempotencyKey: `msg:${input.idempotencyKey}`,
      })
      this.eventBus.enqueue({ type: 'message:created', runId: run.runId, timestamp: Date.now() })
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'message:sent',
        payload: {
          messageId: sent.message.messageId,
          fromRoleId: sent.message.fromRoleId,
          toRoleId: sent.message.toRoleId,
          summary: sent.message.summary,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }

    return sent
  }

  async tick(input: { runId: string; idempotencyKey: string }): Promise<TeamRunTickResult> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    if (run.status !== 'running') {
      return {
        action: 'noop',
        runId: run.runId,
        status: run.status,
        revision: run.revision,
        reason: `TeamRun is not running: ${run.status}`,
        ...(run.currentStageId ? { currentStageId: run.currentStageId } : {}),
      }
    }

    await this.resumeRuntime({ runId: run.runId })
    const budgetExceeded = await this.failRunIfWallClockBudgetExceeded({ runtimeRoot, run, idempotencyKey: input.idempotencyKey })
    if (budgetExceeded) {
      return {
        action: 'noop',
        runId: budgetExceeded.runId,
        status: budgetExceeded.status,
        revision: budgetExceeded.revision,
        reason: 'TeamRun wall-clock budget exceeded',
        ...(budgetExceeded.currentStageId ? { currentStageId: budgetExceeded.currentStageId } : {}),
      }
    }

    await this.refreshStaleDispatchExecutions(runtimeRoot)

    await this.processDispatchQueue({ runId: run.runId })

    return {
      action: 'noop',
      runId: run.runId,
      status: run.status,
      revision: run.revision,
      reason: 'TeamRun is driven by leader workflow tools',
      ...(run.currentStageId ? { currentStageId: run.currentStageId } : {}),
    }
  }

  private resolveTaskGroupPlan(plan: TeamRunWorkflowPlan, taskId: string, groupId?: string): TeamWorkflowGroupPlan {
    const groups = plan.groups.filter((group) => group.taskIds.includes(taskId))
    const group = groupId ? groups.find((candidate) => candidate.groupId === groupId) : groups[0]
    if (!group) {
      throw new Error(`Team workflow task group not found for task: ${taskId}`)
    }
    if (!groupId && groups.length > 1) {
      throw new Error(`Team workflow task belongs to multiple groups; groupId is required: ${taskId}`)
    }
    return group
  }

  private async assertTaskDependenciesCompleted(input: { runtimeRoot: string; plan: TeamRunWorkflowPlan; task: TeamWorkflowTaskPlan }): Promise<void> {
    if (input.task.dependsOnTaskIds.length === 0) {
      return
    }
    const dispatchTasks = (await this.workflowStore.readTasks(input.runtimeRoot)).filter((task) => task.workflowPlanId === input.plan.workflowPlanId)
    const completedTaskIds = new Set(dispatchTasks.filter((task) => task.status === 'completed').map((task) => task.taskId))
    const failedTaskIds = new Set(dispatchTasks.filter((task) => task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale').map((task) => task.taskId))
    const settledTaskIds = new Set(dispatchTasks.filter((task) => task.status !== 'queued').map((task) => task.taskId))
    const readiness = this.evaluateWorkflowTaskReadiness({
      task: input.task,
      plan: input.plan,
      completedTaskIds,
      failedTaskIds,
      settledTaskIds,
    })
    if (readiness === 'runnable') {
      return
    }
    const firstDependencyTaskId = input.task.dependsOnTaskIds[0]
    throw new Error(`Team workflow task dependency is not completed: ${firstDependencyTaskId}`)
  }

  private async artifactIdsForTask(runtimeRoot: string, task: TeamWorkflowTaskPlan): Promise<string[]> {
    if (task.dependsOnTaskIds.length === 0) {
      return []
    }
    const dispatchTasks = await this.workflowStore.readTasks(runtimeRoot)
    return Array.from(new Set(dispatchTasks
      .filter((dispatchTask) => task.dependsOnTaskIds.includes(dispatchTask.taskId) && dispatchTask.artifactId)
      .map((dispatchTask) => dispatchTask.artifactId as string)))
  }

  private evaluateWorkflowTaskReadiness(input: {
    task: TeamWorkflowTaskPlan
    plan: TeamRunWorkflowPlan
    completedTaskIds: Set<string>
    failedTaskIds: Set<string>
    settledTaskIds: Set<string>
  }): 'runnable' | 'waiting' | 'blocked' {
    if (input.task.dependsOnTaskIds.length === 0) {
      return 'runnable'
    }
    const dependencyGroups = new Map<string, string[]>()
    for (const dependencyTaskId of input.task.dependsOnTaskIds) {
      const group = input.plan.groups.find((candidate) => candidate.taskIds.includes(dependencyTaskId))
      if (!group) {
        return 'waiting'
      }
      const existing = dependencyGroups.get(group.groupId)
      if (existing) {
        existing.push(dependencyTaskId)
      } else {
        dependencyGroups.set(group.groupId, [dependencyTaskId])
      }
    }
    let waiting = false
    for (const [groupId, dependencyTaskIds] of dependencyGroups) {
      const group = input.plan.groups.find((candidate) => candidate.groupId === groupId)
      if (!group) {
        return 'waiting'
      }
      const completedDependencies = dependencyTaskIds.filter((taskId) => input.completedTaskIds.has(taskId))
      const failedDependencies = dependencyTaskIds.filter((taskId) => input.failedTaskIds.has(taskId))
      if (group.join.requireCompleted) {
        if (failedDependencies.length > 0) {
          return 'blocked'
        }
        if (completedDependencies.length !== dependencyTaskIds.length) {
          waiting = true
        }
        continue
      }
      const groupSettled = group.taskIds.every((taskId) => input.settledTaskIds.has(taskId))
      if (!groupSettled) {
        waiting = true
        continue
      }
      if (!group.join.allowFailed && failedDependencies.length > 0) {
        return 'blocked'
      }
      if (completedDependencies.length === 0 && failedDependencies.length === dependencyTaskIds.length) {
        return 'blocked'
      }
    }
    return waiting ? 'waiting' : 'runnable'
  }

  private evaluateWorkflowPlanOutcome(input: {
    plan: TeamRunWorkflowPlan
    tasks: TeamDispatchTaskRecord[]
  }): {
    readyForSynthesis: boolean
    finalStatus: 'completed' | 'failed' | 'running'
    completedCount: number
    failedCount: number
  } {
    if (input.tasks.length === 0) {
      return input.plan.tasks.length === 0
        ? { readyForSynthesis: true, finalStatus: 'completed', completedCount: 0, failedCount: 0 }
        : { readyForSynthesis: false, finalStatus: 'running', completedCount: 0, failedCount: 0 }
    }
    const taskByTaskId = new Map(input.tasks.map((task) => [task.taskId, task]))
    const completedTaskIds = new Set(input.tasks.filter((task) => task.status === 'completed').map((task) => task.taskId))
    const failedTaskIds = new Set(input.tasks.filter((task) => task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale').map((task) => task.taskId))
    const settledTaskIds = new Set(input.tasks.filter((task) => task.status !== 'queued').map((task) => task.taskId))

    const derivedStates = new Map<string, 'completed' | 'failed' | 'running'>()
    for (const taskPlan of input.plan.tasks) {
      const task = taskByTaskId.get(taskPlan.taskId)
      if (task?.status === 'completed') {
        derivedStates.set(taskPlan.taskId, 'completed')
        continue
      }
      if (task && (task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale')) {
        derivedStates.set(taskPlan.taskId, 'failed')
        continue
      }
      if (task?.status === 'queued') {
        derivedStates.set(taskPlan.taskId, 'running')
        continue
      }
      const readiness = this.evaluateWorkflowTaskReadiness({
        task: taskPlan,
        plan: input.plan,
        completedTaskIds,
        failedTaskIds,
        settledTaskIds,
      })
      derivedStates.set(taskPlan.taskId, readiness === 'blocked' ? 'failed' : 'running')
    }

    const completedCount = Array.from(derivedStates.values()).filter((state) => state === 'completed').length
    const failedCount = Array.from(derivedStates.values()).filter((state) => state === 'failed').length

    let hasRunningGroup = false
    let hasFailedGroup = false
    for (const group of input.plan.groups) {
      const states = group.taskIds.map((taskId) => derivedStates.get(taskId) ?? 'running')
      if (states.some((state) => state === 'running')) {
        hasRunningGroup = true
        continue
      }
      const groupCompletedCount = states.filter((state) => state === 'completed').length
      const groupFailedCount = states.filter((state) => state === 'failed').length
      if (groupCompletedCount === group.taskIds.length) {
        continue
      }
      if (group.join.requireCompleted && groupCompletedCount !== group.taskIds.length) {
        hasFailedGroup = true
        continue
      }
      if (!group.join.allowFailed && groupFailedCount > 0) {
        hasFailedGroup = true
        continue
      }
      if (groupCompletedCount === 0) {
        hasFailedGroup = true
      }
    }

    if (hasRunningGroup) {
      return { readyForSynthesis: false, finalStatus: 'running', completedCount, failedCount }
    }
    if (hasFailedGroup) {
      return { readyForSynthesis: true, finalStatus: 'failed', completedCount, failedCount }
    }
    return { readyForSynthesis: true, finalStatus: 'completed', completedCount, failedCount }
  }

  private async retryWorkflowTask(input: {
    runtimeRoot: string
    run: TeamRun
    task: TeamDispatchTaskRecord
    reason: string
  }): Promise<boolean> {
    const plan = await this.workflowStore.readPlan(input.runtimeRoot)
    if (!plan || plan.status !== 'running') {
      return false
    }
    const taskPlan = plan.tasks.find((candidate) => candidate.taskId === input.task.taskId)
    if (!taskPlan) {
      return false
    }
    const groupPlan = this.resolveTaskGroupPlan(plan, input.task.taskId, input.task.groupId)
    const currentAttemptCount = input.task.attemptCount ?? 1
    if (currentAttemptCount > groupPlan.join.retryLimit) {
      return false
    }
    const nextAttemptCount = currentAttemptCount + 1
    await this.dispatchQueueStore.enqueue({
      runId: input.run.runId,
      toRoleId: input.task.roleId,
      taskId: input.task.taskId,
      prompt: taskPlan.prompt,
      idempotencyKey: `orchestrate:${input.run.runId}:${input.task.taskId}:${plan.workflowPlanId}:retry:${nextAttemptCount}`,
    })
    const updatedTask = await this.workflowStore.updateTaskStatus({
      runtimeRoot: input.runtimeRoot,
      dispatchTaskId: input.task.dispatchTaskId,
      status: 'queued',
      incrementAttemptCount: true,
    })
    await this.eventStore.append({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      revision: input.run.revision,
      type: 'dispatch:task_retry_scheduled',
      payload: {
        dispatchTaskId: updatedTask.task.dispatchTaskId,
        workflowPlanId: updatedTask.task.workflowPlanId,
        dispatchGroupId: updatedTask.task.dispatchGroupId,
        groupId: updatedTask.task.groupId,
        taskId: updatedTask.task.taskId,
        roleId: updatedTask.task.roleId,
        attemptCount: updatedTask.task.attemptCount,
        reason: input.reason,
      },
    })
    this.eventBus.enqueue({ type: 'task:created', runId: input.run.runId, timestamp: Date.now() })
    return true
  }

  private async maybeFinalizeWorkflowTerminalState(input: {
    runtimeRoot: string
    run: TeamRun
    reason: string
  }): Promise<void> {
    const plan = await this.workflowStore.readPlan(input.runtimeRoot)
    if (!plan || plan.status !== 'running') {
      return
    }
    const tasks = (await this.workflowStore.readTasks(input.runtimeRoot)).filter((task) => task.workflowPlanId === plan.workflowPlanId)
    const verdict = this.evaluateWorkflowPlanOutcome({ plan, tasks })
    if (!verdict.readyForSynthesis || verdict.finalStatus !== 'failed') {
      return
    }
    const updatedPlan = await this.workflowStore.updatePlanStatus({ runtimeRoot: input.runtimeRoot, status: 'failed' })
    const nextRun = TERMINAL_RUN_STATUSES.has(input.run.status)
      ? input.run
      : await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'failed', currentStageId: TEAM_LEADER_ROLE_ID })
    if (updatedPlan.changed || nextRun.status === 'failed') {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: nextRun.runId,
        revision: nextRun.revision,
        type: 'run:failed',
        payload: {
          workflowPlanId: plan.workflowPlanId,
          reason: input.reason,
        },
      })
      await this.stopRuntime({ runId: nextRun.runId })
      await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: nextRun, reason: 'workflow:failed' })
    }
  }

  private async executeLeaderRun(input: { runtimeRoot: string; run: TeamRun; idempotencyKey: string; initialPrompt?: string }): Promise<void> {
    if (!this.roleSessionExecution) {
      throw new Error('Team leader session execution is not configured')
    }
    const role = this.buildLeaderRoleBinding(input.run)
    const dispatch = await this.dispatchStore.save({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      stageId: TEAM_LEADER_ROLE_ID,
      roleId: TEAM_LEADER_ROLE_ID,
      prompt: buildLeaderRunPrompt(input.run, input.initialPrompt),
      inputArtifactIds: [],
      kickbackIds: [],
      idempotencyKey: input.idempotencyKey,
    })
    const execution = await this.executeDispatchRecord({
      runtimeRoot: input.runtimeRoot,
      run: input.run,
      dispatch: dispatch.dispatch,
      role,
      prompt: dispatch.prompt,
      idempotencyKey: `${input.idempotencyKey}:execution`,
    })
    if (dispatch.created || execution.created) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'leader:execution_queued',
        payload: {
          dispatchId: dispatch.dispatch.dispatchId,
          executionRecordId: execution.execution.executionRecordId,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }
  }

  private buildLeaderRoleBinding(run: TeamRun): TeamRoleBinding {
    return {
      runId: run.runId,
      roleId: TEAM_LEADER_ROLE_ID,
      agentId: buildTeamManagedAgentId(run.runId, TEAM_LEADER_ROLE_ID),
      agentName: TEAM_LEADER_ROLE_ID,
      workspaceDir: path.join(this.resolveRuntimeRoot(run.runId), TEAM_LEADER_ROLE_ID),
      agentDir: path.join(this.deps.storageRoot, 'agents', sanitizePathSegment(run.runId), TEAM_LEADER_ROLE_ID, 'agent'),
      skills: [],
      tools: [],
      status: 'provisioned',
    }
  }

  private async executeDispatchRecord(input: {
    runtimeRoot: string
    run: TeamRun
    dispatch: TeamDispatchEnvelope
    role: TeamRoleBinding
    prompt: string
    idempotencyKey: string
  }): Promise<{ execution: TeamDispatchExecutionRecord; created: boolean }> {
    if (!this.roleSessionExecution) {
      throw new Error('Team role session execution is not configured')
    }
    const claimed = await this.dispatchExecutionStore.claim({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      dispatchId: input.dispatch.dispatchId,
      stageId: input.dispatch.stageId,
      roleId: input.dispatch.roleId,
      idempotencyKey: input.idempotencyKey,
    })
    if (!claimed.created) {
      return claimed
    }
    if (input.dispatch.roleId !== TEAM_LEADER_ROLE_ID) {
      throw new Error('TeamRun role dispatch is performed by the leader through OpenClaw native sessions_spawn.')
    }
    let executed: Awaited<ReturnType<RoleSessionExecutionPort['executeLeader']>>
    try {
      executed = await this.roleSessionExecution.executeLeader({
        runId: input.run.runId,
        dispatch: input.dispatch,
        role: input.role,
        prompt: input.prompt,
      })
      if (executed.dispatchId !== input.dispatch.dispatchId) {
        throw new Error(`Team dispatch execution returned dispatchId ${executed.dispatchId}, expected ${input.dispatch.dispatchId}`)
      }
      if (executed.roleId !== input.dispatch.roleId) {
        throw new Error(`Team dispatch execution returned roleId ${executed.roleId}, expected ${input.dispatch.roleId}`)
      }
    } catch (error) {
      const failed = await this.dispatchExecutionStore.markFailed({
        runtimeRoot: input.runtimeRoot,
        executionRecordId: claimed.execution.executionRecordId,
        reason: error instanceof Error ? error.message : String(error),
      })
      await this.markDispatchTaskFailed({ runtimeRoot: input.runtimeRoot, dispatchId: input.dispatch.dispatchId, reason: failed.execution.statusReason ?? 'Dispatch execution failed' })
      throw error
    }
    const queued = await this.dispatchExecutionStore.attachQueuedExecution({
      runtimeRoot: input.runtimeRoot,
      executionRecordId: claimed.execution.executionRecordId,
      executionId: executed.executionId,
      childSessionKey: executed.childSessionKey,
      spawnMode: executed.spawnMode,
    })
    if (queued.changed) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'dispatch:execution_queued',
        payload: {
          executionRecordId: queued.execution.executionRecordId,
          executionId: queued.execution.executionId,
          childSessionKey: queued.execution.childSessionKey,
          spawnMode: queued.execution.spawnMode,
          dispatchId: queued.execution.dispatchId,
          stageId: queued.execution.stageId,
          roleId: queued.execution.roleId,
          workflowPlanId: input.dispatch.workflowPlanId ?? null,
          dispatchGroupId: input.dispatch.dispatchGroupId ?? null,
          groupId: input.dispatch.groupId ?? null,
          taskId: input.dispatch.taskId ?? null,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }
    return { execution: queued.execution, created: true }
  }

  private async buildDependencyPreparationPlan(input: {
    packageName: string
    packageVersion: string
    sourcePath: string
    dependencies: TeamSkillDependencies
  }): Promise<TeamDependencyPreparationPlan> {
    const result = await this.dependencyChecker.check(input.dependencies)
    const missingRequiredSkillNames = new Set(result.missingRequiredSkills.map((item) => item.name))
    const missingOptionalSkillNames = new Set(result.missingOptionalSkills.map((item) => item.name))
    const missingRequiredToolNames = new Set(result.missingRequiredTools.map((item) => item.name))
    const missingOptionalToolNames = new Set(result.missingOptionalTools.map((item) => item.name))
    const skillItems = input.dependencies.skills.map((entry): TeamDependencyPlanItem => {
      const missing = entry.required ? missingRequiredSkillNames.has(entry.name) : missingOptionalSkillNames.has(entry.name)
      return {
        ...entry,
        kind: 'skill',
        status: missing ? 'missing' : 'available',
        severity: missing ? entry.required ? 'blocker' : 'warning' : 'ok',
        installable: missing,
      }
    })
    const toolItems = input.dependencies.tools.map((entry): TeamDependencyPlanItem => {
      const missing = entry.required ? missingRequiredToolNames.has(entry.name) : missingOptionalToolNames.has(entry.name)
      return {
        ...entry,
        kind: 'tool',
        status: missing ? 'missing' : 'available',
        severity: missing ? entry.required ? 'blocker' : 'warning' : 'ok',
        installable: false,
      }
    })
    return {
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      sourcePath: input.sourcePath,
      items: [...skillItems, ...toolItems],
      missingRequiredSkills: result.missingRequiredSkills,
      missingOptionalSkills: result.missingOptionalSkills,
      missingRequiredTools: result.missingRequiredTools,
      missingOptionalTools: result.missingOptionalTools,
      canProceed: result.missingRequiredSkills.length === 0 && result.missingRequiredTools.length === 0,
    }
  }

  private async assertDependencyProceedDegradedAllowed(input: { runtimeRoot: string; stageId: string }): Promise<void> {
    if (input.stageId !== 'step-0-pre-flight-dependency-check') {
      return
    }
    const events = await this.eventStore.read({ runtimeRoot: input.runtimeRoot, cursor: 0, limit: 2000 })
    const dependencyMissing = events.events.findLast((event) => (
      event.type === 'dependency:missing'
      && event.payload.stageId === input.stageId
    ))
    if (!dependencyMissing) {
      return
    }
    const missingRequiredSkills = Array.isArray(dependencyMissing.payload.missingRequiredSkills) ? dependencyMissing.payload.missingRequiredSkills : []
    const missingRequiredTools = Array.isArray(dependencyMissing.payload.missingRequiredTools) ? dependencyMissing.payload.missingRequiredTools : []
    if (missingRequiredSkills.length > 0 || missingRequiredTools.length > 0) {
      throw new Error('Required TeamSkill dependencies must be resolved before continuing.')
    }
  }

  async prepareDispatch(_input: {
    runId: string
    stageId: string
    roleId?: string
    idempotencyKey: string
  }): Promise<{ dispatch: TeamDispatchEnvelope; prompt: string; created: boolean }> {
    throw new Error('TeamRun stage dispatch is not supported; the leader must use team_plan_workflow and OpenClaw native sessions_spawn.')
  }

  async executeDispatch(_input: {
    runId: string
    dispatchId: string
    idempotencyKey: string
  }): Promise<{ execution: TeamDispatchExecutionRecord; created: boolean }> {
    throw new Error('TeamRun direct dispatch execution is not supported; TeamRun uses OpenClaw native sessions_spawn.')
  }

  async submitDecision(input: {
    runId: string
    decision: TeamDecisionType
    note?: string
    idempotencyKey: string
  }): Promise<{ decision: TeamDecision; created: boolean }> {
    if (input.decision !== 'retry' && input.decision !== 'proceed_degraded' && input.decision !== 'abort') {
      throw new Error(`Unsupported Team decision: ${input.decision}`)
    }

    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const current = await this.runStore.read(runtimeRoot)
    if (!current) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const existingDecision = (await this.decisionStore.read(runtimeRoot)).find((decision) => decision.idempotencyKey === input.idempotencyKey)
    if (existingDecision) {
      return { decision: existingDecision, created: false }
    }
    if (current.status !== 'waiting_for_user') {
      throw new Error(`TeamRun is not waiting for user: ${input.runId}`)
    }
    if (!current.currentStageId) {
      throw new Error(`TeamRun has no waiting stage: ${input.runId}`)
    }
    if (input.decision === 'proceed_degraded') {
      await this.assertDependencyProceedDegradedAllowed({ runtimeRoot, stageId: current.currentStageId })
    }

    const saved = await this.decisionStore.save({
      runtimeRoot,
      runId: current.runId,
      stageId: current.currentStageId,
      decision: input.decision,
      ...(input.note ? { note: input.note } : {}),
      idempotencyKey: input.idempotencyKey,
    })

    if (saved.created) {
      if (saved.decision.decision === 'retry' || saved.decision.decision === 'proceed_degraded') {
        const run = await this.runStore.update({ runtimeRoot, status: 'running', currentStageId: saved.decision.stageId })
        await this.resumeRuntime({ runId: run.runId })
        await this.appendDecisionEvent({ runtimeRoot, run, decision: saved.decision, idempotencyKey: input.idempotencyKey })
        await this.projectTeamRun({ runtimeRoot, run, reason: 'decision:submitted' })
      } else {
        const run = await this.runStore.update({ runtimeRoot, status: 'failed', currentStageId: saved.decision.stageId })
        await this.stopRuntime({ runId: run.runId })
        await this.appendDecisionEvent({ runtimeRoot, run, decision: saved.decision, idempotencyKey: input.idempotencyKey })
        await this.projectTeamRun({ runtimeRoot, run, reason: 'decision:submitted' })
      }
    }

    return saved
  }

  async evaluateGate(_input: {
    runId: string
    artifactId: string
    gateType: string
    idempotencyKey: string
  }): Promise<{ gate: TeamGateResult; created: boolean }> {
    throw new Error('TeamRun gate evaluation is not supported; model review gates in the workflow plan and submitted artifacts instead.')
  }

  resolveRuntimeRoot(runId: string): string {
    return path.join(this.deps.storageRoot, 'runs', sanitizePathSegment(runId))
  }

  private assertLeaderToolCaller(input: { runtimeRoot: string; workspaceDir?: string }): void {
    if (!input.workspaceDir?.trim()) {
      throw new Error('Tool caller workspace is required for Team leader')
    }
    if (path.resolve(input.workspaceDir) !== path.resolve(path.join(input.runtimeRoot, TEAM_LEADER_ROLE_ID))) {
      throw new Error('Tool caller workspace does not match Team leader')
    }
  }

  private assertToolCallerAgent(input: { run: TeamRun; role: TeamRoleBinding; callerAgentId?: string }): void {
    if (input.role.runId !== input.run.runId) {
      throw new Error(`Team role binding does not belong to run: ${input.run.runId}`)
    }
    if (!input.callerAgentId?.trim()) {
      throw new Error(`Tool caller agent is required for role: ${input.role.roleId}`)
    }
    if (input.callerAgentId.trim() !== input.role.agentId) {
      throw new Error(`Tool caller agent does not match role: ${input.role.roleId}`)
    }
  }

  private assertRoleChildSessionToolCaller(input: { run: TeamRun; role: TeamRoleBinding; callerAgentId?: string; childSessionKey?: string }): void {
    this.assertToolCallerAgent(input)
    const sessionKey = parseOpenClawAgentSessionKey(input.childSessionKey)
    if (!sessionKey || sessionKey.agentId !== input.role.agentId || (sessionKey.kind !== 'subagent' && sessionKey.kind !== 'task')) {
      throw new Error(`Team role lifecycle tools require a native role child session for role: ${input.role.roleId}`)
    }
  }

  private async findQueuedWorkflowTask(input: {
    runtimeRoot: string
    stageId: string
    roleId: string
    childSessionKey?: string
    requireQueuedChildSessionTask?: boolean
  }): Promise<{ task: TeamDispatchTaskRecord; execution?: TeamDispatchExecutionRecord } | null> {
    const allTasks = await this.workflowStore.readTasks(input.runtimeRoot)
    const queuedRoleTasks = allTasks.filter((task) => task.roleId === input.roleId && task.status === 'queued')
    const executions = await this.dispatchExecutionStore.read(input.runtimeRoot)

    if (input.childSessionKey) {
      const childSessionExecutions = executions.filter((candidate) => candidate.childSessionKey === input.childSessionKey && isWorkflowExecutionBindableToQueuedTask(candidate))
      if (childSessionExecutions.length > 1) {
        if (!input.requireQueuedChildSessionTask) {
          return null
        }
        throw new Error(this.buildWorkflowTaskStageIdError({ roleId: input.roleId, stageId: input.stageId, queuedRoleTasks, reason: `Team workflow child session is ambiguous: ${input.childSessionKey}` }))
      }
      if (childSessionExecutions.length === 1) {
        const execution = childSessionExecutions[0]!
        const task = allTasks.find((candidate) => candidate.dispatchId === execution.dispatchId)
        if (execution.roleId !== input.roleId || (task && task.roleId !== input.roleId)) {
          if (!input.requireQueuedChildSessionTask) {
            return null
          }
          const actualTaskId = task?.taskId ?? execution.stageId
          throw new Error(`Team workflow child session belongs to another role/task: roleId ${execution.roleId}, taskId ${actualTaskId}; expected roleId ${input.roleId}.`)
        }
        if (task?.status === 'queued') {
          return { task, execution }
        }
        if (!input.requireQueuedChildSessionTask) {
          return null
        }
        throw new Error(this.buildWorkflowTaskStageIdError({ roleId: input.roleId, stageId: input.stageId, queuedRoleTasks, reason: `Team workflow child session is not bound to a queued task: ${input.childSessionKey}` }))
      }
      const queuedStageTasks = queuedRoleTasks.filter((task) => task.taskId === input.stageId)
      if (queuedStageTasks.length > 0 && input.requireQueuedChildSessionTask) {
        throw new Error(this.buildWorkflowTaskStageIdError({ roleId: input.roleId, stageId: input.stageId, queuedRoleTasks, reason: `Team workflow execution child session does not match active task: ${input.childSessionKey}` }))
      }
      return null
    }

    const queuedStageTasks = queuedRoleTasks.filter((task) => task.taskId === input.stageId)
    if (queuedStageTasks.length === 0) {
      return null
    }
    if (queuedStageTasks.length > 1) {
      throw new Error(`Multiple active Team workflow tasks match ${input.stageId}/${input.roleId}; childSessionKey is required`)
    }
    const task = queuedStageTasks[0]!
    const execution = executions.find((candidate) => candidate.dispatchId === task.dispatchId && isWorkflowExecutionBindableToQueuedTask(candidate))
    return execution ? { task, execution } : { task }
  }

  private buildWorkflowTaskStageIdError(input: { roleId: string; stageId: string; queuedRoleTasks: TeamDispatchTaskRecord[]; reason: string }): string {
    const validTaskIds = Array.from(new Set(input.queuedRoleTasks.map((task) => task.taskId))).sort()
    const validTaskIdList = validTaskIds.length > 0 ? validTaskIds.join(', ') : '(no active queued tasks)'
    return `${input.reason}. Invalid stageId for role ${input.roleId}: ${input.stageId}; stageId must be one of: ${validTaskIdList}.`
  }

  private async ensureQueuedWorkflowTask(input: {
    runtimeRoot: string
    run: TeamRun
    role: TeamRoleBinding
    stageId: string
    childSessionKey?: string
    activationKey: string
  }): Promise<{ task: TeamDispatchTaskRecord; execution?: TeamDispatchExecutionRecord }> {
    const existing = await this.findQueuedWorkflowTask({
      runtimeRoot: input.runtimeRoot,
      stageId: input.stageId,
      roleId: input.role.roleId,
      childSessionKey: input.childSessionKey,
      requireQueuedChildSessionTask: true,
    })
    if (existing) {
      return existing
    }
    const roleTasks = (await this.workflowStore.readTasks(input.runtimeRoot)).filter((task) => task.roleId === input.role.roleId)
    const queuedRoleTasks = roleTasks.filter((task) => task.status === 'queued')
    const inactiveTask = roleTasks.find((task) => task.taskId === input.stageId && task.status !== 'queued')
    if (inactiveTask) {
      throw new Error(`Team workflow task is ${inactiveTask.status} and cannot accept progress updates: ${input.stageId}`)
    }
    if (!input.childSessionKey) {
      throw new Error(this.buildWorkflowTaskStageIdError({ roleId: input.role.roleId, stageId: input.stageId, queuedRoleTasks, reason: 'Team workflow task is not active' }))
    }
    const plan = await this.workflowStore.readPlan(input.runtimeRoot)
    if (!plan) {
      throw new Error('TeamRun workflow has not been planned')
    }
    const taskPlan = plan.tasks.find((candidate) => candidate.taskId === input.stageId)
    if (!taskPlan || taskPlan.roleId !== input.role.roleId) {
      throw new Error(this.buildWorkflowTaskStageIdError({ roleId: input.role.roleId, stageId: input.stageId, queuedRoleTasks, reason: 'Team workflow task is not assigned to role' }))
    }
    await this.assertTaskDependenciesCompleted({ runtimeRoot: input.runtimeRoot, plan, task: taskPlan })
    const groupPlan = this.resolveTaskGroupPlan(plan, taskPlan.taskId)
    const savedGroup = await this.workflowStore.saveGroup({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      workflowPlanId: plan.workflowPlanId,
      groupId: groupPlan.groupId,
      taskIds: groupPlan.taskIds,
      idempotencyKey: `${plan.workflowPlanId}:group:${groupPlan.groupId}`,
    })
    if (savedGroup.created) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'dispatch:group_queued',
        payload: {
          dispatchGroupId: savedGroup.group.dispatchGroupId,
          workflowPlanId: plan.workflowPlanId,
          groupId: groupPlan.groupId,
          taskIds: groupPlan.taskIds,
          idempotencyKey: `${plan.workflowPlanId}:group:${groupPlan.groupId}`,
        },
      })
    }
    const dispatch = await this.dispatchStore.save({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      stageId: taskPlan.taskId,
      roleId: taskPlan.roleId,
      prompt: buildWorkflowTaskPrompt({ plan, group: savedGroup.group, task: taskPlan }),
      inputArtifactIds: await this.artifactIdsForTask(input.runtimeRoot, taskPlan),
      kickbackIds: [],
      idempotencyKey: `${plan.workflowPlanId}:group:${groupPlan.groupId}:task:${taskPlan.taskId}:dispatch`,
      workflowPlanId: plan.workflowPlanId,
      dispatchGroupId: savedGroup.group.dispatchGroupId,
      groupId: groupPlan.groupId,
      taskId: taskPlan.taskId,
    })
    const savedTask = await this.workflowStore.saveTask({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      workflowPlanId: plan.workflowPlanId,
      dispatchGroupId: savedGroup.group.dispatchGroupId,
      groupId: groupPlan.groupId,
      taskId: taskPlan.taskId,
      roleId: taskPlan.roleId,
      dispatchId: dispatch.dispatch.dispatchId,
      idempotencyKey: `${plan.workflowPlanId}:group:${groupPlan.groupId}:task:${taskPlan.taskId}`,
    })
    const execution = await this.ensureQueuedWorkflowExecution({
      runtimeRoot: input.runtimeRoot,
      run: input.run,
      task: savedTask.task,
      childSessionKey: input.childSessionKey,
      idempotencyKey: `${input.activationKey}:execution`,
    })
    if (dispatch.created || savedTask.created || execution.created) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'dispatch:task_queued',
        payload: {
          dispatchTaskId: savedTask.task.dispatchTaskId,
          dispatchId: savedTask.task.dispatchId,
          executionRecordId: execution.execution.executionRecordId,
          workflowPlanId: savedTask.task.workflowPlanId,
          dispatchGroupId: savedTask.task.dispatchGroupId,
          groupId: savedTask.task.groupId,
          taskId: savedTask.task.taskId,
          roleId: savedTask.task.roleId,
          idempotencyKey: `${input.activationKey}:activation`,
        },
      })
    }
    return { task: savedTask.task, execution: execution.execution }
  }

  private async ensureQueuedWorkflowExecution(input: {
    runtimeRoot: string
    run: TeamRun
    task: TeamDispatchTaskRecord
    childSessionKey?: string
    idempotencyKey: string
  }): Promise<{ execution: TeamDispatchExecutionRecord; created: boolean }> {
    const executions = await this.dispatchExecutionStore.read(input.runtimeRoot)
    if (input.childSessionKey) {
      const byChildSession = executions.find((candidate) => candidate.childSessionKey === input.childSessionKey && isWorkflowExecutionBindableToQueuedTask(candidate))
      if (byChildSession) {
        if (byChildSession.dispatchId !== input.task.dispatchId) {
          throw new Error(`Team workflow execution child session does not match task dispatch: ${input.childSessionKey}`)
        }
        return { execution: byChildSession, created: false }
      }
    }
    const byDispatch = executions.find((candidate) => candidate.dispatchId === input.task.dispatchId && isWorkflowExecutionBindableToQueuedTask(candidate))
    if (byDispatch) {
      return { execution: byDispatch, created: false }
    }
    const claimed = await this.dispatchExecutionStore.claim({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      dispatchId: input.task.dispatchId,
      stageId: input.task.taskId,
      roleId: input.task.roleId,
      idempotencyKey: input.idempotencyKey,
    })
    const queued = await this.dispatchExecutionStore.attachQueuedExecution({
      runtimeRoot: input.runtimeRoot,
      executionRecordId: claimed.execution.executionRecordId,
      ...(input.childSessionKey ? {
        childSessionKey: input.childSessionKey,
        spawnMode: 'run' as const,
      } : {}),
    })
    if (queued.changed) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'dispatch:execution_queued',
        payload: {
          executionRecordId: queued.execution.executionRecordId,
          executionId: queued.execution.executionId,
          childSessionKey: queued.execution.childSessionKey,
          spawnMode: queued.execution.spawnMode,
          dispatchId: queued.execution.dispatchId,
          stageId: queued.execution.stageId,
          roleId: queued.execution.roleId,
          workflowPlanId: input.task.workflowPlanId,
          dispatchGroupId: input.task.dispatchGroupId,
          groupId: input.task.groupId,
          taskId: input.task.taskId,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }
    return { execution: queued.execution, created: queued.changed }
  }

  private async closeQueuedWorkflowTask(input: {
    runtimeRoot: string
    run: TeamRun
    task: TeamDispatchTaskRecord
    artifactId: string
    idempotencyKey: string
  }): Promise<void> {
    const completedExecution = await this.dispatchExecutionStore.markCompleted({
      runtimeRoot: input.runtimeRoot,
      dispatchId: input.task.dispatchId,
      reason: `Artifact submitted: ${input.artifactId}`,
    })
    if (completedExecution.changed && completedExecution.execution) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'dispatch:execution_completed',
        payload: {
          executionRecordId: completedExecution.execution.executionRecordId,
          executionId: completedExecution.execution.executionId,
          dispatchId: completedExecution.execution.dispatchId,
          stageId: completedExecution.execution.stageId,
          roleId: completedExecution.execution.roleId,
          artifactId: input.artifactId,
        },
      })
    }
    const completedTask = await this.workflowStore.updateTaskStatus({
      runtimeRoot: input.runtimeRoot,
      dispatchTaskId: input.task.dispatchTaskId,
      status: 'completed',
      artifactId: input.artifactId,
    })
    if (completedTask.changed) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'dispatch:task_completed',
        payload: {
          dispatchTaskId: completedTask.task.dispatchTaskId,
          workflowPlanId: completedTask.task.workflowPlanId,
          dispatchGroupId: completedTask.task.dispatchGroupId,
          groupId: completedTask.task.groupId,
          taskId: completedTask.task.taskId,
          roleId: completedTask.task.roleId,
          artifactId: input.artifactId,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }
    await this.reconcileDispatchGroupCompletion({ runtimeRoot: input.runtimeRoot, run: input.run, dispatchGroupId: input.task.dispatchGroupId })
    if (!this.disableAutoDispatch) {
      const plan = await this.workflowStore.readPlan(input.runtimeRoot)
      if (plan && plan.status === 'running') {
        await this.sessionEngine.onWorkflowProgressed({ runtimeRoot: input.runtimeRoot, run: input.run, plan })
      }
    }
  }

  private async reconcileDispatchGroupCompletion(input: { runtimeRoot: string; run: TeamRun; dispatchGroupId: string }): Promise<void> {
    const groups = await this.workflowStore.readGroups(input.runtimeRoot)
    const group = groups.find((candidate) => candidate.dispatchGroupId === input.dispatchGroupId)
    if (!group || group.status !== 'queued') {
      return
    }
    const plan = await this.workflowStore.readPlan(input.runtimeRoot)
    const groupPlan = plan?.groups.find((candidate) => candidate.groupId === group.groupId)
    if (!groupPlan) {
      throw new Error(`Team workflow group plan not found: ${group.groupId}`)
    }
    const tasks = (await this.workflowStore.readTasks(input.runtimeRoot)).filter((task) => task.dispatchGroupId === group.dispatchGroupId)
    const completedCount = tasks.filter((task) => task.status === 'completed').length
    const failedCount = tasks.filter((task) => task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale').length
    const allSettled = tasks.length === group.taskIds.length && tasks.every((task) => task.status !== 'queued')
    const status = completedCount === group.taskIds.length
      ? 'completed'
      : allSettled && groupPlan.join.allowFailed && completedCount > 0
        ? 'completed'
        : allSettled || (!groupPlan.join.allowFailed && failedCount > 0)
          ? 'failed'
          : null
    if (!status) {
      return
    }
    const updated = await this.workflowStore.updateGroupStatus({ runtimeRoot: input.runtimeRoot, dispatchGroupId: group.dispatchGroupId, status })
    if (updated.changed) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: status === 'completed' ? 'dispatch:group_completed' : 'dispatch:group_failed',
        payload: {
          dispatchGroupId: updated.group.dispatchGroupId,
          workflowPlanId: updated.group.workflowPlanId,
          groupId: updated.group.groupId,
          completedCount,
          failedCount,
        },
      })
    }
  }

  private async markDispatchTaskFailed(input: { runtimeRoot: string; dispatchId: string; reason: string }): Promise<void> {
    const task = (await this.workflowStore.readTasks(input.runtimeRoot)).find((candidate) => candidate.dispatchId === input.dispatchId)
    if (!task) {
      return
    }
    const run = await this.runStore.read(input.runtimeRoot)
    if (!run) {
      return
    }
    const retried = await this.retryWorkflowTask({
      runtimeRoot: input.runtimeRoot,
      run,
      task,
      reason: input.reason,
    })
    if (retried) {
      return
    }
    await this.workflowStore.updateTaskStatus({
      runtimeRoot: input.runtimeRoot,
      dispatchTaskId: task.dispatchTaskId,
      status: 'failed',
      statusReason: input.reason,
    })
    await this.reconcileDispatchGroupCompletion({ runtimeRoot: input.runtimeRoot, run, dispatchGroupId: task.dispatchGroupId })
    await this.maybeFinalizeWorkflowTerminalState({ runtimeRoot: input.runtimeRoot, run, reason: input.reason })
    if (!this.disableAutoDispatch) {
      const plan = await this.workflowStore.readPlan(input.runtimeRoot)
      if (plan && plan.status === 'running') {
        await this.sessionEngine.onWorkflowProgressed({ runtimeRoot: input.runtimeRoot, run, plan })
      }
    }
  }

  private async reconcileRequestedApproval(input: {
    runtimeRoot: string
    run: TeamRun
    approval: TeamApproval
    idempotencyKey: string
  }): Promise<void> {
    const latestRun = await this.runStore.read(input.runtimeRoot) ?? input.run
    const updatedRun = latestRun.status === 'waiting_for_user'
      ? latestRun
      : await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'waiting_for_user', currentStageId: input.approval.stageId })
    await this.stopRuntime({ runId: updatedRun.runId })
    await this.eventStore.append({
      runtimeRoot: input.runtimeRoot,
      runId: updatedRun.runId,
      revision: updatedRun.revision,
      type: 'approval:requested',
      payload: {
        approvalId: input.approval.approvalId,
        stageId: input.approval.stageId,
        roleId: input.approval.roleId,
        requestedAction: input.approval.requestedAction,
        risk: input.approval.risk,
        idempotencyKey: input.idempotencyKey,
      },
    })
    await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: updatedRun, reason: 'approval:requested' })
  }

  private async reconcileResolvedApproval(input: {
    runtimeRoot: string
    run: TeamRun
    approval: TeamApproval
    decision: 'approve' | 'deny' | 'abort'
    idempotencyKey: string
  }): Promise<void> {
    const latestRun = await this.runStore.read(input.runtimeRoot) ?? input.run
    let updatedRun = input.approval.status === 'approved'
      ? latestRun.status === 'running' ? latestRun : await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'running', currentStageId: input.approval.stageId })
      : latestRun
    if (input.approval.status === 'approved') {
      await this.resumeRuntime({ runId: updatedRun.runId })
    }
    if (input.approval.status !== 'approved') {
      const task = (await this.workflowStore.readTasks(input.runtimeRoot)).find((candidate) => candidate.taskId === input.approval.stageId && candidate.roleId === input.approval.roleId && candidate.status === 'queued')
      if (task) {
        const retried = await this.retryWorkflowTask({
          runtimeRoot: input.runtimeRoot,
          run: latestRun,
          task,
          reason: `Approval ${input.approval.status}`,
        })
        if (!retried) {
          await this.workflowStore.updateTaskStatus({ runtimeRoot: input.runtimeRoot, dispatchTaskId: task.dispatchTaskId, status: 'failed', statusReason: `Approval ${input.approval.status}` })
          await this.reconcileDispatchGroupCompletion({ runtimeRoot: input.runtimeRoot, run: latestRun, dispatchGroupId: task.dispatchGroupId })
          updatedRun = await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'failed', currentStageId: input.approval.stageId })
          await this.stopRuntime({ runId: updatedRun.runId })
          await this.maybeFinalizeWorkflowTerminalState({ runtimeRoot: input.runtimeRoot, run: updatedRun, reason: `Approval ${input.approval.status}` })
          updatedRun = await this.runStore.read(input.runtimeRoot) ?? updatedRun
        }
      }
    }
    await this.appendApprovalResolvedEvent({ runtimeRoot: input.runtimeRoot, run: updatedRun, approval: input.approval, decision: input.decision, idempotencyKey: input.idempotencyKey })
    await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: updatedRun, reason: 'approval:resolved' })
  }

  private async appendApprovalResolvedEvent(input: {
    runtimeRoot: string
    run: TeamRun
    approval: TeamApproval
    decision: 'approve' | 'deny' | 'abort'
    idempotencyKey: string
  }): Promise<void> {
    await this.eventStore.append({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      revision: input.run.revision,
      type: 'approval:resolved',
      payload: {
        approvalId: input.approval.approvalId,
        stageId: input.approval.stageId,
        roleId: input.approval.roleId,
        decision: input.decision,
        note: input.approval.note ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    })
  }

  private async cancelDispatchExecutionsForRun(input: { runtimeRoot: string; runId: string; reason: string }): Promise<{ executions: TeamDispatchExecutionRecord[]; changed: boolean }> {
    const activeExecutions = (await this.dispatchExecutionStore.read(input.runtimeRoot)).filter((execution) => (
      execution.runId === input.runId
      && (execution.status === 'claimed' || execution.status === 'queued')
    ))
    if (activeExecutions.length > 0) {
      if (!this.roleSessionExecution) {
        throw new Error('Team role session execution is not configured')
      }
      await this.roleSessionExecution.cancelRunSessions({
        runId: input.runId,
        executions: activeExecutions,
        reason: input.reason,
      })
    }
    return await this.dispatchExecutionStore.cancelActive(input)
  }

  private async cancelQueuedWorkflowState(input: {
    runtimeRoot: string
    run: TeamRun
    reason: string
    idempotencyKey: string
  }): Promise<void> {
    const plan = await this.workflowStore.readPlan(input.runtimeRoot)
    const tasks = await this.workflowStore.readTasks(input.runtimeRoot)
    const groups = await this.workflowStore.readGroups(input.runtimeRoot)
    const queueItems = await this.dispatchQueueStore.cancelPending(input.run.runId, input.reason)

    if (plan && plan.status !== 'cancelled') {
      await this.workflowStore.updatePlanStatus({ runtimeRoot: input.runtimeRoot, status: 'cancelled' })
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'workflow:cancelled',
        payload: {
          workflowPlanId: plan.workflowPlanId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }

    for (const queueItem of queueItems) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'dispatch:queue_cancelled',
        payload: {
          queueItemId: queueItem.queueItemId,
          toRoleId: queueItem.toRoleId,
          taskId: queueItem.taskId ?? null,
          reason: input.reason,
        },
      })
    }

    for (const task of tasks.filter((candidate) => candidate.status === 'queued')) {
      const updated = await this.workflowStore.updateTaskStatus({
        runtimeRoot: input.runtimeRoot,
        dispatchTaskId: task.dispatchTaskId,
        status: 'cancelled',
        statusReason: input.reason,
      })
      if (updated.changed) {
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: input.run.runId,
          revision: input.run.revision,
          type: 'dispatch:task_cancelled',
          payload: {
            dispatchTaskId: updated.task.dispatchTaskId,
            workflowPlanId: updated.task.workflowPlanId,
            dispatchGroupId: updated.task.dispatchGroupId,
            groupId: updated.task.groupId,
            taskId: updated.task.taskId,
            roleId: updated.task.roleId,
            reason: input.reason,
          },
        })
      }
    }

    for (const group of groups.filter((candidate) => candidate.status === 'queued')) {
      const updated = await this.workflowStore.updateGroupStatus({
        runtimeRoot: input.runtimeRoot,
        dispatchGroupId: group.dispatchGroupId,
        status: 'cancelled',
      })
      if (updated.changed) {
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: input.run.runId,
          revision: input.run.revision,
          type: 'dispatch:group_cancelled',
          payload: {
            dispatchGroupId: updated.group.dispatchGroupId,
            workflowPlanId: updated.group.workflowPlanId,
            groupId: updated.group.groupId,
            taskIds: updated.group.taskIds,
            reason: input.reason,
          },
        })
      }
    }
  }

  private async refreshStaleDispatchExecutions(runtimeRoot: string): Promise<TeamDispatchExecutionRecord[]> {
    const run = await this.runStore.read(runtimeRoot)
    if (!run || run.status !== 'running') {
      return []
    }
    const now = this.deps.clock.nowMs()
    const staleAfterMs = this.deps.staleDispatchExecutionMs ?? DEFAULT_STALE_DISPATCH_EXECUTION_MS
    const executions = await this.dispatchExecutionStore.read(runtimeRoot)
    const stale: TeamDispatchExecutionRecord[] = []
    for (const execution of executions) {
      if ((execution.status !== 'claimed' && execution.status !== 'queued') || now - execution.createdAt <= staleAfterMs) {
        continue
      }
      const marked = await this.dispatchExecutionStore.markStale({
        runtimeRoot,
        executionRecordId: execution.executionRecordId,
        reason: `No completion signal within ${staleAfterMs}ms`,
      })
      stale.push(marked.execution)
      if (marked.changed) {
        const task = (await this.workflowStore.readTasks(runtimeRoot)).find((candidate) => candidate.dispatchId === marked.execution.dispatchId)
        if (task) {
          const retried = await this.retryWorkflowTask({
            runtimeRoot,
            run,
            task,
            reason: marked.execution.statusReason ?? `No completion signal within ${staleAfterMs}ms`,
          })
          if (!retried) {
            await this.workflowStore.updateTaskStatus({
              runtimeRoot,
              dispatchTaskId: task.dispatchTaskId,
              status: 'stale',
              statusReason: marked.execution.statusReason,
            })
            await this.reconcileDispatchGroupCompletion({ runtimeRoot, run, dispatchGroupId: task.dispatchGroupId })
            await this.maybeFinalizeWorkflowTerminalState({ runtimeRoot, run, reason: marked.execution.statusReason ?? `No completion signal within ${staleAfterMs}ms` })
          }
        }
        await this.eventStore.append({
          runtimeRoot,
          runId: run.runId,
          revision: run.revision,
          type: 'dispatch:execution_stale',
          payload: {
            executionRecordId: marked.execution.executionRecordId,
            executionId: marked.execution.executionId,
            dispatchId: marked.execution.dispatchId,
            stageId: marked.execution.stageId,
            roleId: marked.execution.roleId,
            staleAfterMs,
          },
        })
      }
    }
    return stale
  }

  private async failRunIfWallClockBudgetExceeded(input: { runtimeRoot: string; run: TeamRun; idempotencyKey: string }): Promise<TeamRun | null> {
    const packageResult = await this.packageService.validate(input.run.sourcePath)
    const budgetMs = packageResult.valid && packageResult.package?.bind.totalWallClockBudgetMs
      ? packageResult.package.bind.totalWallClockBudgetMs
      : undefined
    if (!budgetMs || this.deps.clock.nowMs() - input.run.createdAt <= budgetMs) {
      return null
    }
    const activeTasks = (await this.workflowStore.readTasks(input.runtimeRoot)).filter((task) => task.status === 'queued')
    for (const task of activeTasks) {
      await this.workflowStore.updateTaskStatus({
        runtimeRoot: input.runtimeRoot,
        dispatchTaskId: task.dispatchTaskId,
        status: 'failed',
        statusReason: 'TeamRun wall clock budget exceeded',
      })
      await this.reconcileDispatchGroupCompletion({ runtimeRoot: input.runtimeRoot, run: input.run, dispatchGroupId: task.dispatchGroupId })
    }
    const failedRun = await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'failed' })
    await this.stopRuntime({ runId: failedRun.runId })
    await this.eventStore.append({
      runtimeRoot: input.runtimeRoot,
      runId: failedRun.runId,
      revision: failedRun.revision,
      type: 'run:budget_exceeded',
      payload: {
        budgetType: 'wall_clock',
        budgetMs,
        elapsedMs: this.deps.clock.nowMs() - input.run.createdAt,
        idempotencyKey: input.idempotencyKey,
      },
    })
    await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: failedRun, reason: 'run:budget_exceeded' })
    return failedRun
  }

  private async buildDiagnostics(input: {
    runtimeRoot: string
    run: TeamRun | null
    roles: TeamRoleBinding[]
    stages: EmptyTeamStages
    approvals: TeamApproval[]
    artifacts: TeamArtifact[]
    dispatches: TeamDispatchEnvelope[]
    dispatchExecutions: TeamDispatchExecutionRecord[]
    dispatchGroups: TeamDispatchGroupRecord[]
    dispatchTasks: TeamDispatchTaskRecord[]
    messages: TeamMessage[]
    gates: TeamGateResult[]
    kickbacks: TeamKickback[]
    decisions: TeamDecision[]
    eventCount: number
  }): Promise<TeamRunDiagnostics> {
    const packageResult = input.run ? await this.packageService.validate(input.run.sourcePath) : null
    const bind = packageResult?.valid ? packageResult.package?.bind : undefined
    const elapsedMs = input.run ? this.deps.clock.nowMs() - input.run.createdAt : undefined
    const totalWallClockBudgetMs = bind?.totalWallClockBudgetMs
    return {
      runId: input.run?.runId ?? path.basename(input.runtimeRoot),
      recoveredFromStorage: Boolean(input.run),
      storageRoot: input.runtimeRoot,
      budgets: {
        ...(totalWallClockBudgetMs ? { totalWallClockBudgetMs } : {}),
        ...(bind?.totalTokenBudget ? { totalTokenBudget: bind.totalTokenBudget } : {}),
        roleWallClockBudgetMs: bind?.roleWallClockBudgetMs ?? {},
        roleTokenBudget: bind?.roleTokenBudget ?? {},
        ...(elapsedMs !== undefined ? { elapsedMs } : {}),
        wallClockExceeded: Boolean(totalWallClockBudgetMs && elapsedMs !== undefined && elapsedMs > totalWallClockBudgetMs),
      },
      limits: {
        maxArtifactContentBytes: this.deps.maxArtifactContentBytes ?? DEFAULT_MAX_ARTIFACT_CONTENT_BYTES,
        maxMessageBodyBytes: this.deps.maxMessageBodyBytes ?? DEFAULT_MAX_MESSAGE_BODY_BYTES,
        staleDispatchExecutionMs: this.deps.staleDispatchExecutionMs ?? DEFAULT_STALE_DISPATCH_EXECUTION_MS,
      },
      staleDispatchExecutions: input.dispatchExecutions.filter((execution) => execution.status === 'stale'),
      counts: {
        roles: input.roles.length,
        stages: input.stages.length,
        approvals: input.approvals.length,
        artifacts: input.artifacts.length,
        dispatches: input.dispatches.length,
        dispatchExecutions: input.dispatchExecutions.length,
        dispatchGroups: input.dispatchGroups.length,
        dispatchTasks: input.dispatchTasks.length,
        messages: input.messages.length,
        gates: input.gates.length,
        kickbacks: input.kickbacks.length,
        decisions: input.decisions.length,
        events: input.eventCount,
      },
    }
  }

  private async appendDecisionEvent(input: {
    runtimeRoot: string
    run: TeamRun
    decision: TeamDecision
    idempotencyKey: string
  }): Promise<void> {
    await this.eventStore.append({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      revision: input.run.revision,
      type: 'decision:submitted',
      payload: {
        decisionId: input.decision.decisionId,
        stageId: input.decision.stageId,
        decision: input.decision.decision,
        note: input.decision.note ?? null,
        idempotencyKey: input.idempotencyKey,
      },
    })
  }

  private async projectTeamRun(input: { runtimeRoot: string; run: TeamRun; reason: string }): Promise<void> {
    if (!this.taskManagerProjection && !this.taskFlowProjection) {
      return
    }
    const dispatchTasks = await this.workflowStore.readTasks(input.runtimeRoot)
    if (this.taskFlowProjection) {
      try {
        await this.taskFlowProjection.projectTeamRun({ run: input.run, dispatchTasks, reason: input.reason })
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: input.run.runId,
          revision: input.run.revision,
          type: 'projection:taskFlow:queued',
          payload: { reason: input.reason },
        })
      } catch (error) {
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: input.run.runId,
          revision: input.run.revision,
          type: 'projection:taskFlow:failed',
          payload: { reason: input.reason, error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
    if (this.taskManagerProjection) {
      try {
        await this.taskManagerProjection.projectTeamRun({ run: input.run, dispatchTasks, reason: input.reason })
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: input.run.runId,
          revision: input.run.revision,
          type: 'projection:taskManager:queued',
          payload: { reason: input.reason },
        })
      } catch (error) {
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: input.run.runId,
          revision: input.run.revision,
          type: 'projection:taskManager:failed',
          payload: { reason: input.reason, error: error instanceof Error ? error.message : String(error) },
        })
      }
    }
  }

  private async projectTaskUpdate(input: TeamTaskUpdateProjectionInput & { runtimeRoot: string }): Promise<void> {
    if (!this.taskFlowProjection) {
      return
    }
    try {
      await this.taskFlowProjection.projectTaskUpdate(input)
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'projection:taskFlow:task_update_queued',
        payload: { stageId: input.taskId, roleId: input.roleId, status: input.status },
      })
    } catch (error) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'projection:taskFlow:task_update_failed',
        payload: { stageId: input.taskId, roleId: input.roleId, status: input.status, error: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

function parseWorkflowTaskPlan(input: Record<string, unknown>, roleIds: Set<string>): TeamWorkflowTaskPlan {
  const taskId = readRequiredRecordString(input, 'taskId')
  const roleId = readRequiredRecordString(input, 'roleId')
  if (!roleIds.has(roleId)) {
    throw new Error(`Team workflow task references unknown role: ${roleId}`)
  }
  const dependsOnTaskIds = readOptionalRecordStringArray(input, 'dependsOnTaskIds')
  return {
    taskId,
    roleId,
    title: readRequiredRecordString(input, 'title'),
    prompt: readRequiredRecordString(input, 'prompt'),
    dependsOnTaskIds,
    ...(readOptionalRecordString(input, 'outputArtifactKind') ? { outputArtifactKind: readOptionalRecordString(input, 'outputArtifactKind') } : {}),
  }
}

function parseWorkflowGroupPlan(input: Record<string, unknown>, taskIds: Set<string>): TeamWorkflowGroupPlan {
  const groupTaskIds = readRequiredRecordStringArray(input, 'taskIds')
  if (groupTaskIds.length === 0) {
    throw new Error('Team workflow group must contain at least one taskId')
  }
  for (const taskId of groupTaskIds) {
    if (!taskIds.has(taskId)) {
      throw new Error(`Team workflow group references unknown task: ${taskId}`)
    }
  }
  return {
    groupId: readRequiredRecordString(input, 'groupId'),
    title: readRequiredRecordString(input, 'title'),
    taskIds: groupTaskIds,
    join: parseWorkflowJoinPolicy(readRequiredRecord(input, 'join')),
  }
}

function parseWorkflowJoinPolicy(input: Record<string, unknown>): TeamWorkflowJoinPolicy {
  return {
    requireCompleted: readRequiredRecordBoolean(input, 'requireCompleted'),
    allowFailed: readRequiredRecordBoolean(input, 'allowFailed'),
    retryLimit: readRequiredRecordNonNegativeInteger(input, 'retryLimit'),
  }
}

function readRequiredRecord(input: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = input[field]
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Team workflow ${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function readRequiredRecordString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Team workflow ${field} is required`)
  }
  return value.trim()
}

function readOptionalRecordString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readRequiredRecordStringArray(input: Record<string, unknown>, field: string): string[] {
  const value = input[field]
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`Team workflow ${field} must be an array of non-empty strings`)
  }
  return value.map((item) => item.trim())
}

function readOptionalRecordStringArray(input: Record<string, unknown>, field: string): string[] {
  const value = input[field]
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(`Team workflow ${field} must be an array of non-empty strings`)
  }
  return value.map((item) => item.trim())
}

function readRequiredRecordBoolean(input: Record<string, unknown>, field: string): boolean {
  const value = input[field]
  if (typeof value !== 'boolean') {
    throw new Error(`Team workflow ${field} must be a boolean`)
  }
  return value
}

function readRequiredRecordNonNegativeInteger(input: Record<string, unknown>, field: string): number {
  const value = input[field]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Team workflow ${field} must be a non-negative integer`)
  }
  return value
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory()
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_')
}

type OpenClawAgentSessionKey =
  | { agentId: string; kind: 'main' }
  | { agentId: string; kind: 'subagent'; subagentId: string }
  | { agentId: string; kind: 'task'; taskId: string }

function isWorkflowExecutionBindableToQueuedTask(execution: TeamDispatchExecutionRecord): boolean {
  return execution.status === 'claimed' || execution.status === 'queued'
}

function parseOpenClawAgentSessionKey(sessionKey: string | undefined): OpenClawAgentSessionKey | null {
  const trimmed = sessionKey?.trim()
  if (!trimmed) {
    return null
  }
  const [scope, agentId, kind, ...rest] = trimmed.split(':')
  if (scope !== 'agent' || !agentId) {
    return null
  }
  if (kind === 'main' && rest.length === 0) {
    return { agentId, kind }
  }
  if (kind === 'subagent' && rest.length === 1 && rest[0]) {
    return { agentId, kind, subagentId: rest[0] }
  }
  if (kind === 'task' && rest.length === 1 && rest[0]) {
    return { agentId, kind, taskId: rest[0] }
  }
  return null
}

function buildLeaderRunPrompt(run: TeamRun, initialPrompt?: string): string {
  return `${[
    `# TeamRun Leader: ${run.packageName}`,
    '',
    `runId: ${run.runId}`,
    `packageVersion: ${run.packageVersion}`,
    '',
    'Read SKILL.md, workflow.md, bind.md, dependencies.json, and AGENTS.md in this workspace.',
    'Do not perform role work yourself.',
    String.raw`<team_workflow_orchestration>
You are the TeamRun leader. Your job is orchestration, not role execution.

Core contract:
- team_plan_workflow describes only work assigned to concrete Team roles from the roster.
- Leader-only work stays outside team_plan_workflow.
- Never include tasks with roleId "leader"; leader is orchestrator, not a workflow task role.
- Never use managed OpenClaw agent ids in tasks[].roleId.
- Every workflow task must include a concrete prompt for the assigned role.

Execution pattern:
1. Read SKILL.md, workflow.md, bind.md, dependencies.json, and each roles/{roleId}/AGENTS.md.
2. If workflow.md contains leader-only context extraction, perform that extraction yourself before calling team_plan_workflow.
3. Build team_plan_workflow with only concrete role-agent tasks.
4. Embed any leader-extracted context directly into each role task prompt that needs it.
5. After role artifacts finish, synthesize the final TeamRun output yourself as the leader response.

Role id rules:
- Valid tasks[].roleId values are exactly the Team role ids listed in the Role roster below.
- Invalid tasks[].roleId values include "leader", managed OpenClaw agent ids, display names, and ad-hoc aliases.

Correct example:
<example>
The workflow asks the leader to extract context, then asks Financial Analyst and Risk Analyst to work in parallel.
The leader first extracts the context personally, then calls team_plan_workflow with role tasks only:
{
  "tasks": [
    {
      "taskId": "financial-analysis",
      "roleId": "financial-analyst",
      "title": "Financial analysis",
      "dependsOnTaskIds": [],
      "prompt": "Use this leader-extracted context: ... Produce the financial lens."
    },
    {
      "taskId": "risk-analysis",
      "roleId": "risk-analyst",
      "title": "Risk analysis",
      "dependsOnTaskIds": [],
      "prompt": "Use this leader-extracted context: ... Produce the risk lens."
    }
  ]
}
</example>

Incorrect example:
<example>
Do not model leader work as a workflow task:
{
  "tasks": [
    {
      "taskId": "leader-context-extraction",
      "roleId": "leader",
      "title": "Extract context",
      "prompt": "Extract context for downstream roles."
    }
  ]
}
This is invalid because "leader" is not a dispatchable Team role and leader tasks cannot complete via team_submit_artifact.
</example>

Tool boundary:
- Your first orchestration action must be a successful team_plan_workflow call once you finish any leader-only context extraction.
- Until team_plan_workflow returns success, do not claim that roles were dispatched, do not say work is running in parallel, and do not say you are waiting for role outputs.
- After calling team_plan_workflow, role agents are dispatched automatically. Do NOT call sessions_spawn.
- team_send_message is reserved for real role child sessions and mailbox/audit traffic, not leader follow-up dispatch.
- As leader, do not call team_send_message, team_submit_artifact, team_update_task, or team_request_approval.
- Produce the final integrated TeamRun output as your leader response.
</team_workflow_orchestration>`,
    ...(initialPrompt ? ['', '## User request', initialPrompt] : []),
  ].join('\n')}\n`
}

function buildWorkflowTaskPrompt(input: {
  plan: TeamRunWorkflowPlan
  group: TeamDispatchGroupRecord
  task: TeamWorkflowTaskPlan
}): string {
  const dependencies = input.task.dependsOnTaskIds.length > 0
    ? input.task.dependsOnTaskIds.map((taskId) => `- ${taskId}`).join('\n')
    : 'No task dependencies.'
  return `${[
    `# Team Workflow Task: ${input.task.taskId}`,
    '',
    String.raw`<team_task_execution>
You are executing one assigned TeamRun workflow task as a role agent. Stay inside your role boundary and complete this task through Team Runtime tools.

Assigned identity:
- runId: ${input.plan.runId}
- stageId: ${input.task.taskId}
- roleId: ${input.task.roleId}
- workflow: ${input.plan.title}
- groupId: ${input.group.groupId}
- task title: ${input.task.title}

Core contract:
- Use the exact runId, stageId, and roleId above for every Team Runtime tool call.
- Submit progress with team_update_task only while this task is still queued.
- Submit completion exactly once with team_submit_artifact using runId, stageId, roleId, and an idempotencyKey.
- Do not call team_plan_workflow; the leader owns workflow planning.
- Do not call sessions_spawn; role agents do not create teammates.
- Do not report completion with team_update_task.

Execution pattern:
1. Read the assigned instructions below and any available workspace materials.
2. If dependencies are listed, use their artifacts as input; do not redo unrelated role work.
3. Work only within this role's assigned lens and output kind.
4. Use team_update_task for meaningful progress, waiting, or blocked status while work is underway.
5. Use team_submit_artifact for the final task output.

Correct example:
<example>
During work, report progress with the assigned identity:
{
  "runId": "${input.plan.runId}",
  "stageId": "${input.task.taskId}",
  "roleId": "${input.task.roleId}",
  "status": "in_progress",
  "summary": "Drafting the assigned analysis.",
  "idempotencyKey": "${input.task.taskId}:progress:1"
}
Then submit the final artifact with team_submit_artifact using the same runId, stageId, and roleId.
</example>

Incorrect example:
<example>
Do not invent or substitute identifiers:
{
  "runId": "${input.plan.runId}",
  "stageId": "${input.group.groupId}",
  "roleId": "leader",
  "status": "completed"
}
This is invalid because stageId must be the assigned task id, roleId must be your assigned role, and completion must use team_submit_artifact.
</example>
</team_task_execution>`,
    '',
    '## Assigned Instructions',
    input.task.prompt,
    '',
    '## Dependencies',
    dependencies,
  ].join('\n')}\n`
}

function buildDispatchPrompt(input: {
  stageId: string
  roleId: string
  inlinePersona: string
  outputSchemaMarkdown: string
  artifactBlocks: string[]
  kickbacks: Array<{ kickbackId: string; failureItems: Array<{ code: string; message: string }> }>
  npuAuthorizationRequired: boolean
}): string {
  const npuAuthorizationGuardrails = input.npuAuthorizationRequired
    ? [
      '## NPU Authorization Guardrail',
      'Live NPU testing, profiling, benchmarking, or hardware-backed execution is forbidden until you call team_request_approval for this run/stage/role and the user approves it.',
      'If approval is absent or denied, do not run the NPU action; submit an artifact that reports degraded mode instead.',
      '',
    ]
    : []
  const lines = [
    `# Team Dispatch: ${input.stageId}`,
    '',
    `Role: ${input.roleId}`,
    '',
    '## Role Persona',
    input.inlinePersona.trim(),
    '',
    ...npuAuthorizationGuardrails,
    '## Output Schema',
    input.outputSchemaMarkdown.trim(),
    '',
    '## Input Artifacts',
    input.artifactBlocks.length > 0 ? input.artifactBlocks.join('\n\n---\n\n') : 'No prior artifacts are available for this dispatch.',
    '',
    '## Kickback Failure Items',
    input.kickbacks.length > 0
      ? input.kickbacks.map((kickback) => [
        `kickbackId: ${kickback.kickbackId}`,
        ...kickback.failureItems.map((item) => `- ${item.code}: ${item.message}`),
      ].join('\n')).join('\n\n')
      : 'No kickback failure items are pending for this dispatch.',
    '',
    'Submit your stage output with team_submit_artifact using the assigned runId, stageId, roleId, and an idempotencyKey.',
  ]
  return `${lines.join('\n')}\n`
}
