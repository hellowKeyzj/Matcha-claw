import { accepted, badRequest, ok, type ApplicationResponseOf } from '../common/application-response';
import type { RuntimeEndpointRef, RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { TeamRuntimeOperationId } from './team-runtime-operation-id';
import type { TeamFailureItem, TeamInboundEnvelope, TeamMessageKind, TeamWorkflowGroupPlan, TeamWorkflowTaskPlan } from './domain/team-envelope';
import type { TeamEvidenceRef } from './domain/team-evidence';
import type { TeamMail, TeamMailKind, TeamMailRelatedEntity } from './domain/team-mail';
import type { TeamOutboxRecord } from './domain/team-outbox';
import type { TeamRoleSessionBinding, TeamRunStatus } from './domain/team-run';
import {
  buildTeamRoleSessionBindingsFromManagedAgents,
  collectTeamManagedAgentIds,
  type TeamInstance,
  type TeamInstanceRunRecord,
  type TeamManagedAgentRecord,
} from './domain/team-instance';
import type { TeamAgentMaterializationPort, TeamRoleAgentMaterializationSpec } from './ports/team-agent-materialization-port';
import type { TeamIngressPort } from './ports/team-ingress-port';
import type { TeamMailDeliveryPort } from './ports/team-mail-delivery-port';
import type { TeamRoleSessionPort } from './ports/team-role-session-port';
import type { TeamRuntimeJobPort } from './team-runtime-jobs';
import type { TeamRuntimePort } from './team-runtime-port';
import type { TeamRuntimeStateStore } from './team-runtime-state-store';
import { isTeamRuntimeDebugLoggingEnabled } from './team-runtime-debug-logging';
import { TeamRunRegistry, isTerminalTeamRunStatus } from './team-run-registry';
import { buildTeamDependencyPlan } from './team-dependency-plan';

export interface TeamRuntimePackagePort {
  validate(packagePath: string): Promise<{
    valid: boolean;
    package?: {
      name: string;
      version: string;
      description: string;
      sourcePath: string;
      roles: Array<{ id: string; purpose: string; skills: string[]; tools: string[]; agentsMd: string }>;
      skill: { markdown: string };
      workflow: { markdown: string };
      bind?: { markdown: string };
      dependencies: { skills: unknown[]; tools: unknown[]; yaml: string };
    };
    errors: unknown[];
    warnings: unknown[];
  }>;
}

export interface TeamSkillCatalogPort {
  snapshot(): Promise<unknown>;
}

export interface TeamRuntimeServiceDeps {
  readonly ingress: TeamIngressPort;
  readonly stateStore?: TeamRuntimeStateStore;
  readonly packageService?: TeamRuntimePackagePort;
  readonly skillCatalog?: TeamSkillCatalogPort;
  readonly agentMaterialization?: TeamAgentMaterializationPort;
  readonly roleSessions?: TeamRoleSessionPort;
  readonly mailDelivery?: TeamMailDeliveryPort;
  readonly jobs?: TeamRuntimeJobPort;
  readonly nowMs?: () => number;
  readonly randomId?: () => string;
  readonly shardCount?: number;
}

type TeamApprovalStatus = 'pending' | 'approved' | 'denied' | 'aborted';
type TeamDecisionType = 'retry' | 'proceed_degraded' | 'abort';
type TeamDispatchTaskStatus = 'queued' | 'completed' | 'failed' | 'cancelled' | 'stale';
type TeamGateStatus = 'open' | 'passed' | 'failed';

type TeamRunRecord = {
  teamId?: string;
  runId: string;
  status: TeamRunStatus;
  revision: number;
  packageName: string;
  packageVersion: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
};

type TeamRunSnapshot = {
  run: TeamRunRecord | null;
  roles: TeamRoleSessionBinding[];
  stages: unknown[];
  workflowPlan: TeamWorkflowPlanProjection | null;
  dispatchGroups: TeamDispatchGroupProjection[];
  dispatchTasks: TeamDispatchTaskProjection[];
  approvals: TeamApprovalProjection[];
  artifacts: TeamArtifactProjection[];
  dispatches: TeamDispatchProjection[];
  dispatchExecutions: TeamDispatchExecutionProjection[];
  messages: TeamMessageProjection[];
  mails: TeamMail[];
  gates: TeamGateProjection[];
  kickbacks: TeamKickbackProjection[];
  decisions: TeamDecisionProjection[];
  diagnostics: TeamRunDiagnosticsProjection;
  events: TeamEventProjection[];
  nextEventCursor: number;
};

type TeamWorkflowPlanProjection = {
  workflowPlanId: string;
  runId: string;
  title: string;
  summary?: string;
  status: 'planned';
  groups: TeamWorkflowGroupPlan[];
  tasks: Array<TeamWorkflowTaskPlan & { dependsOnTaskIds: readonly string[] }>;
  idempotencyKey: string;
  createdAt: number;
};

type TeamDispatchGroupProjection = {
  dispatchGroupId: string;
  runId: string;
  workflowPlanId: string;
  groupId: string;
  taskIds: readonly string[];
  status: 'queued' | 'completed' | 'failed';
  idempotencyKey: string;
  createdAt: number;
  completedAt?: number;
};

type TeamDispatchTaskProjection = {
  dispatchTaskId: string;
  runId: string;
  workflowPlanId: string;
  dispatchGroupId: string;
  groupId: string;
  taskId: string;
  roleId: string;
  dispatchId: string;
  status: TeamDispatchTaskStatus;
  idempotencyKey: string;
  createdAt: number;
  completedAt?: number;
  artifactId?: string;
  statusReason?: string;
};

type TeamDispatchProjection = {
  dispatchId: string;
  runId: string;
  stageId: string;
  roleId: string;
  promptRef: string;
  inputArtifactIds: string[];
  kickbackIds: string[];
  idempotencyKey: string;
  createdAt: number;
  workflowPlanId?: string;
  dispatchGroupId?: string;
  groupId?: string;
  taskId?: string;
};

type TeamDispatchExecutionProjection = {
  executionRecordId: string;
  runId: string;
  dispatchId: string;
  stageId: string;
  roleId: string;
  executionId?: string;
  childSessionKey?: string;
  spawnMode?: 'session';
  status: 'claimed' | 'queued' | 'completed' | 'failed' | 'stale' | 'cancelled';
  statusReason?: string;
  idempotencyKey: string;
  createdAt: number;
};

type TeamApprovalProjection = {
  approvalId: string;
  runId: string;
  stageId: string;
  roleId: string;
  reason: string;
  requestedAction: string;
  risk: string;
  status: TeamApprovalStatus;
  note?: string;
  idempotencyKey: string;
  createdAt: number;
  resolvedAt?: number;
};

type TeamMessageProjection = {
  messageId: string;
  runId: string;
  kind: TeamMessageKind;
  fromRoleId: string;
  toRoleId: string;
  summary: string;
  body: string;
  relatedTaskId?: string;
  relatedArtifactId?: string;
  relatedGateId?: string;
  failureItems: TeamFailureItem[];
  idempotencyKey: string;
  createdAt: number;
};

type TeamArtifactProjection = {
  artifactId: string;
  runId: string;
  stageId: string;
  roleId: string;
  kind: string;
  title: string;
  contentRef: string;
  summary?: string;
  evidenceRefs: TeamEvidenceRef[];
  sourceEnvelopeId: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt?: number;
  relatedTaskId?: string;
  relatedGateId?: string;
};

type TeamGateProjection = {
  gateId: string;
  runId: string;
  stageId: string;
  gateType: string;
  subjectArtifactId?: string;
  relatedTaskId?: string;
  blocking: boolean;
  summary: string;
  verdict?: string;
  passed?: boolean;
  status: TeamGateStatus;
  failureItems: TeamFailureItem[];
  idempotencyKey: string;
  createdAt: number;
  resolvedAt?: number;
  resolutionSummary?: string;
};

type TeamKickbackProjection = {
  kickbackId: string;
  runId: string;
  stageId: string;
  fromRoleId: string;
  toRoleId: string;
  gateId?: string;
  artifactId?: string;
  taskId?: string;
  failureItems: TeamFailureItem[];
  messageId: string;
  idempotencyKey: string;
  createdAt: number;
  resolvedAt?: number;
};

type TeamDecisionProjection = {
  decisionId: string;
  runId: string;
  stageId: string;
  decision: TeamDecisionType;
  note?: string;
  idempotencyKey: string;
  createdAt: number;
};

type TeamEventProjection = {
  eventId: string;
  runId: string;
  revision: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
};

type TeamRunDiagnosticsProjection = {
  runId: string;
  recoveredFromStorage: boolean;
  storageRoot: string;
  budgets: {
    roleWallClockBudgetMs: Record<string, number>;
    roleTokenBudget: Record<string, number>;
    wallClockExceeded: boolean;
  };
  limits: {
    maxArtifactContentBytes: number;
    maxMessageBodyBytes: number;
    staleDispatchExecutionMs: number;
  };
  staleDispatchExecutions: TeamDispatchExecutionProjection[];
  counts: Record<string, number>;
};

type RunActorState = {
  run: TeamRunRecord | null;
  roleBindings: TeamRoleSessionBinding[];
  workflowPlan: TeamWorkflowPlanProjection | null;
  dispatchGroups: TeamDispatchGroupProjection[];
  dispatchTasks: TeamDispatchTaskProjection[];
  dispatches: TeamDispatchProjection[];
  dispatchExecutions: TeamDispatchExecutionProjection[];
  approvals: TeamApprovalProjection[];
  artifacts: TeamArtifactProjection[];
  messages: TeamMessageProjection[];
  mails: TeamMail[];
  gates: TeamGateProjection[];
  kickbacks: TeamKickbackProjection[];
  decisions: TeamDecisionProjection[];
  events: TeamEventProjection[];
  processedIdempotencyKeys: Set<string>;
  acknowledgedOutboxSequence: number;
};

const DEFAULT_SHARD_COUNT = 4;
const OUTBOX_PULL_LIMIT = 100;
const MAX_OUTBOX_BATCHES_PER_TICK = 2;
const OUTBOX_LEASE_MS = 60_000;
const TEAM_RUNTIME_CONSUMER_PREFIX = 'runtime-host-team-runtime';
const TEAM_MAIL_MAX_ATTEMPTS = 3;
const TEAM_MAIL_RETRY_DELAY_MS = 30_000;
const TEAM_DISPATCH_MAX_ACTIVE_ROLE_PROMPTS = 2;
const TEAM_RUNTIME_SERVICE_LOG_NAMESPACE = '[team-runtime:service]';
const LOG_TEXT_LIMIT = 240;

function sanitizeLogText(value: string): string {
  const redacted = value
    .replace(/(api[_-]?key|authorization|token|password|secret)(["'\s:=]+)[^"'\s,}]+/gi, '$1$2[redacted]')
    .replace(/(^|[^A-Za-z0-9_-])(sk-[A-Za-z0-9_-]{20,})/g, '$1sk-[redacted]');
  return redacted.length <= LOG_TEXT_LIMIT ? redacted : `${redacted.slice(0, LOG_TEXT_LIMIT)}…`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return sanitizeLogText(error.message);
  }
  return sanitizeLogText(String(error));
}

function logTeamRuntimeServiceInfo(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.info(`${TEAM_RUNTIME_SERVICE_LOG_NAMESPACE} ${event} ${JSON.stringify(fields)}`);
  }
}

function logTeamRuntimeServiceError(event: string, fields: Record<string, unknown>): void {
  if (isTeamRuntimeDebugLoggingEnabled()) {
    console.error(`${TEAM_RUNTIME_SERVICE_LOG_NAMESPACE} ${event} ${JSON.stringify(fields)}`);
  }
}

export class TeamRuntimeService implements TeamRuntimePort {
  readonly runRegistry: TeamRunRegistry;
  private readonly router: TeamRuntimeRouter;

  constructor(deps: TeamRuntimeServiceDeps) {
    this.runRegistry = new TeamRunRegistry();
    this.router = new TeamRuntimeRouter(deps, this.runRegistry);
  }

  async invoke(operationId: TeamRuntimeOperationId, params: unknown, scope?: RuntimeScope): Promise<ApplicationResponseOf> {
    switch (operationId) {
      case 'team.packageValidate':
        return await this.validatePackage(params);
      case 'team.dependencyPlan':
        return await this.planDependencies(params);
      case 'team.provisionAgents':
        return ok(await this.router.provisionAgents(params, scope));
      case 'team.delete':
        return ok(await this.router.deleteTeam(params, scope));
      case 'team.runCreate':
        return ok(await this.router.forCreateInput(params).createRun(params));
      case 'team.runList':
        return ok(await this.router.listRuns(params));
      case 'team.runSnapshot':
        return ok(await this.router.forInput(params).readSnapshot(params));
      case 'team.runDiagnostics':
        return ok((await this.router.forInput(params).readSnapshot(params)).diagnostics);
      case 'team.runDecisionSubmit':
        return ok(await this.router.forInput(params).submitDecision(params));
      case 'team.planWorkflow':
        return ok(await this.router.forInput(params).submitWorkflowPlan(params, scope));
      case 'team.runTick':
        return ok(await this.router.forInput(params).drainOutbox(params));
      case 'team.resume':
        return ok(await this.router.resumeTeam(params));
      case 'team.approvalResolve':
        return ok(await this.router.forInput(params).resolveApproval(params));
      case 'team.runCancel':
        return ok(await this.router.forInput(params).cancelRun(params));
      case 'team.runDelete':
        return ok(await this.router.forInput(params).deleteRun(params));
    }
  }

  private async validatePackage(params: unknown): Promise<ApplicationResponseOf> {
    const packagePath = readString(readRecord(params).packagePath);
    if (!packagePath) return badRequest('packagePath is required');
    if (!this.router.packageService) return missingPackagePort('TEAM_PACKAGE_VALIDATION_PORT_NOT_CONFIGURED', packagePath);
    return ok(await this.router.packageService.validate(packagePath));
  }

  private async planDependencies(params: unknown): Promise<ApplicationResponseOf> {
    const packagePath = readString(readRecord(params).packagePath);
    if (!packagePath) return badRequest('packagePath is required');
    if (!this.router.packageService) return missingPackagePort('TEAM_DEPENDENCY_PLAN_PORT_NOT_CONFIGURED', packagePath);
    const validation = await this.router.packageService.validate(packagePath);
    if (!validation.valid || !validation.package) {
      return ok({
        packageName: '',
        packageVersion: '',
        sourcePath: packagePath,
        items: [],
        missingRequiredSkills: [],
        missingOptionalSkills: [],
        missingRequiredTools: [],
        missingOptionalTools: [],
        canProceed: false,
        validation,
      });
    }
    if (!this.router.skillCatalog) return missingPackagePort('TEAM_SKILL_CATALOG_PORT_NOT_CONFIGURED', packagePath);
    const skillCatalog = await this.router.skillCatalog.snapshot();
    return ok(buildTeamDependencyPlan({
      packageName: validation.package.name,
      packageVersion: validation.package.version,
      sourcePath: validation.package.sourcePath,
      skills: validation.package.dependencies.skills,
      tools: validation.package.dependencies.tools,
      skillCatalog,
    }));
  }
}

class TeamRuntimeRouter {
  readonly packageService?: TeamRuntimePackagePort;
  readonly skillCatalog?: TeamSkillCatalogPort;
  private readonly teamInstances: TeamInstanceRegistry;
  private readonly shards: TeamRuntimeShardWorker[];

  constructor(private readonly deps: TeamRuntimeServiceDeps, private readonly runRegistry: TeamRunRegistry) {
    this.packageService = deps.packageService;
    this.skillCatalog = deps.skillCatalog;
    this.teamInstances = new TeamInstanceRegistry({
      stateStore: deps.stateStore,
      agentMaterialization: deps.agentMaterialization,
      jobs: deps.jobs,
      nowMs: deps.nowMs ?? Date.now,
    });
    const shardCount = Math.max(1, Math.floor(deps.shardCount ?? DEFAULT_SHARD_COUNT));
    this.shards = Array.from({ length: shardCount }, (_, shardIndex) => new TeamRuntimeShardWorker({
      shardIndex,
      ingress: deps.ingress,
      teamInstances: this.teamInstances,
      stateStore: deps.stateStore,
      packageService: deps.packageService,
      agentMaterialization: deps.agentMaterialization,
      roleSessions: deps.roleSessions,
      mailDelivery: deps.mailDelivery,
      runRegistry: this.runRegistry,
      nowMs: deps.nowMs ?? Date.now,
      randomId: deps.randomId ?? (() => crypto.randomUUID()),
    }));
  }

  forInput(params: unknown): RunActor {
    const runId = readString(readRecord(params).runId);
    if (!runId) throw new Error('runId is required');
    return this.forRun(runId);
  }

  forCreateInput(params: unknown): RunActor {
    const record = readRecord(params);
    return this.forRun(readString(record.runId) ?? createTeamRunId((this.deps.randomId ?? (() => crypto.randomUUID()))()));
  }

  async provisionAgents(params: unknown, scope?: RuntimeScope): Promise<{ teamId: string; managedAgentCount: number }> {
    const input = readRecord(params);
    const packagePath = requireString(input, 'packagePath');
    const validation = this.deps.packageService ? await this.deps.packageService.validate(packagePath) : null;
    if (validation && !validation.valid) {
      throw new Error(`TeamSkill package is invalid: ${JSON.stringify(validation.errors)}`);
    }
    if (!validation?.package) {
      throw new Error('TeamSkill package is required to provision Team managed agents');
    }
    if (!this.deps.agentMaterialization) {
      throw new Error('Team agent materialization is required to provision Team managed agents');
    }
    if (!scope || !('endpoint' in scope)) {
      throw new Error('Runtime endpoint is required to provision Team managed agents');
    }
    requireString(input, 'idempotencyKey');

    const teamId = readString(input.teamId) ?? validation.package.name;
    return await this.teamInstances.provisionAgents({
      teamId,
      packagePath,
      teamPackage: validation.package,
      endpoint: scope.endpoint,
    });
  }

  async deleteTeam(params: unknown, scope?: RuntimeScope): Promise<{ teamId: string; deleted: boolean; deletedRunIds: string[]; deletedAgentIds: string[] }> {
    const teamId = requireString(readRecord(params), 'teamId');
    const teamInstance = await this.teamInstances.readTeamInstance(teamId);
    if (!teamInstance) {
      return { teamId, deleted: false, deletedRunIds: [], deletedAgentIds: [] };
    }
    const deletedRunIds: string[] = [];
    for (const run of teamInstance.runs) {
      await this.forRun(run.runId).deleteRunState({ updateTeamInstance: false, deleteRoleSessions: false });
      await this.deleteTeamRunRoleSessions(run.sessions);
      deletedRunIds.push(run.runId);
    }
    const deletedAgentIds = await this.teamInstances.enqueueDeleteTeamAgents(teamInstance, scope);
    await this.teamInstances.deleteTeamInstance(teamId);
    this.runRegistry.removeTeam(teamId);
    return { teamId, deleted: true, deletedRunIds, deletedAgentIds };
  }

  private async deleteTeamRunRoleSessions(sessions: readonly TeamRoleSessionBinding[]): Promise<void> {
    if (!this.deps.roleSessions) return;
    for (const binding of sessions) {
      await this.deps.roleSessions.deleteRoleSession({ binding });
    }
  }

  async listRuns(params: unknown): Promise<{ teamId: string; runs: TeamInstanceRunRecord[] }> {
    const teamId = requireString(readRecord(params), 'teamId');
    const teamInstance = await this.teamInstances.readTeamInstance(teamId);
    return {
      teamId,
      runs: [...(teamInstance?.runs ?? [])].sort((left, right) => right.updatedAt - left.updatedAt),
    };
  }

  async resumeTeam(params: unknown): Promise<{ success: true; teamId: string; restoredRunIds: string[]; activeRunIds: string[]; skippedTerminalRunIds: string[] }> {
    const input = readRecord(params);
    const teamId = requireString(input, 'teamId');
    requireString(input, 'idempotencyKey');
    const teamInstance = await this.teamInstances.readTeamInstance(teamId);
    const restoredRunIds: string[] = [];
    const activeRunIds: string[] = [];
    const skippedTerminalRunIds: string[] = [];
    for (const runRecord of teamInstance?.runs ?? []) {
      const run = await this.forRun(runRecord.runId).loadRunState();
      const effectiveRun = run ?? runRecord;
      this.runRegistry.upsert(toTeamRunRegistryRecord(effectiveRun));
      restoredRunIds.push(runRecord.runId);
      if (isTerminalTeamRunStatus(effectiveRun.status)) {
        skippedTerminalRunIds.push(runRecord.runId);
      } else {
        activeRunIds.push(runRecord.runId);
      }
    }
    return { success: true, teamId, restoredRunIds, activeRunIds, skippedTerminalRunIds };
  }

  private forRun(runId: string): RunActor {
    return this.shards[stableHash(runId) % this.shards.length]!.actorFor(runId);
  }
}

class TeamInstanceRegistry {
  private readonly memoryTeamInstances = new Map<string, TeamInstance>();

  constructor(private readonly deps: {
    readonly stateStore?: TeamRuntimeStateStore;
    readonly agentMaterialization?: TeamAgentMaterializationPort;
    readonly jobs?: TeamRuntimeJobPort;
    readonly nowMs: () => number;
  }) {}

  async readTeamInstance(teamId: string): Promise<TeamInstance | null> {
    const stored = await this.deps.stateStore?.readTeamInstance(teamId);
    if (stored) return deserializeTeamInstance(stored);
    return this.memoryTeamInstances.get(teamId) ?? null;
  }

  async requireTeamInstance(teamId: string): Promise<TeamInstance> {
    const teamInstance = await this.readTeamInstance(teamId);
    if (!teamInstance) {
      throw new Error(`Team managed agents must be provisioned before creating TeamRun: ${teamId}`);
    }
    return teamInstance;
  }

  async provisionAgents(input: {
    readonly teamId: string;
    readonly packagePath: string;
    readonly teamPackage: NonNullable<Awaited<ReturnType<TeamRuntimePackagePort['validate']>>['package']>;
    readonly endpoint: RuntimeEndpointRef;
  }): Promise<{ teamId: string; managedAgentCount: number }> {
    if (!this.deps.agentMaterialization) {
      throw new Error('Team agent materialization is required to provision Team managed agents');
    }
    const leaderSpec = buildLeaderMaterializationSpec(input.teamPackage);
    const roleSpecs = input.teamPackage.roles.map((role) => buildRoleMaterializationSpec(input.teamPackage, role));
    const materialized = await this.deps.agentMaterialization.materialize({
      teamId: input.teamId,
      endpoint: input.endpoint,
      teamSkill: {
        name: input.teamPackage.name,
        skillMarkdown: input.teamPackage.skill.markdown,
        workflowMarkdown: input.teamPackage.workflow.markdown,
        dependenciesYaml: input.teamPackage.dependencies.yaml,
        dependencies: {
          skills: input.teamPackage.dependencies.skills,
          tools: input.teamPackage.dependencies.tools,
        },
        ...(input.teamPackage.bind ? { bindMarkdown: input.teamPackage.bind.markdown } : {}),
      },
      leader: leaderSpec,
      roles: roleSpecs,
    });
    const now = this.deps.nowMs();
    const existing = await this.readTeamInstance(input.teamId);
    const instance: TeamInstance = {
      teamId: input.teamId,
      teamSkillName: input.teamPackage.name,
      teamSkillVersion: input.teamPackage.version,
      packagePath: input.packagePath,
      sourcePath: input.teamPackage.sourcePath,
      managedAgents: materialized.managedAgents.map((agent) => ({ ...agent })),
      runs: existing?.runs ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.memoryTeamInstances.set(input.teamId, instance);
    await this.deps.stateStore?.writeTeamInstance(input.teamId, instance);
    return { teamId: input.teamId, managedAgentCount: materialized.managedAgents.length };
  }

  async upsertRun(input: {
    readonly run: TeamRunRecord;
    readonly sessions: readonly TeamRoleSessionBinding[];
  }): Promise<void> {
    const now = this.deps.nowMs();
    const existing = await this.requireTeamInstance(input.run.teamId ?? input.run.packageName);
    const teamId = input.run.teamId ?? input.run.packageName;
    const runRecord: TeamInstanceRunRecord = {
      teamId,
      runId: input.run.runId,
      status: input.run.status,
      revision: input.run.revision,
      packageName: input.run.packageName,
      packageVersion: input.run.packageVersion,
      sourcePath: input.run.sourcePath,
      sessions: input.sessions.map((session) => ({ ...session })),
      createdAt: input.run.createdAt,
      updatedAt: input.run.updatedAt,
    };
    const instance: TeamInstance = {
      teamId,
      teamSkillName: input.run.packageName,
      teamSkillVersion: input.run.packageVersion,
      packagePath: existing.packagePath,
      sourcePath: input.run.sourcePath,
      managedAgents: existing.managedAgents,
      runs: upsertTeamInstanceRun(existing?.runs ?? [], runRecord),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.memoryTeamInstances.set(teamId, instance);
    await this.deps.stateStore?.writeTeamInstance(teamId, instance);
  }

  async removeRun(teamId: string | undefined, runId: string): Promise<void> {
    if (!teamId) return;
    const existing = await this.readTeamInstance(teamId);
    if (!existing) return;
    const nextRuns = existing.runs.filter((run) => run.runId !== runId);
    if (nextRuns.length === existing.runs.length) return;
    const nextInstance = {
      ...existing,
      runs: nextRuns,
      updatedAt: this.deps.nowMs(),
    };
    this.memoryTeamInstances.set(teamId, nextInstance);
    await this.deps.stateStore?.writeTeamInstance(teamId, nextInstance);
  }

  async enqueueDeleteTeamAgents(teamInstance: TeamInstance, scope?: RuntimeScope): Promise<string[]> {
    const agentIds = collectTeamManagedAgentIds(teamInstance.managedAgents);
    if (agentIds.length === 0) {
      return [];
    }
    if (!this.deps.jobs) {
      throw new Error('Team runtime jobs are required to delete managed Team agents');
    }
    const endpoint = scope && 'endpoint' in scope ? scope.endpoint : teamInstance.managedAgents[0]?.endpoint;
    if (!endpoint) {
      throw new Error(`Team endpoint is required to delete managed agents for team ${teamInstance.teamId}`);
    }
    await this.deps.jobs.submitDeleteManagedAgents({
      teamId: teamInstance.teamId,
      endpoint,
      agentIds,
      workspacePaths: collectTeamManagedAgentWorkspaces(teamInstance.managedAgents),
    });
    return agentIds;
  }

  async deleteTeamInstance(teamId: string): Promise<void> {
    this.memoryTeamInstances.delete(teamId);
    await this.deps.stateStore?.deleteTeamInstance(teamId);
  }
}

class TeamRuntimeShardWorker {
  private readonly actors = new Map<string, RunActor>();

  constructor(private readonly deps: RunActorDeps & { readonly shardIndex: number }) {}

  actorFor(runId: string): RunActor {
    const existing = this.actors.get(runId);
    if (existing) return existing;
    const actor = new RunActor({ ...this.deps, runId });
    this.actors.set(runId, actor);
    return actor;
  }
}

type RunActorDeps = {
  readonly runId?: string;
  readonly shardIndex?: number;
  readonly ingress: TeamIngressPort;
  readonly teamInstances: TeamInstanceRegistry;
  readonly stateStore?: TeamRuntimeStateStore;
  readonly packageService?: TeamRuntimePackagePort;
  readonly agentMaterialization?: TeamAgentMaterializationPort;
  readonly roleSessions?: TeamRoleSessionPort;
  readonly mailDelivery?: TeamMailDeliveryPort;
  readonly runRegistry: TeamRunRegistry;
  readonly nowMs: () => number;
  readonly randomId: () => string;
};

class RunActor {
  private queuedWork: Promise<void> = Promise.resolve();
  private loaded = false;
  private readonly state: RunActorState = emptyRunActorState();

  constructor(private readonly deps: Required<Pick<RunActorDeps, 'runId' | 'shardIndex' | 'ingress' | 'nowMs' | 'randomId'>> & Omit<RunActorDeps, 'runId' | 'shardIndex' | 'ingress' | 'nowMs' | 'randomId'>) {}

  createRun(params: unknown): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const packagePath = requireString(input, 'packagePath');
      const runId = readString(input.runId) ?? this.deps.runId;
      const validation = this.deps.packageService ? await this.deps.packageService.validate(packagePath) : null;
      if (validation && !validation.valid) {
        throw new Error(`TeamSkill package is invalid: ${JSON.stringify(validation.errors)}`);
      }
      const now = this.deps.nowMs();
      const teamId = readString(input.teamId) ?? validation?.package?.name ?? (lastPathSegment(packagePath) || 'team-skill');
      if (!this.state.run) {
        this.state.run = {
          teamId,
          runId,
          status: 'created',
          revision: 1,
          packageName: validation?.package?.name ?? (lastPathSegment(packagePath) || 'team-skill'),
          packageVersion: validation?.package?.version ?? '0.0.0',
          sourcePath: validation?.package?.sourcePath ?? packagePath,
          createdAt: now,
          updatedAt: now,
        };
      }
      if (validation?.package) {
        const leaderSpec = buildLeaderMaterializationSpec(validation.package);
        const roleSpecs = validation.package.roles.map((role) => buildRoleMaterializationSpec(validation.package!, role));
        const managedAgents = selectManagedAgentsForRoles(
          (await this.deps.teamInstances.requireTeamInstance(this.state.run.teamId ?? teamId)).managedAgents,
          [leaderSpec, ...roleSpecs],
        );
        this.state.roleBindings = buildTeamRoleSessionBindingsFromManagedAgents({ teamId: this.state.run.teamId ?? teamId, runId, managedAgents });
        await this.deps.teamInstances.upsertRun({
          run: this.state.run,
          sessions: this.state.roleBindings,
        });
      }
      await this.flushState();
      return this.runSummary();
    });
  }

  cancelRun(params: unknown): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      requireString(input, 'idempotencyKey');
      this.ensureRun();
      await this.abortRunRoleSessions();
      this.updateRun({ status: 'cancelled' });
      await this.flushState();
      return this.runSummary();
    });
  }

  deleteRun(_params: unknown): Promise<{ runId: string; deleted: boolean }> {
    return this.deleteRunState({ updateTeamInstance: true, deleteRoleSessions: true });
  }

  deleteRunState(options: { readonly updateTeamInstance: boolean; readonly deleteRoleSessions: boolean }): Promise<{ runId: string; deleted: boolean }> {
    return this.enqueue(async () => {
      const teamId = this.state.run?.teamId;
      await this.abortRunRoleSessions();
      if (options.deleteRoleSessions) {
        await this.deleteRunRoleSessions();
      }
      Object.assign(this.state, emptyRunActorState());
      this.deps.runRegistry.remove(this.deps.runId);
      await this.deps.stateStore?.deleteRunState(this.deps.runId);
      if (options.updateTeamInstance) {
        await this.deps.teamInstances.removeRun(teamId, this.deps.runId);
      }
      return { runId: this.deps.runId, deleted: true };
    });
  }

  submitWorkflowPlan(params: unknown, scope?: RuntimeScope): Promise<{ plan: TeamWorkflowPlanProjection; created: boolean }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const envelope: TeamInboundEnvelope = {
        type: 'workflow.plan_submitted',
        envelopeId: `team-envelope-${this.deps.randomId()}`,
        runId: this.deps.runId,
        sourceEndpoint: scope && 'endpoint' in scope ? scope.endpoint : { kind: 'native-runtime', runtimeAdapterId: 'runtime-host', runtimeInstanceId: 'local' },
        sourceAgentId: 'runtime-host',
        idempotencyKey: requireString(input, 'idempotencyKey'),
        createdAt: this.deps.nowMs(),
        title: requireString(input, 'title'),
        ...optionalStringProperty(input, 'summary'),
        groups: readPlanGroups(input.groups),
        tasks: readPlanTasks(input.tasks),
      };
      const created = await this.consumeEnvelope(envelope);
      if (!this.state.workflowPlan) throw new Error('Team workflow plan was not created');
      await this.deliverRetryableMails();
      await this.dispatchReadyTasks();
      this.updateRunCompletionState();
      await this.flushState();
      return { plan: this.state.workflowPlan, created };
    });
  }

  async drainOutbox(params: unknown): Promise<{ success: true; resultType: 'noop' | 'outbox_pending'; runId: string; drainedRecords: number; snapshot: TeamRunSnapshot }> {
    return await this.enqueue(async () => {
      const idempotencyKey = requireString(readRecord(params), 'idempotencyKey');
      const consumerId = `${TEAM_RUNTIME_CONSUMER_PREFIX}:${this.deps.shardIndex}:${this.deps.runId}`;
      let drainedRecords = 0;
      let drainedBatches = 0;
      logTeamRuntimeServiceInfo('outbox.drain_start', {
        runId: this.deps.runId,
        consumerId,
        idempotencyKey,
        afterSequence: this.state.acknowledgedOutboxSequence,
        limit: OUTBOX_PULL_LIMIT,
      });
      while (drainedBatches < MAX_OUTBOX_BATCHES_PER_TICK) {
        const afterSequence = this.state.acknowledgedOutboxSequence;
        logTeamRuntimeServiceInfo('outbox.pull_start', {
          runId: this.deps.runId,
          consumerId,
          afterSequence,
          batchIndex: drainedBatches,
        });
        const pulled = await this.deps.ingress.pull({
          runId: this.deps.runId,
          afterSequence,
          limit: OUTBOX_PULL_LIMIT,
          consumerId,
          leaseMs: OUTBOX_LEASE_MS,
        });
        const records = [...pulled.records].sort((a, b) => a.sequence - b.sequence);
        logTeamRuntimeServiceInfo('outbox.pull_result', {
          runId: this.deps.runId,
          consumerId,
          batchIndex: drainedBatches,
          recordCount: records.length,
          sequences: records.map((record) => record.sequence),
          hasMore: pulled.hasMore,
        });
        if (records.length === 0) break;
        const sequences = records.map((record) => record.sequence);
        for (const record of records) {
          try {
            await this.consumeOutboxRecord(record);
          } catch (error) {
            logTeamRuntimeServiceError('outbox.consume_error', {
              runId: this.deps.runId,
              recordId: record.recordId,
              sequence: record.sequence,
              envelopeType: record.envelope.type,
              errorMessage: safeErrorMessage(error),
            });
            throw error;
          }
        }
        await this.flushState();
        const acked = await this.deps.ingress.ack({ runId: this.deps.runId, sequences, consumerId });
        logTeamRuntimeServiceInfo('outbox.ack_result', {
          runId: this.deps.runId,
          consumerId,
          requestedSequences: sequences,
          ackedSequences: acked.ackedSequences,
        });
        if (acked.ackedSequences.length > 0) {
          this.state.acknowledgedOutboxSequence = Math.max(this.state.acknowledgedOutboxSequence, ...acked.ackedSequences);
          await this.flushState();
        }
        drainedRecords += acked.ackedSequences.length;
        drainedBatches += 1;
        if (!pulled.hasMore) break;
      }
      await this.deliverRetryableMails();
      await this.dispatchReadyTasks();
      this.updateRunCompletionState();
      await this.flushState();
      logTeamRuntimeServiceInfo('outbox.drain_complete', {
        runId: this.deps.runId,
        consumerId,
        drainedRecords,
        drainedBatches,
        acknowledgedOutboxSequence: this.state.acknowledgedOutboxSequence,
      });
      return { success: true, resultType: drainedRecords > 0 ? 'outbox_pending' : 'noop', runId: this.deps.runId, drainedRecords, snapshot: this.buildSnapshot() };
    });
  }

  submitDecision(params: unknown): Promise<{ success: true; runId: string; decisionId: string; decision: TeamDecisionType; snapshot: TeamRunSnapshot }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const idempotencyKey = requireString(input, 'idempotencyKey');
      const existing = this.state.decisions.find((decision) => decision.idempotencyKey === idempotencyKey);
      if (existing) return { success: true, runId: this.deps.runId, decisionId: existing.decisionId, decision: existing.decision, snapshot: this.buildSnapshot() };
      const decision = readDecisionType(input.decision);
      const decisionRecord: TeamDecisionProjection = {
        decisionId: `team-decision-${this.deps.randomId()}`,
        runId: this.deps.runId,
        stageId: readString(input.stageId) ?? this.state.workflowPlan?.tasks[0]?.taskId ?? 'run',
        decision,
        ...optionalStringProperty(input, 'note'),
        idempotencyKey,
        createdAt: this.deps.nowMs(),
      };
      this.state.decisions.push(decisionRecord);
      this.appendEvent('decision.submitted', decisionRecord, idempotencyKey);
      await this.flushState();
      return { success: true, runId: this.deps.runId, decisionId: decisionRecord.decisionId, decision, snapshot: this.buildSnapshot() };
    });
  }

  resolveApproval(params: unknown): Promise<{ success: true; runId: string; approvalId: string; decision: string; status: TeamApprovalStatus; approval: TeamApprovalProjection; snapshot: TeamRunSnapshot }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const approvalId = requireString(input, 'approvalId');
      const decision = readApprovalDecision(input.decision);
      const status = approvalStatusForDecision(decision);
      let approval = this.state.approvals.find((item) => item.approvalId === approvalId);
      if (!approval) {
        approval = {
          approvalId,
          runId: this.deps.runId,
          stageId: readString(input.stageId) ?? 'run',
          roleId: readString(input.roleId) ?? 'leader',
          reason: 'Approval resolved before request projection was available.',
          requestedAction: 'unknown',
          risk: 'unknown',
          status: 'pending',
          idempotencyKey: approvalId,
          createdAt: this.deps.nowMs(),
        };
        this.state.approvals.push(approval);
      }
      approval.status = status;
      approval.resolvedAt = this.deps.nowMs();
      Object.assign(approval, optionalStringProperty(input, 'note'));
      this.appendEvent('approval.resolved', { approvalId, decision, status }, requireString(input, 'idempotencyKey'));
      this.updateRunCompletionState();
      await this.flushState();
      return { success: true, runId: this.deps.runId, approvalId, decision, status, approval, snapshot: this.buildSnapshot() };
    });
  }

  loadRunState(): Promise<TeamRunRecord | null> {
    return this.enqueue(() => (this.state.run ? { ...this.state.run } : null));
  }

  readSnapshot(params: unknown): Promise<TeamRunSnapshot> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const snapshot = this.buildSnapshot();
      const eventCursor = readNumber(input.eventCursor) ?? 0;
      const eventLimit = readNumber(input.eventLimit) ?? snapshot.events.length;
      return {
        ...snapshot,
        events: snapshot.events.filter((event) => event.revision > eventCursor).slice(0, Math.max(0, eventLimit)),
        nextEventCursor: snapshot.events.length > 0 ? snapshot.events[snapshot.events.length - 1]!.revision : 0,
      };
    });
  }

  private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
    const nextWork = this.queuedWork.then(async () => {
      await this.loadState();
      return await work();
    }, async () => {
      await this.loadState();
      return await work();
    });
    this.queuedWork = nextWork.then(() => undefined, () => undefined);
    return nextWork;
  }

  private async consumeOutboxRecord(record: TeamOutboxRecord): Promise<void> {
    logTeamRuntimeServiceInfo('outbox.consume_start', {
      runId: record.runId,
      recordId: record.recordId,
      sequence: record.sequence,
      status: record.status,
      envelopeType: record.envelope.type,
    });
    const created = await this.consumeEnvelope(record.envelope);
    logTeamRuntimeServiceInfo('outbox.consume_result', {
      runId: record.runId,
      recordId: record.recordId,
      sequence: record.sequence,
      envelopeType: record.envelope.type,
      created,
      workflowPlanPresent: this.state.workflowPlan !== null,
      dispatchTaskCount: this.state.dispatchTasks.length,
    });
  }

  private async consumeEnvelope(envelope: TeamInboundEnvelope): Promise<boolean> {
    if (this.state.processedIdempotencyKeys.has(envelope.idempotencyKey)) return false;
    this.ensureRunForEnvelope(envelope);
    switch (envelope.type) {
      case 'workflow.plan_submitted':
        this.applyWorkflowPlan(envelope);
        break;
      case 'task.completed':
        this.applyTaskCompleted(envelope);
        break;
      case 'message.sent':
        await this.applyMessageSent(envelope);
        break;
      case 'approval.requested':
        this.applyApprovalRequested(envelope);
        break;
      case 'artifact.published':
        this.applyArtifactPublished(envelope);
        break;
      case 'artifact.updated':
        this.applyArtifactUpdated(envelope);
        break;
      case 'gate.opened':
        this.applyGateOpened(envelope);
        break;
      case 'gate.resolved':
        await this.applyGateResolved(envelope);
        break;
    }
    this.updateRunCompletionState();
    this.appendEvent(envelope.type, { envelopeId: envelope.envelopeId, envelope }, envelope.idempotencyKey, envelope.createdAt);
    this.state.processedIdempotencyKeys.add(envelope.idempotencyKey);
    return true;
  }

  private applyWorkflowPlan(envelope: Extract<TeamInboundEnvelope, { type: 'workflow.plan_submitted' }>): void {
    assertWorkflowPlanRoleIdsMatchRunBindings(envelope.tasks, this.state.roleBindings);
    const workflowPlanId = `workflow-plan-${envelope.idempotencyKey}`;
    const tasks = envelope.tasks.map((task) => ({ ...task, dependsOnTaskIds: task.dependsOnTaskIds ?? [] }));
    this.state.workflowPlan = {
      workflowPlanId,
      runId: envelope.runId,
      title: envelope.title,
      ...optionalDefinedProperty('summary', envelope.summary),
      status: 'planned',
      groups: [...envelope.groups],
      tasks,
      idempotencyKey: envelope.idempotencyKey,
      createdAt: envelope.createdAt,
    };
    this.state.dispatchGroups = envelope.groups.map((group) => ({
      dispatchGroupId: `${workflowPlanId}:group:${group.groupId}`,
      runId: envelope.runId,
      workflowPlanId,
      groupId: group.groupId,
      taskIds: group.taskIds,
      status: 'queued',
      idempotencyKey: `${envelope.idempotencyKey}:group:${group.groupId}`,
      createdAt: envelope.createdAt,
    }));
    this.state.dispatchTasks = tasks.map((task) => {
      const group = envelope.groups.find((candidate) => candidate.taskIds.includes(task.taskId));
      const groupId = group?.groupId ?? 'ungrouped';
      return {
        dispatchTaskId: `${workflowPlanId}:task:${task.taskId}`,
        runId: envelope.runId,
        workflowPlanId,
        dispatchGroupId: `${workflowPlanId}:group:${groupId}`,
        groupId,
        taskId: task.taskId,
        roleId: task.roleId,
        dispatchId: `${workflowPlanId}:dispatch:${task.taskId}`,
        status: 'queued',
        idempotencyKey: `${envelope.idempotencyKey}:task:${task.taskId}`,
        createdAt: envelope.createdAt,
      };
    });
    this.updateRun({ status: 'running' });
  }

  private applyTaskCompleted(envelope: Extract<TeamInboundEnvelope, { type: 'task.completed' }>): void {
    const artifact = buildTaskCompletionArtifact(envelope, this.state.workflowPlan?.tasks.find((task) => task.taskId === envelope.workflowTaskId));
    this.state.artifacts.push(artifact);
    for (const task of this.state.dispatchTasks) {
      if (task.taskId === envelope.workflowTaskId) {
        task.status = 'completed';
        task.completedAt = envelope.createdAt;
        task.statusReason = envelope.summary;
        task.artifactId = artifact.artifactId;
      }
    }
    for (const execution of this.state.dispatchExecutions) {
      if (execution.stageId === envelope.workflowTaskId) {
        execution.status = 'completed';
        execution.statusReason = envelope.summary;
      }
    }
  }

  private async applyMessageSent(envelope: Extract<TeamInboundEnvelope, { type: 'message.sent' }>): Promise<void> {
    const messageId = `team-message-${envelope.idempotencyKey}`;
    const failureItems = [...(envelope.failureItems ?? [])];
    this.state.messages.push({
      messageId,
      runId: envelope.runId,
      kind: envelope.kind,
      fromRoleId: envelope.fromRoleId,
      toRoleId: envelope.toRoleId,
      summary: envelope.summary,
      body: envelope.body,
      ...optionalDefinedProperty('relatedTaskId', envelope.relatedTaskId),
      ...optionalDefinedProperty('relatedArtifactId', envelope.relatedArtifactId),
      ...optionalDefinedProperty('relatedGateId', envelope.relatedGateId),
      failureItems,
      idempotencyKey: envelope.idempotencyKey,
      createdAt: envelope.createdAt,
    });
    if (envelope.kind === 'kickback') {
      this.state.kickbacks.push({
        kickbackId: `team-kickback-${envelope.idempotencyKey}`,
        runId: envelope.runId,
        stageId: envelope.relatedTaskId ?? envelope.workflowTaskId ?? 'run',
        fromRoleId: envelope.fromRoleId,
        toRoleId: envelope.toRoleId,
        ...optionalDefinedProperty('gateId', envelope.relatedGateId),
        ...optionalDefinedProperty('artifactId', envelope.relatedArtifactId),
        ...optionalDefinedProperty('taskId', envelope.relatedTaskId),
        failureItems,
        messageId,
        idempotencyKey: envelope.idempotencyKey,
        createdAt: envelope.createdAt,
      });
    }
    await this.deliverMessageMail(envelope, messageId);
  }

  private async deliverMessageMail(envelope: Extract<TeamInboundEnvelope, { type: 'message.sent' }>, messageId: string): Promise<void> {
    if (!this.deps.mailDelivery) return;
    const binding = this.state.roleBindings.find((candidate) => candidate.roleId === envelope.toRoleId);
    if (!binding) return;
    await this.deliverMail(buildMessageMail({
      runId: envelope.runId,
      messageId,
      kind: envelope.kind,
      toAgentId: binding.agentId,
      fromRoleId: envelope.fromRoleId,
      threadId: envelope.relatedTaskId ?? envelope.relatedGateId ?? messageId,
      subject: envelope.summary,
      body: envelope.body,
      relatedEntity: relatedEntityForMessage(envelope, messageId),
      idempotencyKey: `${envelope.idempotencyKey}:mail`,
      causationId: envelope.envelopeId,
      createdAt: envelope.createdAt,
      required: envelope.kind === 'kickback',
    }), binding, `${envelope.idempotencyKey}:mail`);
  }

  private applyApprovalRequested(envelope: Extract<TeamInboundEnvelope, { type: 'approval.requested' }>): void {
    this.state.approvals.push({
      approvalId: `team-approval-${envelope.idempotencyKey}`,
      runId: envelope.runId,
      stageId: envelope.workflowTaskId,
      roleId: envelope.roleId,
      reason: envelope.reason,
      requestedAction: envelope.requestedAction,
      risk: envelope.risk,
      status: 'pending',
      idempotencyKey: envelope.idempotencyKey,
      createdAt: envelope.createdAt,
    });
    this.updateRun({ status: 'waiting_for_user' });
  }

  private applyArtifactPublished(envelope: Extract<TeamInboundEnvelope, { type: 'artifact.published' }>): void {
    upsertArtifact(this.state.artifacts, {
      artifactId: envelope.artifactId ?? `team-artifact-${envelope.idempotencyKey}`,
      runId: envelope.runId,
      stageId: envelope.stageId,
      roleId: envelope.roleId,
      kind: envelope.kind,
      title: envelope.title,
      contentRef: envelope.contentRef,
      ...optionalDefinedProperty('summary', envelope.summary),
      evidenceRefs: [...(envelope.evidenceRefs ?? [])],
      sourceEnvelopeId: envelope.envelopeId,
      idempotencyKey: envelope.idempotencyKey,
      createdAt: envelope.createdAt,
      ...optionalDefinedProperty('relatedTaskId', envelope.relatedTaskId),
    });
  }

  private applyArtifactUpdated(envelope: Extract<TeamInboundEnvelope, { type: 'artifact.updated' }>): void {
    const existing = this.state.artifacts.find((artifact) => artifact.artifactId === envelope.artifactId);
    if (!existing) {
      throw new Error(`Artifact must exist before update: ${envelope.artifactId}`);
    }
    Object.assign(existing, {
      ...optionalDefinedProperty('stageId', envelope.stageId),
      ...optionalDefinedProperty('roleId', envelope.roleId),
      ...optionalDefinedProperty('kind', envelope.kind),
      ...optionalDefinedProperty('title', envelope.title),
      ...optionalDefinedProperty('contentRef', envelope.contentRef),
      ...optionalDefinedProperty('summary', envelope.summary),
      ...(envelope.evidenceRefs ? { evidenceRefs: [...envelope.evidenceRefs] } : {}),
      ...optionalDefinedProperty('relatedTaskId', envelope.relatedTaskId),
      ...optionalDefinedProperty('relatedGateId', envelope.relatedGateId),
      updatedAt: envelope.createdAt,
    });
  }

  private applyGateOpened(envelope: Extract<TeamInboundEnvelope, { type: 'gate.opened' }>): void {
    const gate: TeamGateProjection = {
      gateId: envelope.gateId ?? `team-gate-${envelope.idempotencyKey}`,
      runId: envelope.runId,
      stageId: envelope.stageId,
      gateType: envelope.gateType,
      ...optionalDefinedProperty('subjectArtifactId', envelope.subjectArtifactId),
      ...optionalDefinedProperty('relatedTaskId', envelope.relatedTaskId),
      blocking: envelope.blocking,
      summary: envelope.summary,
      status: 'open',
      failureItems: [...(envelope.failureItems ?? [])],
      idempotencyKey: envelope.idempotencyKey,
      createdAt: envelope.createdAt,
    };
    upsertGate(this.state.gates, gate);
    if (gate.blocking) this.updateRun({ status: 'waiting_for_user' });
  }

  private async applyGateResolved(envelope: Extract<TeamInboundEnvelope, { type: 'gate.resolved' }>): Promise<void> {
    let gate = this.state.gates.find((candidate) => candidate.gateId === envelope.gateId);
    if (!gate) {
      gate = {
        gateId: envelope.gateId,
        runId: envelope.runId,
        stageId: envelope.stageId ?? envelope.workflowTaskId ?? 'run',
        gateType: envelope.gateType ?? 'quality',
        blocking: true,
        summary: envelope.resolutionSummary ?? envelope.verdict,
        status: 'open',
        failureItems: [],
        idempotencyKey: envelope.idempotencyKey,
        createdAt: envelope.createdAt,
      };
      this.state.gates.push(gate);
    }
    Object.assign(gate, {
      ...optionalDefinedProperty('stageId', envelope.stageId),
      ...optionalDefinedProperty('gateType', envelope.gateType),
      verdict: envelope.verdict,
      passed: envelope.passed,
      status: envelope.passed ? 'passed' : 'failed',
      failureItems: [...(envelope.failureItems ?? gate.failureItems)],
      resolvedAt: envelope.createdAt,
      ...optionalDefinedProperty('resolutionSummary', envelope.resolutionSummary),
    });
    if (!envelope.passed) await this.createKickbackFromGate(gate, envelope.idempotencyKey, envelope.createdAt);
    if (envelope.passed) this.resolveKickbacksForGate(gate.gateId, envelope.createdAt);
  }

  private async createKickbackFromGate(gate: TeamGateProjection, idempotencyKey: string, createdAt: number): Promise<void> {
    const relatedTask = gate.relatedTaskId ?? gate.stageId;
    const dispatch = this.state.dispatches.find((candidate) => candidate.taskId === relatedTask || candidate.stageId === gate.stageId);
    const toRoleId = dispatch?.roleId ?? this.state.dispatchTasks.find((task) => task.taskId === relatedTask)?.roleId ?? 'leader';
    const messageId = `team-message-${this.deps.randomId()}`;
    const kickbackId = `team-kickback-${idempotencyKey}`;
    const summary = `Gate failed: ${gate.summary}`;
    const body = gate.failureItems.length > 0
      ? gate.failureItems.map((item) => `- ${item.code}: ${item.message}`).join('\n')
      : gate.verdict ?? gate.summary;
    this.state.messages.push({
      messageId,
      runId: gate.runId,
      kind: 'kickback',
      fromRoleId: 'leader',
      toRoleId,
      summary,
      body,
      relatedTaskId: relatedTask,
      ...optionalDefinedProperty('relatedArtifactId', gate.subjectArtifactId),
      relatedGateId: gate.gateId,
      failureItems: [...gate.failureItems],
      idempotencyKey: `${idempotencyKey}:kickback-message`,
      createdAt,
    });
    this.state.kickbacks.push({
      kickbackId,
      runId: gate.runId,
      stageId: gate.stageId,
      fromRoleId: 'leader',
      toRoleId,
      gateId: gate.gateId,
      ...optionalDefinedProperty('artifactId', gate.subjectArtifactId),
      taskId: relatedTask,
      failureItems: [...gate.failureItems],
      messageId,
      idempotencyKey: `${idempotencyKey}:kickback`,
      createdAt,
    });
    await this.enqueueGateKickbackMail({ gate, messageId, toRoleId, relatedTask, summary, body, idempotencyKey, createdAt });
  }

  private async enqueueGateKickbackMail(input: {
    readonly gate: TeamGateProjection;
    readonly messageId: string;
    readonly toRoleId: string;
    readonly relatedTask: string;
    readonly summary: string;
    readonly body: string;
    readonly idempotencyKey: string;
    readonly createdAt: number;
  }): Promise<void> {
    const binding = this.state.roleBindings.find((candidate) => candidate.roleId === input.toRoleId);
    if (!binding || !this.deps.mailDelivery) return;
    await this.deliverMail(buildMessageMail({
      runId: input.gate.runId,
      messageId: input.messageId,
      kind: 'kickback',
      toAgentId: binding.agentId,
      fromRoleId: 'leader',
      threadId: input.relatedTask,
      subject: input.summary,
      body: input.body,
      relatedEntity: { kind: 'gate', id: input.gate.gateId },
      idempotencyKey: `${input.idempotencyKey}:kickback-mail`,
      causationId: input.gate.gateId,
      createdAt: input.createdAt,
    }), binding, `${input.idempotencyKey}:kickback-mail`);
  }

  private resolveKickbacksForGate(gateId: string, resolvedAt: number): void {
    for (const kickback of this.state.kickbacks) {
      if (kickback.gateId === gateId && !kickback.resolvedAt) kickback.resolvedAt = resolvedAt;
    }
  }

  private async dispatchReadyTasks(): Promise<void> {
    if (!this.deps.mailDelivery || !this.state.workflowPlan) return;
    let activeRolePrompts = countActiveRolePrompts(this.state.dispatchTasks, this.state.dispatches);
    for (const task of this.state.dispatchTasks) {
      if (activeRolePrompts >= TEAM_DISPATCH_MAX_ACTIVE_ROLE_PROMPTS) return;
      if (task.status !== 'queued') continue;
      if (this.state.dispatches.some((dispatch) => dispatch.taskId === task.taskId)) continue;
      const plannedTask = this.state.workflowPlan.tasks.find((candidate) => candidate.taskId === task.taskId);
      if (!taskDependenciesCompleted(this.state.dispatchTasks, plannedTask?.dependsOnTaskIds ?? [])) continue;
      const binding = this.state.roleBindings.find((candidate) => candidate.roleId === task.roleId);
      if (!binding) continue;
      const message = plannedTask ? buildTaskPrompt(plannedTask) : `Complete Team workflow task ${task.taskId}.`;
      const mail = buildTaskAssignmentMail({
        task,
        binding,
        message,
        plannedTask,
        createdAt: this.deps.nowMs(),
      });
      const delivery = await this.deliverMail(mail, binding, task.idempotencyKey);
      if (delivery.status !== 'delivered') continue;
      if (!this.state.dispatches.some((dispatch) => dispatch.taskId === task.taskId)) {
        this.state.dispatches.push({
          dispatchId: task.dispatchId,
          runId: task.runId,
          stageId: task.taskId,
          roleId: task.roleId,
          promptRef: mail.mailId,
          inputArtifactIds: inputArtifactIdsForTask(this.state.artifacts, plannedTask?.dependsOnTaskIds ?? []),
          kickbackIds: kickbackIdsForTask(this.state.kickbacks, task.taskId),
          idempotencyKey: task.idempotencyKey,
          createdAt: delivery.deliveredAt ?? this.deps.nowMs(),
          workflowPlanId: task.workflowPlanId,
          dispatchGroupId: task.dispatchGroupId,
          groupId: task.groupId,
          taskId: task.taskId,
        });
        this.state.dispatchExecutions.push({
          executionRecordId: `team-dispatch-execution-${this.deps.randomId()}`,
          runId: task.runId,
          dispatchId: task.dispatchId,
          stageId: task.taskId,
          roleId: task.roleId,
          executionId: mail.mailId,
          childSessionKey: binding.sessionKey,
          spawnMode: 'session',
          status: 'queued',
          idempotencyKey: task.idempotencyKey,
          createdAt: delivery.deliveredAt ?? this.deps.nowMs(),
        });
        this.appendEvent('dispatch.task_prompted', { taskId: task.taskId, roleId: task.roleId, sessionKey: binding.sessionKey, mailId: mail.mailId }, task.idempotencyKey);
        activeRolePrompts += 1;
      }
    }
  }

  private async deliverRetryableMails(): Promise<void> {
    if (!this.deps.mailDelivery) return;
    const now = this.deps.nowMs();
    for (const mail of this.state.mails) {
      if (mail.status !== 'retry_scheduled' || (mail.nextRetryAt ?? 0) > now) continue;
      const binding = this.state.roleBindings.find((candidate) => candidate.agentId === mail.toAgentId);
      if (!binding) continue;
      await this.deliverMail(mail, binding, mail.idempotencyKey);
    }
  }

  private async deliverMail(mail: TeamMail, binding: TeamRoleSessionBinding, idempotencyKey: string): Promise<{ status: 'delivered' | 'failed' | 'retry_scheduled'; reason?: string; deliveredAt?: number }> {
    const existing = this.state.mails.find((candidate) => candidate.mailId === mail.mailId);
    const now = this.deps.nowMs();
    if (existing?.status === 'delivered') return { status: 'delivered', deliveredAt: existing.deliveredAt };
    if (existing?.status === 'retry_scheduled' && (existing.nextRetryAt ?? 0) > now) {
      return { status: 'retry_scheduled', reason: existing.lastError };
    }
    if (existing?.status === 'failed') return { status: 'failed', reason: existing.lastError };
    const attempt = (existing?.attempt ?? 0) + 1;
    const queuedMail: TeamMail = {
      ...mail,
      status: 'delivering',
      attempt,
      maxAttempts: mail.maxAttempts ?? TEAM_MAIL_MAX_ATTEMPTS,
      required: mail.required ?? true,
      deliveringAt: now,
      updatedAt: now,
    };
    upsertMail(this.state.mails, queuedMail);
    try {
      const delivery = await this.deps.mailDelivery!.deliver({ mail: queuedMail, binding, idempotencyKey });
      if (delivery.status === 'delivered') {
        const deliveredAt = delivery.deliveredAt ?? this.deps.nowMs();
        upsertMail(this.state.mails, { ...queuedMail, status: 'delivered', deliveredAt, updatedAt: deliveredAt });
        return { status: 'delivered', deliveredAt };
      }
      return this.scheduleMailRetry(queuedMail, delivery.reason ?? delivery.status);
    } catch (error) {
      return this.scheduleMailRetry(queuedMail, error instanceof Error ? error.message : String(error));
    }
  }

  private scheduleMailRetry(mail: TeamMail, reason: string): { status: 'failed' | 'retry_scheduled'; reason: string } {
    const attempt = mail.attempt ?? 1;
    const maxAttempts = mail.maxAttempts ?? TEAM_MAIL_MAX_ATTEMPTS;
    const now = this.deps.nowMs();
    if (attempt >= maxAttempts) {
      upsertMail(this.state.mails, { ...mail, status: 'failed', lastError: reason, updatedAt: now });
      this.appendEvent('mail.delivery_failed', { mailId: mail.mailId, reason, attempt, maxAttempts }, mail.idempotencyKey);
      return { status: 'failed', reason };
    }
    const nextRetryAt = now + TEAM_MAIL_RETRY_DELAY_MS;
    upsertMail(this.state.mails, { ...mail, status: 'retry_scheduled', lastError: reason, nextRetryAt, updatedAt: now });
    this.appendEvent('mail.retry_scheduled', { mailId: mail.mailId, reason, attempt, maxAttempts, nextRetryAt }, mail.idempotencyKey);
    return { status: 'retry_scheduled', reason };
  }

  private updateRunCompletionState(): void {
    if (!this.state.run || this.state.run.status === 'cancelled' || this.state.run.status === 'failed') return;
    const hasTasks = this.state.dispatchTasks.length > 0;
    const tasksCompleted = hasTasks && this.state.dispatchTasks.every((task) => task.status === 'completed');
    const hasPendingApproval = this.state.approvals.some((approval) => approval.status === 'pending');
    const hasBlockingGate = this.state.gates.some((gate) => gate.blocking && gate.status === 'open');
    const hasOpenKickback = this.state.kickbacks.some((kickback) => !kickback.resolvedAt);
    const hasFailedRequiredMail = this.state.mails.some((mail) => mail.required !== false && mail.status === 'failed');
    const hasPendingRequiredMail = this.state.mails.some((mail) => mail.required !== false && (mail.status === 'pending' || mail.status === 'delivering' || mail.status === 'retry_scheduled'));
    if (hasFailedRequiredMail) {
      this.updateRun({ status: 'failed' });
      return;
    }
    if (tasksCompleted && !hasPendingApproval && !hasBlockingGate && !hasOpenKickback && !hasPendingRequiredMail) {
      if (this.state.run.status !== 'completed') this.updateRun({ status: 'completed' });
      return;
    }
    if (hasPendingApproval || hasBlockingGate || hasOpenKickback || hasPendingRequiredMail) {
      if (this.state.run.status !== 'waiting_for_user') this.updateRun({ status: 'waiting_for_user' });
      return;
    }
    if ((this.state.run.status === 'completed' || this.state.run.status === 'waiting_for_user') && !tasksCompleted) this.updateRun({ status: 'running' });
  }

  private ensureRunForEnvelope(envelope: TeamInboundEnvelope): void {
    if (this.state.run) return;
    this.state.run = { runId: envelope.runId, status: 'running', revision: 0, packageName: 'team-skill', packageVersion: '0.0.0', sourcePath: '', createdAt: envelope.createdAt, updatedAt: envelope.createdAt };
  }

  private ensureRun(): void {
    if (this.state.run) return;
    const now = this.deps.nowMs();
    this.state.run = { runId: this.deps.runId, status: 'created', revision: 0, packageName: 'team-skill', packageVersion: '0.0.0', sourcePath: '', createdAt: now, updatedAt: now };
  }


  private async abortRunRoleSessions(): Promise<void> {
    if (!this.deps.roleSessions) return;
    for (const binding of this.state.roleBindings) {
      await this.deps.roleSessions.abortRoleSession({ binding, runId: this.deps.runId });
    }
  }

  private async deleteRunRoleSessions(): Promise<void> {
    if (!this.deps.roleSessions) return;
    for (const binding of this.state.roleBindings) {
      await this.deps.roleSessions.deleteRoleSession({ binding });
    }
  }

  private updateRun(patch: Partial<Pick<TeamRunRecord, 'status'>>): void {
    this.ensureRun();
    Object.assign(this.state.run!, patch, { revision: this.state.run!.revision + 1, updatedAt: this.deps.nowMs() });
  }

  private appendEvent(type: string, payload: Record<string, unknown>, idempotencyKey: string, createdAt = this.deps.nowMs()): void {
    const revision = this.state.events.length + 1;
    this.state.events.push({ eventId: `team-event-${revision}`, runId: this.deps.runId, revision, type, payload, createdAt });
    if (this.state.run) {
      this.state.run.revision = Math.max(this.state.run.revision, revision);
      this.state.run.updatedAt = createdAt;
    }
    this.state.processedIdempotencyKeys.add(idempotencyKey);
  }

  private runSummary(): { runId: string; status: TeamRunStatus; revision: number } {
    this.ensureRun();
    return { runId: this.state.run!.runId, status: this.state.run!.status, revision: this.state.run!.revision };
  }

  private buildSnapshot(): TeamRunSnapshot {
    return {
      run: this.state.run ? { ...this.state.run } : null,
      roles: this.state.roleBindings.map((role) => ({ ...role })),
      stages: [],
      workflowPlan: this.state.workflowPlan ? { ...this.state.workflowPlan } : null,
      dispatchGroups: this.state.dispatchGroups.map((group) => ({ ...group })),
      dispatchTasks: this.state.dispatchTasks.map((task) => ({ ...task })),
      approvals: this.state.approvals.map((approval) => ({ ...approval })),
      artifacts: this.state.artifacts.map((artifact) => ({ ...artifact, evidenceRefs: artifact.evidenceRefs.map((evidence) => ({ ...evidence })) })),
      dispatches: this.state.dispatches.map((dispatch) => ({ ...dispatch })),
      dispatchExecutions: this.state.dispatchExecutions.map((execution) => ({ ...execution })),
      messages: this.state.messages.map((message) => ({ ...message, failureItems: message.failureItems.map((failureItem) => ({ ...failureItem })) })),
      mails: this.state.mails.map((mail) => ({ ...mail })),
      gates: this.state.gates.map((gate) => ({ ...gate, failureItems: gate.failureItems.map((failureItem) => ({ ...failureItem })) })),
      kickbacks: this.state.kickbacks.map((kickback) => ({ ...kickback, failureItems: kickback.failureItems.map((failureItem) => ({ ...failureItem })) })),
      decisions: this.state.decisions.map((decision) => ({ ...decision })),
      diagnostics: {
        runId: this.deps.runId,
        recoveredFromStorage: false,
        storageRoot: this.deps.stateStore ? 'team-runtime-state-store' : 'memory',
        budgets: { roleWallClockBudgetMs: {}, roleTokenBudget: {}, wallClockExceeded: false },
        limits: { maxArtifactContentBytes: 0, maxMessageBodyBytes: 0, staleDispatchExecutionMs: 0 },
        staleDispatchExecutions: [],
        counts: {
          events: this.state.events.length,
          dispatchTasks: this.state.dispatchTasks.length,
          dispatches: this.state.dispatches.length,
          dispatchExecutions: this.state.dispatchExecutions.length,
          approvals: this.state.approvals.length,
          messages: this.state.messages.length,
          artifacts: this.state.artifacts.length,
          mails: this.state.mails.length,
          gates: this.state.gates.length,
          kickbacks: this.state.kickbacks.length,
        },
      },
      events: this.state.events.map((event) => ({ ...event })),
      nextEventCursor: this.state.events.length > 0 ? this.state.events[this.state.events.length - 1]!.revision : 0,
    };
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const stored = await this.deps.stateStore?.readRunState(this.deps.runId);
    if (!stored) return;
    Object.assign(this.state, deserializeRunActorState(stored));
    this.syncRunRegistry();
  }

  private async flushState(): Promise<void> {
    await this.deps.stateStore?.writeRunState(this.deps.runId, serializeRunActorState(this.state));
    this.syncRunRegistry();
  }

  private syncRunRegistry(): void {
    if (this.state.run) {
      this.deps.runRegistry.upsert(toTeamRunRegistryRecord(this.state.run));
      return;
    }
    this.deps.runRegistry.remove(this.deps.runId);
  }
}

function toTeamRunRegistryRecord(run: Pick<TeamRunRecord, 'teamId' | 'runId' | 'status' | 'revision' | 'updatedAt'>) {
  return {
    teamId: run.teamId,
    runId: run.runId,
    status: run.status,
    revision: run.revision,
    updatedAt: run.updatedAt,
  };
}

function missingPackagePort(code: string, packagePath: string): ApplicationResponseOf {
  return accepted({ success: false, code, packagePath, message: 'TeamSkill package operations require a runtime-host package service to be configured.' });
}

function emptyRunActorState(): RunActorState {
  return { run: null, roleBindings: [], workflowPlan: null, dispatchGroups: [], dispatchTasks: [], dispatches: [], dispatchExecutions: [], approvals: [], artifacts: [], messages: [], mails: [], gates: [], kickbacks: [], decisions: [], events: [], processedIdempotencyKeys: new Set<string>(), acknowledgedOutboxSequence: 0 };
}

function serializeRunActorState(state: RunActorState): Record<string, unknown> {
  return { ...state, processedIdempotencyKeys: Array.from(state.processedIdempotencyKeys) };
}

function deserializeTeamInstance(value: unknown): TeamInstance {
  const record = readRecord(value);
  return {
    teamId: requireString(record, 'teamId'),
    teamSkillName: requireString(record, 'teamSkillName'),
    teamSkillVersion: requireString(record, 'teamSkillVersion'),
    packagePath: requireString(record, 'packagePath'),
    sourcePath: requireString(record, 'sourcePath'),
    managedAgents: readArray(record.managedAgents) as TeamManagedAgentRecord[],
    runs: readArray(record.runs) as TeamInstanceRunRecord[],
    createdAt: readNumber(record.createdAt) ?? 0,
    updatedAt: readNumber(record.updatedAt) ?? 0,
  };
}

function collectTeamManagedAgentWorkspaces(managedAgents: readonly TeamManagedAgentRecord[]): string[] {
  return Array.from(new Set(managedAgents.map((agent) => agent.workspace).filter((workspace) => workspace.trim().length > 0)));
}

function selectManagedAgentsForRoles(managedAgents: readonly TeamManagedAgentRecord[], roles: readonly TeamRoleAgentMaterializationSpec[]): TeamManagedAgentRecord[] {
  const byRoleId = new Map(managedAgents.map((agent) => [agent.roleId, agent]));
  return roles.map((role) => {
    const managedAgent = byRoleId.get(role.roleId);
    if (!managedAgent) {
      throw new Error(`Team managed agent is required before creating run session for role ${role.roleId}`);
    }
    return managedAgent;
  });
}

function upsertTeamInstanceRun(existing: readonly TeamInstanceRunRecord[], incoming: TeamInstanceRunRecord): TeamInstanceRunRecord[] {
  const withoutIncoming = existing.filter((run) => run.runId !== incoming.runId);
  return [...withoutIncoming, incoming];
}

function deserializeRunActorState(value: unknown): RunActorState {
  const record = readRecord(value);
  return {
    run: readRecordOrNull(record.run) as TeamRunRecord | null,
    roleBindings: readArray(record.roleBindings) as TeamRoleSessionBinding[],
    workflowPlan: readRecordOrNull(record.workflowPlan) as TeamWorkflowPlanProjection | null,
    dispatchGroups: readArray(record.dispatchGroups) as TeamDispatchGroupProjection[],
    dispatchTasks: readArray(record.dispatchTasks) as TeamDispatchTaskProjection[],
    dispatches: readArray(record.dispatches) as TeamDispatchProjection[],
    dispatchExecutions: readArray(record.dispatchExecutions) as TeamDispatchExecutionProjection[],
    approvals: readArray(record.approvals) as TeamApprovalProjection[],
    artifacts: readArray(record.artifacts) as TeamArtifactProjection[],
    messages: readArray(record.messages) as TeamMessageProjection[],
    mails: readArray(record.mails) as TeamMail[],
    gates: readArray(record.gates) as TeamGateProjection[],
    kickbacks: readArray(record.kickbacks) as TeamKickbackProjection[],
    decisions: readArray(record.decisions) as TeamDecisionProjection[],
    events: readArray(record.events) as TeamEventProjection[],
    processedIdempotencyKeys: new Set(readStringArray(record.processedIdempotencyKeys)),
    acknowledgedOutboxSequence: readNumber(record.acknowledgedOutboxSequence) ?? 0,
  };
}

function buildLeaderMaterializationSpec(teamPackage: NonNullable<Awaited<ReturnType<TeamRuntimePackagePort['validate']>>['package']>): TeamRoleAgentMaterializationSpec {
  return {
    roleId: 'leader',
    agentName: 'leader',
    workspacePath: teamPackage.sourcePath,
    files: [],
    tools: ['team_submit_workflow_plan', 'team_send_message'],
  };
}

function buildRoleMaterializationSpec(teamPackage: NonNullable<Awaited<ReturnType<TeamRuntimePackagePort['validate']>>['package']>, role: NonNullable<Awaited<ReturnType<TeamRuntimePackagePort['validate']>>['package']>['roles'][number]): TeamRoleAgentMaterializationSpec {
  return {
    roleId: role.id,
    agentName: role.id,
    purpose: role.purpose,
    workspacePath: teamPackage.sourcePath,
    files: [
      { path: 'AGENTS.md', content: role.agentsMd },
    ],
    skills: role.skills,
    tools: role.tools,
  };
}

function buildTaskPrompt(task: TeamWorkflowTaskPlan): string {
  return [
    `Team workflow task: ${task.title}`,
    `Task id: ${task.taskId}`,
    `Role id: ${task.roleId}`,
    '',
    task.prompt,
    '',
    '## Completion',
    '',
    'When your task is done, follow TOOLS.md and call Team Complete Task. Use workflowTaskId equal to the Task id above and roleId equal to the Role id above.',
    'Do not claim completion if the tool call fails. For long evidence, follow the TOOLS.md inlineText limit and evidence reference rules.',
  ].join('\n');
}

function buildTaskAssignmentMail(input: {
  readonly task: TeamDispatchTaskProjection;
  readonly binding: TeamRoleSessionBinding;
  readonly message: string;
  readonly plannedTask?: TeamWorkflowTaskPlan;
  readonly createdAt: number;
}): TeamMail {
  return {
    mailId: `team-mail-${input.task.dispatchId}`,
    runId: input.task.runId,
    threadId: input.task.taskId,
    kind: 'task.assignment',
    toAgentId: input.binding.agentId,
    fromAgentId: 'leader',
    subject: `Team workflow task: ${input.plannedTask?.title ?? input.task.taskId}`,
    body: input.message,
    relatedEntity: { kind: 'task', id: input.task.taskId },
    status: 'pending',
    idempotencyKey: input.task.idempotencyKey,
    causationId: input.task.dispatchTaskId,
    createdAt: input.createdAt,
  };
}

function buildMessageMail(input: {
  readonly runId: string;
  readonly messageId: string;
  readonly kind: TeamMessageKind;
  readonly toAgentId: string;
  readonly fromRoleId: string;
  readonly threadId: string;
  readonly subject: string;
  readonly body: string;
  readonly relatedEntity: TeamMailRelatedEntity;
  readonly idempotencyKey: string;
  readonly causationId: string;
  readonly createdAt: number;
  readonly required?: boolean;
}): TeamMail {
  return {
    mailId: `team-mail-${input.messageId}`,
    runId: input.runId,
    threadId: input.threadId,
    kind: teamMailKindForMessage(input.kind),
    toAgentId: input.toAgentId,
    fromAgentId: input.fromRoleId,
    subject: input.subject,
    body: input.body,
    relatedEntity: input.relatedEntity,
    status: 'pending',
    idempotencyKey: input.idempotencyKey,
    causationId: input.causationId,
    createdAt: input.createdAt,
    ...(input.required === undefined ? {} : { required: input.required }),
  };
}

function teamMailKindForMessage(kind: TeamMessageKind): TeamMailKind {
  switch (kind) {
    case 'note':
      return 'message.note';
    case 'question':
      return 'message.question';
    case 'kickback':
      return 'message.kickback';
  }
}

function relatedEntityForMessage(envelope: Extract<TeamInboundEnvelope, { type: 'message.sent' }>, messageId: string): TeamMailRelatedEntity {
  if (envelope.relatedGateId) return { kind: 'gate', id: envelope.relatedGateId };
  if (envelope.relatedArtifactId) return { kind: 'artifact', id: envelope.relatedArtifactId };
  if (envelope.relatedTaskId) return { kind: 'task', id: envelope.relatedTaskId };
  return { kind: 'message', id: messageId };
}

function buildTaskCompletionArtifact(envelope: Extract<TeamInboundEnvelope, { type: 'task.completed' }>, task: TeamWorkflowTaskPlan | undefined): TeamArtifactProjection {
  const evidenceRefs = [...(envelope.evidenceRefs ?? [])];
  const primaryEvidence = evidenceRefs[0];
  return {
    artifactId: `team-artifact-${envelope.idempotencyKey}`,
    runId: envelope.runId,
    stageId: envelope.workflowTaskId,
    roleId: envelope.roleId,
    kind: primaryEvidence?.type ?? task?.outputArtifactKind ?? 'taskSummary',
    title: primaryEvidence?.label ?? task?.title ?? envelope.workflowTaskId,
    contentRef: contentRefForEvidence(primaryEvidence) ?? `task:${envelope.workflowTaskId}:summary`,
    summary: envelope.summary,
    evidenceRefs,
    sourceEnvelopeId: envelope.envelopeId,
    idempotencyKey: envelope.idempotencyKey,
    createdAt: envelope.createdAt,
  };
}

function contentRefForEvidence(evidence: TeamEvidenceRef | undefined): string | undefined {
  if (!evidence) return undefined;
  switch (evidence.type) {
    case 'workspacePath':
      return evidence.path;
    case 'uri':
      return evidence.uri;
    case 'artifact':
      return evidence.artifactId;
    case 'inlineText':
      return evidence.text;
  }
}

function inputArtifactIdsForTask(artifacts: readonly TeamArtifactProjection[], dependsOnTaskIds: readonly string[]): string[] {
  return dependsOnTaskIds.flatMap((taskId) => {
    const artifactId = artifacts.find((artifact) => artifact.stageId === taskId)?.artifactId;
    return artifactId ? [artifactId] : [];
  });
}

function kickbackIdsForTask(kickbacks: readonly TeamKickbackProjection[], taskId: string): string[] {
  return kickbacks.flatMap((kickback) => kickback.taskId === taskId && !kickback.resolvedAt ? [kickback.kickbackId] : []);
}

function upsertMail(mails: TeamMail[], mail: TeamMail): void {
  const index = mails.findIndex((candidate) => candidate.mailId === mail.mailId);
  if (index >= 0) {
    mails[index] = mail;
    return;
  }
  mails.push(mail);
}

function upsertArtifact(artifacts: TeamArtifactProjection[], artifact: TeamArtifactProjection): void {
  const index = artifacts.findIndex((candidate) => candidate.artifactId === artifact.artifactId);
  if (index >= 0) {
    artifacts[index] = artifact;
    return;
  }
  artifacts.push(artifact);
}

function upsertGate(gates: TeamGateProjection[], gate: TeamGateProjection): void {
  const index = gates.findIndex((candidate) => candidate.gateId === gate.gateId);
  if (index >= 0) {
    gates[index] = gate;
    return;
  }
  gates.push(gate);
}

function taskDependenciesCompleted(dispatchTasks: TeamDispatchTaskProjection[], dependsOnTaskIds: readonly string[]): boolean {
  return dependsOnTaskIds.every((taskId) => dispatchTasks.some((task) => task.taskId === taskId && task.status === 'completed'));
}

function countActiveRolePrompts(dispatchTasks: readonly TeamDispatchTaskProjection[], dispatches: readonly TeamDispatchProjection[]): number {
  return dispatches.filter((dispatch) => dispatchTasks.some((task) => task.taskId === dispatch.taskId && task.status === 'queued')).length;
}

function assertWorkflowPlanRoleIdsMatchRunBindings(tasks: readonly TeamWorkflowTaskPlan[], roleBindings: readonly TeamRoleSessionBinding[]): void {
  if (roleBindings.length === 0) {
    return;
  }
  for (const [index, task] of tasks.entries()) {
    if (task.roleId === 'leader') {
      throw new Error(`tasks[${index}].roleId must be a TeamSkill role id for a worker role. Leader work must stay outside workflow tasks.`);
    }
    if (roleBindings.some((binding) => binding.roleId === task.roleId)) {
      continue;
    }
    const matchingManagedAgent = roleBindings.find((binding) => binding.agentId === task.roleId);
    if (matchingManagedAgent) {
      throw new Error(`tasks[${index}].roleId must be the TeamSkill role id "${matchingManagedAgent.roleId}", not the managed agent id "${task.roleId}".`);
    }
    const validRoleIds = roleBindings
      .map((binding) => binding.roleId)
      .filter((roleId) => roleId !== 'leader')
      .join(', ');
    throw new Error(`tasks[${index}].roleId "${task.roleId}" is not in the TeamSkill role roster. Valid roleId values: ${validRoleIds}.`);
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requireString(input: Record<string, unknown>, field: string): string {
  const value = readString(input[field]);
  if (!value) throw new Error(`${field} is required`);
  return value;
}

function optionalStringProperty(input: Record<string, unknown>, field: string): Record<string, string> {
  const value = readString(input[field]);
  return value ? { [field]: value } : {};
}

function optionalDefinedProperty<T>(field: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [field]: value };
}

function readPlanGroups(value: unknown): TeamWorkflowGroupPlan[] {
  if (!Array.isArray(value)) throw new Error('groups must be an array');
  return value.map((item) => {
    const record = readRecord(item);
    const join = readRecord(record.join);
    return {
      groupId: requireString(record, 'groupId'),
      title: requireString(record, 'title'),
      taskIds: readStringArray(record.taskIds),
      join: {
        requireCompleted: join.requireCompleted === true,
        allowFailed: join.allowFailed === true,
        retryLimit: Number.isInteger(join.retryLimit) && Number(join.retryLimit) >= 0 ? Number(join.retryLimit) : 0,
      },
    };
  });
}

function readPlanTasks(value: unknown): TeamWorkflowTaskPlan[] {
  if (!Array.isArray(value)) throw new Error('tasks must be an array');
  return value.map((item) => {
    const record = readRecord(item);
    return {
      taskId: requireString(record, 'taskId'),
      roleId: requireString(record, 'roleId'),
      title: requireString(record, 'title'),
      prompt: requireString(record, 'prompt'),
      ...(Array.isArray(record.dependsOnTaskIds) ? { dependsOnTaskIds: readStringArray(record.dependsOnTaskIds) } : {}),
      ...optionalStringProperty(record, 'outputArtifactKind'),
    };
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap((item) => typeof item === 'string' && item.trim() ? [item.trim()] : []) : [];
}

function readDecisionType(value: unknown): TeamDecisionType {
  if (value === 'retry' || value === 'proceed_degraded' || value === 'abort') return value;
  throw new Error('decision must be retry, proceed_degraded, or abort');
}

function readApprovalDecision(value: unknown): 'approve' | 'deny' | 'abort' {
  if (value === 'approve' || value === 'deny' || value === 'abort') return value;
  throw new Error('decision must be approve, deny, or abort');
}

function approvalStatusForDecision(decision: 'approve' | 'deny' | 'abort'): TeamApprovalStatus {
  if (decision === 'approve') return 'approved';
  if (decision === 'deny') return 'denied';
  return 'aborted';
}

function lastPathSegment(value: string): string {
  return value.replace(/[/\\]+$/g, '').split(/[/\\]/).pop() ?? '';
}

function createTeamRunId(randomId: string): string {
  return `teamrun-${randomId.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'}`;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
