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
  | 'team.triggerList'
  | 'team.webhookTriggerFire'
  | 'team.runSnapshot'
  | 'team.runDiagnostics'
  | 'team.runDecisionSubmit'
  | 'team.resume'
  | 'team.approvalResolve'
  | 'team.graphSave'
  | 'team.graphPatch'
  | 'team.graphContext'
  | 'team.graphExportYaml'
  | 'team.graphImportYaml'
  | 'team.triggerFire'
  | 'team.roleMessageSubmit'
  | 'team.nodePromptRetryDue'
  | 'team.nodeEvent'
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

export type TeamSourceType = 'teamskill' | 'manual';

export interface ManualTeamMemberProvisionRecord {
  agentId: string;
  agentName: string;
  workspace: string;
  roleId: string;
  skills: string[];
  tools: string[];
  model?: string;
  isLeader: boolean;
}

export interface ManualTeamProvisionRecord {
  name: string;
  description: string;
  version: string;
  members: ManualTeamMemberProvisionRecord[];
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
export type TeamNodePromptDeliveryAttemptStatus = 'pending' | 'delivering' | 'delivered' | 'retry_scheduled' | 'failed' | 'cancelled';
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

export interface TeamNodePromptDeliveryAttemptRecord {
  deliveryRecordId: string;
  runId: string;
  nodeId: string;
  nodeExecutionId: string;
  taskId: string;
  roleId: string;
  toAgentId: string;
  sessionKey: string;
  kind: 'node.prompt';
  title: string;
  prompt: string;
  status: TeamNodePromptDeliveryAttemptStatus;
  idempotencyKey: string;
  causationId: string;
  createdAt: number;
  updatedAt?: number;
  attempt?: number;
  maxAttempts?: number;
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

export interface TeamGraphNodeRecord {
  nodeId: string;
  kind?: string;
  title?: string;
  roleId?: string;
  groupId?: string;
  taskId?: string;
  stageId?: string;
  status?: string;
  statusReason?: string;
  createdAt?: number;
  completedAt?: number;
  artifactId?: string;
  executor?: Record<string, unknown>;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type TeamGraphEdgeAction = 'activate' | 'rework' | 'gate' | 'finish';

export interface TeamGraphEdgePayloadPolicyRecord {
  includeUpstreamResult: boolean;
}

export interface TeamGraphEdgeRecord {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  fromNodeId?: string;
  toNodeId?: string;
  sourcePort?: string;
  targetPort?: string;
  edgeType?: string;
  kind?: string;
  action?: TeamGraphEdgeAction;
  payload?: TeamGraphEdgePayloadPolicyRecord;
  status?: string;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface TeamGraphSnapshotRecord {
  runId?: string;
  workflowPlanId?: string;
  nodes: TeamGraphNodeRecord[];
  edges: TeamGraphEdgeRecord[];
  status: string;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface TeamGraphInboundEdgeStateRecord {
  edgeId: string;
  sourceNodeId: string;
  sourcePort: string;
  targetPort: string;
  action: TeamGraphEdgeAction;
  payload: TeamGraphEdgePayloadPolicyRecord;
  status: 'available' | 'waiting';
  sourceNodeExecutionId?: string;
  artifactIds: string[];
  updatedAt?: number;
}

export interface TeamGraphNodeInputStateRecord {
  nodeId: string;
  status: 'waiting' | 'ready';
  inboundEdges: TeamGraphInboundEdgeStateRecord[];
  activationEdges: TeamGraphInboundEdgeStateRecord[];
  arrivedActivationEdges: TeamGraphInboundEdgeStateRecord[];
  waitingActivationEdges: TeamGraphInboundEdgeStateRecord[];
  updatedAt?: number;
}

export interface TeamNodeExecutionRecord {
  runId: string;
  nodeId: string;
  nodeExecutionId?: string;
  attemptId?: string;
  attemptNumber?: number;
  reason?: string;
  executionRecordId?: string;
  executionId?: string;
  stageId?: string;
  roleId?: string;
  status: string;
  statusReason?: string;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
  createdAt?: number;
  updatedAt?: number;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  result?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface TeamGraphAttemptInputContextRecord {
  edgeId: string;
  action: TeamGraphEdgeAction;
  sourceNodeId: string;
  sourcePort: string;
  targetPort: string;
  sourceNodeExecutionId: string;
  sourceAttemptId: string;
  sourceResult?: Record<string, unknown>;
  artifactIds: string[];
  arrivedAt: number;
}

export interface TeamNodeDeliveryRecord {
  runId?: string;
  nodeId: string;
  deliveryId: string;
  taskId: string;
  roleId: string;
  attemptId: string;
  attemptNumber: number;
  inputContexts: TeamGraphAttemptInputContextRecord[];
  status: 'queued';
  createdAt: number;
}

export interface TeamRunSnapshot {
  run: TeamRunRecord | null;
  graph: TeamGraphSnapshotRecord | null;
  nodeInputStates: TeamGraphNodeInputStateRecord[];
  nodeExecutions: TeamNodeExecutionRecord[];
  nodeDeliveries: TeamNodeDeliveryRecord[];
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
  nodePromptDeliveries: TeamNodePromptDeliveryAttemptRecord[];
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

export type TeamTriggerSourceKind = 'cron' | 'webhook';

export interface TeamTriggerFireResult extends TeamRuntimeOperationReceipt {
  fired?: boolean;
  snapshot?: TeamRunSnapshot;
}

export interface TeamRoleMessageSubmitResult extends TeamRuntimeOperationReceipt {
  submitted?: boolean;
  snapshot?: TeamRunSnapshot;
}

export interface TeamGraphSaveResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  saved?: boolean;
  snapshot?: TeamRunSnapshot;
}

export type TeamNodeEventKind = 'progress' | 'request_input' | 'request_approval' | 'reject' | 'complete';

export type TeamGraphPatchOperation =
  | { op: 'add_node' | 'replace_node'; node: Record<string, unknown> }
  | { op: 'remove_node'; nodeId: string }
  | { op: 'add_edge' | 'replace_edge'; edge: Record<string, unknown> }
  | { op: 'remove_edge'; edgeId: string }
  | { op: 'set_metadata'; metadata: Record<string, unknown> };

export interface TeamGraphPatchInput {
  baseGraphId?: string;
  baseWorkflowPlanId?: string;
  operations: TeamGraphPatchOperation[];
}

export interface TeamAgentCommandResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  accepted?: boolean;
  record?: Record<string, unknown>;
  snapshot?: TeamRunSnapshot;
}

export interface TeamGraphYamlExportResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  fileName: string;
  yaml: string;
}

export interface TeamGraphYamlImportResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  imported?: boolean;
  snapshot?: TeamRunSnapshot;
}

export interface TeamWebhookAuthProjection {
  success: true;
  enabled: true;
  source: 'environment' | 'settings';
  headerName: 'x-matchaclaw-webhook-token';
  authorizationScheme: 'Bearer';
  maskedToken: string;
  copySupported: false;
}

const TEAM_RUNTIME_CAPABILITY_ID = 'team.runtime';

export async function readTeamWebhookAuth(): Promise<TeamWebhookAuthProjection> {
  return await hostApiFetch<TeamWebhookAuthProjection>('/api/runtime-host/team-webhook-auth');
}

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
  sourceType?: TeamSourceType;
  manualTeam?: ManualTeamProvisionRecord;
}): Promise<{ teamId: string; managedAgentCount: number }> {
  return await teamRuntimeApi({
    operationId: 'team.provisionAgents',
    target: { kind: 'team', teamId: payload.teamId, packagePath: payload.packagePath },
    input: {
      teamId: payload.teamId,
      packagePath: payload.packagePath,
      idempotencyKey: payload.idempotencyKey,
      ...(payload.sourceType ? { sourceType: payload.sourceType } : {}),
      ...(payload.manualTeam ? { manualTeam: payload.manualTeam } : {}),
    },
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
  sourceType?: TeamSourceType;
}): Promise<TeamRunSummary> {
  return await teamRuntimeApi({
    operationId: 'team.runCreate',
    target: { kind: 'team', packagePath: payload.packagePath, ...(payload.teamId ? { teamId: payload.teamId } : {}) },
    input: {
      ...(payload.teamId ? { teamId: payload.teamId } : {}),
      packagePath: payload.packagePath,
      ...(payload.runId ? { runId: payload.runId } : {}),
      idempotencyKey: payload.idempotencyKey,
      ...(payload.sourceType ? { sourceType: payload.sourceType } : {}),
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

export async function resumeTeam(payload: {
  teamId: string;
  idempotencyKey: string;
}): Promise<{ success: true; teamId: string; restoredRunIds: string[]; activeRunIds: string[]; skippedTerminalRunIds: string[]; runs: TeamRunListItem[] }> {
  return await teamRuntimeApi({
    operationId: 'team.resume',
    target: { kind: 'team', teamId: payload.teamId },
    input: { teamId: payload.teamId, idempotencyKey: payload.idempotencyKey },
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

export async function saveTeamRunGraphProjection(payload: {
  runId: string;
  graph: TeamGraphSnapshotRecord;
  idempotencyKey: string;
}): Promise<TeamGraphSaveResult> {
  return await teamRuntimeApi({
    operationId: 'team.graphSave',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      graph: payload.graph,
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function submitTeamRunGraphPatch(payload: {
  runId: string;
  summary: string;
  patch: TeamGraphPatchInput;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}): Promise<TeamAgentCommandResult> {
  return await teamRuntimeApi({
    operationId: 'team.graphPatch',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      summary: payload.summary,
      patch: payload.patch,
      idempotencyKey: payload.idempotencyKey,
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    },
  });
}

export async function exportTeamRunGraphYaml(payload: {
  runId: string;
}): Promise<TeamGraphYamlExportResult> {
  return await teamRuntimeApi({
    operationId: 'team.graphExportYaml',
    target: { kind: 'team-run', runId: payload.runId },
    input: { runId: payload.runId },
  });
}

export async function importTeamRunGraphYaml(payload: {
  runId: string;
  yaml: string;
  idempotencyKey: string;
}): Promise<TeamGraphYamlImportResult> {
  return await teamRuntimeApi({
    operationId: 'team.graphImportYaml',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      yaml: payload.yaml,
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function fireTeamRunTrigger(payload: {
  runId: string;
  startNodeId: string;
  triggerSource: TeamTriggerSourceKind;
  payloadSummary?: string;
  idempotencyKey: string;
}): Promise<TeamTriggerFireResult> {
  return await teamRuntimeApi({
    operationId: 'team.triggerFire',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      startNodeId: payload.startNodeId,
      triggerSource: payload.triggerSource,
      ...(payload.payloadSummary ? { payloadSummary: payload.payloadSummary } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function submitTeamRunRoleMessage(payload: {
  runId: string;
  roleId: string;
  text: string;
  idempotencyKey: string;
}): Promise<TeamRoleMessageSubmitResult> {
  return await teamRuntimeApi({
    operationId: 'team.roleMessageSubmit',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      roleId: payload.roleId,
      text: payload.text,
      idempotencyKey: payload.idempotencyKey,
    },
  });
}

export async function submitTeamRunNodeEvent(payload: {
  runId: string;
  nodeExecutionId: string;
  event: TeamNodeEventKind;
  summary: string;
  idempotencyKey: string;
  roleId?: string;
  outputPort?: string;
  evidenceRefs?: TeamEvidenceRefRecord[];
  requestedAction?: string;
  risk?: string;
  metadata?: Record<string, unknown>;
}): Promise<TeamAgentCommandResult> {
  return await teamRuntimeApi({
    operationId: 'team.nodeEvent',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      nodeExecutionId: payload.nodeExecutionId,
      event: payload.event,
      summary: payload.summary,
      idempotencyKey: payload.idempotencyKey,
      ...(payload.roleId ? { roleId: payload.roleId } : {}),
      ...(payload.outputPort ? { outputPort: payload.outputPort } : {}),
      ...(payload.evidenceRefs ? { evidenceRefs: payload.evidenceRefs } : {}),
      ...(payload.requestedAction ? { requestedAction: payload.requestedAction } : {}),
      ...(payload.risk ? { risk: payload.risk } : {}),
      ...(payload.metadata ? { metadata: payload.metadata } : {}),
    },
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
