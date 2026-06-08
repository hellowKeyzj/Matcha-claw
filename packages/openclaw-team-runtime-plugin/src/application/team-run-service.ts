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
import type { TeamManagedAgentConfigProjection, TeamRoleBinding } from '../domain/team-role.js'
import type { TeamRun, TeamRunStatus } from '../domain/team-run.js'
import type { TeamStage } from '../domain/team-stage.js'
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
import { FileStageStore } from '../infrastructure/file-stage-store.js'
import { FileTeamRunStore } from '../infrastructure/file-team-run-store.js'
import type { ClockPort } from '../ports/clock-port.js'
import type { IdGeneratorPort } from '../ports/id-generator-port.js'
import { missingAllDependencyChecker, type TeamDependencyCheckerPort } from '../ports/dependency-checker-port.js'
import type { RoleSessionExecutionPort } from '../ports/role-session-execution-port.js'
import type { TaskFlowProjectionPort, TeamTaskUpdateProjectionInput } from '../ports/task-flow-projection-port.js'
import type { TaskManagerProjectionPort } from '../ports/task-manager-projection-port.js'
import { TeamGateService } from './team-gate-service.js'
import { TeamProvisioningService } from './team-provisioning-service.js'
import { TeamSkillPackageService } from './team-skill-package-service.js'

export interface TeamRunServiceDeps {
  storageRoot: string
  clock: ClockPort
  idGenerator: IdGeneratorPort
  packageService?: TeamSkillPackageService
  taskManagerProjection?: TaskManagerProjectionPort
  taskFlowProjection?: TaskFlowProjectionPort
  roleSessionExecution?: RoleSessionExecutionPort
  dependencyChecker?: TeamDependencyCheckerPort
  maxArtifactContentBytes?: number
  maxMessageBodyBytes?: number
  staleDispatchExecutionMs?: number
}

export interface TeamRunSnapshot {
  run: TeamRun | null
  roles: TeamRoleBinding[]
  stages: TeamStage[]
  approvals: TeamApproval[]
  artifacts: TeamArtifact[]
  dispatches: TeamDispatchEnvelope[]
  dispatchExecutions: TeamDispatchExecutionRecord[]
  messages: TeamMessage[]
  gates: TeamGateResult[]
  kickbacks: TeamKickback[]
  decisions: TeamDecision[]
  diagnostics: TeamRunDiagnostics
  events: TeamEvent[]
  nextEventCursor: number
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
    messages: number
    gates: number
    kickbacks: number
    decisions: number
    events: number
  }
}

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
    missingRequiredSkills: string[]
    missingRequiredTools: string[]
    missingOptionalTools: string[]
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
  private readonly approvalStore: FileApprovalStore
  private readonly eventStore: FileEventStore
  private readonly roleStore: FileRoleBindingStore
  private readonly stageStore: FileStageStore
  private readonly artifactStore: FileArtifactStore
  private readonly messageStore: FileMessageStore
  private readonly gateStore: FileGateStore
  private readonly kickbackStore: FileKickbackStore
  private readonly gateService: TeamGateService
  private readonly provisioningService: TeamProvisioningService
  private readonly taskManagerProjection?: TaskManagerProjectionPort
  private readonly taskFlowProjection?: TaskFlowProjectionPort
  private readonly roleSessionExecution?: RoleSessionExecutionPort
  private readonly dependencyChecker: TeamDependencyCheckerPort

  constructor(private readonly deps: TeamRunServiceDeps) {
    this.packageService = deps.packageService ?? new TeamSkillPackageService()
    this.runStore = new FileTeamRunStore({ clock: deps.clock })
    this.decisionStore = new FileDecisionStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.dispatchStore = new FileDispatchStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.dispatchExecutionStore = new FileDispatchExecutionStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.approvalStore = new FileApprovalStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.eventStore = new FileEventStore({ clock: deps.clock, idGenerator: deps.idGenerator })
    this.roleStore = new FileRoleBindingStore()
    this.stageStore = new FileStageStore({ clock: deps.clock })
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
    this.gateService = new TeamGateService()
    this.provisioningService = new TeamProvisioningService({ storageRoot: deps.storageRoot, roleStore: this.roleStore })
    this.taskManagerProjection = deps.taskManagerProjection
    this.taskFlowProjection = deps.taskFlowProjection
    this.roleSessionExecution = deps.roleSessionExecution
    this.dependencyChecker = deps.dependencyChecker ?? missingAllDependencyChecker
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
      const stages = await this.stageStore.initialize({
        runtimeRoot,
        runId: run.runId,
        stages: packageResult.package.workflow.stages,
      })
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'stages:initialized',
        payload: { stageIds: stages.map((stage) => stage.stageId) },
      })
    }

    return { runId: run.runId, status: run.status, revision: run.revision, ...(managedAgentConfig ? { managedAgentConfig } : {}) }
  }

  async start(input: { runId: string; idempotencyKey: string }): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const current = await this.runStore.read(runtimeRoot)
    if (!current) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }

    if (current.status === 'running') {
      return { runId: current.runId, status: current.status, revision: current.revision }
    }
    if (!STARTABLE_RUN_STATUSES.has(current.status)) {
      throw new Error(`TeamRun cannot be started from status ${current.status}: ${input.runId}`)
    }

    const stages = await this.stageStore.read(runtimeRoot)
    const targetStage = current.currentStageId
      ? stages.find((stage) => stage.stageId === current.currentStageId)
      : stages[0]
    if (!targetStage) {
      throw new Error(`TeamRun has no startable stage: ${input.runId}`)
    }
    if (targetStage.status === 'passed' || targetStage.status === 'failed' || targetStage.status === 'skipped' || targetStage.status === 'cancelled') {
      throw new Error(`Team stage cannot be started from status ${targetStage.status}: ${targetStage.stageId}`)
    }

    const startedStage = targetStage.status === 'running'
      ? targetStage
      : await this.stageStore.updateStatus({
        runtimeRoot,
        stageId: targetStage.stageId,
        status: 'running',
        attempt: targetStage.attempt + 1,
      })
    const run = await this.runStore.update({ runtimeRoot, status: 'running', currentStageId: startedStage.stageId })
    await this.eventStore.append({
      runtimeRoot,
      runId: run.runId,
      revision: run.revision,
      type: 'run:started',
      payload: { idempotencyKey: input.idempotencyKey, currentStageId: run.currentStageId ?? null },
    })
    await this.projectTeamRun({ runtimeRoot, run, reason: 'run:started' })
    if (this.roleSessionExecution) {
      await this.advancePipelineFromCurrentStage({ runId: run.runId, idempotencyKey: `${input.idempotencyKey}:advance` })
    }
    const latest = await this.runStore.read(runtimeRoot) ?? run
    return { runId: latest.runId, status: latest.status, revision: latest.revision }
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
    const activeStage = current.currentStageId
      ? (await this.stageStore.read(runtimeRoot)).find((stage) => stage.stageId === current.currentStageId)
      : undefined
    const shouldCloseActiveStage = activeStage && (activeStage.status === 'running' || activeStage.status === 'waiting_for_user')
    const activeExecutions = (await this.dispatchExecutionStore.read(runtimeRoot)).filter((execution) => (
      execution.runId === current.runId
      && (!activeStage || execution.stageId === activeStage.stageId)
      && (execution.status === 'claimed' || execution.status === 'queued')
    ))
    await this.cancelActiveDispatchSessions({ executions: activeExecutions, reason })
    if (shouldCloseActiveStage) {
      await this.stageStore.updateStatus({ runtimeRoot, stageId: activeStage.stageId, status: 'cancelled' })
    }
    const cancelledExecutions = await this.dispatchExecutionStore.cancelActive({
      runtimeRoot,
      runId: current.runId,
      ...(activeStage ? { stageId: activeStage.stageId } : {}),
      reason,
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

  async snapshot(input: { runId: string; eventCursor?: number; eventLimit?: number }): Promise<TeamRunSnapshot> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    await this.refreshStaleDispatchExecutions(runtimeRoot)
    const [run, roles, stages, approvals, artifacts, dispatches, dispatchExecutions, messages, gates, kickbacks, decisions, events] = await Promise.all([
      this.runStore.read(runtimeRoot),
      this.roleStore.read(runtimeRoot),
      this.stageStore.read(runtimeRoot),
      this.approvalStore.read(runtimeRoot),
      this.artifactStore.read(runtimeRoot),
      this.dispatchStore.read(runtimeRoot),
      this.dispatchExecutionStore.read(runtimeRoot),
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
      stages,
      approvals,
      artifacts,
      dispatches,
      dispatchExecutions,
      messages,
      gates,
      kickbacks,
      decisions,
      eventCount: events.nextCursor,
    })
    return {
      run,
      roles,
      stages,
      approvals,
      artifacts,
      dispatches,
      dispatchExecutions,
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

  async completeStage(input: {
    runId: string
    stageId: string
    outputArtifactIds?: string[]
    idempotencyKey: string
  }): Promise<{ runId: string; status: TeamRunStatus; revision: number; currentStageId?: string }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const stage = (await this.stageStore.read(runtimeRoot)).find((candidate) => candidate.stageId === input.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.stageId}`)
    }
    if (stage.status === 'passed') {
      return await this.reconcileCompletedStage({ runtimeRoot, run, stage, idempotencyKey: input.idempotencyKey })
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    if (run.currentStageId !== input.stageId) {
      throw new Error(`TeamRun current stage is ${run.currentStageId ?? 'none'}, got ${input.stageId}`)
    }
    if (stage.roleId) {
      throw new Error(`Role stage must be completed by artifact submission and gate evaluation: ${stage.stageId}`)
    }

    return await this.completeStageInternal({
      runtimeRoot,
      run,
      stageId: input.stageId,
      outputArtifactIds: input.outputArtifactIds,
      idempotencyKey: input.idempotencyKey,
    })
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
    this.assertToolCallerWorkspace({ run, role, workspaceDir: input.workspaceDir })
    const existingApproval = (await this.approvalStore.read(runtimeRoot)).find((approval) => approval.idempotencyKey === input.idempotencyKey)
    if (existingApproval) {
      await this.reconcileRequestedApproval({ runtimeRoot, run, approval: existingApproval, idempotencyKey: input.idempotencyKey })
      return { approval: existingApproval, created: false }
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    const stage = (await this.stageStore.read(runtimeRoot)).find((candidate) => candidate.stageId === input.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.stageId}`)
    }
    if (run.currentStageId !== input.stageId) {
      throw new Error(`TeamRun current stage is ${run.currentStageId ?? 'none'}, got ${input.stageId}`)
    }
    if (stage.status !== 'running') {
      throw new Error(`Team stage is not running: ${input.stageId}`)
    }
    if (stage.roleId !== role.roleId) {
      throw new Error(`Team stage ${stage.stageId} expects role ${stage.roleId ?? 'none'}, got ${role.roleId}`)
    }

    const requested = await this.approvalStore.request({
      runtimeRoot,
      runId: run.runId,
      stageId: stage.stageId,
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
    this.assertToolCallerWorkspace({ run, role, workspaceDir: input.workspaceDir })

    const existingArtifact = (await this.artifactStore.read(runtimeRoot)).find((artifact) => artifact.idempotencyKey === input.idempotencyKey)
    if (existingArtifact) {
      await this.resumeSubmittedArtifactPipeline({ runtimeRoot, run, artifact: existingArtifact, childSessionKey: input.childSessionKey, idempotencyKey: input.idempotencyKey })
      return { artifact: existingArtifact, created: false }
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    const stage = (await this.stageStore.read(runtimeRoot)).find((candidate) => candidate.stageId === input.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.stageId}`)
    }
    if (run.currentStageId !== input.stageId) {
      throw new Error(`TeamRun current stage is ${run.currentStageId ?? 'none'}, got ${input.stageId}`)
    }
    if (stage.status !== 'running') {
      throw new Error(`Team stage is not running: ${input.stageId}`)
    }
    if (!stage.roleId) {
      throw new Error(`Team stage is not role-dispatchable: ${stage.stageId}`)
    }
    if (role.roleId !== stage.roleId) {
      throw new Error(`Team stage ${stage.stageId} expects role ${stage.roleId}, got ${role.roleId}`)
    }

    const submitted = await this.artifactStore.submit({
      runtimeRoot,
      runId: run.runId,
      stageId: stage.stageId,
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
      await this.closeSubmittedArtifactPipeline({
        runtimeRoot,
        run,
        stage,
        roleId: role.roleId,
        artifactId: submitted.artifact.artifactId,
        childSessionKey: input.childSessionKey,
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
    this.assertToolCallerWorkspace({ run, role, workspaceDir: input.workspaceDir })
    const stage = (await this.stageStore.read(runtimeRoot)).find((candidate) => candidate.stageId === input.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.stageId}`)
    }
    if (!stage.roleId) {
      throw new Error(`Team stage is not role-dispatchable: ${stage.stageId}`)
    }
    if (stage.roleId !== input.roleId) {
      throw new Error(`Team stage ${stage.stageId} expects role ${stage.roleId}, got ${input.roleId}`)
    }
    if (stage.status !== 'running' && stage.status !== 'waiting_for_user') {
      throw new Error(`Team stage is not active: ${stage.stageId}`)
    }

    await this.eventStore.append({
      runtimeRoot,
      runId: run.runId,
      revision: run.revision,
      type: 'task:update_submitted',
      payload: {
        stageId: stage.stageId,
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
      stage,
      roleId: role.roleId,
      status: input.status,
      summary: input.summary,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.progress !== undefined ? { progress: input.progress } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    })
    return { runId: run.runId, stageId: stage.stageId, roleId: role.roleId, status: input.status, summary: input.summary }
  }

  async sendMessage(input: {
    runId: string
    fromRoleId: string
    toRoleId: string
    summary: string
    body: string
    idempotencyKey: string
    workspaceDir?: string
  }): Promise<{ message: TeamMessage; created: boolean }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      throw new Error(`TeamRun cannot accept messages from terminal status ${run.status}: ${input.runId}`)
    }
    const roles = await this.roleStore.read(runtimeRoot)
    const fromRole = roles.find((binding) => binding.roleId === input.fromRoleId)
    if (!fromRole) {
      throw new Error(`Team role not found: ${input.fromRoleId}`)
    }
    if (input.toRoleId !== 'leader' && !roles.some((binding) => binding.roleId === input.toRoleId)) {
      throw new Error(`Team message target not found: ${input.toRoleId}`)
    }
    this.assertToolCallerWorkspace({ run, role: fromRole, workspaceDir: input.workspaceDir })

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
    if (!run.currentStageId) {
      return { action: 'noop', runId: run.runId, status: run.status, revision: run.revision, reason: 'TeamRun has no current stage' }
    }

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
    const stage = (await this.stageStore.read(runtimeRoot)).find((candidate) => candidate.stageId === run.currentStageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${run.currentStageId}`)
    }
    if (stage.status !== 'running') {
      return {
        action: 'noop',
        runId: run.runId,
        status: run.status,
        revision: run.revision,
        reason: `Team stage is not running: ${stage.status}`,
        currentStageId: stage.stageId,
      }
    }

    const roleId = stage.roleId
    if (!roleId) {
      if (stage.stageId === 'step-0-pre-flight-dependency-check') {
        return await this.runDependencyPreflight({ run, stage, idempotencyKey: input.idempotencyKey })
      }
      const completed = await this.completeStageInternal({
        runtimeRoot,
        run,
        stageId: stage.stageId,
        idempotencyKey: `${input.idempotencyKey}:stage:${stage.stageId}`,
      })
      return {
        action: 'stage_completed',
        runId: completed.runId,
        status: completed.status,
        revision: completed.revision,
        ...(completed.currentStageId ? { currentStageId: completed.currentStageId } : {}),
      }
    }

    const prepared = await this.prepareDispatch({
      runId: run.runId,
      stageId: stage.stageId,
      roleId,
      idempotencyKey: `${input.idempotencyKey}:dispatch:${stage.stageId}:${roleId}`,
    })
    if (!this.roleSessionExecution) {
      return {
        action: 'dispatch_prepared',
        runId: run.runId,
        status: run.status,
        revision: run.revision,
        currentStageId: stage.stageId,
        dispatch: prepared.dispatch,
        prompt: prepared.prompt,
        created: prepared.created,
      }
    }

    const executed = await this.executeDispatch({
      runId: run.runId,
      dispatchId: prepared.dispatch.dispatchId,
      idempotencyKey: `${input.idempotencyKey}:execution:${prepared.dispatch.dispatchId}`,
    })
    return {
      action: 'dispatch_execution_queued',
      runId: run.runId,
      status: run.status,
      revision: run.revision,
      currentStageId: stage.stageId,
      dispatch: prepared.dispatch,
      execution: executed.execution,
      created: executed.created,
    }
  }

  private async runDependencyPreflight(input: { run: TeamRun; stage: TeamStage; idempotencyKey: string }): Promise<TeamRunTickResult> {
    const runtimeRoot = this.resolveRuntimeRoot(input.run.runId)
    const packageResult = await this.packageService.validate(input.run.sourcePath)
    if (!packageResult.valid || !packageResult.package) {
      throw new Error(`Invalid TeamSkill package: ${packageResult.errors.map((issue) => issue.message).join('; ')}`)
    }

    const result = await this.dependencyChecker.check(packageResult.package.dependencies)
    const hasMissingRequired = result.missingRequiredSkills.length > 0 || result.missingRequiredTools.length > 0
    await this.eventStore.append({
      runtimeRoot,
      runId: input.run.runId,
      revision: input.run.revision,
      type: hasMissingRequired ? 'dependency:missing' : 'dependency:checked',
      payload: {
        stageId: input.stage.stageId,
        missingRequiredSkills: result.missingRequiredSkills,
        missingRequiredTools: result.missingRequiredTools,
        missingOptionalTools: result.missingOptionalTools,
        idempotencyKey: `${input.idempotencyKey}:dependency:${input.stage.stageId}`,
      },
    })

    if (hasMissingRequired) {
      await this.stageStore.updateStatus({ runtimeRoot, stageId: input.stage.stageId, status: 'waiting_for_user' })
      const waitingRun = await this.runStore.update({ runtimeRoot, status: 'waiting_for_user', currentStageId: input.stage.stageId })
      await this.projectTeamRun({ runtimeRoot, run: waitingRun, reason: 'dependency:missing' })
      return {
        action: 'dependency_missing',
        runId: waitingRun.runId,
        status: waitingRun.status,
        revision: waitingRun.revision,
        currentStageId: input.stage.stageId,
        missingRequiredSkills: result.missingRequiredSkills,
        missingRequiredTools: result.missingRequiredTools,
        missingOptionalTools: result.missingOptionalTools,
      }
    }

    const completed = await this.completeStageInternal({
      runtimeRoot,
      run: input.run,
      stageId: input.stage.stageId,
      idempotencyKey: `${input.idempotencyKey}:stage:${input.stage.stageId}`,
    })
    return {
      action: 'stage_completed',
      runId: completed.runId,
      status: completed.status,
      revision: completed.revision,
      ...(completed.currentStageId ? { currentStageId: completed.currentStageId } : {}),
    }
  }

  async prepareDispatch(input: {
    runId: string
    stageId: string
    roleId?: string
    idempotencyKey: string
  }): Promise<{ dispatch: TeamDispatchEnvelope; prompt: string; created: boolean }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const packageResult = await this.packageService.validate(run.sourcePath)
    if (!packageResult.valid || !packageResult.package) {
      throw new Error(`Invalid TeamSkill package: ${packageResult.errors.map((issue) => issue.message).join('; ')}`)
    }

    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    if (run.currentStageId !== input.stageId) {
      throw new Error(`TeamRun current stage is ${run.currentStageId ?? 'none'}, got ${input.stageId}`)
    }
    const stages = await this.stageStore.read(runtimeRoot)
    const stage = stages.find((candidate) => candidate.stageId === input.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.stageId}`)
    }
    if (stage.status !== 'running') {
      throw new Error(`Team stage is not running: ${input.stageId}`)
    }
    if (stage.stageId !== run.currentStageId) {
      throw new Error(`TeamRun current stage is ${run.currentStageId ?? 'none'}, got ${stage.stageId}`)
    }

    const roleId = input.roleId ?? stage.roleId
    if (!roleId) {
      throw new Error(`Team stage is not role-dispatchable: ${input.stageId}`)
    }
    if (stage.roleId !== roleId) {
      throw new Error(`Team stage ${stage.stageId} expects role ${stage.roleId ?? 'none'}, got ${roleId}`)
    }
    const role = packageResult.package.roles.find((candidate) => candidate.id === roleId)
    if (!role) {
      throw new Error(`Team role not found: ${roleId}`)
    }
    const roleBindings = await this.roleStore.read(runtimeRoot)
    if (!roleBindings.some((binding) => binding.roleId === role.id)) {
      throw new Error(`Team role is not provisioned: ${role.id}`)
    }

    const artifacts = await this.artifactStore.read(runtimeRoot)
    const stageIndex = stages.findIndex((candidate) => candidate.stageId === stage.stageId)
    const inputArtifactIds = artifactIdsForDispatch({ stages, stageIndex, stageInputArtifactIds: stage.inputArtifactIds })
    const inputArtifacts = artifacts.filter((artifact) => inputArtifactIds.includes(artifact.artifactId))
    const artifactBlocks = await Promise.all(inputArtifacts.map(async (artifact) => {
      return [
        `## Artifact: ${artifact.title}`,
        `artifactId: ${artifact.artifactId}`,
        `stageId: ${artifact.stageId}`,
        `roleId: ${artifact.roleId}`,
        `kind: ${artifact.kind}`,
        '',
        await this.artifactStore.readContent(runtimeRoot, artifact),
      ].join('\n')
    }))
    const kickbacks = (await this.kickbackStore.read(runtimeRoot)).filter((kickback) => kickback.stageId === stage.stageId)
    const prompt = buildDispatchPrompt({
      stageId: stage.stageId,
      roleId: role.id,
      inlinePersona: role.inlinePersona ?? role.agentsMd,
      outputSchemaMarkdown: role.outputSchemaMarkdown,
      artifactBlocks,
      kickbacks: kickbacks.map((kickback) => ({ kickbackId: kickback.kickbackId, failureItems: kickback.failureItems })),
      npuAuthorizationRequired: packageResult.package.bind.requiresNpuAuthorization,
    })

    const saved = await this.dispatchStore.save({
      runtimeRoot,
      runId: run.runId,
      stageId: stage.stageId,
      roleId: role.id,
      prompt,
      inputArtifactIds: inputArtifacts.map((artifact) => artifact.artifactId),
      kickbackIds: kickbacks.map((kickback) => kickback.kickbackId),
      idempotencyKey: input.idempotencyKey,
    })

    if (saved.created) {
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'dispatch:prepared',
        payload: {
          dispatchId: saved.dispatch.dispatchId,
          stageId: saved.dispatch.stageId,
          roleId: saved.dispatch.roleId,
          inputArtifactIds: saved.dispatch.inputArtifactIds,
          kickbackIds: saved.dispatch.kickbackIds,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }

    return saved
  }

  async executeDispatch(input: {
    runId: string
    dispatchId: string
    idempotencyKey: string
  }): Promise<{ execution: TeamDispatchExecutionRecord; created: boolean }> {
    if (!this.roleSessionExecution) {
      throw new Error('Team role session execution is not configured')
    }

    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }

    const dispatch = (await this.dispatchStore.read(runtimeRoot)).find((candidate) => candidate.dispatchId === input.dispatchId)
    if (!dispatch) {
      throw new Error(`Team dispatch not found: ${input.dispatchId}`)
    }
    if (run.currentStageId !== dispatch.stageId) {
      throw new Error(`TeamRun current stage is ${run.currentStageId ?? 'none'}, got ${dispatch.stageId}`)
    }
    const stage = (await this.stageStore.read(runtimeRoot)).find((candidate) => candidate.stageId === dispatch.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${dispatch.stageId}`)
    }
    if (stage.status !== 'running') {
      throw new Error(`Team stage is not running: ${stage.stageId}`)
    }
    const role = (await this.roleStore.read(runtimeRoot)).find((binding) => binding.roleId === dispatch.roleId)
    if (!role) {
      throw new Error(`Team role not found: ${dispatch.roleId}`)
    }

    const claimed = await this.dispatchExecutionStore.claim({
      runtimeRoot,
      runId: run.runId,
      dispatchId: dispatch.dispatchId,
      stageId: dispatch.stageId,
      roleId: dispatch.roleId,
      idempotencyKey: input.idempotencyKey,
    })
    if (!claimed.created) {
      return claimed
    }

    const prompt = await this.dispatchStore.readPrompt(runtimeRoot, dispatch)
    let executed: Awaited<ReturnType<RoleSessionExecutionPort['executeDispatch']>>
    try {
      executed = await this.roleSessionExecution.executeDispatch({
        runId: run.runId,
        dispatch,
        role,
        prompt,
      })
      if (executed.dispatchId !== dispatch.dispatchId) {
        throw new Error(`Team dispatch execution returned dispatchId ${executed.dispatchId}, expected ${dispatch.dispatchId}`)
      }
      if (executed.roleId !== dispatch.roleId) {
        throw new Error(`Team dispatch execution returned roleId ${executed.roleId}, expected ${dispatch.roleId}`)
      }
    } catch (error) {
      const failed = await this.dispatchExecutionStore.markFailed({
        runtimeRoot,
        executionRecordId: claimed.execution.executionRecordId,
        reason: error instanceof Error ? error.message : String(error),
      })
      if (failed.changed) {
        await this.eventStore.append({
          runtimeRoot,
          runId: run.runId,
          revision: run.revision,
          type: 'dispatch:execution_failed',
          payload: {
            executionRecordId: failed.execution.executionRecordId,
            dispatchId: failed.execution.dispatchId,
            stageId: failed.execution.stageId,
            roleId: failed.execution.roleId,
            reason: failed.execution.statusReason ?? null,
            idempotencyKey: input.idempotencyKey,
          },
        })
      }
      throw error
    }
    const queued = await this.dispatchExecutionStore.attachQueuedExecution({
      runtimeRoot,
      executionRecordId: claimed.execution.executionRecordId,
      executionId: executed.executionId,
      childSessionKey: executed.childSessionKey,
      spawnMode: executed.spawnMode,
    })

    if (queued.changed) {
      await this.eventStore.append({
        runtimeRoot,
        runId: run.runId,
        revision: run.revision,
        type: 'dispatch:execution_queued',
        payload: {
          executionRecordId: queued.execution.executionRecordId,
          executionId: queued.execution.executionId,
          childSessionKey: queued.execution.childSessionKey,
          spawnMode: queued.execution.spawnMode,
          dispatchId: queued.execution.dispatchId,
          stageId: queued.execution.stageId,
          roleId: queued.execution.roleId,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }

    return { execution: queued.execution, created: true }
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

    const saved = await this.decisionStore.save({
      runtimeRoot,
      runId: current.runId,
      stageId: current.currentStageId,
      decision: input.decision,
      ...(input.note ? { note: input.note } : {}),
      idempotencyKey: input.idempotencyKey,
    })

    if (saved.created) {
      if (saved.decision.decision === 'retry') {
        await this.stageStore.resumeWaitingStage({ runtimeRoot, stageId: saved.decision.stageId })
        const run = await this.runStore.update({ runtimeRoot, status: 'running', currentStageId: saved.decision.stageId })
        await this.appendDecisionEvent({ runtimeRoot, run, decision: saved.decision, idempotencyKey: input.idempotencyKey })
        await this.projectTeamRun({ runtimeRoot, run, reason: 'decision:submitted' })
      } else if (saved.decision.decision === 'proceed_degraded') {
        await this.stageStore.resumeWaitingStage({ runtimeRoot, stageId: saved.decision.stageId })
        const resumedRun = await this.runStore.update({ runtimeRoot, status: 'running', currentStageId: saved.decision.stageId })
        await this.completeStageInternal({
          runtimeRoot,
          run: resumedRun,
          stageId: saved.decision.stageId,
          idempotencyKey: `${input.idempotencyKey}:proceed_degraded`,
        })
        const run = (await this.runStore.read(runtimeRoot)) ?? resumedRun
        await this.appendDecisionEvent({ runtimeRoot, run, decision: saved.decision, idempotencyKey: input.idempotencyKey })
        await this.projectTeamRun({ runtimeRoot, run, reason: 'decision:submitted' })
      } else {
        await this.stageStore.updateStatus({ runtimeRoot, stageId: saved.decision.stageId, status: 'failed' })
        const run = await this.runStore.update({ runtimeRoot, status: 'failed', currentStageId: saved.decision.stageId })
        await this.appendDecisionEvent({ runtimeRoot, run, decision: saved.decision, idempotencyKey: input.idempotencyKey })
        await this.projectTeamRun({ runtimeRoot, run, reason: 'decision:submitted' })
      }
    }

    return saved
  }

  async evaluateGate(input: {
    runId: string
    artifactId: string
    gateType: string
    idempotencyKey: string
  }): Promise<{ gate: TeamGateResult; created: boolean }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.runId)
    const run = await this.runStore.read(runtimeRoot)
    if (!run) {
      throw new Error(`TeamRun not found: ${input.runId}`)
    }
    const existingGate = (await this.gateStore.read(runtimeRoot)).find((gate) => gate.idempotencyKey === input.idempotencyKey)
    if (existingGate) {
      await this.reconcileExistingGate({ runtimeRoot, run, gate: existingGate, idempotencyKey: input.idempotencyKey })
      return { gate: existingGate, created: false }
    }
    const artifacts = await this.artifactStore.read(runtimeRoot)
    const artifact = artifacts.find((item) => item.artifactId === input.artifactId)
    if (!artifact) {
      throw new Error(`Team artifact not found: ${input.artifactId}`)
    }
    const existingArtifactGate = (await this.gateStore.read(runtimeRoot)).find((gate) => gate.artifactId === artifact.artifactId && gate.gateType === input.gateType)
    if (existingArtifactGate) {
      await this.reconcileExistingGate({ runtimeRoot, run, gate: existingArtifactGate, idempotencyKey: input.idempotencyKey })
      return { gate: existingArtifactGate, created: false }
    }
    if (run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.runId}`)
    }
    const stage = (await this.stageStore.read(runtimeRoot)).find((candidate) => candidate.stageId === artifact.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${artifact.stageId}`)
    }
    if (stage.status !== 'running') {
      throw new Error(`Team stage is not running: ${stage.stageId}`)
    }
    if (!stage.gateType) {
      throw new Error(`Team stage has no gate: ${stage.stageId}`)
    }
    if (input.gateType !== stage.gateType) {
      throw new Error(`Team stage ${stage.stageId} expects gate ${stage.gateType}, got ${input.gateType}`)
    }

    return await this.evaluateStageGate({
      runtimeRoot,
      run,
      stage,
      artifact,
      gateType: input.gateType,
      idempotencyKey: input.idempotencyKey,
    })
  }

  resolveRuntimeRoot(runId: string): string {
    return path.join(this.deps.storageRoot, 'runs', sanitizePathSegment(runId))
  }

  private assertToolCallerWorkspace(input: { run: TeamRun; role: TeamRoleBinding; workspaceDir?: string }): void {
    if (!input.workspaceDir?.trim()) {
      throw new Error(`Tool caller workspace is required for role: ${input.role.roleId}`)
    }
    if (input.role.runId !== input.run.runId) {
      throw new Error(`Team role binding does not belong to run: ${input.run.runId}`)
    }
    if (path.resolve(input.workspaceDir) !== path.resolve(input.role.workspaceDir)) {
      throw new Error(`Tool caller workspace does not match role: ${input.role.roleId}`)
    }
  }

  private async completeStageInternal(input: {
    runtimeRoot: string
    run: TeamRun
    stageId: string
    outputArtifactIds?: string[]
    idempotencyKey: string
  }): Promise<{ runId: string; status: TeamRunStatus; revision: number; currentStageId?: string }> {
    if (input.run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.run.runId}`)
    }
    if (input.run.currentStageId !== input.stageId) {
      throw new Error(`TeamRun current stage is ${input.run.currentStageId ?? 'none'}, got ${input.stageId}`)
    }
    const transition = await this.stageStore.completeStage({
      runtimeRoot: input.runtimeRoot,
      stageId: input.stageId,
      outputArtifactIds: input.outputArtifactIds,
    })
    const updatedRun = transition.changed
      ? await this.runStore.update({
        runtimeRoot: input.runtimeRoot,
        status: transition.completed ? 'completed' : 'running',
        currentStageId: transition.nextStage?.stageId ?? transition.stage.stageId,
      })
      : input.run

    if (transition.changed) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: updatedRun.runId,
        revision: updatedRun.revision,
        type: 'stage:completed',
        payload: {
          stageId: transition.stage.stageId,
          nextStageId: transition.nextStage?.stageId ?? null,
          completed: transition.completed,
          outputArtifactIds: transition.stage.outputArtifactIds,
          idempotencyKey: input.idempotencyKey,
        },
      })
      if (transition.completed) {
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: updatedRun.runId,
          revision: updatedRun.revision,
          type: 'run:completed',
          payload: { stageId: transition.stage.stageId, idempotencyKey: input.idempotencyKey },
        })
      }
      await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: updatedRun, reason: transition.completed ? 'run:completed' : 'stage:completed' })
    }

    return {
      runId: updatedRun.runId,
      status: updatedRun.status,
      revision: updatedRun.revision,
      ...(updatedRun.currentStageId ? { currentStageId: updatedRun.currentStageId } : {}),
    }
  }

  private async resumeSubmittedArtifactPipeline(input: {
    runtimeRoot: string
    run: TeamRun
    artifact: TeamArtifact
    childSessionKey?: string
    idempotencyKey: string
  }): Promise<void> {
    const stage = (await this.stageStore.read(input.runtimeRoot)).find((candidate) => candidate.stageId === input.artifact.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.artifact.stageId}`)
    }
    const alreadyClosed = stage.status === 'passed' || input.run.currentStageId !== input.artifact.stageId
    if (alreadyClosed) {
      return
    }
    await this.closeSubmittedArtifactPipeline({
      runtimeRoot: input.runtimeRoot,
      run: input.run,
      stage,
      roleId: input.artifact.roleId,
      artifactId: input.artifact.artifactId,
      childSessionKey: input.childSessionKey,
      idempotencyKey: input.idempotencyKey,
    })
  }

  private async closeSubmittedArtifactPipeline(input: {
    runtimeRoot: string
    run: TeamRun
    stage: TeamStage
    roleId: string
    artifactId: string
    childSessionKey?: string
    idempotencyKey: string
  }): Promise<void> {
    const completionIdentity = await this.resolveExecutionCompletionIdentity(input)
    const completedExecution: { execution?: TeamDispatchExecutionRecord; changed: boolean } = completionIdentity
      ? await this.dispatchExecutionStore.markCompleted({
        runtimeRoot: input.runtimeRoot,
        ...completionIdentity,
        reason: `Artifact submitted: ${input.artifactId}`,
      })
      : { changed: false }
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

    if (input.stage.gateType) {
      const artifacts = await this.artifactStore.read(input.runtimeRoot)
      const artifact = artifacts.find((item) => item.artifactId === input.artifactId)
      if (!artifact) {
        throw new Error(`Team artifact not found: ${input.artifactId}`)
      }
      const evaluated = await this.evaluateStageGate({
        runtimeRoot: input.runtimeRoot,
        run: input.run,
        stage: input.stage,
        artifact,
        gateType: input.stage.gateType,
        idempotencyKey: `${input.idempotencyKey}:gate:${input.stage.stageId}`,
      })
      if (evaluated.gate.passed) {
        await this.advancePipelineFromCurrentStage({ runId: input.run.runId, idempotencyKey: `${input.idempotencyKey}:advance` })
      }
      return
    }

    await this.completeStageInternal({
      runtimeRoot: input.runtimeRoot,
      run: input.run,
      stageId: input.stage.stageId,
      outputArtifactIds: [input.artifactId],
      idempotencyKey: `${input.idempotencyKey}:stage:${input.stage.stageId}`,
    })
    await this.advancePipelineFromCurrentStage({ runId: input.run.runId, idempotencyKey: `${input.idempotencyKey}:advance` })
  }

  private async resolveExecutionCompletionIdentity(input: {
    runtimeRoot: string
    stage: TeamStage
    roleId: string
    childSessionKey?: string
  }): Promise<{ executionRecordId: string } | { dispatchId: string } | null> {
    const executions = await this.dispatchExecutionStore.read(input.runtimeRoot)
    const queuedForStage = executions.filter((execution) => execution.stageId === input.stage.stageId && execution.roleId === input.roleId && execution.status === 'queued')
    if (queuedForStage.length === 0) {
      return null
    }
    if (input.childSessionKey) {
      const execution = queuedForStage.find((candidate) => candidate.childSessionKey === input.childSessionKey)
      if (!execution) {
        throw new Error(`Team dispatch execution child session does not match active role dispatch: ${input.childSessionKey}`)
      }
      return { executionRecordId: execution.executionRecordId }
    }
    if (queuedForStage.length === 1) {
      return { executionRecordId: queuedForStage[0].executionRecordId }
    }
    const dispatch = (await this.dispatchStore.read(input.runtimeRoot)).findLast((candidate) => candidate.stageId === input.stage.stageId && candidate.roleId === input.roleId)
    if (!dispatch) {
      return null
    }
    return { dispatchId: dispatch.dispatchId }
  }

  private async evaluateStageGate(input: {
    runtimeRoot: string
    run: TeamRun
    stage: TeamStage
    artifact: TeamArtifact
    gateType: string
    idempotencyKey: string
  }): Promise<{ gate: TeamGateResult; created: boolean }> {
    if (input.run.status !== 'running') {
      throw new Error(`TeamRun is not running: ${input.run.runId}`)
    }
    const latestRun = await this.runStore.read(input.runtimeRoot)
    if (!latestRun) {
      throw new Error(`TeamRun not found: ${input.run.runId}`)
    }
    if (latestRun.status !== 'running') {
      const existingGate = (await this.gateStore.read(input.runtimeRoot)).find((gate) => gate.artifactId === input.artifact.artifactId && gate.gateType === input.gateType)
      if (existingGate) {
        await this.reconcileExistingGate({ runtimeRoot: input.runtimeRoot, run: latestRun, gate: existingGate, idempotencyKey: input.idempotencyKey })
        return { gate: existingGate, created: false }
      }
      throw new Error(`TeamRun is not running: ${input.run.runId}`)
    }
    if (latestRun.currentStageId !== input.stage.stageId) {
      const existingGate = (await this.gateStore.read(input.runtimeRoot)).find((gate) => gate.artifactId === input.artifact.artifactId && gate.gateType === input.gateType)
      if (existingGate) {
        await this.reconcileExistingGate({ runtimeRoot: input.runtimeRoot, run: latestRun, gate: existingGate, idempotencyKey: input.idempotencyKey })
        return { gate: existingGate, created: false }
      }
      throw new Error(`TeamRun current stage is ${latestRun.currentStageId ?? 'none'}, got ${input.stage.stageId}`)
    }
    const content = await this.artifactStore.readContent(input.runtimeRoot, input.artifact)
    const evaluated = this.gateService.evaluate({ gateType: input.gateType, content })
    const saved = await this.gateStore.save({
      runtimeRoot: input.runtimeRoot,
      runId: input.run.runId,
      stageId: input.artifact.stageId,
      artifactId: input.artifact.artifactId,
      gateType: evaluated.gateType,
      verdict: evaluated.verdict,
      passed: evaluated.passed,
      failureItems: evaluated.failureItems,
      idempotencyKey: input.idempotencyKey,
    })

    if (saved.created) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'gate:evaluated',
        payload: {
          gateId: saved.gate.gateId,
          stageId: saved.gate.stageId,
          artifactId: saved.gate.artifactId,
          gateType: saved.gate.gateType,
          verdict: saved.gate.verdict,
          passed: saved.gate.passed,
          failureItems: saved.gate.failureItems,
          idempotencyKey: input.idempotencyKey,
        },
      })
    }

    await this.applyGateTransition({
      runtimeRoot: input.runtimeRoot,
      run: input.run,
      gate: saved.gate,
      idempotencyKey: input.idempotencyKey,
    })

    return saved
  }

  private async reconcileCompletedStage(input: {
    runtimeRoot: string
    run: TeamRun
    stage: TeamStage
    idempotencyKey: string
  }): Promise<{ runId: string; status: TeamRunStatus; revision: number; currentStageId?: string }> {
    const stages = await this.stageStore.read(input.runtimeRoot)
    const stageIndex = stages.findIndex((stage) => stage.stageId === input.stage.stageId)
    if (stageIndex < 0) {
      throw new Error(`Team stage not found: ${input.stage.stageId}`)
    }
    const nextStage = stages[stageIndex + 1]
    const expectedStatus: TeamRunStatus = nextStage ? 'running' : 'completed'
    const expectedCurrentStageId = nextStage?.stageId ?? input.stage.stageId
    const run = input.run.status === expectedStatus && input.run.currentStageId === expectedCurrentStageId
      ? input.run
      : await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: expectedStatus, currentStageId: expectedCurrentStageId })
    await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run, reason: expectedStatus === 'completed' ? 'run:completed' : 'stage:completed' })
    return {
      runId: run.runId,
      status: run.status,
      revision: run.revision,
      ...(run.currentStageId ? { currentStageId: run.currentStageId } : {}),
    }
  }

  private async reconcileRequestedApproval(input: {
    runtimeRoot: string
    run: TeamRun
    approval: TeamApproval
    idempotencyKey: string
  }): Promise<void> {
    const stage = (await this.stageStore.read(input.runtimeRoot)).find((candidate) => candidate.stageId === input.approval.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.approval.stageId}`)
    }
    const stageChanged = stage.status !== 'waiting_for_user'
    if (stageChanged) {
      if (stage.status !== 'running') {
        throw new Error(`Team stage is not running: ${input.approval.stageId}`)
      }
      await this.stageStore.updateStatus({ runtimeRoot: input.runtimeRoot, stageId: stage.stageId, status: 'waiting_for_user' })
    }
    const latestRun = await this.runStore.read(input.runtimeRoot) ?? input.run
    const runChanged = latestRun.status !== 'waiting_for_user' || latestRun.currentStageId !== input.approval.stageId
    const updatedRun = runChanged
      ? await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'waiting_for_user', currentStageId: input.approval.stageId })
      : latestRun
    if (!stageChanged && !runChanged) {
      return
    }
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
    if (input.approval.status === 'approved') {
      const stage = (await this.stageStore.read(input.runtimeRoot)).find((candidate) => candidate.stageId === input.approval.stageId)
      if (!stage) {
        throw new Error(`Team stage not found: ${input.approval.stageId}`)
      }
      const stageChanged = stage.status === 'waiting_for_user'
      if (stageChanged) {
        await this.stageStore.resumeWaitingStage({ runtimeRoot: input.runtimeRoot, stageId: input.approval.stageId })
      } else if (stage.status !== 'running') {
        throw new Error(`Team stage is not resumable: ${input.approval.stageId}`)
      }
      const latestRun = await this.runStore.read(input.runtimeRoot) ?? input.run
      const runChanged = latestRun.status !== 'running' || latestRun.currentStageId !== input.approval.stageId
      const updatedRun = runChanged
        ? await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'running', currentStageId: input.approval.stageId })
        : latestRun
      if (!stageChanged && !runChanged) {
        return
      }
      await this.appendApprovalResolvedEvent({ runtimeRoot: input.runtimeRoot, run: updatedRun, approval: input.approval, decision: input.decision, idempotencyKey: input.idempotencyKey })
      await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: updatedRun, reason: 'approval:resolved' })
      return
    }

    const stage = (await this.stageStore.read(input.runtimeRoot)).find((candidate) => candidate.stageId === input.approval.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.approval.stageId}`)
    }
    const stageChanged = stage.status !== 'failed'
    if (stageChanged) {
      await this.stageStore.updateStatus({ runtimeRoot: input.runtimeRoot, stageId: input.approval.stageId, status: 'failed' })
    }
    const latestRun = await this.runStore.read(input.runtimeRoot) ?? input.run
    const runChanged = latestRun.status !== 'failed' || latestRun.currentStageId !== input.approval.stageId
    const updatedRun = runChanged
      ? await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'failed', currentStageId: input.approval.stageId })
      : latestRun
    if (!stageChanged && !runChanged) {
      return
    }
    await this.appendApprovalResolvedEvent({ runtimeRoot: input.runtimeRoot, run: updatedRun, approval: input.approval, decision: input.decision, idempotencyKey: input.idempotencyKey })
    await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: updatedRun, reason: 'approval:resolved' })
  }

  private async reconcileExistingGate(input: {
    runtimeRoot: string
    run: TeamRun
    gate: TeamGateResult
    idempotencyKey: string
  }): Promise<void> {
    const stage = (await this.stageStore.read(input.runtimeRoot)).find((candidate) => candidate.stageId === input.gate.stageId)
    if (!stage) {
      throw new Error(`Team stage not found: ${input.gate.stageId}`)
    }
    if (!stage.outputArtifactIds.includes(input.gate.artifactId) && stage.status !== 'passed' && stage.status !== 'waiting_for_user') {
      await this.applyGateTransition({ runtimeRoot: input.runtimeRoot, run: input.run, gate: input.gate, idempotencyKey: input.idempotencyKey })
      return
    }
    await this.reconcileGateRunCursor({ runtimeRoot: input.runtimeRoot, run: input.run, gate: input.gate })
  }

  private async applyGateTransition(input: {
    runtimeRoot: string
    run: TeamRun
    gate: TeamGateResult
    idempotencyKey: string
  }): Promise<void> {
    const transition = await this.stageStore.applyGateTransition({
      runtimeRoot: input.runtimeRoot,
      stageId: input.gate.stageId,
      artifactId: input.gate.artifactId,
      passed: input.gate.passed,
    })
    const transitionedRun = await this.reconcileGateRunCursor({ runtimeRoot: input.runtimeRoot, run: input.run, gate: input.gate })
    if (transition.changed) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: transitionedRun.revision,
        type: 'stage:gate_transitioned',
        payload: {
          stageId: transition.stage.stageId,
          status: transition.stage.status,
          nextStageId: transition.nextStage?.stageId ?? null,
          nextStageStatus: transition.nextStage?.status ?? null,
          exhausted: transition.exhausted,
          completed: transition.completed,
          gateId: input.gate.gateId,
          artifactId: input.gate.artifactId,
        },
      })
      if (transition.completed) {
        await this.eventStore.append({
          runtimeRoot: input.runtimeRoot,
          runId: transitionedRun.runId,
          revision: transitionedRun.revision,
          type: 'run:completed',
          payload: { stageId: transition.stage.stageId, idempotencyKey: input.idempotencyKey },
        })
      }
      if (!input.gate.passed) {
        const kickback = await this.kickbackStore.save({
          runtimeRoot: input.runtimeRoot,
          runId: input.run.runId,
          stageId: input.gate.stageId,
          gateId: input.gate.gateId,
          failureItems: input.gate.failureItems,
          idempotencyKey: `${input.idempotencyKey}:kickback`,
        })
        if (kickback.created) {
          await this.eventStore.append({
            runtimeRoot: input.runtimeRoot,
            runId: input.run.runId,
            revision: input.run.revision,
            type: 'kickback:issued',
            payload: {
              kickbackId: kickback.kickback.kickbackId,
              stageId: kickback.kickback.stageId,
              gateId: kickback.kickback.gateId,
              failureItems: kickback.kickback.failureItems,
            },
          })
        }
      }
      await this.projectTeamRun({ runtimeRoot: input.runtimeRoot, run: transitionedRun, reason: 'stage:gate_transitioned' })
    }
  }

  private async reconcileGateRunCursor(input: { runtimeRoot: string; run: TeamRun; gate: TeamGateResult }): Promise<TeamRun> {
    const stages = await this.stageStore.read(input.runtimeRoot)
    const stageIndex = stages.findIndex((stage) => stage.stageId === input.gate.stageId)
    if (stageIndex < 0) {
      throw new Error(`Team stage not found: ${input.gate.stageId}`)
    }
    const stage = stages[stageIndex]
    const nextStage = stages[stageIndex + 1]
    const expectedStatus: TeamRunStatus = input.gate.passed
      ? nextStage ? 'running' : 'completed'
      : stage.status === 'waiting_for_user' ? 'waiting_for_user' : 'running'
    const expectedCurrentStageId = input.gate.passed && nextStage ? nextStage.stageId : stage.stageId
    const latestRun = await this.runStore.read(input.runtimeRoot) ?? input.run
    if (latestRun.status === expectedStatus && latestRun.currentStageId === expectedCurrentStageId) {
      return latestRun
    }
    return await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: expectedStatus, currentStageId: expectedCurrentStageId })
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

  private async cancelActiveDispatchSessions(input: { executions: TeamDispatchExecutionRecord[]; reason: string }): Promise<void> {
    if (!this.roleSessionExecution) {
      const cancellable = input.executions.filter((execution) => execution.childSessionKey)
      if (cancellable.length > 0) {
        throw new Error('TeamRun cancellation requires role session execution cleanup')
      }
      return
    }
    for (const execution of input.executions) {
      const result = await this.roleSessionExecution.cancelDispatchExecution({ execution, reason: input.reason })
      if (!result.cancelled && execution.childSessionKey) {
        throw new Error(result.reason || `Team dispatch execution child session was not cancelled: ${execution.executionRecordId}`)
      }
    }
  }

  private async advancePipelineFromCurrentStage(input: { runId: string; idempotencyKey: string }): Promise<void> {
    for (let step = 0; step < 16; step += 1) {
      const result = await this.tick({ runId: input.runId, idempotencyKey: `${input.idempotencyKey}:${step}` })
      if (result.action !== 'stage_completed') {
        return
      }
    }
    throw new Error(`TeamRun pipeline advance exceeded safety bound: ${input.runId}`)
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
    if (input.run.currentStageId) {
      await this.stageStore.updateStatus({ runtimeRoot: input.runtimeRoot, stageId: input.run.currentStageId, status: 'failed' })
    }
    const failedRun = await this.runStore.update({ runtimeRoot: input.runtimeRoot, status: 'failed' })
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
    stages: TeamStage[]
    approvals: TeamApproval[]
    artifacts: TeamArtifact[]
    dispatches: TeamDispatchEnvelope[]
    dispatchExecutions: TeamDispatchExecutionRecord[]
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
    const stages = await this.stageStore.read(input.runtimeRoot)
    if (this.taskFlowProjection) {
      try {
        await this.taskFlowProjection.projectTeamRun({ run: input.run, stages, reason: input.reason })
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
        await this.taskManagerProjection.projectTeamRun({ run: input.run, stages, reason: input.reason })
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
        payload: { stageId: input.stage.stageId, roleId: input.roleId, status: input.status },
      })
    } catch (error) {
      await this.eventStore.append({
        runtimeRoot: input.runtimeRoot,
        runId: input.run.runId,
        revision: input.run.revision,
        type: 'projection:taskFlow:task_update_failed',
        payload: { stageId: input.stage.stageId, roleId: input.roleId, status: input.status, error: error instanceof Error ? error.message : String(error) },
      })
    }
  }
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, '_')
}

function artifactIdsForDispatch(input: { stages: TeamStage[]; stageIndex: number; stageInputArtifactIds: string[] }): string[] {
  const artifactIds = input.stageInputArtifactIds.length > 0
    ? input.stageInputArtifactIds
    : input.stages.slice(0, Math.max(input.stageIndex, 0)).flatMap((stage) => stage.outputArtifactIds)
  return Array.from(new Set(artifactIds))
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
