import { accepted, badRequest, ok, type ApplicationResponseOf } from '../common/application-response';
import type { RuntimeEndpointRef, RuntimeScope } from '../agent-runtime/contracts/runtime-address';
import type { TeamRuntimeOperationId } from './team-runtime-operation-id';
import type { TeamEvidenceRef } from './domain/team-evidence';
import type { TeamNodePromptDeliveryRecord } from './domain/team-node-prompt-delivery';
import type { TeamAgentCommand, TeamAgentCommandLedgerRecord, TeamGraphPatchCommand, TeamGraphPatchOperation, TeamNodeEventCommand, TeamNodeEventKind } from './domain/team-command-ledger';
import type { TeamRoleSessionBinding, TeamRunStatus } from './domain/team-run';
import {
  buildTeamRoleSessionBindingsFromManagedAgents,
  collectTeamManagedAgentIds,
  type TeamInstance,
  type TeamInstanceRunRecord,
  type TeamManagedAgentRecord,
} from './domain/team-instance';
import type { TeamAgentMaterializationPort, TeamAgentMaterializationSpec, TeamRoleAgentMaterializationSpec } from './ports/team-agent-materialization-port';
import type { TeamCommandLedgerPort } from './ports/team-command-ledger-port';
import type { TeamNodePromptDeliveryPort } from './ports/team-node-prompt-delivery-port';
import type { TeamRoleSessionPort } from './ports/team-role-session-port';
import type { TeamRuntimeJobPort } from './team-runtime-jobs';
import type { TeamRuntimePort } from './team-runtime-port';
import type { TeamRuntimeStateStore } from './team-runtime-state-store';
import { TeamRunRegistry, isTerminalTeamRunStatus } from './team-run-registry';
import { buildTeamDependencyPlan } from './team-dependency-plan';
import { type TeamGraphDefinition, type TeamGraphEdgeDefinition, type TeamGraphNodeDefinition, type TeamGraphWorkflowGroupInput, type TeamGraphWorkNodeDefinition } from './graph/index';
import { createInitialTeamGraphRunState, reduceTeamGraphRunState, type TeamGraphEvent } from './graph/reducer';
import { scheduleReadyWorkNodeDeliveries, type TeamGraphControlNodeEffect, type TeamWorkNodeDelivery } from './graph/scheduler';
import { buildTeamGraphSnapshotProjection, buildTeamNodeDeliveryProjection, buildTeamNodeExecutionProjection, buildTeamNodeInputStateProjection } from './graph/projection';
import type { TeamGraphAttemptInputContext, TeamGraphNodeExecutionAttempt, TeamGraphNodeExecutionHistory, TeamGraphReadyQueueItem, TeamGraphRunState, TeamNodeResult } from './graph/run-state';
import { exportTeamGraphDefinitionYaml, parseTeamGraphDefinitionYaml } from './graph/export-yaml';
import { readStartNodeTrigger, type TeamGraphStartTrigger } from './graph/definition';

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

type TeamSourceType = 'teamskill' | 'manual';

type ManualTeamMemberProvisionInput = {
  readonly agentId: string;
  readonly agentName: string;
  readonly workspace: string;
  readonly roleId: string;
  readonly skills: readonly string[];
  readonly tools: readonly string[];
  readonly model?: string;
  readonly isLeader: boolean;
};

type ManualTeamProvisionInput = {
  readonly name: string;
  readonly description: string;
  readonly version: string;
  readonly members: readonly ManualTeamMemberProvisionInput[];
};

export interface TeamRuntimeServiceDeps {
  readonly commandLedger?: TeamCommandLedgerPort;
  readonly stateStore?: TeamRuntimeStateStore;
  readonly packageService?: TeamRuntimePackagePort;
  readonly skillCatalog?: TeamSkillCatalogPort;
  readonly agentMaterialization?: TeamAgentMaterializationPort;
  readonly roleSessions?: TeamRoleSessionPort;
  readonly nodePromptDelivery?: TeamNodePromptDeliveryPort;
  readonly jobs?: TeamRuntimeJobPort;
  readonly nowMs?: () => number;
  readonly randomId?: () => string;
  readonly shardCount?: number;
}

type TeamApprovalStatus = 'pending' | 'approved' | 'denied' | 'aborted';
type TeamDecisionType = 'retry' | 'proceed_degraded' | 'abort';
type TeamDispatchTaskStatus = 'queued' | 'completed' | 'failed' | 'cancelled' | 'stale';
type TeamGateStatus = 'open' | 'passed' | 'failed';
type TeamAgentCommandReceipt = {
  readonly success: true;
  readonly runId: string;
  readonly accepted: boolean;
  readonly record: TeamAgentCommandLedgerRecord;
  readonly snapshot: TeamRunSnapshot;
};

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

type TeamGraphSnapshot = ReturnType<typeof buildTeamGraphSnapshotProjection>;
type TeamGraphNodeInputStateProjection = ReturnType<typeof buildTeamNodeInputStateProjection>[number];
type TeamNodeExecutionProjection = ReturnType<typeof buildTeamNodeExecutionProjection>[number];
type TeamNodeDeliveryProjection = ReturnType<typeof buildTeamNodeDeliveryProjection>[number];
type TeamGraphContextView = 'current_node' | 'graph_summary';

type TeamGraphContextProjection = {
  fieldGuide: Record<string, string>;
  run: Pick<TeamRunRecord, 'runId' | 'status' | 'revision' | 'updatedAt'> & { readonly teamId?: string };
  view: TeamGraphContextView;
  graph: {
    readonly graphId?: string;
    readonly workflowPlanId?: string;
    readonly title?: string;
    readonly status?: string;
    readonly nodeCount: number;
    readonly edgeCount: number;
    readonly nodes: Array<{
      readonly nodeId: string;
      readonly kind: string;
      readonly title: string;
      readonly roleId?: string;
      readonly status?: string;
      readonly nodeExecutionId?: string;
      readonly attemptNumber?: number;
      readonly outputPort?: string;
      readonly summary?: string;
    }>;
    readonly edges: Array<{
      readonly edgeId: string;
      readonly sourceNodeId: string;
      readonly sourcePort: string;
      readonly targetNodeId: string;
      readonly targetPort: string;
      readonly status: 'satisfied' | 'waiting';
      readonly action: string;
      readonly payload: Record<string, unknown>;
    }>;
  } | null;
  currentNode?: {
    readonly nodeId: string;
    readonly kind: string;
    readonly title: string;
    readonly roleId?: string;
    readonly nodeExecutionId: string;
    readonly status: string;
    readonly attemptNumber: number;
    readonly reason?: string;
    readonly inputContexts: TeamGraphAttemptInputContext[];
    readonly outputArtifactIds: string[];
    readonly outputPort?: string;
    readonly summary?: string;
    readonly incomingEdges: Array<{ readonly edgeId: string; readonly sourceNodeId: string; readonly sourcePort: string; readonly targetPort: string; readonly action: string; readonly payload: Record<string, unknown> }>;
    readonly outgoingEdges: Array<{ readonly edgeId: string; readonly targetNodeId: string; readonly sourcePort: string; readonly targetPort: string; readonly action: string; readonly payload: Record<string, unknown> }>;
  };
  nodeInputStates: TeamGraphNodeInputStateProjection[];
  pendingApprovals: TeamApprovalProjection[];
  recentEvents: TeamEventProjection[];
};

type TeamRunSnapshot = {
  run: TeamRunRecord | null;
  graph: TeamGraphSnapshot | null;
  nodeInputStates: TeamGraphNodeInputStateProjection[];
  nodeExecutions: TeamNodeExecutionProjection[];
  nodeDeliveries: TeamNodeDeliveryProjection[];
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
  nodePromptDeliveries: TeamNodePromptDeliveryRecord[];
  gates: TeamGateProjection[];
  kickbacks: TeamKickbackProjection[];
  decisions: TeamDecisionProjection[];
  diagnostics: TeamRunDiagnosticsProjection;
  events: TeamEventProjection[];
  nextEventCursor: number;
};

export type TeamArmedTriggerDescriptor = {
  runId: string;
  teamId?: string;
  startNodeId: string;
  trigger: TeamGraphStartTrigger;
};

type TeamWorkflowGroupPlan = {
  readonly groupId: string;
  readonly title: string;
  readonly taskIds: readonly string[];
  readonly join: {
    readonly requireCompleted: boolean;
    readonly allowFailed: boolean;
    readonly retryLimit: number;
  };
};

type TeamWorkflowTaskPlan = {
  readonly taskId: string;
  readonly roleId: string;
  readonly title: string;
  readonly prompt: string;
  readonly dependsOnTaskIds?: readonly string[];
  readonly outputArtifactKind?: string;
};

type TeamTriggerSourceKind = 'cron' | 'webhook';
type TeamMessageKind = 'note' | 'question' | 'kickback';

type TeamFailureItem = {
  readonly code: string;
  readonly message: string;
  readonly severity?: 'info' | 'warning' | 'blocker';
  readonly evidenceRefs?: readonly TeamEvidenceRef[];
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
  graphRunState: TeamGraphRunState | null;
  nodeDeliveries: TeamWorkNodeDelivery[];
  roleBindings: TeamRoleSessionBinding[];
  workflowPlan: TeamWorkflowPlanProjection | null;
  dispatchGroups: TeamDispatchGroupProjection[];
  dispatchTasks: TeamDispatchTaskProjection[];
  dispatches: TeamDispatchProjection[];
  dispatchExecutions: TeamDispatchExecutionProjection[];
  approvals: TeamApprovalProjection[];
  artifacts: TeamArtifactProjection[];
  messages: TeamMessageProjection[];
  nodePromptDeliveries: TeamNodePromptDeliveryRecord[];
  gates: TeamGateProjection[];
  kickbacks: TeamKickbackProjection[];
  decisions: TeamDecisionProjection[];
  events: TeamEventProjection[];
  processedIdempotencyKeys: Set<string>;
};

type NodePromptDeliveryResult = { status: 'delivered' | 'failed' | 'retry_scheduled'; reason?: string; deliveredAt?: number };

type TeamNodePromptDispatchRequest = {
  readonly graphDelivery: TeamWorkNodeDelivery;
  readonly task: TeamDispatchTaskProjection;
  readonly attemptTask: TeamDispatchTaskProjection;
  readonly binding: TeamRoleSessionBinding;
  readonly attemptKey: string;
  readonly nodePromptDelivery: TeamNodePromptDeliveryRecord;
};

const DEFAULT_SHARD_COUNT = 4;
const TEAM_NODE_PROMPT_DELIVERY_MAX_ATTEMPTS = 3;
const TEAM_NODE_PROMPT_DELIVERY_RETRY_DELAY_MS = 30_000;
const TEAM_DISPATCH_MAX_ACTIVE_ROLE_PROMPTS = 2;
const LOG_TEXT_LIMIT = 240;
const TEAM_GRAPH_CONTEXT_FIELD_GUIDE: Record<string, string> = {
  'fieldGuide': 'Static field documentation for this team_graph_context response. These entries describe response fields and field-level boundaries; they are not runtime state.',
  'run': 'Compact TeamRun identity and lifecycle summary from runtime-host.',
  'run.status': 'Current TeamRun lifecycle status. It is not the status of every graph node.',
  'view': 'The requested context shape. graph_summary is for graph-level inspection; current_node is for a specific nodeExecutionId.',
  'graph': 'Compact graph topology and latest node/edge statuses. It omits full node config, prompts, executors, metadata, artifacts, and session messages.',
  'graph.nodes[]': 'One compact entry per graph node for graph_summary. For current_node view, only nodes with a latest non-pending attempt are returned.',
  'graph.nodes[].status': 'Latest attempt status for that node. It may be absent when the node has not executed yet.',
  'graph.nodes[].nodeExecutionId': 'Latest execution id projected for that node when available. currentNode.nodeExecutionId is the focused execution id when currentNode is present.',
  'graph.edges[]': 'Directed graph edges between nodes. sourcePort describes the branch produced by the source node; targetPort describes the input port on the target node.',
  'graph.edges[].status': 'satisfied means the source node has produced this sourcePort. waiting means this edge is not yet satisfied.',
  'graph.edges[].action': 'Event rule selected by the source output: activate, rework, gate, or finish.',
  'graph.edges[].payload.includeUpstreamResult': 'Whether this edge carries the upstream NodeResult into the downstream attempt prompt context.',
  'currentNode': 'Focused node execution context. Present only when nodeExecutionId is provided and belongs to the current graph state.',
  'currentNode.status': 'Current execution status for the requested nodeExecutionId.',
  'currentNode.inputContexts': 'Edge-scoped upstream contexts carried into this attempt. This replaces legacy input counters.',
  'currentNode.outputArtifactIds': 'Artifact ids already attached as outputs to this execution. Empty means no output artifact is projected in this compact context.',
  'currentNode.incomingEdges': 'Edges that provide inputs into currentNode.',
  'currentNode.outgoingEdges': 'Edges that may be selected by currentNode outputPort on complete/reject.',
  'nodeInputStates': 'Reducer-derived node input state from edge actions. It describes waiting and arrived activation edges for compact graph context.',
  'pendingApprovals': 'Human approvals that are still pending for this run.',
  'recentEvents': 'Last 20 TeamRun events for local context only. This is not a full audit log.',
};

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

export class TeamRuntimeService implements TeamRuntimePort {
  readonly runRegistry: TeamRunRegistry;
  private readonly router: TeamRuntimeRouter;

  constructor(deps: TeamRuntimeServiceDeps) {
    this.runRegistry = new TeamRunRegistry();
    this.router = new TeamRuntimeRouter(deps, this.runRegistry);
  }

  async rehydrateActiveRuns(): Promise<{ success: true; restoredRunIds: string[]; activeRunIds: string[]; skippedTerminalRunIds: string[] }> {
    return await this.router.rehydrateActiveRuns();
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
      case 'team.triggerList':
        return ok(await this.router.listArmedTriggers());
      case 'team.webhookTriggerFire':
        return await this.router.fireWebhookTrigger(params, scope);
      case 'team.runSnapshot':
        return ok(await this.router.forInput(params).readSnapshot(params));
      case 'team.graphSave':
        return ok(await this.router.forInput(params).saveGraphConfig(params));
      case 'team.graphPatch':
        return ok(await this.router.forInput(params).submitGraphPatch(params, scope));
      case 'team.graphContext':
        return ok(await this.router.forInput(params).readGraphContext(params));
      case 'team.graphExportYaml':
        return ok(await this.router.forInput(params).exportGraphYaml(params));
      case 'team.graphImportYaml':
        return ok(await this.router.forInput(params).importGraphYaml(params));
      case 'team.triggerFire':
        return ok(await this.router.forInput(params).fireTrigger(params, scope));
      case 'team.roleMessageSubmit':
        return ok(await this.router.forInput(params).submitRoleMessage(params));
      case 'team.nodePromptRetryDue':
        return ok(await this.router.forInput(params).retryDueNodePrompts(params));
      case 'team.nodeEvent':
        return ok(await this.router.forInput(params).submitNodeEvent(params, scope));
      case 'team.runDiagnostics':
        return ok((await this.router.forInput(params).readSnapshot(params)).diagnostics);
      case 'team.runDecisionSubmit':
        return ok(await this.router.forInput(params).submitDecision(params));
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
      commandLedger: deps.commandLedger,
      teamInstances: this.teamInstances,
      stateStore: deps.stateStore,
      packageService: deps.packageService,
      agentMaterialization: deps.agentMaterialization,
      roleSessions: deps.roleSessions,
      nodePromptDelivery: deps.nodePromptDelivery,
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
    const sourceType = readTeamSourceType(input.sourceType);
    if (!this.deps.agentMaterialization) {
      throw new Error('Team agent materialization is required to provision Team managed agents');
    }
    if (!scope || !('endpoint' in scope)) {
      throw new Error('Runtime endpoint is required to provision Team managed agents');
    }
    requireString(input, 'idempotencyKey');

    if (sourceType === 'manual') {
      const manualTeam = readManualTeamProvisionInput(input.manualTeam);
      return await this.teamInstances.provisionManualAgents({
        teamId: readString(input.teamId) ?? manualTeam.name,
        packagePath,
        manualTeam,
        endpoint: scope.endpoint,
      });
    }

    const validation = this.deps.packageService ? await this.deps.packageService.validate(packagePath) : null;
    if (validation && !validation.valid) {
      throw new Error(`TeamSkill package is invalid: ${JSON.stringify(validation.errors)}`);
    }
    if (!validation?.package) {
      throw new Error('TeamSkill package is required to provision Team managed agents');
    }

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
    const runs = await Promise.all((teamInstance?.runs ?? []).map(async (runRecord) => (
      toTeamInstanceRunRecord(await this.forRun(runRecord.runId).loadRunState() ?? runRecord, runRecord.sessions)
    )));
    return {
      teamId,
      runs: runs.sort(compareTeamInstanceRunsByRecentUpdate),
    };
  }

  async listArmedTriggers(): Promise<{ triggers: TeamArmedTriggerDescriptor[] }> {
    const runIds = this.runRegistry.listNonTerminalRunIds();
    const triggers: TeamArmedTriggerDescriptor[] = [];
    for (const runId of runIds) {
      triggers.push(...(await this.forRun(runId).listArmedTriggers()));
    }
    return { triggers };
  }

  async fireWebhookTrigger(params: unknown, scope?: RuntimeScope): Promise<ApplicationResponseOf> {
    const input = readRecord(params);
    const webhookPath = normalizeWebhookPath(requireString(input, 'webhookPath'));
    if (!webhookPath) return badRequest('TeamRun webhook path is required');
    const matches = (await this.listArmedTriggers()).triggers
      .filter((trigger) => trigger.trigger.mode === 'webhook' && normalizeWebhookPath(trigger.trigger.path) === webhookPath);
    if (matches.length === 0) {
      return { status: 404, data: { success: false, error: 'No armed TeamRun webhook trigger matches this path.' } };
    }
    if (matches.length > 1) {
      return { status: 409, data: { success: false, error: 'Multiple armed TeamRun webhook triggers match this path; make StartNode webhook paths unique.' } };
    }

    const trigger = matches[0]!;
    const idempotencyKey = readString(input.idempotencyKey)
      ?? `team-webhook-request:${(this.deps.randomId ?? (() => crypto.randomUUID()))()}`;
    return ok(await this.forRun(trigger.runId).fireTrigger({
      runId: trigger.runId,
      ...(trigger.teamId ? { teamId: trigger.teamId } : {}),
      startNodeId: trigger.startNodeId,
      triggerSource: 'webhook',
      idempotencyKey,
      ...optionalStringProperty(input, 'payloadSummary'),
      ...optionalStringProperty(input, 'deterministicBodyHash'),
      ...optionalDefinedProperty('payload', readRecordOrUndefined(input.payload)),
    }, scope));
  }

  async rehydrateActiveRuns(): Promise<{ success: true; restoredRunIds: string[]; activeRunIds: string[]; skippedTerminalRunIds: string[] }> {
    const restoredRunIds: string[] = [];
    const activeRunIds: string[] = [];
    const skippedTerminalRunIds: string[] = [];
    const instances = await this.teamInstances.listTeamInstances();
    for (const teamInstance of instances) {
      for (const runRecord of teamInstance.runs) {
        const run = await this.forRun(runRecord.runId).loadRunState();
        const effectiveRun = run ?? runRecord;
        restoredRunIds.push(runRecord.runId);
        if (isTerminalTeamRunStatus(effectiveRun.status)) {
          skippedTerminalRunIds.push(runRecord.runId);
        } else {
          this.runRegistry.upsert(toTeamRunRegistryRecord(effectiveRun));
          activeRunIds.push(runRecord.runId);
        }
      }
    }
    return { success: true, restoredRunIds, activeRunIds, skippedTerminalRunIds };
  }

  async resumeTeam(params: unknown): Promise<{ success: true; teamId: string; restoredRunIds: string[]; activeRunIds: string[]; skippedTerminalRunIds: string[]; runs: TeamInstanceRunRecord[] }> {
    const input = readRecord(params);
    const teamId = requireString(input, 'teamId');
    requireString(input, 'idempotencyKey');
    const teamInstance = await this.teamInstances.readTeamInstance(teamId);
    const restoredRunIds: string[] = [];
    const activeRunIds: string[] = [];
    const skippedTerminalRunIds: string[] = [];
    const runs: TeamInstanceRunRecord[] = [];
    for (const runRecord of teamInstance?.runs ?? []) {
      const run = await this.forRun(runRecord.runId).loadRunState();
      const effectiveRun = run ?? runRecord;
      const effectiveRunRecord = toTeamInstanceRunRecord(effectiveRun, runRecord.sessions);
      runs.push(effectiveRunRecord);
      this.runRegistry.upsert(toTeamRunRegistryRecord(effectiveRun));
      restoredRunIds.push(runRecord.runId);
      if (isTerminalTeamRunStatus(effectiveRun.status)) {
        skippedTerminalRunIds.push(runRecord.runId);
      } else {
        activeRunIds.push(runRecord.runId);
      }
    }
    return { success: true, teamId, restoredRunIds, activeRunIds, skippedTerminalRunIds, runs: runs.sort(compareTeamInstanceRunsByRecentUpdate) };
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

  async listTeamInstances(): Promise<TeamInstance[]> {
    const stored = await this.deps.stateStore?.listTeamInstances();
    if (stored) return stored.map(deserializeTeamInstance);
    return Array.from(this.memoryTeamInstances.values()).map(cloneTeamInstance);
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
    const leaderSpec = buildLeaderMaterializationSpec();
    const roleSpecs = input.teamPackage.roles.map((role) => buildRoleMaterializationSpec(role));
    const materialized = await this.deps.agentMaterialization.materialize({
      teamId: input.teamId,
      endpoint: input.endpoint,
      sourceType: 'teamskill',
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
      sourceType: 'teamskill',
      managedAgents: materialized.managedAgents.map((agent) => ({ ...agent })),
      graphTemplate: existing?.graphTemplate ?? null,
      runs: existing?.runs ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.memoryTeamInstances.set(input.teamId, instance);
    await this.deps.stateStore?.writeTeamInstance(input.teamId, instance);
    return { teamId: input.teamId, managedAgentCount: materialized.managedAgents.length };
  }

  async provisionManualAgents(input: {
    readonly teamId: string;
    readonly packagePath: string;
    readonly manualTeam: ManualTeamProvisionInput;
    readonly endpoint: RuntimeEndpointRef;
  }): Promise<{ teamId: string; managedAgentCount: number }> {
    if (!this.deps.agentMaterialization) {
      throw new Error('Team agent materialization is required to provision Team managed agents');
    }
    const materializationSpec = buildManualTeamMaterializationSpec(input.teamId, input.endpoint, input.manualTeam);
    const materialized = await this.deps.agentMaterialization.materialize(materializationSpec);
    const now = this.deps.nowMs();
    const existing = await this.readTeamInstance(input.teamId);
    const instance: TeamInstance = {
      teamId: input.teamId,
      teamSkillName: input.manualTeam.name,
      teamSkillVersion: input.manualTeam.version,
      packagePath: input.packagePath,
      sourcePath: input.packagePath,
      sourceType: 'manual',
      managedAgents: materialized.managedAgents.map((agent) => ({ ...agent })),
      graphTemplate: existing?.graphTemplate ?? null,
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
    const teamId = input.run.teamId ?? input.run.packageName;
    const existing = await this.readTeamInstance(teamId);
    if (!existing) return;
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
      sourceType: existing.sourceType,
      managedAgents: existing.managedAgents,
      graphTemplate: existing.graphTemplate ?? null,
      runs: upsertTeamInstanceRun(existing?.runs ?? [], runRecord),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.memoryTeamInstances.set(teamId, instance);
    await this.deps.stateStore?.writeTeamInstance(teamId, instance);
  }

  async saveGraphTemplate(input: {
    readonly teamId: string;
    readonly definition: TeamGraphDefinition;
  }): Promise<void> {
    const existing = await this.readTeamInstance(input.teamId);
    if (!existing) return;
    await this.writeTeamInstanceGraphTemplate(existing, input.definition);
  }

  async resolveGraphTemplate(teamInstance: TeamInstance): Promise<TeamGraphDefinition | null> {
    if (teamInstance.graphTemplate) return cloneTeamGraphDefinition(teamInstance.graphTemplate);
    const legacyDefinition = await this.readLatestRunGraphDefinition(teamInstance.runs);
    if (!legacyDefinition) return null;
    await this.writeTeamInstanceGraphTemplate(teamInstance, legacyDefinition);
    return cloneTeamGraphDefinition(legacyDefinition);
  }

  private async writeTeamInstanceGraphTemplate(teamInstance: TeamInstance, definition: TeamGraphDefinition): Promise<void> {
    const nextInstance: TeamInstance = {
      ...teamInstance,
      graphTemplate: cloneTeamGraphDefinition(definition),
      updatedAt: this.deps.nowMs(),
    };
    this.memoryTeamInstances.set(teamInstance.teamId, nextInstance);
    await this.deps.stateStore?.writeTeamInstance(teamInstance.teamId, nextInstance);
  }

  private async readLatestRunGraphDefinition(runs: readonly TeamInstanceRunRecord[]): Promise<TeamGraphDefinition | null> {
    const runsByRecentUpdate = [...runs].sort(compareTeamInstanceRunsByRecentUpdate);
    for (const run of runsByRecentUpdate) {
      const stored = await this.deps.stateStore?.readRunState(run.runId);
      const definition = readRecordOrNull(readRecord(stored).graphRunState)?.definition;
      if (definition) return cloneTeamGraphDefinition(definition as TeamGraphDefinition);
    }
    return null;
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
    if (teamInstance.managedAgents.length === 0) {
      return [];
    }
    if (!this.deps.jobs) {
      throw new Error('Team runtime jobs are required to delete Team agent materialization');
    }
    const endpoint = scope && 'endpoint' in scope ? scope.endpoint : teamInstance.managedAgents[0]?.endpoint;
    if (!endpoint) {
      throw new Error(`Team endpoint is required to delete agent materialization for team ${teamInstance.teamId}`);
    }
    await this.deps.jobs.submitDeleteManagedAgents({
      teamId: teamInstance.teamId,
      endpoint,
      managedAgents: teamInstance.managedAgents.map((agent) => ({ ...agent })),
    });
    return collectTeamManagedAgentIds(teamInstance.managedAgents);
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
  readonly commandLedger?: TeamCommandLedgerPort;
  readonly teamInstances: TeamInstanceRegistry;
  readonly stateStore?: TeamRuntimeStateStore;
  readonly packageService?: TeamRuntimePackagePort;
  readonly agentMaterialization?: TeamAgentMaterializationPort;
  readonly roleSessions?: TeamRoleSessionPort;
  readonly nodePromptDelivery?: TeamNodePromptDeliveryPort;
  readonly runRegistry: TeamRunRegistry;
  readonly nowMs: () => number;
  readonly randomId: () => string;
};

class RunActor {
  private queuedWork: Promise<void> = Promise.resolve();
  private loaded = false;
  private readonly state: RunActorState = emptyRunActorState();

  constructor(private readonly deps: Required<Pick<RunActorDeps, 'runId' | 'shardIndex' | 'nowMs' | 'randomId'>> & Omit<RunActorDeps, 'runId' | 'shardIndex' | 'nowMs' | 'randomId'>) {}

  createRun(params: unknown): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const packagePath = requireString(input, 'packagePath');
      const runId = readString(input.runId) ?? this.deps.runId;
      const sourceType = readTeamSourceType(input.sourceType);
      const validation = sourceType === 'teamskill' && this.deps.packageService ? await this.deps.packageService.validate(packagePath) : null;
      if (validation && !validation.valid) {
        throw new Error(`TeamSkill package is invalid: ${JSON.stringify(validation.errors)}`);
      }
      const now = this.deps.nowMs();
      const requestedTeamId = readString(input.teamId);
      const teamId = requestedTeamId ?? validation?.package?.name ?? (lastPathSegment(packagePath) || 'team-skill');
      const existingTeamInstance = sourceType === 'manual' ? await this.deps.teamInstances.requireTeamInstance(teamId) : null;
      if (!this.state.run) {
        this.state.run = {
          teamId,
          runId,
          status: 'created',
          revision: 1,
          packageName: validation?.package?.name ?? existingTeamInstance?.teamSkillName ?? (lastPathSegment(packagePath) || 'team-skill'),
          packageVersion: validation?.package?.version ?? existingTeamInstance?.teamSkillVersion ?? '0.0.0',
          sourcePath: validation?.package?.sourcePath ?? existingTeamInstance?.sourcePath ?? packagePath,
          createdAt: now,
          updatedAt: now,
        };
      }
      const runTeamId = this.state.run.teamId ?? teamId;
      let teamInstance: TeamInstance | null = existingTeamInstance;
      let managedAgentsForRun: readonly TeamManagedAgentRecord[] = [];
      if (validation?.package) {
        const leaderSpec = buildLeaderMaterializationSpec();
        const roleSpecs = validation.package.roles.map((role) => buildRoleMaterializationSpec(role));
        teamInstance = await this.deps.teamInstances.requireTeamInstance(runTeamId);
        managedAgentsForRun = selectManagedAgentsForRoles(
          teamInstance.managedAgents,
          [leaderSpec, ...roleSpecs],
        );
      } else {
        teamInstance = teamInstance ?? await this.deps.teamInstances.readTeamInstance(runTeamId);
        managedAgentsForRun = teamInstance?.managedAgents ?? [];
      }
      const graphTemplate = teamInstance ? await this.deps.teamInstances.resolveGraphTemplate(teamInstance) : null;
      if (managedAgentsForRun.length > 0) {
        this.state.roleBindings = buildTeamRoleSessionBindingsFromManagedAgents({ teamId: runTeamId, runId, managedAgents: managedAgentsForRun });
      }
      if (!this.state.graphRunState && graphTemplate) {
        this.state.graphRunState = createInitialTeamGraphRunState({
          definition: instantiateTeamGraphTemplateForRun(graphTemplate, {
            runId,
            idempotencyKey: requireString(input, 'idempotencyKey'),
            nowMs: now,
          }),
          nowMs: now,
        });
        this.state.nodeDeliveries = [];
      }
      await this.flushState();
      return this.runSummary();
    });
  }

  cancelRun(params: unknown): Promise<{ runId: string; status: TeamRunStatus; revision: number }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const idempotencyKey = requireString(input, 'idempotencyKey');
      if (this.state.processedIdempotencyKeys.has(idempotencyKey)) return this.runSummary();
      this.ensureRun();
      await this.abortRunRoleSessions();
      this.cancelRunRuntimeState(this.deps.nowMs());
      this.updateRun({ status: 'cancelled' });
      this.appendEvent('run.cancelled', { reason: readString(input.reason) ?? 'cancelled' }, idempotencyKey);
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

  fireTrigger(params: unknown, _scope?: RuntimeScope): Promise<{ fired: boolean; snapshot: TeamRunSnapshot }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const idempotencyKey = requireString(input, 'idempotencyKey');
      if (this.state.processedIdempotencyKeys.has(idempotencyKey)) {
        return { fired: false, snapshot: this.buildSnapshot() };
      }
      this.applyTriggerFired({
        runId: this.deps.runId,
        idempotencyKey,
        createdAt: this.deps.nowMs(),
        startNodeId: requireString(input, 'startNodeId'),
        triggerSource: requireTriggerSource(input),
        ...optionalStringProperty(input, 'payloadSummary'),
        ...optionalStringProperty(input, 'deterministicBodyHash'),
        ...optionalDefinedProperty('payload', readRecordOrUndefined(input.payload)),
      });
      await this.dispatchReadyTasks();
      this.updateRunCompletionState();
      await this.flushState();
      return { fired: true, snapshot: this.buildSnapshot() };
    });
  }

  submitRoleMessage(params: unknown): Promise<{ submitted: boolean; snapshot: TeamRunSnapshot }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const idempotencyKey = requireString(input, 'idempotencyKey');
      if (this.state.processedIdempotencyKeys.has(idempotencyKey)) {
        return { submitted: false, snapshot: this.buildSnapshot() };
      }
      if (!this.state.run) {
        throw new Error(`TeamRun ${this.deps.runId} must exist before submitting a Team role message.`);
      }
      if (!this.deps.roleSessions) {
        throw new Error('Team role session runtime is required to submit a Team role message.');
      }

      const roleId = requireString(input, 'roleId');
      const text = requireTextInput(input, 'text');
      const binding = this.state.roleBindings.find((candidate) => candidate.roleId === roleId);
      if (!binding) {
        throw new Error(`TeamRun ${this.deps.runId} has no role session binding for role "${roleId}".`);
      }
      const entryDelivery = this.claimEntryReadyWorkNodeForRole({ roleId, attemptUserMessage: text });
      if (entryDelivery) {
        await this.dispatchWorkNodeDeliveries([entryDelivery]);
        this.appendEvent('entry_message.submitted', {
          roleId,
          sessionKey: binding.sessionKey,
          nodeId: entryDelivery.nodeId,
          nodeExecutionId: entryDelivery.nodeExecutionId,
          attemptNumber: entryDelivery.attemptNumber,
          textLength: text.length,
        }, idempotencyKey);
        await this.flushState();
        return { submitted: true, snapshot: this.buildSnapshot() };
      }

      const prompt = await this.deps.roleSessions.promptRoleSession({
        binding,
        message: appendTeamRunWorkspaceContext(text, { run: this.state.run, binding }),
        displayMessage: text,
        idempotencyKey,
      });
      this.appendEvent('role_message.submitted', {
        roleId,
        sessionKey: prompt.sessionKey,
        promptRunId: prompt.promptRunId,
        textLength: text.length,
      }, idempotencyKey);
      await this.flushState();
      return { submitted: true, snapshot: this.buildSnapshot() };
    });
  }

  saveGraphConfig(params: unknown): Promise<{ success: true; runId: string; saved: boolean; snapshot: TeamRunSnapshot }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const idempotencyKey = requireString(input, 'idempotencyKey');
      if (!this.state.run) {
        throw new Error(`TeamRun ${this.deps.runId} must exist before saving graph config.`);
      }
      if (this.state.processedIdempotencyKeys.has(idempotencyKey)) {
        return { success: true, runId: this.deps.runId, saved: false, snapshot: this.buildSnapshot() };
      }
      const definition = readTeamGraphDefinitionInput(readRecord(input.graph), {
        runId: this.deps.runId,
        idempotencyKey,
        nowMs: this.deps.nowMs(),
        existingDefinition: this.state.graphRunState?.definition ?? null,
        workflowPlan: this.state.workflowPlan,
        definitionStatusSource: 'preserve-existing',
      });
      if (this.state.graphRunState && isLayoutOnlyTeamGraphDefinitionChange(this.state.graphRunState.definition, definition)) {
        this.state.graphRunState = { ...this.state.graphRunState, definition };
      } else {
        this.state.graphRunState = createInitialTeamGraphRunState({ definition, nowMs: definition.createdAt });
        this.state.nodeDeliveries = [];
      }
      this.appendEvent('graph.config_saved', {
        graphId: definition.graphId,
        workflowPlanId: definition.workflowPlanId,
        nodeCount: definition.nodes.length,
        edgeCount: definition.edges.length,
      }, idempotencyKey);
      this.updateRunCompletionState();
      await this.deps.teamInstances.saveGraphTemplate({
        teamId: this.state.run.teamId ?? this.state.run.packageName,
        definition,
      });
      await this.flushState();
      return { success: true, runId: this.deps.runId, saved: true, snapshot: this.buildSnapshot() };
    });
  }

  importGraphYaml(params: unknown): Promise<{ success: true; runId: string; imported: boolean; snapshot: TeamRunSnapshot }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      const idempotencyKey = requireString(input, 'idempotencyKey');
      if (!this.state.run) {
        throw new Error(`TeamRun ${this.deps.runId} must exist before importing graph YAML.`);
      }
      if (this.state.processedIdempotencyKeys.has(idempotencyKey)) {
        return { success: true, runId: this.deps.runId, imported: false, snapshot: this.buildSnapshot() };
      }
      const definition = readTeamGraphDefinitionInput(parseTeamGraphDefinitionYaml(requireTextInput(input, 'yaml')), {
        runId: this.deps.runId,
        idempotencyKey,
        nowMs: this.deps.nowMs(),
        existingDefinition: this.state.graphRunState?.definition ?? null,
        workflowPlan: this.state.workflowPlan,
        definitionStatusSource: 'input',
      });
      if (this.state.graphRunState && isLayoutOnlyTeamGraphDefinitionChange(this.state.graphRunState.definition, definition)) {
        this.state.graphRunState = { ...this.state.graphRunState, definition };
      } else {
        this.state.graphRunState = createInitialTeamGraphRunState({ definition, nowMs: definition.createdAt });
        this.state.nodeDeliveries = [];
      }
      this.appendEvent('graph.yaml_imported', {
        graphId: definition.graphId,
        workflowPlanId: definition.workflowPlanId,
        nodeCount: definition.nodes.length,
        edgeCount: definition.edges.length,
      }, idempotencyKey);
      this.updateRunCompletionState();
      await this.deps.teamInstances.saveGraphTemplate({
        teamId: this.state.run.teamId ?? this.state.run.packageName,
        definition,
      });
      await this.flushState();
      return { success: true, runId: this.deps.runId, imported: true, snapshot: this.buildSnapshot() };
    });
  }

  submitGraphPatch(params: unknown, scope?: RuntimeScope): Promise<TeamAgentCommandReceipt> {
    return this.enqueue(async () => {
      const command = readTeamGraphPatchCommand(readRecord(params), {
        runId: this.deps.runId,
        sourceEndpoint: scope && 'endpoint' in scope ? scope.endpoint : { kind: 'native-runtime', runtimeAdapterId: 'runtime-host', runtimeInstanceId: 'local' },
        nowMs: this.deps.nowMs(),
        commandId: `team-command-${this.deps.randomId()}`,
      });
      const existing = this.state.processedIdempotencyKeys.has(command.idempotencyKey);
      if (!existing) {
        try {
          this.applyGraphPatchCommand(command);
        } catch (error) {
          await this.rejectCommand(command, safeErrorMessage(error));
          throw error;
        }
        const record = await this.appendAcceptedCommand(command);
        rejectIfExistingCommandWasRejected(record);
        await this.flushState();
        return { success: true, runId: this.deps.runId, accepted: true, record, snapshot: this.buildSnapshot() };
      }
      const record = await this.appendAcceptedCommand(command);
      rejectIfExistingCommandWasRejected(record);
      return { success: true, runId: this.deps.runId, accepted: false, record, snapshot: this.buildSnapshot() };
    });
  }

  submitNodeEvent(params: unknown, scope?: RuntimeScope): Promise<TeamAgentCommandReceipt> {
    return this.enqueue(async () => {
      const command = readTeamNodeEventCommand(readRecord(params), {
        runId: this.deps.runId,
        sourceEndpoint: scope && 'endpoint' in scope ? scope.endpoint : { kind: 'native-runtime', runtimeAdapterId: 'runtime-host', runtimeInstanceId: 'local' },
        nowMs: this.deps.nowMs(),
        commandId: `team-command-${this.deps.randomId()}`,
      });
      const existing = this.state.processedIdempotencyKeys.has(command.idempotencyKey);
      if (!existing) {
        try {
          await this.applyNodeEventCommand(command);
        } catch (error) {
          await this.rejectCommand(command, safeErrorMessage(error));
          throw error;
        }
        const record = await this.appendAcceptedCommand(command);
        rejectIfExistingCommandWasRejected(record);
        await this.dispatchReadyTasks();
        this.updateRunCompletionState();
        await this.flushState();
        return { success: true, runId: this.deps.runId, accepted: true, record, snapshot: this.buildSnapshot() };
      }
      const record = await this.appendAcceptedCommand(command);
      rejectIfExistingCommandWasRejected(record);
      return { success: true, runId: this.deps.runId, accepted: false, record, snapshot: this.buildSnapshot() };
    });
  }

  exportGraphYaml(params: unknown): Promise<{ runId: string; fileName: string; yaml: string }> {
    return this.enqueue(async () => {
      const input = readRecord(params);
      requireString(input, 'runId');
      if (!this.state.run) {
        throw new Error(`TeamRun ${this.deps.runId} must exist before exporting graph YAML.`);
      }
      if (!this.state.graphRunState) {
        throw new Error(`TeamRun ${this.deps.runId} has no saved graph to export. Save the TeamRun graph before exporting YAML.`);
      }
      const { fileName, yaml } = exportTeamGraphDefinitionYaml(this.state.graphRunState.definition);
      return { runId: this.deps.runId, fileName, yaml };
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
      const approvalNode = this.state.graphRunState?.definition.nodes.find((node) => node.nodeId === approval.stageId);
      if (this.state.graphRunState && approvalNode?.kind === 'human_decision' && approval.approvalId === graphHumanApprovalId(approvalNode.nodeId)) {
        this.state.graphRunState = reduceTeamGraphRunState(this.state.graphRunState, {
          type: 'node.completed',
          nodeId: approval.stageId,
          completedAt: approval.resolvedAt,
          outputPort: decision === 'approve' ? 'approved' : decision === 'deny' ? 'rejected' : 'aborted',
          summary: status,
          metadata: { approvalId, decision },
        });
      }
      this.appendEvent('approval.resolved', { approvalId, decision, status }, requireString(input, 'idempotencyKey'));
      await this.dispatchReadyTasks();
      this.updateRunCompletionState();
      await this.flushState();
      return { success: true, runId: this.deps.runId, approvalId, decision, status, approval, snapshot: this.buildSnapshot() };
    });
  }

  loadRunState(): Promise<TeamRunRecord | null> {
    return this.enqueue(() => (this.state.run ? { ...this.state.run } : null));
  }

  listArmedTriggers(): Promise<TeamArmedTriggerDescriptor[]> {
    return this.enqueue(() => {
      const definition = this.state.graphRunState?.definition;
      const run = this.state.run;
      if (!definition || !run || isTerminalTeamRunStatus(run.status)) return [];
      const descriptors: TeamArmedTriggerDescriptor[] = [];
      for (const node of definition.nodes) {
        const trigger = readStartNodeTrigger(node);
        if (!trigger) continue;
        descriptors.push({
          runId: run.runId,
          ...optionalDefinedProperty('teamId', run.teamId),
          startNodeId: node.nodeId,
          trigger,
        });
      }
      return descriptors;
    });
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

  readGraphContext(params: unknown): Promise<TeamGraphContextProjection> {
    return this.enqueue(() => {
      const input = readRecord(params);
      return this.buildGraphContext({
        view: readGraphContextView(input.view),
        nodeExecutionId: readString(input.nodeExecutionId) ?? undefined,
      });
    });
  }

  retryDueNodePrompts(_params: unknown): Promise<{ processedDeliveryRecordIds: string[]; nextRetryAt: number | null; snapshot: TeamRunSnapshot }> {
    return this.enqueue(async () => {
      const now = this.deps.nowMs();
      const dueDeliveryRecordIds = new Set(this.state.nodePromptDeliveries
        .filter((delivery) => delivery.status === 'retry_scheduled' && (delivery.nextRetryAt ?? 0) <= now)
        .map((delivery) => delivery.deliveryRecordId));
      await this.deliverRetryableNodePrompts();
      this.updateRunCompletionState();
      await this.flushState();
      return {
        processedDeliveryRecordIds: this.state.nodePromptDeliveries
          .filter((delivery) => dueDeliveryRecordIds.has(delivery.deliveryRecordId) && delivery.status !== 'retry_scheduled')
          .map((delivery) => delivery.deliveryRecordId),
        nextRetryAt: nextRetryAtForNodePromptDeliveries(this.state.nodePromptDeliveries),
        snapshot: this.buildSnapshot(),
      };
    });
  }

  private applyGraphPatchCommand(command: TeamGraphPatchCommand): void {
    if (!this.state.run) throw new Error(`TeamRun ${this.deps.runId} must exist before applying graph patch.`);
    if (!this.state.graphRunState) throw new Error(`TeamRun ${this.deps.runId} has no graph to patch. Save the TeamRun graph before submitting graph patches.`);
    if (command.patch.operations.length === 0) throw new Error('Team graph patch operations must be a non-empty array.');
    const definition = readTeamGraphDefinitionInput(applyTeamGraphPatch(this.state.graphRunState.definition, command.patch.operations), {
      runId: this.deps.runId,
      idempotencyKey: command.idempotencyKey,
      nowMs: command.createdAt,
      existingDefinition: this.state.graphRunState.definition,
      workflowPlan: this.state.workflowPlan,
      definitionStatusSource: 'preserve-existing',
    });
    if (isLayoutOnlyTeamGraphDefinitionChange(this.state.graphRunState.definition, definition)) {
      this.state.graphRunState = { ...this.state.graphRunState, definition };
    } else {
      this.state.graphRunState = createInitialTeamGraphRunState({ definition, nowMs: definition.createdAt });
      this.state.nodeDeliveries = [];
    }
    this.appendEvent('graph.patch_applied', { commandId: command.commandId, summary: command.summary, operationCount: command.patch.operations.length }, command.idempotencyKey, command.createdAt);
    this.updateRunCompletionState();
  }

  private async applyNodeEventCommand(command: TeamNodeEventCommand): Promise<void> {
    if (!this.state.run) throw new Error(`TeamRun ${this.deps.runId} must exist before accepting node events.`);
    const graphRunState = this.state.graphRunState;
    if (!graphRunState) throw new Error(`TeamRun ${this.deps.runId} has no graph for node event ${command.nodeExecutionId}.`);
    const nodeExecution = findCurrentNodeExecutionById(graphRunState, command.nodeExecutionId);
    if (!nodeExecution) throw new Error(`nodeExecutionId ${command.nodeExecutionId} does not belong to the current TeamRun graph state.`);
    const node = graphRunState.definition.nodes.find((candidate) => candidate.nodeId === nodeExecution.nodeId);
    if (!node) throw new Error(`nodeExecutionId ${command.nodeExecutionId} references missing node ${nodeExecution.nodeId}.`);
    if (command.roleId && node.roleId && command.roleId !== node.roleId) throw new Error(`roleId must match node roleId ${node.roleId}.`);

    switch (command.event) {
      case 'progress':
        this.appendEvent('node.progress', { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, nodeId: node.nodeId, summary: command.summary, metadata: command.metadata ?? {} }, command.idempotencyKey, command.createdAt);
        return;
      case 'request_input':
        this.state.graphRunState = reduceTeamGraphRunState(graphRunState, { type: 'node.waiting', nodeId: node.nodeId, waitingAt: command.createdAt, reason: command.summary, metadata: { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, ...(command.metadata ?? {}) } });
        this.updateRun({ status: 'waiting_for_user' });
        this.appendEvent('node.input_requested', { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, nodeId: node.nodeId, summary: command.summary }, command.idempotencyKey, command.createdAt);
        return;
      case 'request_approval':
        this.upsertNodeEventApproval(command, node.nodeId, node.roleId ?? command.roleId ?? 'agent');
        this.state.graphRunState = reduceTeamGraphRunState(graphRunState, { type: 'node.waiting', nodeId: node.nodeId, waitingAt: command.createdAt, reason: 'waiting_for_approval', metadata: { commandId: command.commandId, approvalId: `team-approval-${command.idempotencyKey}` } });
        this.updateRun({ status: 'waiting_for_user' });
        this.appendEvent('node.approval_requested', { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, nodeId: node.nodeId, summary: command.summary }, command.idempotencyKey, command.createdAt);
        return;
      case 'reject':
        this.state.graphRunState = reduceTeamGraphRunState(graphRunState, { type: 'node.failed', nodeId: node.nodeId, failedAt: command.createdAt, outputPort: command.outputPort ?? 'failed', reason: command.summary, result: command.result, metadata: { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, ...(command.metadata ?? {}) } });
        this.markDispatchForNodeEvent(node, 'failed', command.summary, undefined);
        this.appendEvent('node.rejected', { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, nodeId: node.nodeId, summary: command.summary }, command.idempotencyKey, command.createdAt);
        return;
      case 'complete': {
        const artifact = buildNodeEventCompletionArtifact(command, node);
        this.state.graphRunState = reduceTeamGraphRunState(graphRunState, { type: 'node.completed', nodeId: node.nodeId, completedAt: command.createdAt, outputPort: command.outputPort, summary: command.summary, result: command.result, metadata: { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, artifactId: artifact.artifactId, ...(command.metadata ?? {}) } });
        this.state.artifacts.push(artifact);
        this.markDispatchForNodeEvent(node, 'completed', command.summary, artifact.artifactId);
        this.appendEvent('node.completed', { commandId: command.commandId, nodeExecutionId: command.nodeExecutionId, nodeId: node.nodeId, artifactId: artifact.artifactId, summary: command.summary }, command.idempotencyKey, command.createdAt);
        return;
      }
    }
  }

  private upsertNodeEventApproval(command: TeamNodeEventCommand, nodeId: string, roleId: string): void {
    const approval: TeamApprovalProjection = {
      approvalId: `team-approval-${command.idempotencyKey}`,
      runId: this.deps.runId,
      stageId: nodeId,
      roleId,
      reason: command.summary,
      requestedAction: command.requestedAction ?? command.summary,
      risk: command.risk ?? 'agent requested approval',
      status: 'pending',
      idempotencyKey: command.idempotencyKey,
      createdAt: command.createdAt,
    };
    const index = this.state.approvals.findIndex((candidate) => candidate.approvalId === approval.approvalId);
    if (index >= 0) this.state.approvals[index] = approval;
    else this.state.approvals.push(approval);
  }

  private markDispatchForNodeEvent(node: TeamGraphNodeDefinition, status: 'completed' | 'failed', summary: string, artifactId: string | undefined): void {
    for (const task of this.state.dispatchTasks) {
      if (task.taskId === node.taskId || task.taskId === node.nodeId) {
        task.status = status;
        task.completedAt = this.deps.nowMs();
        task.statusReason = summary;
        if (artifactId) task.artifactId = artifactId;
      }
    }
    for (const execution of this.state.dispatchExecutions) {
      if (execution.stageId === node.taskId || execution.stageId === node.nodeId) {
        execution.status = status;
        execution.statusReason = summary;
      }
    }
  }

  private async appendAcceptedCommand(command: TeamAgentCommand): Promise<TeamAgentCommandLedgerRecord> {
    if (!this.deps.commandLedger) throw new Error('Team command ledger is required to accept agent commands.');
    return await this.deps.commandLedger.append({ command, status: 'accepted' });
  }

  private async appendRejectedCommand(command: TeamAgentCommand, rejectionReason: string): Promise<TeamAgentCommandLedgerRecord> {
    if (!this.deps.commandLedger) throw new Error('Team command ledger is required to reject agent commands.');
    return await this.deps.commandLedger.append({ command, status: 'rejected', rejectionReason });
  }

  private async rejectCommand(command: TeamAgentCommand, rejectionReason: string): Promise<never> {
    await this.appendRejectedCommand(command, rejectionReason);
    this.state.processedIdempotencyKeys.add(command.idempotencyKey);
    await this.flushState();
    throw new Error(rejectionReason);
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

  private applyTriggerFired(input: {
    readonly runId: string;
    readonly startNodeId: string;
    readonly triggerSource: TeamTriggerSourceKind;
    readonly payloadSummary?: string;
    readonly deterministicBodyHash?: string;
    readonly payload?: Record<string, unknown>;
    readonly idempotencyKey: string;
    readonly createdAt: number;
  }): void {
    if (!this.state.graphRunState) {
      throw new Error(`Cannot fire trigger for run "${input.runId}" because it has no saved graph. Save the team graph before arming a StartNode trigger.`);
    }
    this.state.graphRunState = reduceTeamGraphRunState(this.state.graphRunState, {
      type: 'trigger.fired',
      nodeId: input.startNodeId,
      firedAt: input.createdAt,
      metadata: {
        triggerSource: input.triggerSource,
        ...(input.payloadSummary ? { payloadSummary: input.payloadSummary } : {}),
        ...(input.deterministicBodyHash ? { deterministicBodyHash: input.deterministicBodyHash } : {}),
        ...(input.payload ? { payload: input.payload } : {}),
      },
    });
    this.updateRun({ status: 'running' });
    this.appendEvent('trigger.fired', {
      startNodeId: input.startNodeId,
      triggerSource: input.triggerSource,
      ...(input.payloadSummary ? { payloadSummary: input.payloadSummary } : {}),
      ...(input.deterministicBodyHash ? { deterministicBodyHash: input.deterministicBodyHash } : {}),
      ...(input.payload ? { payload: input.payload } : {}),
    }, input.idempotencyKey, input.createdAt);
  }

  private claimEntryReadyWorkNodeForRole(input: { readonly roleId: string; readonly attemptUserMessage: string }): TeamWorkNodeDelivery | null {
    if (!this.state.graphRunState || !this.deps.nodePromptDelivery) return null;
    const graphRunState = this.state.graphRunState;
    const nodesById = new Map(graphRunState.definition.nodes.map((node) => [node.nodeId, node]));
    const activeRoleSessionKeys = new Set(this.collectActiveRoleSessionKeys());
    for (const queueItem of graphRunState.readyQueueItems) {
      const node = nodesById.get(queueItem.nodeId);
      if (!node || node.kind !== 'work' || node.roleId !== input.roleId) continue;
      if (!isEntryWorkNode(graphRunState.definition, node.nodeId)) continue;
      const binding = this.state.roleBindings.find((candidate) => candidate.roleId === input.roleId);
      if (!binding || activeRoleSessionKeys.has(binding.sessionKey)) continue;
      const currentAttempt = graphRunState.nodeExecutionsByNodeId[node.nodeId]?.attempts.at(-1);
      if (!currentAttempt || currentAttempt.status !== 'ready') continue;
      if (currentAttempt.attemptId !== queueItem.attemptId || currentAttempt.startedAt !== undefined || currentAttempt.attemptNumber !== 1) continue;
      if (this.hasActiveNodePromptDeliveryForExecution(queueItem.nodeExecutionId)) continue;

      const now = this.deps.nowMs();
      this.state.graphRunState = markReadyQueueItemRunning(graphRunState, queueItem, now);
      this.updateRun({ status: 'running' });
      return {
        deliveryId: `team-graph-delivery:${currentAttempt.attemptId}`,
        nodeId: node.nodeId,
        taskId: node.taskId,
        roleId: node.roleId,
        attemptId: currentAttempt.attemptId,
        nodeExecutionId: queueItem.nodeExecutionId,
        attemptNumber: currentAttempt.attemptNumber,
        inputContexts: [...queueItem.inputContexts],
        attemptUserMessage: input.attemptUserMessage,
        idempotencyKey: queueItem.idempotencyKey,
        status: 'queued',
        createdAt: now,
      };
    }
    return null;
  }

  private hasActiveNodePromptDeliveryForExecution(nodeExecutionId: string): boolean {
    return this.state.nodePromptDeliveries.some((delivery) => (
      delivery.nodeExecutionId === nodeExecutionId
      && (delivery.status === 'pending' || delivery.status === 'delivering' || delivery.status === 'retry_scheduled' || delivery.status === 'delivered')
    ));
  }

  private async dispatchReadyGraphNodes(): Promise<void> {
    await this.deliverRetryableNodePrompts();
    if (!this.state.graphRunState) return;
    const roleSessionKeyByRoleId = Object.fromEntries(this.state.roleBindings.map((binding) => [binding.roleId, binding.sessionKey]));
    let activeRoleSessionKeys = this.collectActiveRoleSessionKeys();
    const maxIterations = Math.max(1, this.state.graphRunState.definition.nodes.length * 2);
    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const scheduled = scheduleReadyWorkNodeDeliveries(this.state.graphRunState, {
        maxDeliveries: TEAM_DISPATCH_MAX_ACTIVE_ROLE_PROMPTS,
        maxActiveRoleSessions: TEAM_DISPATCH_MAX_ACTIVE_ROLE_PROMPTS,
        activeRoleSessionCount: activeRoleSessionKeys.length,
        activeRoleSessionKeys,
        roleSessionKeyByRoleId,
        nowMs: this.deps.nowMs(),
      });
      this.state.graphRunState = scheduled.state;
      let progressed = false;
      if (scheduled.deliveries.length > 0) {
        await this.dispatchWorkNodeDeliveries(scheduled.deliveries);
        progressed = true;
      }
      if (scheduled.controlEffects.length > 0) {
        await this.applyGraphControlEffects(scheduled.controlEffects);
        progressed = true;
      }
      if (scheduled.deliveries.length > 0) return;
      if (!progressed) return;
      activeRoleSessionKeys = this.collectActiveRoleSessionKeys();
    }
  }

  private collectActiveRoleSessionKeys(): string[] {
    const activeNodeExecutionIds = this.collectActiveNodeExecutionIds();
    return Array.from(new Set([
      ...this.state.dispatchExecutions
        .filter((execution) => execution.status === 'queued' || execution.status === 'claimed')
        .map((execution) => execution.childSessionKey ?? `${execution.roleId}:${execution.dispatchId}`),
      ...this.state.nodePromptDeliveries
        .filter((delivery) => (
          delivery.status === 'pending'
          || delivery.status === 'delivering'
          || delivery.status === 'retry_scheduled'
          || (delivery.status === 'delivered' && activeNodeExecutionIds.has(delivery.nodeExecutionId))
        ))
        .map((delivery) => delivery.sessionKey),
    ]));
  }

  private collectActiveNodeExecutionIds(): Set<string> {
    const activeNodeExecutionIds = new Set<string>();
    for (const history of Object.values(this.state.graphRunState?.nodeExecutionsByNodeId ?? {})) {
      const currentAttempt = history.attempts.at(-1);
      if (!currentAttempt?.nodeExecutionId) continue;
      if (currentAttempt.status === 'ready' || currentAttempt.status === 'running' || currentAttempt.status === 'waiting') {
        activeNodeExecutionIds.add(currentAttempt.nodeExecutionId);
      }
    }
    return activeNodeExecutionIds;
  }

  private async dispatchWorkNodeDeliveries(deliveries: readonly TeamWorkNodeDelivery[]): Promise<void> {
    if (!this.deps.nodePromptDelivery || !this.state.graphRunState) return;
    const graphRunState = this.state.graphRunState;
    const nodesById = new Map(graphRunState.definition.nodes.map((node) => [node.nodeId, node]));
    const plannedTaskById = new Map((this.state.workflowPlan?.tasks ?? []).map((task) => [task.taskId, task]));
    const roleBindingByRoleId = new Map(this.state.roleBindings.map((binding) => [binding.roleId, binding]));
    const dispatchTaskByTaskId = new Map(this.state.dispatchTasks.map((task) => [task.taskId, task]));
    const nodePromptDeliveryIndexById = buildNodePromptDeliveryIndexById(this.state.nodePromptDeliveries);
    const requests: TeamNodePromptDispatchRequest[] = [];
    for (const graphDelivery of deliveries) {
      const graphNode = nodesById.get(graphDelivery.nodeId);
      const plannedTask = plannedTaskById.get(graphDelivery.taskId);
      const binding = roleBindingByRoleId.get(graphDelivery.roleId);
      if (!binding || !graphNode || graphNode.kind !== 'work') continue;
      const existingTask = dispatchTaskByTaskId.get(graphDelivery.taskId);
      const task = existingTask ?? buildCanvasGraphDispatchTask({
        runId: this.deps.runId,
        workflowPlanId: graphRunState.workflowPlanId,
        node: graphNode,
        createdAt: graphDelivery.createdAt,
      });
      if (!existingTask) {
        this.state.dispatchTasks.push(task);
        dispatchTaskByTaskId.set(task.taskId, task);
      }
      const attemptKey = `${task.idempotencyKey}:attempt:${graphDelivery.attemptNumber}`;
      const attemptTask: TeamDispatchTaskProjection = {
        ...task,
        dispatchId: `${task.dispatchId}:attempt:${graphDelivery.attemptNumber}`,
        idempotencyKey: attemptKey,
      };
      const upstreamContext = buildGraphDeliveryInputContext(graphRunState, this.state.artifacts, graphDelivery);
      const message = appendGraphDeliveryInputContext(buildGraphWorkNodePrompt({
        node: graphNode,
        delivery: graphDelivery,
        runId: this.deps.runId,
        runtimeEndpoint: binding.sessionIdentity.endpoint,
        plannedTask,
      }), upstreamContext);
      requests.push({
        graphDelivery,
        task,
        attemptTask,
        binding,
        attemptKey,
        nodePromptDelivery: buildNodePromptDeliveryRecord({
          task: attemptTask,
          binding,
          nodeId: graphDelivery.nodeId,
          nodeExecutionId: graphDelivery.nodeExecutionId,
          prompt: message,
          ...(graphDelivery.attemptUserMessage ? { displayMessage: graphDelivery.attemptUserMessage } : {}),
          plannedTask,
          createdAt: graphDelivery.createdAt,
        }),
      });
    }

    const results = await Promise.all(requests.map((request) => this.deliverNodePrompt(request.nodePromptDelivery, request.binding, request.attemptKey, nodePromptDeliveryIndexById)));
    for (let index = 0; index < requests.length; index += 1) {
      const request = requests[index]!;
      const delivery = results[index]!;
      if (delivery.status !== 'delivered') continue;
      this.applyDeliveredNodePrompt(request, delivery.deliveredAt ?? request.graphDelivery.createdAt);
    }
  }

  private async dispatchAgentReviewNode(effect: TeamGraphControlNodeEffect, node: TeamGraphNodeDefinition): Promise<void> {
    if (!this.deps.nodePromptDelivery || !this.state.graphRunState) return;
    const roleId = readString(node.executor?.roleId) ?? node.roleId;
    if (!roleId) throw new Error(`ReviewNode "${node.nodeId}" requires executor.roleId before it can dispatch reviewer agent work.`);
    const binding = this.state.roleBindings.find((candidate) => candidate.roleId === roleId);
    if (!binding) throw new Error(`ReviewNode "${node.nodeId}" references roleId "${roleId}", but the TeamRun has no role binding for it.`);
    const task = buildGraphReviewDispatchTask({
      runId: this.deps.runId,
      workflowPlanId: this.state.graphRunState.workflowPlanId,
      node,
      roleId,
      createdAt: effect.createdAt,
    });
    const graphDelivery: TeamWorkNodeDelivery = {
      deliveryId: `team-graph-review-delivery:${effect.attemptId}`,
      nodeId: effect.nodeId,
      taskId: task.taskId,
      roleId,
      attemptId: effect.attemptId,
      nodeExecutionId: effect.nodeExecutionId,
      attemptNumber: effect.attemptNumber,
      inputContexts: [...effect.inputContexts],
      idempotencyKey: effect.idempotencyKey,
      status: 'queued',
      createdAt: effect.createdAt,
    };
    const upstreamContext = buildGraphDeliveryInputContext(this.state.graphRunState, this.state.artifacts, graphDelivery);
    const nodePromptDelivery = buildNodePromptDeliveryRecord({
      task,
      binding,
      nodeId: effect.nodeId,
      nodeExecutionId: effect.nodeExecutionId,
      prompt: appendGraphDeliveryInputContext(buildGraphReviewNodePrompt({
        node,
        task,
        effect,
        runId: this.deps.runId,
        runtimeEndpoint: binding.sessionIdentity.endpoint,
      }), upstreamContext),
      createdAt: effect.createdAt,
    });
    const delivery = await this.deliverNodePrompt(nodePromptDelivery, binding, task.idempotencyKey);
    if (delivery.status !== 'delivered') return;
    this.state.dispatchTasks.push(task);
    this.applyDeliveredNodePrompt({
      graphDelivery,
      task,
      attemptTask: task,
      binding,
      attemptKey: task.idempotencyKey,
      nodePromptDelivery,
    }, delivery.deliveredAt ?? effect.createdAt, 'dispatch.review_prompted');
  }

  private async applyGraphControlEffects(effects: readonly TeamGraphControlNodeEffect[]): Promise<void> {
    if (!this.state.graphRunState) return;
    for (const effect of effects) {
      const node = this.state.graphRunState.definition.nodes.find((candidate) => candidate.nodeId === effect.nodeId);
      if (!node) continue;
      switch (effect.effectType) {
        case 'auto_complete':
          this.state.graphRunState = reduceTeamGraphRunState(this.state.graphRunState, { type: 'node.completed', nodeId: effect.nodeId, completedAt: effect.createdAt, outputPort: node.kind === 'join' ? 'joined' : 'completed' });
          break;
        case 'script_review':
          this.state.graphRunState = reduceTeamGraphRunState(this.state.graphRunState, runBuiltInScriptReviewNode(node, this.state, effect.createdAt));
          break;
        case 'agent_review':
          await this.dispatchAgentReviewNode(effect, node);
          break;
        case 'request_review':
          this.upsertGraphReviewGate(effect, node);
          this.state.graphRunState = reduceTeamGraphRunState(this.state.graphRunState, { type: 'node.waiting', nodeId: effect.nodeId, waitingAt: effect.createdAt, reason: 'waiting_for_review', metadata: { gateId: graphReviewGateId(effect.nodeId) } });
          this.updateRun({ status: 'waiting_for_user' });
          break;
        case 'request_human_decision':
          this.upsertGraphHumanApproval(effect, node);
          this.state.graphRunState = reduceTeamGraphRunState(this.state.graphRunState, { type: 'node.waiting', nodeId: effect.nodeId, waitingAt: effect.createdAt, reason: 'waiting_for_human_decision', metadata: { approvalId: graphHumanApprovalId(effect.nodeId) } });
          this.updateRun({ status: 'waiting_for_user' });
          break;
      }
    }
  }

  private upsertGraphReviewGate(effect: TeamGraphControlNodeEffect, node: TeamGraphNodeDefinition): void {
    const gateId = graphReviewGateId(effect.nodeId);
    upsertGate(this.state.gates, {
      gateId,
      runId: this.deps.runId,
      stageId: effect.nodeId,
      gateType: 'review',
      blocking: true,
      summary: node.title,
      status: 'open',
      failureItems: [],
      idempotencyKey: `graph-review:${effect.attemptId}`,
      createdAt: effect.createdAt,
    });
  }

  private upsertGraphHumanApproval(effect: TeamGraphControlNodeEffect, node: TeamGraphNodeDefinition): void {
    const approvalId = graphHumanApprovalId(effect.nodeId);
    const existing = this.state.approvals.find((approval) => approval.approvalId === approvalId);
    if (existing) return;
    this.state.approvals.push({
      approvalId,
      runId: this.deps.runId,
      stageId: effect.nodeId,
      roleId: node.roleId ?? 'human',
      reason: readString(node.config?.reason) ?? node.title,
      requestedAction: readString(node.config?.requestedAction) ?? node.title,
      risk: readString(node.config?.risk) ?? 'manual decision required',
      status: 'pending',
      idempotencyKey: `graph-human:${effect.attemptId}`,
      createdAt: effect.createdAt,
    });
  }

  private async dispatchReadyTasks(): Promise<void> {
    await this.dispatchReadyGraphNodes();
  }

  private applyDeliveredNodePrompt(request: TeamNodePromptDispatchRequest, createdAt: number, eventType: 'dispatch.task_prompted' | 'dispatch.review_prompted' = 'dispatch.task_prompted'): void {
    const { graphDelivery, task, attemptTask, binding, attemptKey, nodePromptDelivery } = request;
    this.state.nodeDeliveries.push(graphDelivery);
    this.state.dispatches.push({
      dispatchId: attemptTask.dispatchId,
      runId: task.runId,
      stageId: task.taskId,
      roleId: task.roleId,
      promptRef: nodePromptDelivery.deliveryRecordId,
      kickbackIds: kickbackIdsForTask(this.state.kickbacks, task.taskId),
      idempotencyKey: attemptKey,
      createdAt,
      workflowPlanId: task.workflowPlanId,
      dispatchGroupId: task.dispatchGroupId,
      groupId: task.groupId,
      taskId: task.taskId,
    });
    this.state.dispatchExecutions.push({
      executionRecordId: `team-dispatch-execution-${this.deps.randomId()}`,
      runId: task.runId,
      dispatchId: attemptTask.dispatchId,
      stageId: task.taskId,
      roleId: task.roleId,
      executionId: nodePromptDelivery.deliveryRecordId,
      childSessionKey: binding.sessionKey,
      spawnMode: 'session',
      status: 'queued',
      idempotencyKey: attemptKey,
      createdAt,
    });
    this.appendEvent(eventType, { taskId: task.taskId, roleId: task.roleId, sessionKey: binding.sessionKey, deliveryRecordId: nodePromptDelivery.deliveryRecordId, nodeId: graphDelivery.nodeId, attemptNumber: graphDelivery.attemptNumber }, attemptKey);
  }

  private async deliverRetryableNodePrompts(): Promise<void> {
    if (!this.deps.nodePromptDelivery) return;
    const now = this.deps.nowMs();
    const roleBindingByAgentId = new Map(this.state.roleBindings.map((binding) => [binding.agentId, binding]));
    const nodePromptDeliveryIndexById = buildNodePromptDeliveryIndexById(this.state.nodePromptDeliveries);
    for (const nodePromptDelivery of this.state.nodePromptDeliveries) {
      if (nodePromptDelivery.status !== 'retry_scheduled' || (nodePromptDelivery.nextRetryAt ?? 0) > now) continue;
      const binding = roleBindingByAgentId.get(nodePromptDelivery.toAgentId);
      if (!binding) continue;
      await this.deliverNodePrompt(nodePromptDelivery, binding, nodePromptDelivery.idempotencyKey, nodePromptDeliveryIndexById);
    }
  }

  private async deliverNodePrompt(
    nodePromptDelivery: TeamNodePromptDeliveryRecord,
    binding: TeamRoleSessionBinding,
    idempotencyKey: string,
    nodePromptDeliveryIndexById = buildNodePromptDeliveryIndexById(this.state.nodePromptDeliveries),
  ): Promise<NodePromptDeliveryResult> {
    const existingIndex = nodePromptDeliveryIndexById.get(nodePromptDelivery.deliveryRecordId);
    const existing = existingIndex === undefined ? undefined : this.state.nodePromptDeliveries[existingIndex];
    const now = this.deps.nowMs();
    if (existing?.status === 'delivered') return { status: 'delivered', deliveredAt: existing.deliveredAt };
    if (existing?.status === 'retry_scheduled' && (existing.nextRetryAt ?? 0) > now) {
      return { status: 'retry_scheduled', reason: existing.lastError };
    }
    if (existing?.status === 'failed') return { status: 'failed', reason: existing.lastError };
    const attempt = (existing?.attempt ?? 0) + 1;
    const queuedDelivery: TeamNodePromptDeliveryRecord = {
      ...nodePromptDelivery,
      status: 'delivering',
      attempt,
      maxAttempts: nodePromptDelivery.maxAttempts ?? TEAM_NODE_PROMPT_DELIVERY_MAX_ATTEMPTS,
      deliveringAt: now,
      updatedAt: now,
    };
    upsertNodePromptDelivery(this.state.nodePromptDeliveries, queuedDelivery, nodePromptDeliveryIndexById);
    try {
      const delivery = await this.deps.nodePromptDelivery!.deliver({ delivery: queuedDelivery, binding, idempotencyKey });
      if (delivery.status === 'delivered') {
        const deliveredAt = delivery.deliveredAt ?? this.deps.nowMs();
        upsertNodePromptDelivery(this.state.nodePromptDeliveries, { ...queuedDelivery, status: 'delivered', deliveredAt, updatedAt: deliveredAt }, nodePromptDeliveryIndexById);
        return { status: 'delivered', deliveredAt };
      }
      return this.scheduleNodePromptRetry(queuedDelivery, delivery.reason ?? delivery.status, nodePromptDeliveryIndexById);
    } catch (error) {
      return this.scheduleNodePromptRetry(queuedDelivery, error instanceof Error ? error.message : String(error), nodePromptDeliveryIndexById);
    }
  }

  private scheduleNodePromptRetry(nodePromptDelivery: TeamNodePromptDeliveryRecord, reason: string, nodePromptDeliveryIndexById: Map<string, number>): { status: 'failed' | 'retry_scheduled'; reason: string } {
    const attempt = nodePromptDelivery.attempt ?? 1;
    const maxAttempts = nodePromptDelivery.maxAttempts ?? TEAM_NODE_PROMPT_DELIVERY_MAX_ATTEMPTS;
    const now = this.deps.nowMs();
    if (attempt >= maxAttempts) {
      upsertNodePromptDelivery(this.state.nodePromptDeliveries, { ...nodePromptDelivery, status: 'failed', lastError: reason, updatedAt: now }, nodePromptDeliveryIndexById);
      this.appendEvent('node_prompt.delivery_failed', { deliveryRecordId: nodePromptDelivery.deliveryRecordId, reason, attempt, maxAttempts }, nodePromptDelivery.idempotencyKey);
      return { status: 'failed', reason };
    }
    const nextRetryAt = now + TEAM_NODE_PROMPT_DELIVERY_RETRY_DELAY_MS;
    upsertNodePromptDelivery(this.state.nodePromptDeliveries, { ...nodePromptDelivery, status: 'retry_scheduled', lastError: reason, nextRetryAt, updatedAt: now }, nodePromptDeliveryIndexById);
    this.appendEvent('node_prompt.retry_scheduled', { deliveryRecordId: nodePromptDelivery.deliveryRecordId, reason, attempt, maxAttempts, nextRetryAt }, nodePromptDelivery.idempotencyKey);
    return { status: 'retry_scheduled', reason };
  }

  private cancelRunRuntimeState(cancelledAt: number): void {
    if (this.state.graphRunState) {
      const nodeExecutionsByNodeId = Object.fromEntries(Object.entries(this.state.graphRunState.nodeExecutionsByNodeId).map(([nodeId, history]) => {
        const currentAttempt = history.attempts.at(-1);
        if (!currentAttempt || currentAttempt.status === 'completed' || currentAttempt.status === 'failed' || currentAttempt.status === 'cancelled') {
          return [nodeId, history];
        }
        return [nodeId, {
          attempts: [...history.attempts.slice(0, -1), {
            ...currentAttempt,
            status: 'cancelled' as const,
            updatedAt: cancelledAt,
            completedAt: cancelledAt,
            summary: 'TeamRun cancelled.',
          }],
        }];
      }));
      this.state.graphRunState = {
        ...this.state.graphRunState,
        nodeExecutionsByNodeId,
        readyQueue: [],
        readyQueueItems: [],
        readyQueueHead: 0,
        queuedReadyNodeIds: [],
        nodeInputStateByNodeId: {},
      };
    }
    this.state.dispatchTasks = this.state.dispatchTasks.map((task) => (
      task.status === 'queued' ? { ...task, status: 'cancelled', completedAt: cancelledAt, statusReason: 'TeamRun cancelled.' } : task
    ));
    this.state.dispatchExecutions = this.state.dispatchExecutions.map((execution) => (
      execution.status === 'queued' || execution.status === 'claimed'
        ? { ...execution, status: 'cancelled', statusReason: 'TeamRun cancelled.' }
        : execution
    ));
    this.state.nodePromptDeliveries = this.state.nodePromptDeliveries.map((delivery) => (
      delivery.status === 'pending' || delivery.status === 'delivering' || delivery.status === 'retry_scheduled'
        ? { ...delivery, status: 'cancelled', lastError: 'TeamRun cancelled.', updatedAt: cancelledAt }
        : delivery
    ));
    this.state.approvals = this.state.approvals.map((approval) => (
      approval.status === 'pending' ? { ...approval, status: 'aborted', note: 'TeamRun cancelled.', resolvedAt: cancelledAt } : approval
    ));
  }

  private updateRunCompletionState(): void {
    if (!this.state.run || this.state.run.status === 'cancelled' || this.state.run.status === 'failed') return;
    const hasTasks = this.state.dispatchTasks.length > 0;
    const tasksCompleted = hasTasks && this.state.dispatchTasks.every((task) => task.status === 'completed');
    const hasPendingApproval = this.state.approvals.some((approval) => approval.status === 'pending');
    const hasBlockingGate = this.state.gates.some((gate) => gate.blocking && gate.status === 'open');
    const hasOpenKickback = this.state.kickbacks.some((kickback) => !kickback.resolvedAt);
    if ((this.isGraphComplete() || tasksCompleted) && !hasPendingApproval && !hasBlockingGate && !hasOpenKickback) {
      if (this.state.run.status !== 'completed') this.updateRun({ status: 'completed' });
      return;
    }
    if (hasPendingApproval || hasBlockingGate || hasOpenKickback) {
      if (this.state.run.status !== 'waiting_for_user') this.updateRun({ status: 'waiting_for_user' });
      return;
    }
    if ((this.state.run.status === 'completed' || this.state.run.status === 'waiting_for_user') && !tasksCompleted) this.updateRun({ status: 'running' });
  }

  private isGraphComplete(): boolean {
    if (!this.state.graphRunState || this.state.graphRunState.definition.nodes.length === 0) return false;
    const endNodes = this.state.graphRunState.definition.nodes.filter((node) => node.kind === 'end');
    if (endNodes.length > 0) {
      return endNodes.every((node) => this.state.graphRunState!.completedNodeIds.includes(node.nodeId));
    }
    return this.state.graphRunState.definition.nodes.every((node) => this.state.graphRunState!.completedNodeIds.includes(node.nodeId) || this.state.graphRunState!.nodeExecutionsByNodeId[node.nodeId]?.attempts.at(-1)?.status === 'failed');
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

  private buildGraphContext(input: { readonly view: TeamGraphContextView; readonly nodeExecutionId?: string }): TeamGraphContextProjection {
    const run: Pick<TeamRunRecord, 'runId' | 'teamId' | 'status' | 'revision' | 'updatedAt'> = this.state.run ?? { runId: this.deps.runId, status: 'created' as TeamRunStatus, revision: 0, updatedAt: 0 };
    const graphRunState = this.state.graphRunState;
    if (input.nodeExecutionId && !graphRunState) {
      throw new Error(`TeamRun ${this.deps.runId} has no graph for nodeExecutionId ${input.nodeExecutionId}.`);
    }
    const currentAttempt = input.nodeExecutionId && graphRunState ? findCurrentNodeExecutionById(graphRunState, input.nodeExecutionId) : null;
    if (input.nodeExecutionId && graphRunState && !currentAttempt) {
      throw new Error(`nodeExecutionId ${input.nodeExecutionId} does not belong to the current TeamRun graph state.`);
    }
    const currentNode = currentAttempt && graphRunState
      ? buildCurrentNodeContext(graphRunState, currentAttempt)
      : undefined;
    return {
      fieldGuide: TEAM_GRAPH_CONTEXT_FIELD_GUIDE,
      run: {
        runId: run.runId,
        ...optionalDefinedProperty('teamId', run.teamId),
        status: run.status,
        revision: run.revision,
        updatedAt: run.updatedAt,
      },
      view: input.view,
      graph: graphRunState ? buildCompactGraphContext(graphRunState, input.view) : null,
      ...(currentNode ? { currentNode } : {}),
      nodeInputStates: graphRunState ? buildTeamNodeInputStateProjection(graphRunState) : [],
      pendingApprovals: this.state.approvals.filter((approval) => approval.status === 'pending').map((approval) => ({ ...approval })),
      recentEvents: this.state.events.slice(-20).map((event) => ({ ...event })),
    };
  }

  private buildSnapshot(): TeamRunSnapshot {
    return {
      run: this.state.run ? { ...this.state.run } : null,
      graph: this.state.graphRunState ? buildTeamGraphSnapshotProjection(this.state.graphRunState) : null,
      nodeInputStates: this.state.graphRunState ? buildTeamNodeInputStateProjection(this.state.graphRunState) : [],
      nodeExecutions: this.state.graphRunState ? buildTeamNodeExecutionProjection(this.state.graphRunState) : [],
      nodeDeliveries: buildTeamNodeDeliveryProjection(this.state.nodeDeliveries),
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
      nodePromptDeliveries: this.state.nodePromptDeliveries.map((delivery) => ({ ...delivery })),
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
          nodePromptDeliveries: this.state.nodePromptDeliveries.length,
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
    if (this.state.run) {
      await this.deps.teamInstances.upsertRun({
        run: this.state.run,
        sessions: this.state.roleBindings,
      });
    }
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

function rejectIfExistingCommandWasRejected(record: TeamAgentCommandLedgerRecord): void {
  if (record.status === 'rejected') {
    throw new Error(record.rejectionReason ?? `Team agent command ${record.commandId} was rejected.`);
  }
}

function readTeamNodeEventCommand(input: Record<string, unknown>, context: { readonly runId: string; readonly sourceEndpoint: RuntimeEndpointRef; readonly nowMs: number; readonly commandId: string }): TeamNodeEventCommand {
  const event = readTeamNodeEventKind(input.event);
  const result = readTeamNodeResult(input.result);
  const summary = readString(input.summary) ?? result?.summary;
  if (!summary) throw new Error('summary is required when result.summary is not provided');
  return {
    type: 'team.node_event',
    commandId: readString(input.commandId) ?? context.commandId,
    runId: context.runId,
    idempotencyKey: requireString(input, 'idempotencyKey'),
    sourceEndpoint: context.sourceEndpoint,
    sourceAgentId: readString(input.sourceAgentId) ?? 'agent',
    ...optionalStringProperty(input, 'sourceRuntimeAdapterId'),
    ...optionalStringProperty(input, 'sourceSessionKey'),
    createdAt: context.nowMs,
    nodeExecutionId: requireString(input, 'nodeExecutionId'),
    event,
    ...optionalStringProperty(input, 'roleId'),
    summary,
    ...optionalStringProperty(input, 'outputPort'),
    ...optionalDefinedProperty('result', result),
    evidenceRefs: readArray(input.evidenceRefs) as TeamEvidenceRef[],
    ...optionalStringProperty(input, 'requestedAction'),
    ...optionalStringProperty(input, 'risk'),
    metadata: readRecord(input.metadata),
  };
}

function readTeamNodeResult(value: unknown): TeamNodeResult | undefined {
  if (value === undefined || value === null) return undefined;
  const record = readRecord(value);
  const kind = readTeamNodeResultKind(record.kind);
  const summary = requireString(record, 'summary');
  return {
    kind,
    summary,
    ...optionalStringProperty(record, 'content'),
    ...optionalTeamNodeDecisionProperty(record),
    ...optionalTeamRoleAssignmentsProperty(record),
    evidenceRefs: readArray(record.evidenceRefs),
    artifactIds: readStringArray(record.artifactIds),
    metadata: readRecord(record.metadata),
  };
}

function readTeamNodeResultKind(value: unknown): TeamNodeResult['kind'] {
  if (value === 'trigger' || value === 'work' || value === 'review' || value === 'human_decision' || value === 'script_check' || value === 'joined' || value === 'final') return value;
  throw new Error('result.kind must be trigger, work, review, human_decision, script_check, joined, or final');
}

function optionalTeamNodeDecisionProperty(record: Record<string, unknown>): { decision?: TeamNodeResult['decision'] } {
  const value = readString(record.decision);
  if (!value) return {};
  if (value === 'approved' || value === 'rejected' || value === 'aborted' || value === 'passed' || value === 'failed' || value === 'completed' || value === 'joined') return { decision: value };
  throw new Error('result.decision must be approved, rejected, aborted, passed, failed, completed, or joined when provided');
}

function optionalTeamRoleAssignmentsProperty(record: Record<string, unknown>): { assignments?: TeamNodeResult['assignments'] } {
  if (!Array.isArray(record.assignments)) return {};
  return {
    assignments: record.assignments.map((assignment) => {
      const assignmentRecord = readRecord(assignment);
      return { roleId: requireString(assignmentRecord, 'roleId'), text: requireString(assignmentRecord, 'text') };
    }),
  };
}

function readTeamGraphPatchCommand(input: Record<string, unknown>, context: { readonly runId: string; readonly sourceEndpoint: RuntimeEndpointRef; readonly nowMs: number; readonly commandId: string }): TeamGraphPatchCommand {
  const patch = readRecord(input.patch);
  return {
    type: 'team.graph_patch',
    commandId: readString(input.commandId) ?? context.commandId,
    runId: context.runId,
    idempotencyKey: requireString(input, 'idempotencyKey'),
    sourceEndpoint: context.sourceEndpoint,
    sourceAgentId: readString(input.sourceAgentId) ?? 'agent',
    ...optionalStringProperty(input, 'sourceRuntimeAdapterId'),
    ...optionalStringProperty(input, 'sourceSessionKey'),
    createdAt: context.nowMs,
    summary: requireString(input, 'summary'),
    patch: {
      ...optionalStringProperty(patch, 'baseGraphId'),
      ...optionalStringProperty(patch, 'baseWorkflowPlanId'),
      operations: readArray(patch.operations).map(readTeamGraphPatchOperation),
    },
    metadata: readRecord(input.metadata),
  };
}

function readTeamNodeEventKind(value: unknown): TeamNodeEventKind {
  if (value === 'progress' || value === 'request_input' || value === 'request_approval' || value === 'reject' || value === 'complete') return value;
  throw new Error('event must be progress, request_input, request_approval, reject, or complete');
}

function readTeamGraphPatchOperation(value: unknown): TeamGraphPatchOperation {
  const record = readRecord(value);
  const op = requireString(record, 'op');
  if (op === 'add_node' || op === 'replace_node') return { op, node: readRecord(record.node) };
  if (op === 'remove_node') return { op, nodeId: requireString(record, 'nodeId') };
  if (op === 'add_edge' || op === 'replace_edge') return { op, edge: readRecord(record.edge) };
  if (op === 'remove_edge') return { op, edgeId: requireString(record, 'edgeId') };
  if (op === 'set_metadata') return { op, metadata: readRecord(record.metadata) };
  throw new Error(`Unsupported Team graph patch operation "${op}".`);
}

function applyTeamGraphPatch(definition: TeamGraphDefinition, operations: readonly TeamGraphPatchOperation[]): Record<string, unknown> {
  let nodes: TeamGraphNodeDefinition[] = definition.nodes.map((node) => ({ ...node, metadata: { ...node.metadata }, config: node.config ? { ...node.config } : undefined, executor: node.executor ? { ...node.executor } : undefined }) as TeamGraphNodeDefinition);
  let edges: TeamGraphEdgeDefinition[] = definition.edges.map((edge) => ({ ...edge, metadata: { ...edge.metadata } }));
  let metadata = { ...(definition.metadata ?? {}) };
  for (const operation of operations) {
    switch (operation.op) {
      case 'add_node':
        nodes = [...nodes, operation.node as unknown as TeamGraphNodeDefinition];
        break;
      case 'replace_node': {
        const nodeId = requireString(operation.node, 'nodeId');
        nodes = [...nodes.filter((node) => node.nodeId !== nodeId), operation.node as unknown as TeamGraphNodeDefinition];
        break;
      }
      case 'remove_node':
        nodes = nodes.filter((node) => node.nodeId !== operation.nodeId);
        edges = edges.filter((edge) => edge.sourceNodeId !== operation.nodeId && edge.targetNodeId !== operation.nodeId);
        break;
      case 'add_edge':
        edges = [...edges, operation.edge as unknown as TeamGraphEdgeDefinition];
        break;
      case 'replace_edge': {
        const edgeId = requireString(operation.edge, 'edgeId');
        edges = [...edges.filter((edge) => edge.edgeId !== edgeId), operation.edge as unknown as TeamGraphEdgeDefinition];
        break;
      }
      case 'remove_edge':
        edges = edges.filter((edge) => edge.edgeId !== operation.edgeId);
        break;
      case 'set_metadata':
        metadata = { ...metadata, ...operation.metadata };
        break;
    }
  }
  return { ...definition, nodes, edges, metadata };
}

function findCurrentNodeExecutionById(state: TeamGraphRunState, nodeExecutionId: string): TeamGraphNodeExecutionAttempt | null {
  for (const history of Object.values(state.nodeExecutionsByNodeId)) {
    const attempt = history.attempts.at(-1);
    if (attempt && (attempt.nodeExecutionId ?? attempt.attemptId) === nodeExecutionId) return attempt;
  }
  return null;
}

function readGraphContextView(value: unknown): TeamGraphContextView {
  return value === 'current_node' ? 'current_node' : 'graph_summary';
}

function buildCompactGraphContext(state: TeamGraphRunState, view: TeamGraphContextView): NonNullable<TeamGraphContextProjection['graph']> {
  const nodes: NonNullable<TeamGraphContextProjection['graph']>['nodes'] = state.definition.nodes.map((node) => {
    const attempt = currentAttemptForCompactContext(state, node.nodeId);
    return {
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      ...optionalDefinedProperty('roleId', node.roleId),
      ...optionalDefinedProperty('status', attempt?.status),
      ...optionalDefinedProperty('nodeExecutionId', attempt?.nodeExecutionId ?? attempt?.attemptId),
      ...optionalDefinedProperty('attemptNumber', attempt?.attemptNumber),
      ...optionalDefinedProperty('outputPort', attempt?.outputPort),
      ...optionalDefinedProperty('summary', attempt?.summary),
    };
  });
  return {
    graphId: state.definition.graphId,
    workflowPlanId: state.workflowPlanId,
    title: state.definition.title,
    status: state.definition.status,
    nodeCount: state.definition.nodes.length,
    edgeCount: state.definition.edges.length,
    nodes: view === 'graph_summary' ? nodes : nodes.filter((node) => node.status && node.status !== 'pending'),
    edges: state.definition.edges.map((edge) => ({
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      sourcePort: edge.sourcePort,
      targetNodeId: edge.targetNodeId,
      targetPort: edge.targetPort,
      status: state.completedNodeOutputPortsByNodeId?.[edge.sourceNodeId]?.includes(edge.sourcePort) ? 'satisfied' : 'waiting',
      action: edge.action,
      payload: { ...edge.payload },
    })),
  };
}

function buildCurrentNodeContext(state: TeamGraphRunState, attempt: TeamGraphNodeExecutionAttempt): NonNullable<TeamGraphContextProjection['currentNode']> {
  const node = state.definition.nodes.find((candidate) => candidate.nodeId === attempt.nodeId);
  if (!node) throw new Error(`nodeExecutionId ${attempt.nodeExecutionId ?? attempt.attemptId} references missing node ${attempt.nodeId}.`);
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    title: node.title,
    ...optionalDefinedProperty('roleId', node.roleId),
    nodeExecutionId: attempt.nodeExecutionId ?? attempt.attemptId,
    status: attempt.status,
    attemptNumber: attempt.attemptNumber,
    ...optionalDefinedProperty('reason', attempt.reason),
    inputContexts: [...(attempt.inputContexts ?? [])],
    outputArtifactIds: [...(attempt.outputArtifactIds ?? [])],
    ...optionalDefinedProperty('outputPort', attempt.outputPort),
    ...optionalDefinedProperty('summary', attempt.summary),
    incomingEdges: state.definition.edges
      .filter((edge) => edge.targetNodeId === node.nodeId)
      .map((edge) => ({ edgeId: edge.edgeId, sourceNodeId: edge.sourceNodeId, sourcePort: edge.sourcePort, targetPort: edge.targetPort, action: edge.action, payload: { ...edge.payload } })),
    outgoingEdges: state.definition.edges
      .filter((edge) => edge.sourceNodeId === node.nodeId)
      .map((edge) => ({ edgeId: edge.edgeId, targetNodeId: edge.targetNodeId, sourcePort: edge.sourcePort, targetPort: edge.targetPort, action: edge.action, payload: { ...edge.payload } })),
  };
}

function currentAttemptForCompactContext(state: TeamGraphRunState, nodeId: string): TeamGraphNodeExecutionAttempt | undefined {
  return state.nodeExecutionsByNodeId[nodeId]?.attempts.at(-1);
}

function buildNodeEventCompletionArtifact(command: TeamNodeEventCommand, node: TeamGraphNodeDefinition): TeamArtifactProjection {
  const evidenceRefs = [...(command.evidenceRefs ?? [])];
  const primaryEvidence = evidenceRefs[0];
  return {
    artifactId: `team-artifact-${command.idempotencyKey}`,
    runId: command.runId,
    stageId: node.taskId ?? node.nodeId,
    roleId: command.roleId ?? node.roleId ?? 'agent',
    kind: primaryEvidence?.type ?? readString(node.config?.outputArtifactKind) ?? 'nodeSummary',
    title: primaryEvidence?.label ?? node.title,
    contentRef: contentRefForEvidence(primaryEvidence) ?? `node:${command.nodeExecutionId}:summary`,
    summary: command.result?.summary ?? command.summary,
    evidenceRefs,
    sourceEnvelopeId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    createdAt: command.createdAt,
  };
}

function graphReviewGateId(nodeId: string): string {
  return `team-graph-gate:${nodeId}`;
}

function graphHumanApprovalId(nodeId: string): string {
  return `team-graph-approval:${nodeId}`;
}

function runBuiltInScriptReviewNode(node: TeamGraphNodeDefinition, state: RunActorState, nowMs: number): TeamGraphEvent {
  const ruleId = readString(node.config?.ruleId) ?? 'passThrough';
  switch (ruleId) {
    case 'passThrough':
      return { type: 'node.completed', nodeId: node.nodeId, completedAt: nowMs, outputPort: 'passed', summary: 'Script review passed by passThrough rule.' };
    case 'assertAllUpstreamCompleted':
      return upstreamNodesSatisfied(node.nodeId, state.graphRunState)
        ? { type: 'node.completed', nodeId: node.nodeId, completedAt: nowMs, outputPort: 'passed', summary: 'All gate upstream nodes completed.' }
        : { type: 'node.completed', nodeId: node.nodeId, completedAt: nowMs, outputPort: 'failed', summary: 'Gate upstream nodes are not complete.' };
    case 'assertNoBlockingGate':
      return state.gates.some((gate) => gate.blocking && gate.status === 'open')
        ? { type: 'node.completed', nodeId: node.nodeId, completedAt: nowMs, outputPort: 'failed', summary: 'Blocking gate is open.' }
        : { type: 'node.completed', nodeId: node.nodeId, completedAt: nowMs, outputPort: 'passed', summary: 'No blocking gate is open.' };
    case 'assertArtifactExists': {
      const artifactKind = readString(node.config?.artifactKind);
      const hasArtifact = state.artifacts.some((artifact) => artifactKind ? artifact.kind === artifactKind : true);
      return hasArtifact
        ? { type: 'node.completed', nodeId: node.nodeId, completedAt: nowMs, outputPort: 'passed', summary: 'Required artifact exists.' }
        : { type: 'node.completed', nodeId: node.nodeId, completedAt: nowMs, outputPort: 'failed', summary: artifactKind ? `Artifact kind "${artifactKind}" does not exist.` : 'No artifact exists.' };
    }
    default:
      return { type: 'node.failed', nodeId: node.nodeId, failedAt: nowMs, outputPort: 'failed', reason: `Unsupported script review ruleId "${ruleId}".` };
  }
}

function upstreamNodesSatisfied(nodeId: string, graphRunState: TeamGraphRunState | null): boolean {
  if (!graphRunState) return false;
  return graphRunState.definition.edges
    .filter((edge) => edge.targetNodeId === nodeId && edge.action === 'gate')
    .every((edge) => graphRunState.completedNodeOutputPortsByNodeId?.[edge.sourceNodeId]?.includes(edge.sourcePort));
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

function normalizeWebhookPath(value: string | undefined): string | null {
  const normalized = (value ?? '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized || normalized.includes('..')) return null;
  return normalized;
}

function compareTeamInstanceRunsByRecentUpdate(left: TeamInstanceRunRecord, right: TeamInstanceRunRecord): number {
  return right.updatedAt - left.updatedAt;
}

function toTeamInstanceRunRecord(run: TeamRunRecord | TeamInstanceRunRecord, sessions: readonly TeamRoleSessionBinding[]): TeamInstanceRunRecord {
  return {
    teamId: run.teamId ?? run.packageName,
    runId: run.runId,
    status: run.status,
    revision: run.revision,
    packageName: run.packageName,
    packageVersion: run.packageVersion,
    sourcePath: run.sourcePath,
    sessions: sessions.map((session) => ({ ...session })),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function missingPackagePort(code: string, packagePath: string): ApplicationResponseOf {
  return accepted({ success: false, code, packagePath, message: 'TeamSkill package operations require a runtime-host package service to be configured.' });
}

function emptyRunActorState(): RunActorState {
  return { run: null, graphRunState: null, nodeDeliveries: [], roleBindings: [], workflowPlan: null, dispatchGroups: [], dispatchTasks: [], dispatches: [], dispatchExecutions: [], approvals: [], artifacts: [], messages: [], nodePromptDeliveries: [], gates: [], kickbacks: [], decisions: [], events: [], processedIdempotencyKeys: new Set<string>() };
}

function serializeRunActorState(state: RunActorState): Record<string, unknown> {
  return { ...state, processedIdempotencyKeys: Array.from(state.processedIdempotencyKeys) };
}

function cloneTeamInstance(instance: TeamInstance): TeamInstance {
  return {
    ...instance,
    managedAgents: instance.managedAgents.map((agent) => ({ ...agent })),
    graphTemplate: instance.graphTemplate ? cloneTeamGraphDefinition(instance.graphTemplate) : null,
    runs: instance.runs.map((run) => ({ ...run, sessions: run.sessions.map((session) => ({ ...session })) })),
  };
}

function cloneTeamGraphDefinition(definition: TeamGraphDefinition): TeamGraphDefinition {
  return JSON.parse(JSON.stringify(definition)) as TeamGraphDefinition;
}

function deserializeTeamInstance(value: unknown): TeamInstance {
  const record = readRecord(value);
  return {
    teamId: requireString(record, 'teamId'),
    teamSkillName: requireString(record, 'teamSkillName'),
    teamSkillVersion: requireString(record, 'teamSkillVersion'),
    packagePath: requireString(record, 'packagePath'),
    sourcePath: requireString(record, 'sourcePath'),
    ...(readTeamInstanceSourceType(record.sourceType) ? { sourceType: readTeamInstanceSourceType(record.sourceType)! } : {}),
    managedAgents: readArray(record.managedAgents) as TeamManagedAgentRecord[],
    graphTemplate: readRecordOrNull(record.graphTemplate) as TeamGraphDefinition | null,
    runs: readArray(record.runs) as TeamInstanceRunRecord[],
    createdAt: readNumber(record.createdAt) ?? 0,
    updatedAt: readNumber(record.updatedAt) ?? 0,
  };
}

function instantiateTeamGraphTemplateForRun(template: TeamGraphDefinition, context: {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly nowMs: number;
}): TeamGraphDefinition {
  const workflowPlanId = `graph-${context.idempotencyKey}`;
  return {
    ...template,
    graphId: `team-graph:${context.runId}`,
    workflowPlanId,
    runId: context.runId,
    idempotencyKey: context.idempotencyKey,
    createdAt: context.nowMs,
    nodes: template.nodes.map((node) => ({
      ...node,
      executor: { ...node.executor },
      config: { ...node.config },
      metadata: {
        ...node.metadata,
        workflowPlanId,
        runId: context.runId,
      },
    })),
    edges: template.edges.map((edge) => ({
      ...edge,
      payload: { ...edge.payload },
      metadata: { ...edge.metadata },
    })),
    groups: cloneTeamGraphWorkflowGroups(template.groups),
    metadata: template.metadata ? { ...template.metadata, workflowPlanId, runId: context.runId } : undefined,
  };
}

function cloneTeamGraphWorkflowGroups(groups: readonly TeamGraphWorkflowGroupInput[]): TeamGraphWorkflowGroupInput[] {
  return groups.map((group) => ({
    ...group,
    taskIds: [...group.taskIds],
    join: { ...group.join },
  }));
}

function readTeamGraphDefinitionInput(value: Record<string, unknown>, context: {
  readonly runId: string;
  readonly idempotencyKey: string;
  readonly nowMs: number;
  readonly existingDefinition: TeamGraphDefinition | null;
  readonly workflowPlan: TeamWorkflowPlanProjection | null;
  readonly definitionStatusSource: 'input' | 'preserve-existing';
}): TeamGraphDefinition {
  const nodes = readArray(value.nodes).map((nodeValue) => readTeamGraphNodeDefinition(nodeValue, context));
  const edges = readArray(value.edges).map((edgeValue) => readTeamGraphEdgeDefinition(edgeValue));
  const workflowPlanId = readString(value.workflowPlanId) ?? context.workflowPlan?.workflowPlanId ?? context.existingDefinition?.workflowPlanId ?? `graph-${context.idempotencyKey}`;
  return {
    graphId: readString(value.graphId) ?? context.existingDefinition?.graphId ?? `team-graph:${context.runId}`,
    workflowPlanId,
    runId: context.runId,
    title: readString(value.title) ?? context.workflowPlan?.title ?? context.existingDefinition?.title ?? 'TeamRun graph',
    status: readTeamGraphDefinitionStatus(value, context),
    idempotencyKey: context.idempotencyKey,
    createdAt: readNumber(value.updatedAt) ?? context.nowMs,
    nodes,
    edges,
    groups: context.workflowPlan?.groups ?? context.existingDefinition?.groups ?? [],
    ...optionalRecordProperty(value, 'metadata'),
  };
}

function readTeamGraphDefinitionStatus(value: Record<string, unknown>, context: { readonly existingDefinition: TeamGraphDefinition | null; readonly definitionStatusSource: 'input' | 'preserve-existing' }): string {
  if (context.definitionStatusSource === 'preserve-existing' && context.existingDefinition) return context.existingDefinition.status;
  return readString(value.status) ?? context.existingDefinition?.status ?? 'planned';
}

function readTeamGraphNodeDefinition(value: unknown, context: { readonly runId: string; readonly workflowPlan: TeamWorkflowPlanProjection | null; readonly existingDefinition: TeamGraphDefinition | null }): TeamGraphNodeDefinition {
  const record = readRecord(value);
  const nodeKind = readTeamGraphNodeKind(record);
  if (nodeKind === 'work') return readTeamGraphWorkNodeDefinition(record, context);

  const nodeId = requireString(record, 'nodeId');
  const existingNode = context.existingDefinition?.nodes.find((node) => node.nodeId === nodeId);
  const title = readString(record.title) ?? existingNode?.title ?? nodeKind;
  return {
    nodeId,
    nodeKind,
    kind: nodeKind,
    title,
    ...optionalStringProperty(record, 'roleId'),
    ...optionalStringProperty(record, 'groupId'),
    executor: readRecord(record.executor),
    config: readRecord(record.config),
    metadata: {
      ...readRecord(record.metadata),
      workflowPlanId: context.workflowPlan?.workflowPlanId ?? existingNode?.metadata.workflowPlanId ?? 'graph-config',
      runId: context.runId,
      title,
      ...optionalStringProperty(record, 'groupId'),
    },
  };
}

function readTeamGraphWorkNodeDefinition(record: Record<string, unknown>, context: { readonly runId: string; readonly workflowPlan: TeamWorkflowPlanProjection | null; readonly existingDefinition: TeamGraphDefinition | null }): TeamGraphWorkNodeDefinition {
  const nodeId = requireString(record, 'nodeId');
  const taskId = readString(record.taskId) ?? readString(record.stageId) ?? nodeId;
  const existingNode = context.existingDefinition?.nodes.find((node) => node.nodeId === nodeId || node.taskId === taskId);
  const plannedTask = context.workflowPlan?.tasks.find((task) => task.taskId === taskId);
  const roleId = readString(record.roleId) ?? plannedTask?.roleId ?? existingNode?.roleId;
  if (!roleId) throw new Error(`Team graph node "${nodeId}" roleId is required`);
  const title = readString(record.title) ?? plannedTask?.title ?? existingNode?.title ?? taskId;
  const executor = { ...readRecord(record.executor), kind: 'team-role' as const, roleId };
  const inputConfig = readRecord(record.config);
  const existingConfig = readRecord(existingNode?.config);
  const config = {
    ...inputConfig,
    prompt: readString(inputConfig.prompt) ?? plannedTask?.prompt ?? readString(existingConfig.prompt) ?? title,
    ...optionalStringProperty(inputConfig, 'outputArtifactKind'),
  };
  return {
    nodeId,
    nodeKind: 'work',
    kind: 'work',
    taskId,
    roleId,
    title,
    ...optionalStringProperty(record, 'groupId'),
    executor,
    config,
    metadata: {
      ...readRecord(record.metadata),
      workflowPlanId: context.workflowPlan?.workflowPlanId ?? existingNode?.metadata.workflowPlanId ?? 'graph-config',
      runId: context.runId,
      taskId,
      roleId,
      title,
      ...optionalStringProperty(record, 'groupId'),
    },
  };
}

function readTeamGraphNodeKind(record: Record<string, unknown>): TeamGraphNodeDefinition['kind'] {
  const kind = readString(record.kind) ?? readString(record.nodeKind) ?? 'work';
  if (kind === 'start' || kind === 'work' || kind === 'review' || kind === 'human_decision' || kind === 'script_review' || kind === 'join' || kind === 'end') return kind;
  throw new Error(`Unsupported Team graph node kind "${kind}".`);
}

function isLayoutOnlyTeamGraphDefinitionChange(previous: TeamGraphDefinition, next: TeamGraphDefinition): boolean {
  return JSON.stringify(normalizeExecutableGraphDefinition(previous)) === JSON.stringify(normalizeExecutableGraphDefinition(next));
}

function normalizeExecutableGraphDefinition(definition: TeamGraphDefinition): Record<string, unknown> {
  return {
    graphId: definition.graphId,
    workflowPlanId: definition.workflowPlanId,
    runId: definition.runId,
    title: definition.title,
    groups: definition.groups,
    nodes: definition.nodes.map((node) => ({
      nodeId: node.nodeId,
      kind: node.kind,
      title: node.title,
      roleId: node.roleId,
      groupId: node.groupId,
      taskId: node.taskId,
      executor: node.executor,
      config: node.config,
    })),
    edges: definition.edges.map((edge) => ({
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      kind: edge.kind,
      type: edge.type,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
      action: edge.action,
      payload: edge.payload,
    })),
  };
}

function readTeamGraphEdgeDefinition(value: unknown): TeamGraphEdgeDefinition {
  const record = readRecord(value);
  const edgeId = requireString(record, 'edgeId');
  const sourceNodeId = readString(record.sourceNodeId) ?? readString(record.fromNodeId);
  const targetNodeId = readString(record.targetNodeId) ?? readString(record.toNodeId);
  if (!sourceNodeId || !targetNodeId) throw new Error(`Team graph edge "${edgeId}" sourceNodeId and targetNodeId are required`);
  const sourcePort = readString(record.sourcePort) ?? 'completed';
  const targetPort = readString(record.targetPort) ?? 'input';
  const edgeType = readString(record.edgeType) ?? readString(record.type) ?? (sourcePort === 'completed' ? 'completed_success' : sourcePort);
  return {
    edgeId,
    sourceNodeId,
    targetNodeId,
    kind: readString(record.kind) ?? edgeType,
    type: edgeType,
    sourcePort,
    targetPort,
    action: readTeamGraphEdgeAction(record.action),
    payload: readTeamGraphEdgePayloadPolicy(record.payload),
    metadata: {
      ...readRecord(record.metadata),
      ...optionalStringProperty(record, 'label'),
    },
  };
}

function readTeamGraphEdgeAction(value: unknown): TeamGraphEdgeDefinition['action'] {
  if (value === 'activate' || value === 'rework' || value === 'gate' || value === 'finish') return value;
  throw new Error('Team graph edge action must be activate, rework, gate, or finish');
}

function readTeamGraphEdgePayloadPolicy(value: unknown): TeamGraphEdgeDefinition['payload'] {
  const record = readRecord(value);
  return { includeUpstreamResult: record.includeUpstreamResult === true };
}

function optionalRecordProperty(input: Record<string, unknown>, field: string): Record<string, Record<string, unknown>> {
  const value = readRecordOrNull(input[field]);
  return value ? { [field]: value } : {};
}

function readTeamSourceType(value: unknown): TeamSourceType {
  if (value === undefined || value === null || value === 'teamskill') return 'teamskill';
  if (value === 'manual') return 'manual';
  throw new Error('Team sourceType must be teamskill or manual');
}

function readTeamInstanceSourceType(value: unknown): TeamSourceType | undefined {
  return value === 'teamskill' || value === 'manual' ? value : undefined;
}

function readManualTeamProvisionInput(value: unknown): ManualTeamProvisionInput {
  const record = readRecord(value);
  const name = requireString(record, 'name');
  const description = readString(record.description) ?? 'Selected agent team';
  const version = readString(record.version) ?? 'manual';
  const members = readArray(record.members).map(readManualTeamMemberProvisionInput);
  if (members.length === 0) {
    throw new Error('Selected agent team members are required');
  }
  const leaderCount = members.filter((member) => member.isLeader).length;
  if (leaderCount !== 1) {
    throw new Error('Selected agent team must have exactly one leader');
  }
  const agentIds = new Set<string>();
  const roleIds = new Set<string>();
  for (const member of members) {
    if (agentIds.has(member.agentId)) {
      throw new Error(`Selected agent team member agentId must be unique: ${member.agentId}`);
    }
    agentIds.add(member.agentId);
    const runtimeRoleId = member.isLeader ? 'leader' : member.roleId;
    if (!member.isLeader && runtimeRoleId === 'leader') {
      throw new Error('Selected agent team roleId "leader" is reserved for the selected leader');
    }
    if (roleIds.has(runtimeRoleId)) {
      throw new Error(`Selected agent team roleId must be unique: ${runtimeRoleId}`);
    }
    roleIds.add(runtimeRoleId);
  }
  return { name, description, version, members };
}

function readManualTeamMemberProvisionInput(value: unknown): ManualTeamMemberProvisionInput {
  const record = readRecord(value);
  return {
    agentId: requireString(record, 'agentId'),
    agentName: readString(record.agentName) ?? requireString(record, 'agentId'),
    workspace: requireString(record, 'workspace'),
    roleId: requireString(record, 'roleId'),
    skills: readStringArray(record.skills),
    tools: readStringArray(record.tools),
    ...optionalStringProperty(record, 'model'),
    isLeader: record.isLeader === true,
  };
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
    graphRunState: readRecordOrNull(record.graphRunState) as TeamGraphRunState | null,
    nodeDeliveries: readArray(record.nodeDeliveries) as TeamWorkNodeDelivery[],
    roleBindings: readArray(record.roleBindings) as TeamRoleSessionBinding[],
    workflowPlan: readRecordOrNull(record.workflowPlan) as TeamWorkflowPlanProjection | null,
    dispatchGroups: readArray(record.dispatchGroups) as TeamDispatchGroupProjection[],
    dispatchTasks: readArray(record.dispatchTasks) as TeamDispatchTaskProjection[],
    dispatches: readArray(record.dispatches) as TeamDispatchProjection[],
    dispatchExecutions: readArray(record.dispatchExecutions) as TeamDispatchExecutionProjection[],
    approvals: readArray(record.approvals) as TeamApprovalProjection[],
    artifacts: readArray(record.artifacts) as TeamArtifactProjection[],
    messages: readArray(record.messages) as TeamMessageProjection[],
    nodePromptDeliveries: readArray(record.nodePromptDeliveries) as TeamNodePromptDeliveryRecord[],
    gates: readArray(record.gates) as TeamGateProjection[],
    kickbacks: readArray(record.kickbacks) as TeamKickbackProjection[],
    decisions: readArray(record.decisions) as TeamDecisionProjection[],
    events: readArray(record.events) as TeamEventProjection[],
    processedIdempotencyKeys: new Set(readStringArray(record.processedIdempotencyKeys)),
  };
}

function buildManualTeamMaterializationSpec(teamId: string, endpoint: RuntimeEndpointRef, manualTeam: ManualTeamProvisionInput): TeamAgentMaterializationSpec {
  const leaderMember = manualTeam.members.find((member) => member.isLeader);
  if (!leaderMember) {
    throw new Error('Selected agent team must have exactly one leader');
  }
  return {
    teamId,
    endpoint,
    sourceType: 'manual',
    teamSkill: {
      name: manualTeam.name,
      skillMarkdown: buildManualTeamSkillMarkdown(manualTeam),
      workflowMarkdown: buildManualTeamWorkflowMarkdown(manualTeam),
      dependenciesYaml: 'skills: []\ntools: []\n',
      dependencies: { skills: [], tools: [] },
    },
    leader: buildManualTeamRoleMaterializationSpec(leaderMember, 'leader'),
    roles: manualTeam.members.filter((member) => !member.isLeader).map((member) => buildManualTeamRoleMaterializationSpec(member, member.roleId)),
  };
}

function buildManualTeamRoleMaterializationSpec(member: ManualTeamMemberProvisionInput, roleId: string): TeamRoleAgentMaterializationSpec {
  return {
    roleId,
    agentName: member.agentName,
    roleMarkdown: buildManualTeamRoleMarkdown(member, roleId),
    skills: member.skills,
    tools: member.tools,
    ...(member.model ? { model: member.model } : {}),
    sourceAgentId: member.agentId,
    sourceWorkspace: member.workspace,
  };
}

function buildManualTeamSkillMarkdown(manualTeam: ManualTeamProvisionInput): string {
  return [
    `# ${manualTeam.name}`,
    '',
    manualTeam.description,
    '',
    '## Members',
    '',
    ...manualTeam.members.map((member) => `- ${member.isLeader ? 'leader' : member.roleId}: ${member.agentName}`),
    '',
  ].join('\n');
}

function buildManualTeamWorkflowMarkdown(manualTeam: ManualTeamProvisionInput): string {
  return [
    '# Team Workflow',
    '',
    'This team was created by selecting existing agents and selecting one leader.',
    '',
    'The graph remains user-configured in TeamRun; no dispatch/chat mode is selected at team creation time.',
    '',
    'Role prompts are generated from this template at materialization time, not from user-entered role instructions.',
    '',
    ...manualTeam.members.map((member) => `- ${member.isLeader ? 'leader' : member.roleId}: ${member.agentName}`),
    '',
  ].join('\n');
}

function buildManualTeamRoleMarkdown(member: ManualTeamMemberProvisionInput, roleId: string): string {
  return [
    `# ${roleId}`,
    '',
    `Agent: ${member.agentName}`,
    `Role: ${roleId}`,
    '',
    '## Role baseline',
    '',
    '- Treat the current node prompt as the assignment source.',
    '- Do not infer stable duties beyond the assigned node and available context.',
    '- Use the roleId above when TeamRun asks for a role identifier.',
    '',
  ].join('\n');
}

function buildLeaderMaterializationSpec(): TeamRoleAgentMaterializationSpec {
  return {
    roleId: 'leader',
    agentName: 'leader',
  };
}

function buildRoleMaterializationSpec(role: NonNullable<Awaited<ReturnType<TeamRuntimePackagePort['validate']>>['package']>['roles'][number]): TeamRoleAgentMaterializationSpec {
  return {
    roleId: role.id,
    agentName: role.id,
    purpose: role.purpose,
    roleMarkdown: role.agentsMd,
    skills: role.skills,
    tools: role.tools,
  };
}

function buildGraphWorkNodePrompt(input: {
  readonly node: TeamGraphWorkNodeDefinition;
  readonly delivery: TeamWorkNodeDelivery;
  readonly runId: string;
  readonly runtimeEndpoint: RuntimeEndpointRef;
  readonly plannedTask?: TeamWorkflowTaskPlan;
}): string {
  const prompt = readString(input.node.config.prompt) ?? input.plannedTask?.prompt ?? input.node.title;
  return appendAttemptUserMessageSection([
    `## TeamRun WorkNode: ${input.node.title}`,
    '',
    '### Node context',
    '',
    'These fields identify the exact TeamRun node execution. Use them when a TeamRun tool asks for runId, nodeExecutionId, or roleId; do not invent replacements.',
    '',
    `- runId: ${input.runId}`,
    `- nodeId: ${input.node.nodeId}`,
    `- nodeExecutionId: ${input.delivery.nodeExecutionId}`,
    `- roleId: ${input.node.roleId}`,
    `- attempt: ${input.delivery.attemptNumber}`,
    '',
    ...formatRuntimeEndpointPromptSection(input.runtimeEndpoint),
    '',
    ...formatNodeEventLifecyclePromptSection(),
    '',
    '### Node work',
    '',
    'This is the work instruction from the node config, workflow task, or node title. Do this work; do not treat it as tool documentation.',
    '',
    prompt,
    '',
  ].join('\n'), input.delivery.attemptUserMessage);
}

function appendTeamRunWorkspaceContext(message: string, input: { readonly run: TeamRunRecord; readonly binding: TeamRoleSessionBinding }): string {
  return [
    message,
    '',
    '### TeamRun workspace context',
    '',
    'This message is for the long-lived Team role workspace session. It is not a WorkNode attempt prompt and does not claim a nodeExecutionId.',
    '',
    `- teamId: ${input.run.teamId ?? ''}`,
    `- runId: ${input.run.runId}`,
    `- roleId: ${input.binding.roleId}`,
    ...formatRuntimeEndpointPromptSection(input.binding.sessionIdentity.endpoint),
    '',
  ].join('\n');
}

function isEntryWorkNode(definition: TeamGraphDefinition, nodeId: string): boolean {
  return !definition.edges.some((edge) => edge.targetNodeId === nodeId && (edge.action === 'activate' || edge.action === 'gate' || edge.action === 'finish'));
}

function markReadyQueueItemRunning(state: TeamGraphRunState, queueItem: TeamGraphReadyQueueItem, nowMs: number): TeamGraphRunState {
  const currentAttempt = state.nodeExecutionsByNodeId[queueItem.nodeId]?.attempts.at(-1);
  if (!currentAttempt) {
    throw new Error(`Ready node "${queueItem.nodeId}" cannot be scheduled because it has no execution attempt. Recreate the run state from the submitted workflow plan.`);
  }
  if (currentAttempt.status !== 'ready') {
    throw new Error(`Ready node "${queueItem.nodeId}" current attempt "${currentAttempt.attemptId}" has status "${currentAttempt.status}", expected "ready".`);
  }
  if (currentAttempt.attemptId !== queueItem.attemptId) {
    throw new Error(`Ready queue item for node "${queueItem.nodeId}" points to attempt "${queueItem.attemptId}", but current attempt is "${currentAttempt.attemptId}".`);
  }
  const history = state.nodeExecutionsByNodeId[queueItem.nodeId];
  if (!history || history.attempts.length === 0) {
    throw new Error(`Cannot mark node "${queueItem.nodeId}" running because it has no attempt history. Recreate the run state from the submitted workflow plan.`);
  }
  const readyQueueItems = state.readyQueueItems.filter((item) => item.queueItemId !== queueItem.queueItemId);
  const nodeExecutionsByNodeId: Record<string, TeamGraphNodeExecutionHistory> = {
    ...state.nodeExecutionsByNodeId,
    [queueItem.nodeId]: {
      attempts: [...history.attempts.slice(0, -1), { ...currentAttempt, status: 'running', startedAt: nowMs, updatedAt: nowMs }],
    },
  };
  return {
    ...state,
    nodeExecutionsByNodeId,
    readyQueue: readyQueueItems.map((item) => item.nodeId),
    readyQueueItems,
    readyQueueHead: 0,
    queuedReadyNodeIds: readyQueueItems.map((item) => item.nodeId),
  };
}

function formatNodeEventLifecyclePromptSection(): string[] {
  return [
    '### Node event lifecycle',
    '',
    'Use Team Node Event only for this nodeExecutionId. Do not invent or edit attempt ids.',
    '',
    'Before calling Team Node Event:',
    '- Copy runId, nodeExecutionId, roleId, and the runtime endpoint fields from this prompt.',
    '- Include top-level summary, event, and a stable idempotencyKey.',
    '',
    'After calling Team Node Event:',
    '- If complete or reject returns success: true, stop calling Team Node Event for this nodeExecutionId.',
    '- Do not submit another terminal event for the same nodeExecutionId with a new idempotencyKey.',
    '- If review requests rework, wait for a new TeamRun node prompt with a new nodeExecutionId; do not guess the next attempt id.',
  ];
}

function formatRuntimeEndpointPromptSection(runtimeEndpoint: RuntimeEndpointRef): string[] {
  const endpointFields = runtimeEndpoint.kind === 'native-runtime'
    ? [
      `- runtimeKind: ${runtimeEndpoint.kind}`,
      `- runtimeAdapterId: ${runtimeEndpoint.runtimeAdapterId}`,
      `- runtimeInstanceId: ${runtimeEndpoint.runtimeInstanceId}`,
    ]
    : [
      `- runtimeKind: ${runtimeEndpoint.kind}`,
      `- protocolId: ${runtimeEndpoint.protocolId}`,
      `- connectorId: ${runtimeEndpoint.connectorId}`,
      `- endpointId: ${runtimeEndpoint.endpointId}`,
    ];
  const flatEndpointArgument = runtimeEndpoint.kind === 'native-runtime'
    ? {
      runtimeKind: runtimeEndpoint.kind,
      runtimeAdapterId: runtimeEndpoint.runtimeAdapterId,
      runtimeInstanceId: runtimeEndpoint.runtimeInstanceId,
    }
    : {
      runtimeKind: runtimeEndpoint.kind,
      protocolId: runtimeEndpoint.protocolId,
      connectorId: runtimeEndpoint.connectorId,
      endpointId: runtimeEndpoint.endpointId,
    };
  return [
    '### Runtime endpoint tool arguments',
    '',
    'TeamRun tools use flat runtime endpoint fields. Copy these fields directly into the tool arguments; keep them as top-level fields.',
    '',
    ...endpointFields,
    '',
    'Before calling any TeamRun tool, check the argument shape:',
    '- Correct: runtimeKind/runtimeAdapterId/runtimeInstanceId are top-level fields for native-runtime.',
    '- If validation mentions runtimeKind or runtime endpoint fields, retry the same tool once with the flat fields below.',
    '',
    'Correct tool argument fragment:',
    '```json',
    JSON.stringify(flatEndpointArgument, null, 2).slice(1, -1),
    '```',
  ];
}

function reviewOutputPortFromSummary(summary: string): 'passed' | 'failed' {
  const normalized = summary.trim().toLowerCase();
  return normalized.startsWith('fail:') || normalized.startsWith('failed:') || normalized.startsWith('reject:') || normalized.startsWith('rejected:') ? 'failed' : 'passed';
}

function buildGraphReviewNodePrompt(input: {
  readonly node: TeamGraphNodeDefinition;
  readonly task: TeamDispatchTaskProjection;
  readonly effect: TeamGraphControlNodeEffect;
  readonly runId: string;
  readonly runtimeEndpoint: RuntimeEndpointRef;
}): string {
  return [
    `## TeamRun ReviewNode: ${input.node.title}`,
    '',
    '### Node context',
    '',
    'These fields identify the exact TeamRun review node execution. Use them when a TeamRun tool asks for runId, nodeExecutionId, or roleId; do not invent replacements.',
    '',
    `- runId: ${input.runId}`,
    `- nodeId: ${input.node.nodeId}`,
    `- nodeExecutionId: ${input.effect.nodeExecutionId}`,
    `- roleId: ${input.task.roleId}`,
    `- attempt: ${input.effect.attemptNumber}`,
    '',
    ...formatRuntimeEndpointPromptSection(input.runtimeEndpoint),
    '',
    ...formatNodeEventLifecyclePromptSection(),
    '',
    '### Review work',
    '',
    'This is the review instruction from the review node config. Use it to judge upstream results; do not treat it as tool documentation.',
    '',
    readString(input.node.config?.prompt) ?? 'Review the upstream TeamRun results and decide which ReviewNode output port should be used.',
    '',
  ].join('\n');
}

function buildGraphDeliveryInputContext(_graphRunState: TeamGraphRunState, artifacts: readonly TeamArtifactProjection[], delivery: TeamWorkNodeDelivery): string[] {
  if (delivery.inputContexts.length === 0) return [];
  const artifactById = new Map(artifacts.map((artifact) => [artifact.artifactId, artifact]));
  const sourceSummaries = delivery.inputContexts.map((context) => {
    const result = context.sourceResult;
    const resultParts = result
      ? [
        `kind=${result.kind}`,
        `summary=${result.summary}`,
        ...(result.content ? [`content=${result.content}`] : []),
        ...(result.decision ? [`decision=${result.decision}`] : []),
        ...(result.assignments?.length ? [`assignments=${result.assignments.map((assignment) => `${assignment.roleId}: ${assignment.text}`).join(' | ')}`] : []),
      ]
      : ['upstream result not included by edge payload'];
    return `- ${context.sourceNodeId} (${context.sourceNodeExecutionId}) via ${context.edgeId} action=${context.action}: ${resultParts.join('; ')}`;
  });
  const artifactSummaries = delivery.inputContexts.flatMap((context) => context.artifactIds).flatMap((artifactId) => {
    const artifact = artifactById.get(artifactId);
    if (!artifact) return [`- ${artifactId}`];
    return [`- ${artifact.artifactId} · ${artifact.kind} · ${artifact.title}${artifact.summary ? `: ${artifact.summary}` : ''}`];
  });
  return [
    '## Upstream inputs',
    '',
    'Use these explicit upstream NodeResults from edge input contexts instead of guessing from chat history.',
    ...(sourceSummaries.length > 0 ? ['', '### Input contexts', '', ...sourceSummaries] : []),
    ...(artifactSummaries.length > 0 ? ['', '### Artifacts', '', 'Upstream artifacts available to this node.', '', ...artifactSummaries] : []),
  ];
}

function appendGraphDeliveryInputContext(message: string, contextLines: readonly string[]): string {
  return appendAttemptUserMessageSection(
    contextLines.length === 0 ? message : [message, '', ...contextLines].join('\n'),
    extractAttemptUserMessage(message),
  );
}

function appendAttemptUserMessageSection(message: string, attemptUserMessage: string | undefined): string {
  if (!attemptUserMessage) return message;
  return [
    removeAttemptUserMessageSection(message),
    '',
    '### Attempt user message',
    '',
    'This user message started this entry WorkNode attempt. Treat it as the attempt input, not as generic chat history.',
    '',
    attemptUserMessage,
    '',
  ].join('\n');
}

function extractAttemptUserMessage(message: string): string | undefined {
  const marker = '### Attempt user message';
  const markerIndex = message.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const afterMarker = message.slice(markerIndex + marker.length);
  const description = 'This user message started this entry WorkNode attempt. Treat it as the attempt input, not as generic chat history.';
  return afterMarker.replace(description, '').trim() || undefined;
}

function removeAttemptUserMessageSection(message: string): string {
  const marker = '### Attempt user message';
  const markerIndex = message.indexOf(marker);
  return markerIndex < 0 ? message : message.slice(0, markerIndex).trimEnd();
}

function buildGraphReviewDispatchTask(input: {
  readonly runId: string;
  readonly workflowPlanId: string;
  readonly node: TeamGraphNodeDefinition;
  readonly roleId: string;
  readonly createdAt: number;
}): TeamDispatchTaskProjection {
  const groupId = input.node.groupId ?? 'graph-review';
  const taskId = input.node.taskId ?? input.node.nodeId;
  return {
    dispatchTaskId: `${input.workflowPlanId}:review:${input.node.nodeId}`,
    runId: input.runId,
    workflowPlanId: input.workflowPlanId,
    dispatchGroupId: `${input.workflowPlanId}:group:${groupId}`,
    groupId,
    taskId,
    roleId: input.roleId,
    dispatchId: `${input.workflowPlanId}:review-dispatch:${input.node.nodeId}`,
    status: 'queued',
    idempotencyKey: `${input.workflowPlanId}:review:${input.node.nodeId}`,
    createdAt: input.createdAt,
  };
}

function buildCanvasGraphDispatchTask(input: {
  readonly runId: string;
  readonly workflowPlanId: string;
  readonly node: TeamGraphWorkNodeDefinition;
  readonly createdAt: number;
}): TeamDispatchTaskProjection {
  const groupId = input.node.groupId ?? 'graph';
  return {
    dispatchTaskId: `${input.workflowPlanId}:task:${input.node.taskId}`,
    runId: input.runId,
    workflowPlanId: input.workflowPlanId,
    dispatchGroupId: `${input.workflowPlanId}:group:${groupId}`,
    groupId,
    taskId: input.node.taskId,
    roleId: input.node.roleId,
    dispatchId: `${input.workflowPlanId}:dispatch:${input.node.taskId}`,
    status: 'queued',
    idempotencyKey: `${input.workflowPlanId}:task:${input.node.taskId}`,
    createdAt: input.createdAt,
  };
}

function buildNodePromptDeliveryRecord(input: {
  readonly task: TeamDispatchTaskProjection;
  readonly binding: TeamRoleSessionBinding;
  readonly nodeId: string;
  readonly nodeExecutionId: string;
  readonly prompt: string;
  readonly displayMessage?: string;
  readonly plannedTask?: TeamWorkflowTaskPlan;
  readonly createdAt: number;
}): TeamNodePromptDeliveryRecord {
  return {
    deliveryRecordId: `team-node-prompt-${input.task.dispatchId}`,
    runId: input.task.runId,
    nodeId: input.nodeId,
    nodeExecutionId: input.nodeExecutionId,
    taskId: input.task.taskId,
    roleId: input.task.roleId,
    toAgentId: input.binding.agentId,
    sessionKey: input.binding.sessionKey,
    kind: 'node.prompt',
    title: input.plannedTask?.title ?? input.task.taskId,
    prompt: input.prompt,
    ...(input.displayMessage ? { displayMessage: input.displayMessage } : {}),
    status: 'pending',
    idempotencyKey: input.task.idempotencyKey,
    causationId: input.task.dispatchTaskId,
    createdAt: input.createdAt,
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

function kickbackIdsForTask(kickbacks: readonly TeamKickbackProjection[], taskId: string): string[] {
  return kickbacks.flatMap((kickback) => kickback.taskId === taskId && !kickback.resolvedAt ? [kickback.kickbackId] : []);
}

function buildNodePromptDeliveryIndexById(nodePromptDeliveries: readonly TeamNodePromptDeliveryRecord[]): Map<string, number> {
  return new Map(nodePromptDeliveries.map((delivery, index) => [delivery.deliveryRecordId, index]));
}

function upsertNodePromptDelivery(nodePromptDeliveries: TeamNodePromptDeliveryRecord[], delivery: TeamNodePromptDeliveryRecord, deliveryIndexById = buildNodePromptDeliveryIndexById(nodePromptDeliveries)): void {
  const index = deliveryIndexById.get(delivery.deliveryRecordId);
  if (index !== undefined) {
    nodePromptDeliveries[index] = delivery;
    return;
  }
  deliveryIndexById.set(delivery.deliveryRecordId, nodePromptDeliveries.length);
  nodePromptDeliveries.push(delivery);
}

function nextRetryAtForNodePromptDeliveries(nodePromptDeliveries: readonly TeamNodePromptDeliveryRecord[]): number | null {
  let nextRetryAt: number | null = null;
  for (const delivery of nodePromptDeliveries) {
    if (delivery.status !== 'retry_scheduled') continue;
    if (typeof delivery.nextRetryAt !== 'number' || !Number.isFinite(delivery.nextRetryAt)) continue;
    nextRetryAt = nextRetryAt === null ? delivery.nextRetryAt : Math.min(nextRetryAt, delivery.nextRetryAt);
  }
  return nextRetryAt;
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


function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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

function requireTextInput(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${field} is required`);
  return value;
}

function optionalStringProperty(input: Record<string, unknown>, field: string): Record<string, string> {
  const value = readString(input[field]);
  return value ? { [field]: value } : {};
}

function optionalDefinedProperty<T>(field: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [field]: value };
}

function requireTriggerSource(input: Record<string, unknown>): TeamTriggerSourceKind {
  const value = readString(input.triggerSource);
  if (value === 'cron' || value === 'webhook') return value;
  throw new Error('triggerSource must be "cron" or "webhook"');
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
