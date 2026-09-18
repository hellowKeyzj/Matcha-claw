import { hostApiFetch, resolveSingleCapabilityScope } from '@/lib/host-api';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeError,
  summarizeIdentifier,
} from '@/lib/session-trace';
import type { RuntimeEndpointRef, SessionIdentity } from '../../../electron/desktop-contract/runtime-address';
import type { CapabilityTarget } from '../../../electron/desktop-contract/capability-target';

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
  | 'team.proposalConfirm'
  | 'team.proposalCancel'
  | 'team.roleMessageSubmit'
  | 'team.nodePromptRetryDue'
  | 'team.nodePromptSettled'
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

export type TeamSkillSelectionId = `teamskill:v1:${string}`;

export interface TeamSkillPackage {
  selectionId: TeamSkillSelectionId;
  name: string;
  version: string;
  kind: 'team-skill';
  description: string;
}

export type TeamSkillPackageValidationResult =
  | { status: 'valid'; package: TeamSkillPackage }
  | { status: 'invalid' | 'unavailable' };

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
  endpointRef: RuntimeEndpointRef;
  localSessionId: string;
  endpointSessionId: string;
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
  localSessionId: string;
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
  childLocalSessionId?: string;
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
  maxAttempts?: number;
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
  graphId?: string;
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

export type TeamStartGateStatus = 'intake' | 'proposal_pending' | 'started';

export interface TeamRunProposalProjection {
  proposalId?: string;
  taskSummary: string;
  detail?: string;
  createdAt?: number;
}

export interface TeamRunStartGateProjection {
  status: TeamStartGateStatus;
  proposal?: TeamRunProposalProjection | null;
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
  startGate?: TeamRunStartGateProjection | null;
  nextEventCursor: number;
}

export interface TeamRuntimeOperationReceipt {
  success?: boolean;
  code?: string;
  operationId?: TeamRuntimeOperationId;
  message?: string;
  outcome?: string;
}

export interface TeamRunDecisionSubmitResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  stageId?: string;
  decisionId?: string;
  decision?: TeamDecisionType;
  sequence?: number;
  replayed?: boolean;
  run?: TeamRunSummary;
  snapshot?: TeamRunSnapshot;
}

export type TeamApprovalResolutionDecision = 'approve' | 'deny' | 'abort';

export interface TeamApprovalResolveResult extends TeamRuntimeOperationReceipt {
  success?: true;
  outcome?: 'recorded' | 'replayed';
  runId?: string;
  approvalId?: string;
  decision?: TeamApprovalResolutionDecision;
  status?: TeamApprovalStatus;
  approval?: TeamApprovalRecord;
  run?: TeamRunSummary;
  snapshot?: TeamRunSnapshot;
}

export type TeamTriggerSourceKind = 'cron' | 'webhook';

export interface TeamTriggerRecord {
  teamId: string;
  runId: string;
  startNodeId: string;
  trigger: { kind: 'webhook' } | { kind: 'cron'; expression: string };
}

export interface TeamTriggerListResult {
  triggers: TeamTriggerRecord[];
}

export interface TeamWebhookTriggerFireResult extends TeamRuntimeOperationReceipt {
  success: true;
  fired: boolean;
  runId: string;
  outcome: 'recorded' | 'replayed';
}

export interface TeamTriggerFireResult extends TeamRuntimeOperationReceipt {
  success?: true;
  fired?: boolean;
  runId?: string;
  outcome?: 'recorded' | 'replayed';
  snapshot?: TeamRunSnapshot;
}

export interface TeamRoleMessageSubmitResult extends TeamRuntimeOperationReceipt {
  success?: true;
  submitted?: boolean;
  deliveryId?: string;
  outcome?: 'accepted';
  snapshot?: TeamRunSnapshot;
}

export interface TeamGraphSaveResult extends TeamRuntimeOperationReceipt {
  success?: true;
  runId?: string;
  saved?: true;
  outcome?: 'available';
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
  success?: true;
  runId?: string;
  accepted?: boolean;
  saved?: true;
  record?: Record<string, unknown>;
  snapshot?: TeamRunSnapshot;
}

export interface TeamGraphContextNodeRecord {
  nodeId: string;
  nodeExecutionId?: string;
  status: string;
  outputPort?: string;
}

export interface TeamGraphContextEdgeRecord {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
}

export interface TeamGraphContextResult {
  teamId: string;
  runId: string;
  graphStatus: string;
  nodes: TeamGraphContextNodeRecord[];
  edges: TeamGraphContextEdgeRecord[];
  pendingApprovalIds: string[];
  recentEventIds: string[];
}

export interface TeamNodePromptRetryDueItemResult {
  deliveryId: string;
  nodeId: string;
  nodeExecutionId?: string;
  resolution: Record<string, unknown>;
}

export interface TeamNodePromptRetryDueResult {
  runId: string;
  processedDeliveryRecordIds: string[];
  nextRetryAt?: number | null;
  items: TeamNodePromptRetryDueItemResult[];
}

export type TeamNodePromptSettledPhase = 'final' | 'error' | 'aborted';

export interface TeamNodePromptSettledResult {
  settled: boolean;
  runId: string | null;
  snapshot: TeamRunSnapshot | null;
}

export interface TeamGraphYamlExportResult {
  runId: string;
  fileName: string;
  yaml: string;
}

export interface TeamGraphYamlImportResult extends TeamRuntimeOperationReceipt {
  runId?: string;
  imported: true;
  snapshot?: TeamRunSnapshot;
}

export interface TeamProposalConfirmResult extends TeamRuntimeOperationReceipt {
  success?: true;
  runId?: string;
  outcome?: 'recorded' | 'replayed' | 'started' | 'intake';
  snapshot?: TeamRunSnapshot;
}

export interface TeamRunCancelResult {
  success: true;
  runId: string;
  state: 'cancelling' | 'cancelled' | 'tombstoned';
}

export interface TeamRunDeleteResult {
  runId: string;
  state: 'purged';
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

type TeamRuntimeResponseDecoder<T> = (payload: unknown) => T;

async function teamRuntimeApi<T>(payload: {
  operationId: TeamRuntimeOperationId;
  target: CapabilityTarget | null;
  input: Record<string, unknown>;
}, decode?: TeamRuntimeResponseDecoder<T>): Promise<T> {
  const traceId = createSessionTraceId(`team-runtime:${payload.operationId}`);
  let scope: Awaited<ReturnType<typeof resolveSingleCapabilityScope>>;
  try {
    scope = await resolveSingleCapabilityScope(TEAM_RUNTIME_CAPABILITY_ID);
  } catch (error) {
    logSessionTrace('renderer.team.runtime.scope-error', traceId, {
      ...summarizeTeamRuntimeRequest(payload),
      error: summarizeError(error),
    });
    throw error;
  }

  logSessionTrace('renderer.team.runtime.request', traceId, summarizeTeamRuntimeRequest(payload));
  try {
    const response = await hostApiFetch<unknown>('/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: TEAM_RUNTIME_CAPABILITY_ID,
        operationId: payload.operationId,
        scope,
        target: payload.target,
        input: payload.input,
      }),
      timeoutMs: 60_000,
      traceId,
    });
    const result = decode ? decode(response) : response as T;
    logSessionTrace('renderer.team.runtime.response', traceId, {
      operationId: payload.operationId,
      contract: decode ? 'decoded' : 'raw',
    });
    return result;
  } catch (error) {
    logSessionTrace('renderer.team.runtime.error', traceId, {
      ...summarizeTeamRuntimeRequest(payload),
      error: summarizeError(error),
    });
    throw error;
  }
}

function summarizeTeamRuntimeRequest(payload: {
  operationId: TeamRuntimeOperationId;
  target: CapabilityTarget | null;
  input: Record<string, unknown>;
}): Record<string, unknown> {
  const target = isRecord(payload.target) ? payload.target : null;
  return {
    operationId: payload.operationId,
    targetKind: readString(target, 'kind'),
    teamId: summarizeIdentifier(readString(payload.input, 'teamId') ?? readString(target, 'teamId')),
    runId: summarizeIdentifier(readString(payload.input, 'runId') ?? readString(target, 'runId')),
    approvalId: summarizeIdentifier(readString(payload.input, 'approvalId') ?? readString(target, 'approvalId')),
    packagePath: summarizeIdentifier(readString(payload.input, 'packagePath') ?? readString(target, 'packagePath')),
    webhookPath: summarizeIdentifier(readString(payload.input, 'webhookPath')),
    sessionKey: summarizeIdentifier(readString(payload.input, 'sessionKey')),
    promptRunId: summarizeIdentifier(readString(payload.input, 'promptRunId')),
    sourceType: readString(payload.input, 'sourceType'),
    phase: readString(payload.input, 'phase'),
    decision: readString(payload.input, 'decision'),
    event: readString(payload.input, 'event'),
  };
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' ? value : null;
}

export async function validateTeamSkillPackage(payload: {
  packagePath: string;
}): Promise<TeamSkillPackageValidationResult> {
  return await teamRuntimeApi({
    operationId: 'team.packageValidate',
    target: { kind: 'team', packagePath: payload.packagePath },
    input: { packagePath: payload.packagePath },
  }, decodeTeamSkillPackageValidation);
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
      ...(payload.manualTeam ? { manualTeam: toManualTeamProvisionInput(payload.manualTeam) } : {}),
    },
  }, decodeTeamProvisionAgents);
}

export async function deleteTeamInstance(payload: {
  teamId: string;
}): Promise<{ teamId: string | null; deleted?: boolean; state: 'tombstoned'; deletedRunIds?: string[]; deletedAgentIds?: string[] }> {
  return await teamRuntimeApi({
    operationId: 'team.delete',
    target: { kind: 'team', teamId: payload.teamId },
    input: { kind: 'team', teamId: payload.teamId },
  }, decodeTeamDelete);
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
  }, decodeTeamRunSummary);
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

export async function listTeamRunTriggers(payload?: {
  teamId?: string;
}): Promise<TeamTriggerListResult> {
  return await teamRuntimeApi({
    operationId: 'team.triggerList',
    target: payload?.teamId ? { kind: 'team', teamId: payload.teamId } : { kind: 'team' },
    input: {},
  });
}

export async function fireTeamWebhookTrigger(payload: {
  webhookPath: string;
  idempotencyKey: string;
}): Promise<TeamWebhookTriggerFireResult> {
  return await teamRuntimeApi({
    operationId: 'team.webhookTriggerFire',
    target: { kind: 'team' },
    input: {
      webhookPath: payload.webhookPath,
      idempotencyKey: payload.idempotencyKey,
    },
  }, decodeTeamWebhookTriggerFire);
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
  }, decodeTeamRunDecisionSubmit);
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
  }, decodeTeamApprovalResolve);
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
  }, decodeTeamGraphSave);
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
  }, decodeTeamAgentCommandAvailable);
}

export async function readTeamRunGraphContext(payload: {
  teamId: string;
  runId: string;
  view: 'current_node' | 'currentNode' | 'graph_summary' | 'graphSummary';
  nodeExecutionId?: string;
}): Promise<TeamGraphContextResult> {
  return await teamRuntimeApi({
    operationId: 'team.graphContext',
    target: { kind: 'team-run', teamId: payload.teamId, runId: payload.runId },
    input: {
      teamId: payload.teamId,
      runId: payload.runId,
      view: payload.view,
      ...(payload.nodeExecutionId ? { nodeExecutionId: payload.nodeExecutionId } : {}),
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
  }, decodeTeamGraphYamlExport);
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
  }, decodeTeamGraphYamlImport);
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
  }, decodeTeamTriggerFire);
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
  }, decodeTeamRoleMessageSubmit);
}

export async function wakeDueTeamRunNodePromptRetries(payload: {
  runId: string;
}): Promise<TeamNodePromptRetryDueResult> {
  return await teamRuntimeApi({
    operationId: 'team.nodePromptRetryDue',
    target: { kind: 'team-run', runId: payload.runId },
    input: { runId: payload.runId },
  }, decodeTeamNodePromptRetryDue);
}

export async function settleTeamRunNodePrompt(payload: {
  sessionKey: string;
  promptRunId: string;
  phase: TeamNodePromptSettledPhase;
}): Promise<TeamNodePromptSettledResult> {
  return await teamRuntimeApi({
    operationId: 'team.nodePromptSettled',
    target: null,
    input: {
      sessionKey: payload.sessionKey,
      promptRunId: payload.promptRunId,
      phase: payload.phase,
    },
  }, decodeTeamNodePromptSettled);
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
  result?: Record<string, unknown>;
  deliveryId?: string;
  receipt?: string;
  nodeId?: string;
  attemptNumber?: number;
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
      ...(payload.result ? { result: payload.result } : {}),
      ...(payload.deliveryId ? { deliveryId: payload.deliveryId } : {}),
      ...(payload.receipt ? { receipt: payload.receipt } : {}),
      ...(payload.nodeId ? { nodeId: payload.nodeId } : {}),
      ...(payload.attemptNumber !== undefined ? { attemptNumber: payload.attemptNumber } : {}),
    },
  }, decodeTeamNodeEvent);
}

export async function confirmTeamRunProposal(payload: {
  runId: string;
  proposalId?: string;
  idempotencyKey: string;
}): Promise<TeamProposalConfirmResult> {
  return await teamRuntimeApi({
    operationId: 'team.proposalConfirm',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      ...(payload.proposalId ? { proposalId: payload.proposalId } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  }, decodeTeamProposalConfirm);
}

export async function cancelTeamRunProposal(payload: {
  runId: string;
  proposalId?: string;
  idempotencyKey: string;
}): Promise<TeamProposalConfirmResult> {
  return await teamRuntimeApi({
    operationId: 'team.proposalCancel',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      ...(payload.proposalId ? { proposalId: payload.proposalId } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  }, decodeTeamProposalConfirm);
}

export async function cancelTeamRun(payload: {
  runId: string;
  reason?: string;
  idempotencyKey: string;
}): Promise<TeamRunCancelResult> {
  return await teamRuntimeApi({
    operationId: 'team.runCancel',
    target: { kind: 'team-run', runId: payload.runId },
    input: {
      runId: payload.runId,
      ...(payload.reason ? { reason: payload.reason } : {}),
      idempotencyKey: payload.idempotencyKey,
    },
  }, decodeTeamRunCancel);
}

export async function deleteTeamRun(payload: {
  runId: string;
}): Promise<TeamRunDeleteResult> {
  return await teamRuntimeApi({
    operationId: 'team.runDelete',
    target: { kind: 'team-run', runId: payload.runId },
    input: { runId: payload.runId },
  }, decodeTeamRunDelete);
}

function toManualTeamProvisionInput(manualTeam: ManualTeamProvisionRecord): ManualTeamProvisionRecord {
  return {
    name: manualTeam.name,
    description: manualTeam.description,
    version: manualTeam.version,
    members: manualTeam.members.map((member) => ({
      agentId: member.agentId,
      agentName: member.agentName,
      workspace: member.workspace,
      roleId: member.roleId,
      skills: member.skills,
      tools: member.tools,
      ...(member.model ? { model: member.model } : {}),
      isLeader: member.isLeader,
    })),
  };
}

function decodeTeamSkillPackageValidation(payload: unknown): TeamSkillPackageValidationResult {
  if (!isRecord(payload) || typeof payload.status !== 'string') return teamRuntimeDecodeFailure();
  if ((payload.status === 'invalid' || payload.status === 'unavailable') && hasExactKeys(payload, ['status'])) {
    return { status: payload.status };
  }
  if (payload.status === 'valid' && hasExactKeys(payload, ['status', 'package']) && isTeamSkillPackage(payload.package)) {
    return payload as TeamSkillPackageValidationResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamProvisionAgents(payload: unknown): { teamId: string; managedAgentCount: number } {
  if (isRecord(payload)
    && hasExactKeys(payload, ['teamId', 'managedAgentCount'])
    && isText(payload.teamId)
    && isSafeNonNegativeInteger(payload.managedAgentCount)) {
    return payload as { teamId: string; managedAgentCount: number };
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamDelete(payload: unknown): { teamId: string | null; deleted?: boolean; state: 'tombstoned'; deletedRunIds?: string[]; deletedAgentIds?: string[] } {
  if (isRecord(payload)
    && hasOnlyKeys(payload, ['teamId', 'state', 'deleted', 'deletedRunIds', 'deletedAgentIds'])
    && (payload.teamId === null || isText(payload.teamId))
    && payload.state === 'tombstoned'
    && (payload.deleted === undefined || typeof payload.deleted === 'boolean')
    && (payload.deletedRunIds === undefined || isStringArray(payload.deletedRunIds))
    && (payload.deletedAgentIds === undefined || isStringArray(payload.deletedAgentIds))) {
    return payload as { teamId: string | null; deleted?: boolean; state: 'tombstoned'; deletedRunIds?: string[]; deletedAgentIds?: string[] };
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamRunSummary(payload: unknown): TeamRunSummary {
  if (isRecord(payload)
    && hasOnlyKeys(payload, ['runId', 'status', 'revision', 'currentStageId', 'replayed'])
    && isText(payload.runId)
    && isTeamRunStatus(payload.status)
    && isSafeNonNegativeInteger(payload.revision)
    && (payload.currentStageId === undefined || isText(payload.currentStageId))
    && (payload.replayed === undefined || typeof payload.replayed === 'boolean')) {
    return payload as unknown as TeamRunSummary;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamRunDecisionSubmit(payload: unknown): TeamRunDecisionSubmitResult {
  if (isRecord(payload)
    && hasOnlyKeys(payload, ['runId', 'decisionId', 'stageId', 'decision', 'sequence', 'replayed'])
    && isText(payload.runId)
    && isText(payload.decisionId)
    && isText(payload.stageId)
    && isTeamDecisionType(payload.decision)
    && isSafeNonNegativeInteger(payload.sequence)
    && typeof payload.replayed === 'boolean') {
    return payload as TeamRunDecisionSubmitResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamApprovalResolve(payload: unknown): TeamApprovalResolveResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['success', 'outcome'])
    && payload.success === true
    && (payload.outcome === 'recorded' || payload.outcome === 'replayed')) {
    return payload as TeamApprovalResolveResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamWebhookTriggerFire(payload: unknown): TeamWebhookTriggerFireResult {
  if (isRecordedTriggerFire(payload)) {
    return payload as TeamWebhookTriggerFireResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamGraphSave(payload: unknown): TeamGraphSaveResult {
  if (isAvailableGraphCommand(payload)) {
    return payload as TeamGraphSaveResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamAgentCommandAvailable(payload: unknown): TeamAgentCommandResult {
  if (isAvailableGraphCommand(payload)) {
    return payload as TeamAgentCommandResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamGraphYamlExport(payload: unknown): TeamGraphYamlExportResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['runId', 'fileName', 'yaml'])
    && isText(payload.runId)
    && isText(payload.fileName)
    && typeof payload.yaml === 'string') {
    return payload as unknown as TeamGraphYamlExportResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamGraphYamlImport(payload: unknown): TeamGraphYamlImportResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['runId', 'imported'])
    && isText(payload.runId)
    && payload.imported === true) {
    return payload as unknown as TeamGraphYamlImportResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamTriggerFire(payload: unknown): TeamTriggerFireResult {
  if (isRecordedTriggerFire(payload)) {
    return payload as TeamTriggerFireResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamRoleMessageSubmit(payload: unknown): TeamRoleMessageSubmitResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['success', 'outcome', 'deliveryId'])
    && payload.success === true
    && payload.outcome === 'accepted'
    && isText(payload.deliveryId)) {
    return payload as TeamRoleMessageSubmitResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamNodePromptRetryDue(payload: unknown): TeamNodePromptRetryDueResult {
  if (isRecord(payload)
    && hasOnlyKeys(payload, ['runId', 'processedDeliveryRecordIds', 'nextRetryAt', 'items'])
    && isText(payload.runId)
    && isStringArray(payload.processedDeliveryRecordIds)
    && (payload.nextRetryAt === undefined || payload.nextRetryAt === null || isSafeNonNegativeInteger(payload.nextRetryAt))
    && Array.isArray(payload.items)
    && payload.items.every(isTeamNodePromptRetryDueItem)) {
    return payload as unknown as TeamNodePromptRetryDueResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamNodePromptSettled(payload: unknown): TeamNodePromptSettledResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['settled', 'runId', 'snapshot'])
    && typeof payload.settled === 'boolean'
    && (payload.runId === null || isText(payload.runId))
    && (payload.snapshot === null || isRecord(payload.snapshot))) {
    return payload as unknown as TeamNodePromptSettledResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamNodeEvent(payload: unknown): TeamAgentCommandResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['success', 'runId', 'outcome'])
    && payload.success === true
    && isText(payload.runId)
    && isText(payload.outcome)) {
    return payload as TeamAgentCommandResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamProposalConfirm(payload: unknown): TeamProposalConfirmResult {
  if (isRecord(payload)
    && hasOnlyKeys(payload, ['success', 'runId', 'outcome', 'snapshot'])
    && (payload.success === undefined || payload.success === true)
    && (payload.runId === undefined || isText(payload.runId))
    && (payload.outcome === undefined || payload.outcome === 'recorded' || payload.outcome === 'replayed' || payload.outcome === 'started' || payload.outcome === 'intake')
    && (payload.snapshot === undefined || isRecord(payload.snapshot))) {
    return payload as TeamProposalConfirmResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamRunCancel(payload: unknown): TeamRunCancelResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['success', 'runId', 'state'])
    && payload.success === true
    && isText(payload.runId)
    && (payload.state === 'cancelling' || payload.state === 'cancelled' || payload.state === 'tombstoned')) {
    return payload as unknown as TeamRunCancelResult;
  }
  return teamRuntimeDecodeFailure();
}

function decodeTeamRunDelete(payload: unknown): TeamRunDeleteResult {
  if (isRecord(payload)
    && hasExactKeys(payload, ['runId', 'state'])
    && isText(payload.runId)
    && payload.state === 'purged') {
    return payload as unknown as TeamRunDeleteResult;
  }
  return teamRuntimeDecodeFailure();
}

function isRecordedTriggerFire(payload: unknown): boolean {
  return isRecord(payload)
    && hasExactKeys(payload, ['success', 'fired', 'runId', 'outcome'])
    && payload.success === true
    && typeof payload.fired === 'boolean'
    && isText(payload.runId)
    && (payload.outcome === 'recorded' || payload.outcome === 'replayed');
}

function isAvailableGraphCommand(payload: unknown): boolean {
  return isRecord(payload)
    && hasExactKeys(payload, ['success', 'runId', 'saved', 'outcome'])
    && payload.success === true
    && isText(payload.runId)
    && payload.saved === true
    && payload.outcome === 'available';
}

function isTeamNodePromptRetryDueItem(payload: unknown): boolean {
  return isRecord(payload)
    && hasExactKeys(payload, ['deliveryId', 'nodeId', 'nodeExecutionId', 'resolution'])
    && isText(payload.deliveryId)
    && isText(payload.nodeId)
    && isText(payload.nodeExecutionId)
    && isRecord(payload.resolution);
}

function isTeamRunStatus(value: unknown): value is TeamRunStatus {
  return value === 'created'
    || value === 'provisioning'
    || value === 'waiting_for_user'
    || value === 'running'
    || value === 'paused'
    || value === 'cancelling'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled';
}

function isTeamDecisionType(value: unknown): value is TeamDecisionType {
  return value === 'retry' || value === 'proceed_degraded' || value === 'abort';
}

function isTeamSkillPackage(payload: unknown): payload is TeamSkillPackage {
  return isRecord(payload)
    && hasExactKeys(payload, ['selectionId', 'name', 'version', 'kind', 'description'])
    && isTeamSkillSelectionId(payload.selectionId)
    && isText(payload.name)
    && isText(payload.version)
    && payload.kind === 'team-skill'
    && typeof payload.description === 'string';
}

function isTeamSkillSelectionId(value: unknown): value is TeamSkillSelectionId {
  return typeof value === 'string' && /^teamskill:v1:[a-f0-9]{64}$/.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function teamRuntimeDecodeFailure(): never {
  throw new Error('Team runtime response is unavailable');
}
