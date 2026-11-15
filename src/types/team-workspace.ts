export type RunWorkspaceProjection = { status: 'ready' | 'preparing' | 'legacy' };

export type TeamRunStatus = 'created' | 'provisioning' | 'waiting_for_user' | 'running' | 'paused' | 'cancelling' | 'completed' | 'failed' | 'cancelled';
export type TeamRunLifecycle = 'active' | 'cancelling' | 'cancelled' | 'outcome_unknown';

export function isTeamRunLifecycle(value: unknown): value is TeamRunLifecycle {
  return value === 'active' || value === 'cancelling' || value === 'cancelled' || value === 'outcome_unknown';
}

export interface TeamRunSummary {
  runId: string;
  status: TeamRunStatus;
  revision: number;
  workspace: RunWorkspaceProjection;
  currentStageId?: string;
}

export interface TeamRunRecord extends TeamRunSummary {
  teamId?: string;
  packageName: string;
  packageVersion: string;
  sourcePath: string;
  createdAt: number;
  updatedAt: number;
}

export type TeamApprovalStatus = 'pending' | 'approved' | 'denied' | 'aborted';
export type TeamApprovalResolutionDecision = 'approve' | 'deny' | 'abort';

export interface TeamApprovalRecord {
  approvalId: string;
  runId: string;
  subject: 'stage' | 'work_node' | 'human_decision';
  nodeId: string | null;
  stageId: string;
  roleId: string;
  reason: string;
  requestedAction: string;
  content: { title: string; body: string | null; artifactIds: string[] } | null;
  risk: string;
  status: TeamApprovalStatus;
  decision: TeamApprovalResolutionDecision | null;
  note: string | null;
  cause: 'human_decision' | 'run_cancelled' | null;
  idempotencyKey: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface TeamArtifactRecord {
  artifactId: string;
  runId: string;
  stageId: string;
  nodeId: string;
  nodeExecutionId: string;
  attemptId: string;
  currentAttempt: boolean;
  roleId: string;
  sessionRef?: string;
  agentIdentity?: { agentId: string; endpointRef: string };
  files: string[];
  kind: string;
  title: string;
  contentRef: string;
  summary: string | null;
  evidenceRefs: { type: 'artifact'; artifactId: string }[];
  idempotencyKey: string;
  createdAt: number;
  updatedAt: number;
}

export type TeamMessageKind = 'note' | 'question' | 'kickback';

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
  nodeId: string;
  nodeExecutionId: string;
  attemptId: string;
  bodyOffset: number;
  bodyBytes: number;
  bodyComplete: boolean;
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

export interface TeamRunMessagePage {
  revision: string;
  status: 'complete' | 'incomplete' | 'unavailable' | 'stale';
  nextCursor: { revision: string; messageId: string; bodyOffset: number } | null;
}

export interface TeamNodeReviewCursor {
  revision: string;
  nodeExecutionId: string;
  attemptId: string;
}

export interface TeamNodeReviewListQuery {
  kind: 'list';
  cursor?: TeamNodeReviewCursor;
}

export interface TeamNodeReviewMessagesQuery {
  kind: 'messages';
  nodeExecutionId: string;
  attemptId: string;
  cursor?: NonNullable<TeamRunMessagePage['nextCursor']>;
}

export type TeamNodeReviewQuery = TeamNodeReviewListQuery | TeamNodeReviewMessagesQuery;

export interface TeamNodeReviewRecord {
  nodeExecutionId: string;
  attemptId: string;
  attemptNumber: number;
  batchId: number;
  currentAttempt: boolean;
  roleId: string | null;
  outputPort: 'completed' | 'rework';
  status: 'completed' | 'failed';
  summary: string | null;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  bodyStatus: 'available' | 'unavailable';
}

export interface TeamNodeReviewHistory {
  runId: string;
  nodeId: string;
  entries: TeamNodeReviewRecord[];
  page: {
    revision: string;
    status: 'complete' | 'incomplete' | 'stale';
    nextCursor: TeamNodeReviewCursor | null;
  };
}

export interface TeamNodeReviewMessages {
  runId: string;
  nodeId: string;
  nodeExecutionId: string;
  attemptId: string;
  messages: TeamMessageRecord[];
  messagePage: TeamRunMessagePage;
}

export function isTeamRunMessage(value: unknown, runId: string): value is TeamMessageRecord {
  if (!isRecord(value) || value.runId !== runId
    || ![value.messageId, value.nodeId, value.nodeExecutionId, value.attemptId].every(isText)
    || !['note', 'question', 'kickback'].includes(String(value.kind))
    || !['fromRoleId', 'toRoleId', 'summary', 'body', 'idempotencyKey'].every((key) => typeof value[key] === 'string')
    || !Array.isArray(value.failureItems) || !value.failureItems.every(isRecord)
    || !isTimestamp(value.createdAt) || !isTimestamp(value.bodyOffset)
    || !isTimestamp(value.bodyBytes) || typeof value.bodyComplete !== 'boolean') return false;
  const end = value.bodyOffset + new TextEncoder().encode(value.body as string).length;
  return end <= value.bodyBytes && value.bodyComplete === (end === value.bodyBytes);
}

export function isTeamRunMessageCursor(value: unknown): value is NonNullable<TeamRunMessagePage['nextCursor']> {
  return isRecord(value) && hasKeys(value, ['revision', 'messageId', 'bodyOffset'])
    && isRevision(value.revision) && isIdentifier(value.messageId) && value.messageId.length <= 512
    && isTimestamp(value.bodyOffset);
}

export function isTeamRunMessagePage(value: unknown): value is TeamRunMessagePage {
  if (!isRecord(value) || !hasKeys(value, ['revision', 'status', 'nextCursor'])
    || !isRevision(value.revision)
    || !['complete', 'incomplete', 'unavailable', 'stale'].includes(String(value.status))) return false;
  const cursor = value.nextCursor;
  return cursor === null || value.status === 'incomplete' && isRecord(cursor)
    && hasKeys(cursor, ['revision', 'messageId', 'bodyOffset']) && cursor.revision === value.revision
    && isText(cursor.messageId) && isTimestamp(cursor.bodyOffset);
}

export function isTeamNodeReviewQuery(value: unknown): value is TeamNodeReviewQuery {
  if (!isRecord(value)) return false;
  if (value.kind === 'list') return onlyKeys(value, ['kind', 'cursor'])
    && (value.cursor === undefined || isTeamNodeReviewCursor(value.cursor));
  return value.kind === 'messages' && onlyKeys(value, ['kind', 'nodeExecutionId', 'attemptId', 'cursor'])
    && isIdentifier(value.nodeExecutionId) && isIdentifier(value.attemptId)
    && (value.cursor === undefined || isTeamRunMessageCursor(value.cursor));
}

export function isTeamNodeReviewHistory(value: unknown, runId: string, nodeId: string): value is TeamNodeReviewHistory {
  if (!isRecord(value) || !hasKeys(value, ['runId', 'nodeId', 'entries', 'page'])
    || value.runId !== runId || value.nodeId !== nodeId
    || !Array.isArray(value.entries) || value.entries.length > 64
    || !value.entries.every(isTeamNodeReviewRecord)) return false;
  const page = value.page;
  if (!isRecord(page) || !hasKeys(page, ['revision', 'status', 'nextCursor']) || !isRevision(page.revision)) return false;
  if (page.status === 'incomplete') return isTeamNodeReviewCursor(page.nextCursor)
    && page.nextCursor.revision === page.revision && value.entries.length > 0;
  return (page.status === 'complete' || page.status === 'stale' && value.entries.length === 0)
    && page.nextCursor === null;
}

export function isTeamNodeReviewMessages(value: unknown, runId: string, nodeId: string, query: TeamNodeReviewMessagesQuery): value is TeamNodeReviewMessages {
  if (!isRecord(value) || !hasKeys(value, ['runId', 'nodeId', 'nodeExecutionId', 'attemptId', 'messages', 'messagePage'])
    || value.runId !== runId || value.nodeId !== nodeId
    || value.nodeExecutionId !== query.nodeExecutionId || value.attemptId !== query.attemptId
    || !Array.isArray(value.messages) || value.messages.length > 64
    || !isTeamRunMessagePage(value.messagePage)) return false;
  let bytes = 0;
  for (const message of value.messages) {
    if (!isRecord(message) || !onlyKeys(message, ['messageId', 'runId', 'nodeId', 'nodeExecutionId', 'attemptId', 'kind', 'fromRoleId', 'toRoleId', 'summary', 'body', 'bodyOffset', 'bodyBytes', 'bodyComplete', 'failureItems', 'idempotencyKey', 'createdAt'])
      || !isTeamRunMessage(message, runId) || message.nodeId !== nodeId
      || message.nodeExecutionId !== query.nodeExecutionId || message.attemptId !== query.attemptId) return false;
    bytes += new TextEncoder().encode(message.body).length;
  }
  const page = value.messagePage;
  return bytes <= 48 * 1024
    && (page.status !== 'stale' || value.messages.length === 0);
}

function isTeamNodeReviewCursor(value: unknown): value is TeamNodeReviewCursor {
  return isRecord(value) && hasKeys(value, ['revision', 'nodeExecutionId', 'attemptId'])
    && isRevision(value.revision) && isIdentifier(value.nodeExecutionId) && isIdentifier(value.attemptId);
}

function isTeamNodeReviewRecord(value: unknown): value is TeamNodeReviewRecord {
  return isRecord(value) && hasKeys(value, ['nodeExecutionId', 'attemptId', 'attemptNumber', 'batchId', 'currentAttempt', 'roleId', 'outputPort', 'status', 'summary', 'createdAt', 'updatedAt', 'resolvedAt', 'bodyStatus'])
    && isIdentifier(value.nodeExecutionId) && isIdentifier(value.attemptId)
    && isTimestamp(value.attemptNumber) && value.attemptNumber > 0
    && isTimestamp(value.batchId) && value.batchId > 0
    && typeof value.currentAttempt === 'boolean' && (value.roleId === null || isIdentifier(value.roleId))
    && (value.outputPort === 'completed' || value.outputPort === 'rework')
    && (value.status === 'completed' || value.status === 'failed')
    && (value.summary === null || typeof value.summary === 'string')
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt)
    && (value.resolvedAt === null || isTimestamp(value.resolvedAt))
    && (value.bodyStatus === 'available' || value.bodyStatus === 'unavailable');
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function isIdentifier(value: unknown): value is string {
  return isText(value) && value.length <= 4096 && !/[\0\p{Cc}]/u.test(value);
}

export function isRunWorkspaceProjection(value: unknown): value is RunWorkspaceProjection {
  return isRecord(value) && hasKeys(value, ['status'])
    && (value.status === 'ready' || value.status === 'preparing' || value.status === 'legacy');
}

export function isTeamRunSummaryProjection(value: unknown): value is TeamRunSummary {
  return isRecord(value) && onlyKeys(value, ['runId', 'status', 'revision', 'workspace', 'currentStageId', 'replayed'])
    && isRunSummary(value) && (value.replayed === undefined || typeof value.replayed === 'boolean');
}

export function isTeamRunRecordProjection(value: unknown, extraKeys: readonly string[] = []): value is TeamRunRecord {
  return isRecord(value) && onlyKeys(value, ['teamId', 'runId', 'status', 'revision', 'workspace', 'currentStageId', 'packageName', 'packageVersion', 'sourcePath', 'createdAt', 'updatedAt', ...extraKeys])
    && isRunSummary(value) && (value.teamId === undefined || isText(value.teamId))
    && typeof value.packageName === 'string' && typeof value.packageVersion === 'string' && typeof value.sourcePath === 'string'
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

export function isTeamApprovalProjection(value: unknown, runId: string): value is TeamApprovalRecord {
  if (!isRecord(value) || !hasKeys(value, ['approvalId', 'runId', 'stageId', 'subject', 'nodeId', 'roleId', 'reason', 'requestedAction', 'content', 'risk', 'status', 'decision', 'note', 'cause', 'idempotencyKey', 'createdAt', 'resolvedAt'])) return false;
  const content = value.content;
  return value.runId === runId && [value.approvalId, value.stageId, value.roleId, value.reason, value.requestedAction].every(isText)
    && ['stage', 'work_node', 'human_decision'].includes(value.subject as string)
    && (value.subject === 'stage' ? value.nodeId === null : isText(value.nodeId))
    && (content === null || isRecord(content) && hasKeys(content, ['title', 'body', 'artifactIds']) && isText(content.title)
      && (content.body === null || isText(content.body))
      && Array.isArray(content.artifactIds) && content.artifactIds.every(isText) && new Set(content.artifactIds).size === content.artifactIds.length)
    && typeof value.risk === 'string' && typeof value.idempotencyKey === 'string'
    && ['pending', 'approved', 'denied', 'aborted'].includes(value.status as string)
    && (value.decision === null || ['approve', 'deny', 'abort'].includes(value.decision as string))
    && (value.note === null || isText(value.note))
    && (value.cause === null || value.cause === 'human_decision' || value.cause === 'run_cancelled')
    && isTimestamp(value.createdAt)
    && (value.status === 'pending'
      ? value.decision === null && value.note === null && value.cause === null && value.resolvedAt === null
      : ({ approved: 'approve', denied: 'deny', aborted: 'abort' } as Record<string, string>)[value.status as string] === value.decision
        && value.cause !== null && isTimestamp(value.resolvedAt) && value.resolvedAt >= value.createdAt);
}

export function isTeamArtifactProjection(value: unknown, runId: string): value is TeamArtifactRecord {
  return isRecord(value) && onlyKeys(value, ['artifactId', 'runId', 'stageId', 'nodeId', 'nodeExecutionId', 'attemptId', 'currentAttempt', 'roleId', 'sessionRef', 'agentIdentity', 'files', 'kind', 'title', 'contentRef', 'summary', 'evidenceRefs', 'idempotencyKey', 'createdAt', 'updatedAt'])
    && value.runId === runId && [value.artifactId, value.stageId, value.nodeId, value.nodeExecutionId, value.attemptId, value.roleId, value.kind, value.title, value.contentRef].every(isText)
    && typeof value.currentAttempt === 'boolean' && typeof value.idempotencyKey === 'string'
    && (value.summary === null || typeof value.summary === 'string')
    && (!Object.hasOwn(value, 'sessionRef') || isText(value.sessionRef))
    && (!Object.hasOwn(value, 'agentIdentity') || (isRecord(value.agentIdentity) && hasKeys(value.agentIdentity, ['agentId', 'endpointRef'])
      && isText(value.agentIdentity.agentId) && isText(value.agentIdentity.endpointRef)))
    && Array.isArray(value.files) && value.files.every(isTeamDeliveryFilePath)
    && new Set(value.files).size === value.files.length
    && Array.isArray(value.evidenceRefs) && value.evidenceRefs.every((ref) => isRecord(ref) && hasKeys(ref, ['type', 'artifactId']) && ref.type === 'artifact' && isText(ref.artifactId))
    && isTimestamp(value.createdAt) && isTimestamp(value.updatedAt);
}

export function isTeamDeliveryFilePath(value: unknown): value is string {
  return isText(value) && new TextEncoder().encode(value).length <= 4096 && !/[\p{Cc}\\:*?]/u.test(value) && !value.startsWith('/')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function isRunSummary(value: Record<string, unknown>): boolean {
  return isText(value.runId) && typeof value.status === 'string'
    && ['created', 'provisioning', 'waiting_for_user', 'running', 'paused', 'completed', 'failed', 'cancelled', 'cancelling'].includes(value.status)
    && isTimestamp(value.revision) && isRunWorkspaceProjection(value.workspace)
    && (value.currentStageId === undefined || isText(value.currentStageId));
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function hasKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
