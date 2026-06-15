import { hostApiFetch, resolveSingleCapabilityScope } from '@/lib/host-api';
import { ensurePluginEnabled } from '@/services/openclaw/plugin-manager-client';
import type { CapabilityTarget } from '../../../runtime-host/shared/runtime-address';

export type TeamRunStatus = 'created' | 'provisioning' | 'waiting_for_user' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export type TeamRuntimeOperationId =
  | 'team.packageValidate'
  | 'team.dependencyPlan'
  | 'team.runCreate'
  | 'team.runStart'
  | 'team.runSnapshot'
  | 'team.runDiagnostics'
  | 'team.runDecisionSubmit'
  | 'team.planWorkflow'
  | 'team.runTick'
  | 'team.approvalResolve'
  | 'team.runCancel'
  | 'team.runDelete';

export interface TeamRunSummary {
  runId: string;
  status: TeamRunStatus;
  revision: number;
  currentStageId?: string;
}

export interface TeamSkillDependencyEntry {
  name: string;
  required: boolean;
  purpose: string;
  source?: string;
}

export interface TeamSkillDependencies {
  skills: TeamSkillDependencyEntry[];
  tools: TeamSkillDependencyEntry[];
}

export interface TeamSkillValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface TeamSkillPackage {
  name: string;
  version: string;
  kind: 'team-skill';
  description: string;
  dependencies: TeamSkillDependencies;
  sourcePath: string;
}

export interface TeamSkillPackageValidationResult {
  valid: boolean;
  package?: TeamSkillPackage;
  errors: TeamSkillValidationIssue[];
  warnings: TeamSkillValidationIssue[];
}

export type TeamDependencyPlanItemKind = 'skill' | 'tool';
export type TeamDependencyPlanItemStatus = 'available' | 'missing';
export type TeamDependencyPlanItemSeverity = 'ok' | 'warning' | 'blocker';

export interface TeamDependencyPlanItem extends TeamSkillDependencyEntry {
  kind: TeamDependencyPlanItemKind;
  status: TeamDependencyPlanItemStatus;
  severity: TeamDependencyPlanItemSeverity;
  installable: boolean;
}

export interface TeamDependencyPreparationPlan {
  packageName: string;
  packageVersion: string;
  sourcePath: string;
  items: TeamDependencyPlanItem[];
  missingRequiredSkills: TeamSkillDependencyEntry[];
  missingOptionalSkills: TeamSkillDependencyEntry[];
  missingRequiredTools: TeamSkillDependencyEntry[];
  missingOptionalTools: TeamSkillDependencyEntry[];
  canProceed: boolean;
}

export type TeamStageStatus = 'pending' | 'running' | 'waiting_for_user' | 'passed' | 'failed' | 'skipped' | 'cancelled';
export type TeamApprovalStatus = 'pending' | 'approved' | 'denied' | 'aborted';
export type TeamDecisionType = 'retry' | 'proceed_degraded' | 'abort';
export type TeamWorkflowPlanStatus = 'planned';
export type TeamDispatchGroupStatus = 'queued' | 'completed' | 'failed';
export type TeamDispatchTaskStatus = 'queued' | 'completed' | 'failed' | 'cancelled' | 'stale';

export interface TeamRunRecord extends TeamRunSummary {
  packageName: string;
  packageVersion: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamWorkflowJoinPolicy {
  requireCompleted: boolean;
  allowFailed: boolean;
  retryLimit: number;
}

export interface TeamWorkflowTaskPlan {
  taskId: string;
  roleId: string;
  title: string;
  prompt: string;
  dependsOnTaskIds: string[];
  outputArtifactKind?: string;
}

export interface TeamWorkflowGroupPlan {
  groupId: string;
  title: string;
  taskIds: string[];
  join: TeamWorkflowJoinPolicy;
}

export interface TeamRunWorkflowPlan {
  workflowPlanId: string;
  runId: string;
  title: string;
  summary?: string;
  status: TeamWorkflowPlanStatus;
  groups: TeamWorkflowGroupPlan[];
  tasks: TeamWorkflowTaskPlan[];
  idempotencyKey: string;
  createdAt: number;
}

export interface TeamDispatchGroupRecord {
  dispatchGroupId: string;
  runId: string;
  workflowPlanId: string;
  groupId: string;
  taskIds: string[];
  status: TeamDispatchGroupStatus;
  idempotencyKey: string;
  createdAt: number;
  completedAt?: number;
}

export interface TeamDispatchTaskRecord {
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
}

export interface TeamStageRecord {
  runId: string;
  stageId: string;
  title: string;
  executor: string;
  roleId?: string;
  gateType?: string;
  status: TeamStageStatus;
  attempt: number;
  maxAttempts: number;
  inputArtifactIds: string[];
  outputArtifactIds: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TeamRoleBindingRecord {
  runId: string;
  roleId: string;
  agentId: string;
  agentName: string;
  workspaceDir: string;
  agentDir: string;
  skills: string[];
  tools: string[];
  status: string;
}

export interface TeamApprovalRecord {
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
}

export interface TeamMessageRecord {
  messageId: string;
  runId: string;
  fromRoleId: string;
  toRoleId: string;
  summary: string;
  body: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface TeamArtifactRecord {
  artifactId: string;
  runId: string;
  stageId: string;
  roleId: string;
  kind: string;
  title: string;
  contentRef: string;
  summary?: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface TeamDispatchRecord {
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
}

export interface TeamDispatchExecutionRecord {
  executionRecordId: string;
  runId: string;
  dispatchId: string;
  stageId: string;
  roleId: string;
  executionId?: string;
  childSessionKey?: string;
  spawnMode?: 'run' | 'session';
  status: 'claimed' | 'queued' | 'completed' | 'failed' | 'stale' | 'cancelled';
  statusReason?: string;
  staleAt?: number;
  idempotencyKey: string;
  createdAt: number;
}

export interface TeamGateRecord {
  gateId: string;
  runId: string;
  stageId: string;
  artifactId: string;
  gateType: string;
  verdict: string;
  passed: boolean;
  failureItems: Array<{ code: string; message: string }>;
  idempotencyKey: string;
  createdAt: number;
}

export interface TeamKickbackRecord {
  kickbackId: string;
  runId: string;
  stageId: string;
  gateId: string;
  failureItems: Array<{ code: string; message: string }>;
  idempotencyKey: string;
  createdAt: number;
}

export interface TeamDecisionRecord {
  decisionId: string;
  runId: string;
  stageId: string;
  decision: TeamDecisionType;
  note?: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface TeamEventRecord {
  eventId: string;
  runId: string;
  revision: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: number;
}

export interface TeamRunDiagnostics {
  runId: string;
  recoveredFromStorage: boolean;
  storageRoot: string;
  budgets: {
    totalWallClockBudgetMs?: number;
    totalTokenBudget?: number;
    roleWallClockBudgetMs: Record<string, number>;
    roleTokenBudget: Record<string, number>;
    elapsedMs?: number;
    wallClockExceeded: boolean;
  };
  limits: {
    maxArtifactContentBytes: number;
    maxMessageBodyBytes: number;
    staleDispatchExecutionMs: number;
  };
  staleDispatchExecutions: TeamDispatchExecutionRecord[];
  counts: Record<string, number>;
}

export interface TeamRunSnapshot {
  run: TeamRunRecord | null;
  roles: TeamRoleBindingRecord[];
  stages: TeamStageRecord[];
  workflowPlan: TeamRunWorkflowPlan | null;
  dispatchGroups: TeamDispatchGroupRecord[];
  dispatchTasks: TeamDispatchTaskRecord[];
  approvals: TeamApprovalRecord[];
  artifacts: TeamArtifactRecord[];
  dispatches: TeamDispatchRecord[];
  dispatchExecutions: TeamDispatchExecutionRecord[];
  messages: TeamMessageRecord[];
  gates: TeamGateRecord[];
  kickbacks: TeamKickbackRecord[];
  decisions: TeamDecisionRecord[];
  diagnostics: TeamRunDiagnostics;
  events: TeamEventRecord[];
  nextEventCursor: number;
}

const TEAM_RUNTIME_CAPABILITY_ID = 'team.runtime';
const TEAM_RUNTIME_PLUGIN_ID = 'team-runtime';

let teamRuntimePluginTask: Promise<void> | null = null;

async function ensureTeamRuntimePluginEnabled(): Promise<void> {
  if (teamRuntimePluginTask) {
    await teamRuntimePluginTask;
    return;
  }

  const task = ensurePluginEnabled(TEAM_RUNTIME_PLUGIN_ID).then(() => undefined);
  teamRuntimePluginTask = task;
  try {
    await task;
  } finally {
    if (teamRuntimePluginTask === task) {
      teamRuntimePluginTask = null;
    }
  }
}

async function teamRuntimeApi<T>(payload: {
  operationId: TeamRuntimeOperationId;
  target: CapabilityTarget;
  input: Record<string, unknown>;
}): Promise<T> {
  await ensureTeamRuntimePluginEnabled();
  return await hostApiFetch<T>('/api/capabilities/execute', {
    method: 'POST',
    body: JSON.stringify({
      id: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: payload.operationId,
      scope: await resolveSingleCapabilityScope(TEAM_RUNTIME_CAPABILITY_ID),
      target: payload.target,
      input: payload.input,
    }),
    timeoutMs: 60_000,
  });
}

export async function validateTeamSkillPackage(payload: {
  packagePath: string;
}): Promise<TeamSkillPackageValidationResult> {
  return await teamRuntimeApi({
    operationId: 'team.packageValidate',
    target: { kind: 'team', packagePath: payload.packagePath },
    input: { packagePath: payload.packagePath },
  });
}

export async function planTeamDependencies(payload: {
  packagePath: string;
}): Promise<TeamDependencyPreparationPlan> {
  return await teamRuntimeApi({
    operationId: 'team.dependencyPlan',
    target: { kind: 'team', packagePath: payload.packagePath },
    input: { packagePath: payload.packagePath },
  });
}

export async function createTeamRun(payload: {
  packagePath: string;
  runId?: string;
  idempotencyKey: string;
}): Promise<TeamRunSummary> {
  return await teamRuntimeApi({
    operationId: 'team.runCreate',
    target: { kind: 'team', packagePath: payload.packagePath },
    input: {
      packagePath: payload.packagePath,
      ...(payload.runId ? { runId: payload.runId } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function startTeamRun(payload: {
  runId: string;
  idempotencyKey: string;
  initialPrompt?: string;
}): Promise<TeamRunSummary> {
  return await teamRuntimeApi({
    operationId: 'team.runStart',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      idempotencyKey: payload.idempotencyKey,
      ...(payload.initialPrompt ? { initialPrompt: payload.initialPrompt } : {}),
    },
  });
}

export async function tickTeamRun(payload: {
  runId: string;
  idempotencyKey: string;
}): Promise<unknown> {
  return await teamRuntimeApi({
    operationId: 'team.runTick',
    target: { kind: 'team-run', runId: payload.runId },
    input: { runId: payload.runId, idempotencyKey: payload.idempotencyKey },
  });
}

export async function planTeamWorkflow(payload: {
  runId: string;
  title: string;
  summary?: string;
  groups: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  idempotencyKey: string;
}): Promise<{ plan: TeamRunWorkflowPlan; created: boolean }> {
  return await teamRuntimeApi({
    operationId: 'team.planWorkflow',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      title: payload.title,
      ...(payload.summary ? { summary: payload.summary } : {}),
      groups: payload.groups,
      tasks: payload.tasks,
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function submitTeamRunDecision(payload: {
  runId: string;
  decision: 'retry' | 'proceed_degraded' | 'abort';
  note?: string;
  idempotencyKey: string;
}): Promise<unknown> {
  return await teamRuntimeApi({
    operationId: 'team.runDecisionSubmit',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      decision: payload.decision,
      ...(payload.note ? { note: payload.note } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function resolveTeamApproval(payload: {
  runId: string;
  approvalId: string;
  decision: 'approve' | 'deny' | 'abort';
  note?: string;
  idempotencyKey: string;
}): Promise<unknown> {
  return await teamRuntimeApi({
    operationId: 'team.approvalResolve',
    target: { kind: 'team-approval', runId: payload.runId, approvalId: payload.approvalId },
    input: {
      runId: payload.runId,
      approvalId: payload.approvalId,
      decision: payload.decision,
      ...(payload.note ? { note: payload.note } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function readTeamRunSnapshot(payload: {
  runId: string;
  eventCursor?: number;
  eventLimit?: number;
}): Promise<TeamRunSnapshot> {
  return await teamRuntimeApi({
    operationId: 'team.runSnapshot',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      ...(typeof payload.eventCursor === 'number' ? { eventCursor: payload.eventCursor } : {}),
      ...(typeof payload.eventLimit === 'number' ? { eventLimit: payload.eventLimit } : {}),
    },
  });
}

export async function readTeamRunDiagnostics(payload: {
  runId: string;
}): Promise<TeamRunDiagnostics> {
  return await teamRuntimeApi({
    operationId: 'team.runDiagnostics',
    target: { kind: 'team-run', runId: payload.runId },
    input: { runId: payload.runId },
  });
}

export async function cancelTeamRun(payload: {
  runId: string;
  reason?: string;
  idempotencyKey: string;
}): Promise<TeamRunSummary> {
  return await teamRuntimeApi({
    operationId: 'team.runCancel',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      ...(payload.reason ? { reason: payload.reason } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function deleteTeamRun(payload: {
  runId: string;
}): Promise<{ runId: string; deleted: boolean }> {
  return await teamRuntimeApi({
    operationId: 'team.runDelete',
    target: { kind: 'team-run', runId: payload.runId },
    input: { runId: payload.runId },
  });
}
