import { hostApiFetch, resolveSingleCapabilityScope } from '@/lib/host-api';
import type { CapabilityTarget, SessionIdentity } from '../../../runtime-host/shared/runtime-address';

export type TeamRunStatus = 'created' | 'provisioning' | 'waiting_for_user' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export type TeamRuntimeOperationId =
  | 'team.packageValidate'
  | 'team.dependencyPlan'
  | 'team.provisionAgents'
  | 'team.delete'
  | 'team.runCreate'
  | 'team.runList'
  | 'team.runSnapshot'
  | 'team.runDiagnostics'
  | 'team.runDecisionSubmit'
  | 'team.planWorkflow'
  | 'team.runTick'
  | 'team.resume'
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
export type TeamMessageKind = 'note' | 'question' | 'kickback';
export type TeamMailKind = 'task.assignment' | 'message.note' | 'message.question' | 'message.kickback';
export type TeamMailRelatedEntityKind = 'run' | 'task' | 'message' | 'artifact' | 'gate' | 'dispatch';
export type TeamMailStatus = 'pending' | 'delivering' | 'delivered' | 'retry_scheduled' | 'failed' | 'cancelled';
export type TeamGateStatus = 'open' | 'passed' | 'failed';

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
  teamId?: string;
  runId: string;
  roleId: string;
  agentId: string;
  sessionKey: string;
  sessionIdentity: SessionIdentity;
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

export interface TeamEvidenceRefRecord {
  type: 'workspacePath' | 'uri' | 'artifact' | 'inlineText';
  path?: string;
  uri?: string;
  artifactId?: string;
  text?: string;
  label?: string;
}

export interface TeamFailureItemRecord {
  code: string;
  message: string;
  severity?: 'info' | 'warning' | 'blocker';
  evidenceRefs?: TeamEvidenceRefRecord[];
}

export interface TeamMessageRecord {
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
  failureItems: TeamFailureItemRecord[];
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
  evidenceRefs?: TeamEvidenceRefRecord[];
  sourceEnvelopeId?: string;
  idempotencyKey: string;
  createdAt: number;
  updatedAt?: number;
  relatedTaskId?: string;
  relatedGateId?: string;
}

export interface TeamMailRecord {
  mailId: string;
  runId: string;
  threadId: string;
  kind: TeamMailKind;
  toAgentId: string;
  fromAgentId?: string;
  subject: string;
  body?: string;
  bodyRef?: string;
  payloadRef?: string;
  relatedEntity: { kind: TeamMailRelatedEntityKind; id: string };
  status: TeamMailStatus;
  idempotencyKey: string;
  causationId: string;
  createdAt: number;
  updatedAt?: number;
  attempt?: number;
  maxAttempts?: number;
  required?: boolean;
  nextRetryAt?: number;
  lastError?: string;
  deliveringAt?: number;
  deliveredAt?: number;
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
  gateType: string;
  subjectArtifactId?: string;
  relatedTaskId?: string;
  blocking: boolean;
  summary: string;
  verdict?: string;
  passed?: boolean;
  status: TeamGateStatus;
  failureItems: TeamFailureItemRecord[];
  idempotencyKey: string;
  createdAt: number;
  resolvedAt?: number;
  resolutionSummary?: string;
}

export interface TeamKickbackRecord {
  kickbackId: string;
  runId: string;
  stageId: string;
  fromRoleId: string;
  toRoleId: string;
  gateId?: string;
  artifactId?: string;
  taskId?: string;
  failureItems: TeamFailureItemRecord[];
  messageId: string;
  idempotencyKey: string;
  createdAt: number;
  resolvedAt?: number;
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
  mails: TeamMailRecord[];
  gates: TeamGateRecord[];
  kickbacks: TeamKickbackRecord[];
  decisions: TeamDecisionRecord[];
  diagnostics: TeamRunDiagnostics;
  events: TeamEventRecord[];
  nextEventCursor: number;
}

export interface TeamRuntimeOperationReceipt {
  success?: boolean;
  code?: string;
  operationId?: TeamRuntimeOperationId;
  message?: string;
}

export type TeamRunTickResultType = 'noop' | 'outbox_pending';
export type TeamRunTickAction = 'dependency_missing' | 'dispatch_prepared' | 'dispatch_execution_queued';

export interface TeamRunDirtyRunSummary {
  runId: string;
  updatedAt?: number;
}

export interface TeamRunTickResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  resultType?: TeamRunTickResultType;
  action?: TeamRunTickAction;
  dirtyRun?: TeamRunDirtyRunSummary | null;
  run?: TeamRunSummary;
  snapshot?: TeamRunSnapshot;
}

export interface TeamRunDecisionSubmitResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  stageId?: string;
  decisionId?: string;
  decision?: TeamDecisionType;
  run?: TeamRunSummary;
  snapshot?: TeamRunSnapshot;
}

export type TeamApprovalResolutionDecision = 'approve' | 'deny' | 'abort';

export interface TeamApprovalResolveResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  approvalId?: string;
  decision?: TeamApprovalResolutionDecision;
  status?: TeamApprovalStatus;
  approval?: TeamApprovalRecord;
  run?: TeamRunSummary;
  snapshot?: TeamRunSnapshot;
}

const TEAM_RUNTIME_CAPABILITY_ID = 'team.runtime';

async function teamRuntimeApi<T>(payload: {
  operationId: TeamRuntimeOperationId;
  target: CapabilityTarget;
  input: Record<string, unknown>;
}): Promise<T> {
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

export async function provisionTeamAgents(payload: {
  teamId: string;
  packagePath: string;
  idempotencyKey: string;
}): Promise<{ teamId: string; managedAgentCount: number }> {
  return await teamRuntimeApi({
    operationId: 'team.provisionAgents',
    target: { kind: 'team', teamId: payload.teamId, packagePath: payload.packagePath },
    input: { teamId: payload.teamId, packagePath: payload.packagePath, idempotencyKey: payload.idempotencyKey },
  });
}

export async function deleteTeamInstance(payload: {
  teamId: string;
}): Promise<{ teamId: string; deleted: boolean; deletedRunIds: string[]; deletedAgentIds: string[] }> {
  return await teamRuntimeApi({
    operationId: 'team.delete',
    target: { kind: 'team', teamId: payload.teamId },
    input: { kind: 'team', teamId: payload.teamId },
  });
}

export async function createTeamRun(payload: {
  teamId?: string;
  packagePath: string;
  runId?: string;
  idempotencyKey: string;
}): Promise<TeamRunSummary> {
  return await teamRuntimeApi({
    operationId: 'team.runCreate',
    target: { kind: 'team', packagePath: payload.packagePath, ...(payload.teamId ? { teamId: payload.teamId } : {}) },
    input: {
      ...(payload.teamId ? { teamId: payload.teamId } : {}),
      packagePath: payload.packagePath,
      ...(payload.runId ? { runId: payload.runId } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export interface TeamRunListItem extends TeamRunRecord {
  sessions: TeamRoleBindingRecord[];
}

export async function listTeamRuns(payload: {
  teamId: string;
}): Promise<{ teamId: string; runs: TeamRunListItem[] }> {
  return await teamRuntimeApi({
    operationId: 'team.runList',
    target: { kind: 'team', teamId: payload.teamId },
    input: { teamId: payload.teamId },
  });
}

export async function tickTeamRun(payload: {
  runId: string;
  idempotencyKey: string;
}): Promise<TeamRunTickResult> {
  return await teamRuntimeApi({
    operationId: 'team.runTick',
    target: { kind: 'team-run', runId: payload.runId },
    input: { runId: payload.runId, idempotencyKey: payload.idempotencyKey },
  });
}

export async function resumeTeam(payload: {
  teamId: string;
  idempotencyKey: string;
}): Promise<{ success: true; teamId: string; restoredRunIds: string[]; activeRunIds: string[]; skippedTerminalRunIds: string[] }> {
  return await teamRuntimeApi({
    operationId: 'team.resume',
    target: { kind: 'team', teamId: payload.teamId },
    input: { teamId: payload.teamId, idempotencyKey: payload.idempotencyKey },
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
  decision: TeamDecisionType;
  note?: string;
  idempotencyKey: string;
}): Promise<TeamRunDecisionSubmitResult> {
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
  decision: TeamApprovalResolutionDecision;
  note?: string;
  idempotencyKey: string;
}): Promise<TeamApprovalResolveResult> {
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
