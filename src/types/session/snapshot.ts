import type { SessionIdentity } from '../desktop/runtime-address';
import type { SessionGoal, SessionGoalView } from '../session-goal';
import { isSessionOwnership, type SessionOwnership } from '../desktop/session-ownership';
import type { SessionRenderItem } from './render-item';
import type { SessionRuntimeStateSnapshot } from './runtime-state';
import type { TaskSnapshotEvent } from './task-snapshot';

export type SessionCatalogKind = 'main' | 'subsession' | 'session' | 'automation';
export type SessionCatalogTitleSource = 'user' | 'assistant' | 'none';
export type SessionModelOverrideSource = 'user' | 'auto';
export type SessionModelIdentity = {
  provider?: string;
  model: string;
  ref: string;
};
export type SessionModelState = {
  selected?: SessionModelIdentity;
  active?: SessionModelIdentity;
  overrideSource?: SessionModelOverrideSource;
  selectionId?: string;
};

export interface SessionWindowStateSnapshot {
  totalItemCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
}

export interface SessionUsageSnapshotItem {
  id: string;
  sessionKey: string;
  runId?: string;
  timestamp?: number;
  payload: unknown;
}

export interface SessionArtifactSnapshotItem {
  id: string;
  sessionKey: string;
  runId?: string;
  timestamp?: number;
  payload: unknown;
}

export interface SessionContextTokenSnapshot {
  totalTokens?: number;
  totalTokensFresh?: boolean;
  contextTokens?: number;
}

export interface SessionCatalogItem {
  key: string;
  agentId: string;
  protocolId: string;
  runtimeEndpointId: string;
  endpointSessionId?: string;
  sessionIdentity: SessionIdentity;
  ownership: SessionOwnership | null;
  kind: SessionCatalogKind;
  preferred: boolean;
  status?: 'active' | 'completed' | 'archived' | 'deleted';
  label?: string;
  titleSource?: SessionCatalogTitleSource;
  displayName?: string;
  modelState?: SessionModelState;
  contextTokens?: SessionContextTokenSnapshot;
  updatedAt?: number;
}


export type SessionApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export interface SessionApprovalRequestItem {
  id: string;
  sessionKey: string;
  sessionIdentity: SessionIdentity;
  runId?: string;
  title: string;
  command?: string;
  allowedDecisions: ReadonlyArray<SessionApprovalDecision>;
  request?: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs?: number;
}

export interface SessionStateSnapshot {
  sessionKey: string;
  catalog: SessionCatalogItem;
  items: SessionRenderItem[];
  approvals: SessionApprovalRequestItem[];
  usage: SessionUsageSnapshotItem[];
  artifacts: SessionArtifactSnapshotItem[];
  contextTokens?: SessionContextTokenSnapshot;
  taskSnapshot?: TaskSnapshotEvent;
  replayComplete: boolean;
  runtime: SessionRuntimeStateSnapshot;
  window: SessionWindowStateSnapshot;
}

export interface SessionLoadResult {
  snapshot: SessionStateSnapshot;
}

export type SessionProjectionLoadResult = SessionView;

export interface SessionListResult {
  sessions: SessionCatalogItem[];
  ready: boolean;
  refreshing: boolean;
  updatedAt: number | null;
  error: string | null;
}

export interface SessionWindowResult {
  snapshot: SessionStateSnapshot;
}

/** Rust host/session_state.rs wire facts. These types are intentionally independent
 * from the legacy renderer snapshot above; unknown and unavailable are preserved. */
export type SessionMissingFact =
  | 'session_identity'
  | 'catalog'
  | 'usage'
  | 'artifacts'
  | 'context_tokens'
  | 'tasks'
  | 'replay_cursor'
  | 'bounded_history'
  | 'partial_runtime'
  | 'event_only';

export type SessionFact<T> =
  | { complete: T }
  | { incomplete: { facts: T; gaps: SessionMissingFact[] } }
  | 'unavailable'
  | 'unknown';

export type SessionCompleteness =
  | 'complete'
  | { incomplete: { missing: SessionMissingFact[] } }
  | 'unavailable'
  | 'unknown';

export type SessionWireIdentity = {
  sessionKey: string;
  endpoint: {
    kind: 'native-runtime';
    runtimeAdapterId: 'openclaw' | 'matcha-agent';
    runtimeInstanceId: string;
  };
  agentId: string;
};

export type SessionWireContent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'largeText'; text: string; contentRef: string; totalBytes: number; loadedBytes: number }
  | { kind: 'toolUse'; name: string; toolCallId: string }
  | { kind: 'toolResult'; toolCallId: string; summary: string | null; isError: boolean }
  | { kind: 'media'; mediaType: string | null; reference: string }
  | { kind: 'omitted'; reason: 'thinking' | 'unsafe_media' | 'unknown' };

export type SessionWireItem =
  | {
    kind: 'userMessage';
    itemId: string;
    messageId: string | null;
    text: string;
    content: SessionWireContent[];
    status: SessionWireItemStatus;
  }
  | {
    kind: 'assistantTurn';
    itemId: string;
    runId: string | null;
    messageId: string | null;
    status: SessionWireItemStatus;
    segments: SessionWireContent[];
    text: string;
  }
  | {
    kind: 'system';
    itemId: string;
    text: string;
    status: SessionWireItemStatus;
  };

export type SessionWireItemStatus =
  | 'pending'
  | 'streaming'
  | 'waiting_for_tool'
  | 'final'
  | 'error'
  | 'aborted';

export type SessionWireTool = {
  toolCallId: string;
  runId: string | null;
  name: string | null;
  phase: 'started' | 'updated' | 'completed' | 'failed';
  input: unknown | null;
  inputText: string | null;
  summary: string | null;
  output: unknown | null;
  details: unknown | null;
  isError: boolean | null;
};

export type SessionWireApproval = {
  approvalId: string;
  runId: string | null;
  phase: 'requested' | 'resolved';
  optionIds: string[];
};

export type SessionWireRuntimeActivity = 'compacting';
export type SessionWireRunStartupPhase =
  | 'preparing_workspace'
  | 'naming_worktree'
  | 'creating_worktree'
  | 'running_setup'
  | 'provisioning_environment'
  | 'preparing_context'
  | 'starting_model';
export type SessionWireRunProgress =
  | { kind: 'startup'; phase: SessionWireRunStartupPhase }
  | { kind: 'retrying'; attempt: number; maxAttempts: number };

export type SessionWireRuntimeErrorDetail = {
  kind: 'fallback' | 'error';
  failoverReason: string | null;
  providerRuntimeFailureKind: string | null;
  providerErrorType: string | null;
  providerErrorMessagePreview: string | null;
  httpStatus: number | null;
};

export type SessionWireRuntimeNotice = {
  runId: string;
  kind:
    | 'guardian_reviewing'
    | 'guardian_approved'
    | 'guardian_denied'
    | 'guardian_warning'
    | 'guardian_strict_review_required';
  command: string | null;
  riskLevel: string | null;
  rationale: string | null;
  message: string | null;
};

export type SessionWireRuntime = {
  phase:
    | 'queued'
    | 'started'
    | 'waiting_for_approval'
    | 'cancellation_requested'
    | 'cancelled'
    | 'completed'
    | 'failed'
    | 'interrupted';
  activeRunId: string | null;
  issue: 'unknown' | 'unavailable' | 'timeout' | 'rejected' | null;
  runProgress: SessionWireRunProgress | null;
  runtimeActivity: SessionWireRuntimeActivity | null;
  errorDetail: SessionWireRuntimeErrorDetail | null;
};

export type SessionWireWindow = {
  totalItemCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
};

export type SessionView = {
  sessionKey: string;
  endpointSessionId: string | null;
  modelState: SessionModelState | null;
  goal: SessionGoalView;
  ownership: SessionOwnership | null;
  identity: SessionWireIdentity;
  epoch: number;
  seq: number;
  cursor: number;
  items: SessionFact<SessionWireItem[]>;
  tools: SessionFact<SessionWireTool[]>;
  approvals: SessionFact<SessionWireApproval[]>;
  runtime: SessionFact<SessionWireRuntime>;
  window: SessionFact<SessionWireWindow>;
  completeness: SessionCompleteness;
};

export type SessionObservationResult<View = SessionView> =
  | Readonly<{ leaseId: string; view: View }>
  | Readonly<{ leaseId: string; outcome: 'released' }>;

export type SessionRecoveryReason =
  | 'cursor_gap'
  | 'cursor_stale'
  | 'epoch_changed'
  | 'event_overflow'
  | 'native_unavailable'
  | 'native_unknown';

export type SessionChange =
  | { kind: 'runPhaseChanged'; runId: string; phase: SessionWireRuntime['phase'] }
  | { kind: 'messageDelta'; itemId: string; runId: string | null; messageId: string | null; text: string; replace: boolean; status: SessionWireItemStatus }
  | { kind: 'messageUpdated'; item: SessionWireItem }
  | { kind: 'messageReplaced'; item: SessionWireItem }
  | { kind: 'itemsReplaced'; oldItemIds: string[]; anchor: { kind: 'start' } | { kind: 'after'; itemId: string }; items: SessionWireItem[] }
  | { kind: 'toolUpdated'; tool: SessionWireTool }
  | { kind: 'approvalUpdated'; approval: SessionWireApproval }
  | { kind: 'goalChanged'; goal: SessionGoalView }
  | { kind: 'runtimeChanged'; runtime: SessionWireRuntime }
  | { kind: 'runtimeNoticeUpdated'; notice: SessionWireRuntimeNotice }
  | { kind: 'windowChanged'; window: SessionWireWindow }
  | { kind: 'recoveryRequired'; reason: SessionRecoveryReason };

export type SessionDelta = {
  sessionKey: string;
  identity: SessionWireIdentity;
  epoch: number;
  seq: number;
  cursor: number;
  runId?: string;
  changes: SessionChange[];
};

export type SessionProjectionSnapshot = {
  sessionKey: string;
  endpointSessionId: string | null;
  modelState: SessionModelState | null;
  goal: SessionGoalView;
  ownership: SessionOwnership | null;
  identity: SessionWireIdentity;
  epoch: number;
  seq: number;
  cursor: number;
  items: SessionFact<SessionWireItem[]>;
  tools: SessionFact<SessionWireTool[]>;
  approvals: SessionFact<SessionWireApproval[]>;
  runtime: SessionFact<SessionWireRuntime>;
  window: SessionFact<SessionWireWindow>;
  completeness: SessionCompleteness;
};

export type SessionProjectionFactStatus = 'complete' | 'incomplete' | 'unavailable' | 'unknown';

export type SessionContentLoadResult = {
  contentRef: string;
  offset: number;
  text: string;
  nextOffset: number;
  totalBytes: number;
  complete: boolean;
};

const MAX_SESSION_KEY_BYTES = 4096;
const MAX_ID_BYTES = 256;
const MAX_CONTENT_REF_BYTES = 512;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_ITEMS = 200;
const MAX_TOOLS = 128;
const MAX_SEGMENTS = 64;
const MAX_APPROVALS = 32;
const MAX_CHANGE_COUNT = 16;
const MAX_MISSING_FACTS = 16;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function isNonEmptyIdentifier(value: unknown, maxBytes = MAX_ID_BYTES): value is string {
  return typeof value === 'string'
    && value.length > 0
    && utf8ByteLength(value) <= maxBytes
    && value.trim() === value
    && ![...value].some((character) => (character.codePointAt(0) ?? 0) < 32 || character === '\\0');
}

function isNullableShortText(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && utf8ByteLength(value) <= 300 && !value.includes('\0'));
}

function isPayloadText(value: unknown): value is string {
  return typeof value === 'string'
    && utf8ByteLength(value) <= MAX_TEXT_BYTES
    && !value.includes('\0');
}

function isPayloadValue(value: unknown): boolean {
  const text = JSON.stringify(value);
  return text !== undefined
    && utf8ByteLength(text) <= MAX_TEXT_BYTES
    && !payloadValueContainsNul(value)
    && (value === null || typeof value !== 'object' || value.constructor === Object || Array.isArray(value));
}

function payloadValueContainsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\0');
  if (Array.isArray(value)) return value.some(payloadValueContainsNul);
  if (isRecord(value)) return Object.entries(value)
    .some(([key, entry]) => key.includes('\0') || payloadValueContainsNul(entry));
  return false;
}

function isValidMissingFacts(value: unknown): value is SessionMissingFact[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_MISSING_FACTS
    && value.every((item, index, all) => typeof item === 'string'
      && isMissingFact(item)
      && all.indexOf(item) === index);
}

function isMissingFact(value: string): value is SessionMissingFact {
  return value === 'session_identity'
    || value === 'catalog'
    || value === 'usage'
    || value === 'artifacts'
    || value === 'context_tokens'
    || value === 'tasks'
    || value === 'replay_cursor'
    || value === 'bounded_history'
    || value === 'partial_runtime'
    || value === 'event_only';
}

function decodeFact<T>(value: unknown, decode: (value: unknown) => T | null): SessionFact<T> | null {
  if (value === 'unavailable' || value === 'unknown') return value;
  if (!isRecord(value)) return null;
  if (hasExactKeys(value, ['complete'])) {
    const facts = decode(value.complete);
    return facts === null ? null : { complete: facts };
  }
  if (!hasExactKeys(value, ['incomplete']) || !isRecord(value.incomplete)
    || !hasExactKeys(value.incomplete, ['facts', 'gaps'])
    || !isValidMissingFacts(value.incomplete.gaps)) {
    return null;
  }
  const facts = decode(value.incomplete.facts);
  return facts === null ? null : { incomplete: { facts, gaps: [...value.incomplete.gaps] } };
}

function decodeModelIdentity(value: unknown): SessionModelIdentity | null {
  if (!isRecord(value) || !hasAllowedKeys(value, ['model', 'ref'], ['provider'])) return null;
  if (!isNonEmptyIdentifier(value.model, MAX_SESSION_KEY_BYTES)
    || !isNonEmptyIdentifier(value.ref, MAX_SESSION_KEY_BYTES)
    || (value.provider !== undefined && !isNonEmptyIdentifier(value.provider))) return null;
  return {
    ...(value.provider === undefined ? {} : { provider: value.provider }),
    model: value.model,
    ref: value.ref,
  };
}

function decodeModelState(value: unknown): SessionModelState | null {
  if (!isRecord(value) || !hasAllowedKeys(value, [], ['selected', 'active', 'overrideSource', 'selectionId'])) return null;
  const selected = value.selected === undefined ? undefined : decodeModelIdentity(value.selected);
  const active = value.active === undefined ? undefined : decodeModelIdentity(value.active);
  if ((value.selected !== undefined && !selected)
    || (value.active !== undefined && !active)
    || (value.overrideSource !== undefined && value.overrideSource !== 'user' && value.overrideSource !== 'auto')
    || (value.selectionId !== undefined && !isNonEmptyIdentifier(value.selectionId))) return null;
  return {
    ...(selected ? { selected } : {}),
    ...(active ? { active } : {}),
    ...(value.overrideSource === undefined ? {} : { overrideSource: value.overrideSource }),
    ...(value.selectionId === undefined ? {} : { selectionId: value.selectionId }),
  };
}

export function tryDecodeSessionGoal(value: unknown): SessionGoal | null {
  const required = ['schemaVersion', 'id', 'objective', 'status', 'createdAt', 'updatedAt', 'tokenStart', 'tokensUsed', 'continuationTurns'];
  const optional = ['tokenStartFresh', 'tokenBudget', 'lastStatusNote', 'pausedAt', 'blockedAt', 'completedAt', 'usageLimitedAt', 'budgetLimitedAt'];
  if (!isRecord(value) || !hasAllowedKeys(value, required, optional)
    || value.schemaVersion !== 1 || !isNonEmptyIdentifier(value.id) || !isPayloadText(value.objective)
    || !['active', 'paused', 'blocked', 'complete', 'budget_limited', 'usage_limited'].includes(value.status as string)
    || !['createdAt', 'updatedAt', 'tokenStart', 'tokensUsed', 'continuationTurns'].every((key) => typeof value[key] === 'number' && Number.isFinite(value[key]))
    || !['tokenBudget', 'pausedAt', 'blockedAt', 'completedAt', 'usageLimitedAt', 'budgetLimitedAt'].every((key) => !Object.hasOwn(value, key) || typeof value[key] === 'number' && Number.isFinite(value[key]))
    || Object.hasOwn(value, 'tokenStartFresh') && typeof value.tokenStartFresh !== 'boolean'
    || Object.hasOwn(value, 'lastStatusNote') && !isPayloadText(value.lastStatusNote)) return null;
  return { ...value } as SessionGoal;
}

export function tryDecodeSessionGoalView(value: unknown): SessionGoalView | null {
  if (!isRecord(value)) return null;
  if ((value.kind === 'unknown' || value.kind === 'unsupported') && hasExactKeys(value, ['kind'])) return { kind: value.kind };
  if (value.kind !== 'known' || !hasExactKeys(value, ['kind', 'goal'])) return null;
  const goal = value.goal === null ? null : tryDecodeSessionGoal(value.goal);
  return value.goal !== null && !goal ? null : { kind: 'known', goal };
}

function decodeIdentity(value: unknown): SessionWireIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionKey', 'endpoint', 'agentId'])) return null;
  if (!isNonEmptyIdentifier(value.sessionKey, MAX_SESSION_KEY_BYTES)
    || !isRecord(value.endpoint)
    || !hasExactKeys(value.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    || value.endpoint.kind !== 'native-runtime'
    || (value.endpoint.runtimeAdapterId !== 'openclaw' && value.endpoint.runtimeAdapterId !== 'matcha-agent')
    || !isNonEmptyIdentifier(value.endpoint.runtimeInstanceId)
    || !isNonEmptyIdentifier(value.agentId)) return null;
  return {
    sessionKey: value.sessionKey,
    endpoint: {
      kind: value.endpoint.kind,
      runtimeAdapterId: value.endpoint.runtimeAdapterId,
      runtimeInstanceId: value.endpoint.runtimeInstanceId,
    },
    agentId: value.agentId as string,
  };
}

export function decodeSessionContentLoadResult(value: unknown): SessionContentLoadResult {
  if (!isRecord(value)
    || !hasExactKeys(value, ['contentRef', 'offset', 'text', 'nextOffset', 'totalBytes', 'complete'])
    || !isNonEmptyIdentifier(value.contentRef, MAX_CONTENT_REF_BYTES)
    || !isSafeInteger(value.offset) || value.offset < 0 || value.offset > MAX_SAFE_INTEGER
    || !isPayloadText(value.text)
    || !isSafeInteger(value.nextOffset) || value.nextOffset < value.offset || value.nextOffset > MAX_SAFE_INTEGER
    || !isSafeInteger(value.totalBytes) || value.totalBytes < value.nextOffset || value.totalBytes > MAX_SAFE_INTEGER
    || value.offset + utf8ByteLength(value.text) !== value.nextOffset
    || typeof value.complete !== 'boolean'
    || (value.complete && value.nextOffset !== value.totalBytes)) {
    throw new Error('Invalid SessionContentLoadResult payload');
  }
  return {
    contentRef: value.contentRef,
    offset: value.offset,
    text: value.text,
    nextOffset: value.nextOffset,
    totalBytes: value.totalBytes,
    complete: value.complete,
  };
}

function decodeContent(value: unknown): SessionWireContent | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'text':
    case 'thinking':
      return hasExactKeys(value, ['kind', 'text']) && isPayloadText(value.text)
        ? { kind: value.kind, text: value.text }
        : null;
    case 'largeText':
      return hasExactKeys(value, ['kind', 'text', 'contentRef', 'totalBytes', 'loadedBytes'])
        && isPayloadText(value.text)
        && isNonEmptyIdentifier(value.contentRef, MAX_CONTENT_REF_BYTES)
        && isSafeInteger(value.totalBytes)
        && value.totalBytes >= 0
        && value.totalBytes <= MAX_SAFE_INTEGER
        && isSafeInteger(value.loadedBytes)
        && value.loadedBytes >= 0
        && value.loadedBytes <= value.totalBytes
        && utf8ByteLength(value.text) === value.loadedBytes
        ? {
          kind: 'largeText',
          text: value.text,
          contentRef: value.contentRef,
          totalBytes: value.totalBytes,
          loadedBytes: value.loadedBytes,
        }
        : null;
    case 'toolUse':
      return hasExactKeys(value, ['kind', 'name', 'toolCallId'])
        && isNonEmptyIdentifier(value.name)
        && isNonEmptyIdentifier(value.toolCallId)
        ? { kind: 'toolUse', name: value.name, toolCallId: value.toolCallId }
        : null;
    case 'toolResult':
      return hasExactKeys(value, ['kind', 'toolCallId', 'summary', 'isError'])
        && isNonEmptyIdentifier(value.toolCallId)
        && (value.summary === null || isPayloadText(value.summary))
        && typeof value.isError === 'boolean'
        ? { kind: 'toolResult', toolCallId: value.toolCallId, summary: value.summary, isError: value.isError }
        : null;
    case 'media':
      return hasExactKeys(value, ['kind', 'mediaType', 'reference'])
        && (value.mediaType === null || isNonEmptyIdentifier(value.mediaType))
        && isNonEmptyIdentifier(value.reference)
        ? { kind: 'media', mediaType: value.mediaType, reference: value.reference }
        : null;
    case 'omitted':
      return hasExactKeys(value, ['kind', 'reason'])
        && (value.reason === 'thinking' || value.reason === 'unsafe_media' || value.reason === 'unknown')
        ? { kind: 'omitted', reason: value.reason }
        : null;
    default:
      return null;
  }
}

function decodeItem(value: unknown): SessionWireItem | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'userMessage' && hasExactKeys(value, ['kind', 'itemId', 'messageId', 'text', 'content', 'status'])
    && isNonEmptyIdentifier(value.itemId)
    && (value.messageId === null || isNonEmptyIdentifier(value.messageId))
    && isPayloadText(value.text)
    && Array.isArray(value.content)
    && value.content.length <= MAX_SEGMENTS
    && value.content.every((item) => decodeContent(item) !== null)
    && isItemStatus(value.status)) {
    return { kind: 'userMessage', itemId: value.itemId, messageId: value.messageId, text: value.text, content: value.content.map((item) => decodeContent(item)!), status: value.status };
  }
  if (value.kind === 'assistantTurn' && hasExactKeys(value, ['kind', 'itemId', 'runId', 'messageId', 'status', 'segments', 'text'])
    && isNonEmptyIdentifier(value.itemId)
    && (value.runId === null || isNonEmptyIdentifier(value.runId))
    && (value.messageId === null || isNonEmptyIdentifier(value.messageId))
    && isItemStatus(value.status)
    && Array.isArray(value.segments)
    && value.segments.length <= MAX_SEGMENTS
    && value.segments.every((item) => decodeContent(item) !== null)
    && isPayloadText(value.text)) {
    return { kind: 'assistantTurn', itemId: value.itemId, runId: value.runId, messageId: value.messageId, status: value.status, segments: value.segments.map((item) => decodeContent(item)!), text: value.text };
  }
  if (value.kind === 'system' && hasExactKeys(value, ['kind', 'itemId', 'text', 'status'])
    && isNonEmptyIdentifier(value.itemId) && isPayloadText(value.text) && isItemStatus(value.status)) {
    return { kind: 'system', itemId: value.itemId, text: value.text, status: value.status };
  }
  return null;
}

function isItemStatus(value: unknown): value is SessionWireItemStatus {
  return value === 'pending' || value === 'streaming' || value === 'waiting_for_tool'
    || value === 'final' || value === 'error' || value === 'aborted';
}

function decodeTool(value: unknown): SessionWireTool | null {
  return isRecord(value)
    && hasExactKeys(value, ['toolCallId', 'runId', 'name', 'phase', 'input', 'inputText', 'summary', 'output', 'details', 'isError'])
    && isNonEmptyIdentifier(value.toolCallId)
    && (value.runId === null || isNonEmptyIdentifier(value.runId))
    && (value.name === null || isNonEmptyIdentifier(value.name))
    && (value.phase === 'started' || value.phase === 'updated' || value.phase === 'completed' || value.phase === 'failed')
    && (value.input === null || isPayloadValue(value.input))
    && (value.inputText === null || isPayloadText(value.inputText))
    && (value.summary === null || isPayloadText(value.summary))
    && (value.output === null || isPayloadValue(value.output))
    && (value.details === null || isPayloadValue(value.details))
    && (value.isError === null || typeof value.isError === 'boolean')
    ? {
      toolCallId: value.toolCallId,
      runId: value.runId,
      name: value.name,
      phase: value.phase,
      input: value.input,
      inputText: value.inputText,
      summary: value.summary,
      output: value.output,
      details: value.details,
      isError: value.isError,
    }
    : null;
}

function decodeApproval(value: unknown): SessionWireApproval | null {
  return isRecord(value)
    && hasExactKeys(value, ['approvalId', 'runId', 'phase', 'optionIds'])
    && isNonEmptyIdentifier(value.approvalId)
    && (value.runId === null || isNonEmptyIdentifier(value.runId))
    && (value.phase === 'requested' || value.phase === 'resolved')
    && Array.isArray(value.optionIds)
    && value.optionIds.length <= MAX_APPROVALS
    && value.optionIds.every((item) => isNonEmptyIdentifier(item))
    ? { approvalId: value.approvalId, runId: value.runId, phase: value.phase, optionIds: [...value.optionIds] }
    : null;
}

function decodeRuntimeNotice(value: unknown): SessionWireRuntimeNotice | null {
  return isRecord(value)
    && hasExactKeys(value, ['runId', 'kind', 'command', 'riskLevel', 'rationale', 'message'])
    && isNonEmptyIdentifier(value.runId)
    && isRuntimeNoticeKind(value.kind)
    && isNullableShortText(value.command)
    && isNullableShortText(value.riskLevel)
    && isNullableShortText(value.rationale)
    && isNullableShortText(value.message)
    ? {
      runId: value.runId,
      kind: value.kind,
      command: value.command,
      riskLevel: value.riskLevel,
      rationale: value.rationale,
      message: value.message,
    }
    : null;
}

function isRuntimeNoticeKind(value: unknown): value is SessionWireRuntimeNotice['kind'] {
  return value === 'guardian_reviewing'
    || value === 'guardian_approved'
    || value === 'guardian_denied'
    || value === 'guardian_warning'
    || value === 'guardian_strict_review_required';
}

function decodeRuntime(value: unknown): SessionWireRuntime | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['phase', 'activeRunId', 'issue', 'runProgress', 'runtimeActivity', 'errorDetail'])
    || !isRuntimePhase(value.phase)
    || (value.activeRunId !== null && !isNonEmptyIdentifier(value.activeRunId))
    || (value.issue !== null && value.issue !== 'unknown' && value.issue !== 'unavailable' && value.issue !== 'timeout' && value.issue !== 'rejected')
    || (value.runProgress !== null && !isRunProgress(value.runProgress))
    || (value.runtimeActivity !== null && value.runtimeActivity !== 'compacting')) {
    return null;
  }
  const errorDetail = decodeRuntimeErrorDetail(value.errorDetail);
  if (value.errorDetail !== null && !errorDetail) {
    return null;
  }
  return {
    phase: value.phase,
    activeRunId: value.activeRunId,
    issue: value.issue,
    runProgress: value.runProgress,
    runtimeActivity: value.runtimeActivity,
    errorDetail,
  };
}

function isRunProgress(value: unknown): value is SessionWireRunProgress {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'startup') {
    return hasExactKeys(value, ['kind', 'phase']) && isRunStartupPhase(value.phase);
  }
  return value.kind === 'retrying'
    && hasExactKeys(value, ['kind', 'attempt', 'maxAttempts'])
    && isSafeInteger(value.attempt)
    && isSafeInteger(value.maxAttempts)
    && value.attempt >= 1
    && value.maxAttempts <= 10
    && value.attempt <= value.maxAttempts;
}

function isRunStartupPhase(value: unknown): value is SessionWireRunStartupPhase {
  return value === 'preparing_workspace'
    || value === 'naming_worktree'
    || value === 'creating_worktree'
    || value === 'running_setup'
    || value === 'provisioning_environment'
    || value === 'preparing_context'
    || value === 'starting_model';
}

function decodeRuntimeErrorDetail(value: unknown): SessionWireRuntimeErrorDetail | null {
  return value === null
    ? null
    : isRecord(value)
      && hasExactKeys(value, ['kind', 'failoverReason', 'providerRuntimeFailureKind', 'providerErrorType', 'providerErrorMessagePreview', 'httpStatus'])
      && (value.kind === 'fallback' || value.kind === 'error')
      && isNullableShortText(value.failoverReason)
      && isNullableShortText(value.providerRuntimeFailureKind)
      && isNullableShortText(value.providerErrorType)
      && isNullableShortText(value.providerErrorMessagePreview)
      && (value.httpStatus === null || (isSafeInteger(value.httpStatus) && value.httpStatus >= 100 && value.httpStatus <= 599))
      ? {
        kind: value.kind,
        failoverReason: value.failoverReason,
        providerRuntimeFailureKind: value.providerRuntimeFailureKind,
        providerErrorType: value.providerErrorType,
        providerErrorMessagePreview: value.providerErrorMessagePreview,
        httpStatus: value.httpStatus,
      }
      : null;
}

function isRuntimePhase(value: unknown): value is SessionWireRuntime['phase'] {
  return value === 'queued' || value === 'started' || value === 'waiting_for_approval'
    || value === 'cancellation_requested' || value === 'cancelled' || value === 'completed'
    || value === 'failed' || value === 'interrupted';
}

function decodeWindow(value: unknown): SessionWireWindow | null {
  return isRecord(value)
    && hasExactKeys(value, ['totalItemCount', 'windowStartOffset', 'windowEndOffset', 'hasMore', 'hasNewer', 'isAtLatest'])
    && isSafeInteger(value.totalItemCount) && value.totalItemCount >= 0 && value.totalItemCount <= MAX_SAFE_INTEGER
    && isSafeInteger(value.windowStartOffset) && value.windowStartOffset >= 0
    && isSafeInteger(value.windowEndOffset) && value.windowEndOffset >= value.windowStartOffset
    && value.windowEndOffset <= value.totalItemCount
    && value.windowEndOffset - value.windowStartOffset <= MAX_ITEMS
    && typeof value.hasMore === 'boolean' && typeof value.hasNewer === 'boolean' && typeof value.isAtLatest === 'boolean'
    ? { totalItemCount: value.totalItemCount, windowStartOffset: value.windowStartOffset, windowEndOffset: value.windowEndOffset, hasMore: value.hasMore, hasNewer: value.hasNewer, isAtLatest: value.isAtLatest }
    : null;
}

function decodeCompleteness(value: unknown): SessionCompleteness | null {
  if (value === 'complete' || value === 'unavailable' || value === 'unknown') return value;
  return isRecord(value)
    && hasExactKeys(value, ['incomplete'])
    && isRecord(value.incomplete)
    && hasExactKeys(value.incomplete, ['missing'])
    && isValidMissingFacts(value.incomplete.missing)
    ? { incomplete: { missing: [...value.incomplete.missing] } }
    : null;
}

function decodeChange(value: unknown): SessionChange | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  switch (value.kind) {
    case 'runPhaseChanged':
      return hasExactKeys(value, ['kind', 'runId', 'phase']) && isNonEmptyIdentifier(value.runId) && isRuntimePhase(value.phase)
        ? { kind: 'runPhaseChanged', runId: value.runId, phase: value.phase }
        : null;
    case 'messageDelta':
      return hasExactKeys(value, ['kind', 'itemId', 'runId', 'messageId', 'text', 'replace', 'status'])
        && isNonEmptyIdentifier(value.itemId)
        && (value.runId === null || isNonEmptyIdentifier(value.runId))
        && (value.messageId === null || isNonEmptyIdentifier(value.messageId))
        && isPayloadText(value.text)
        && typeof value.replace === 'boolean'
        && isItemStatus(value.status)
        ? { kind: 'messageDelta', itemId: value.itemId, runId: value.runId, messageId: value.messageId, text: value.text, replace: value.replace, status: value.status }
        : null;
    case 'messageUpdated':
    case 'messageReplaced':
      return hasExactKeys(value, ['kind', 'item']) ? (() => { const item = decodeItem(value.item); return item ? { kind: value.kind as 'messageUpdated' | 'messageReplaced', item } : null; })() : null;
    case 'itemsReplaced': {
      if (!hasExactKeys(value, ['kind', 'oldItemIds', 'anchor', 'items'])
        || !Array.isArray(value.oldItemIds) || value.oldItemIds.length > MAX_ITEMS
        || !value.oldItemIds.every((id) => isNonEmptyIdentifier(id))
        || new Set(value.oldItemIds).size !== value.oldItemIds.length
        || !isRecord(value.anchor)
        || !(value.anchor.kind === 'start' && hasExactKeys(value.anchor, ['kind'])
          || value.anchor.kind === 'after' && hasExactKeys(value.anchor, ['kind', 'itemId']) && isNonEmptyIdentifier(value.anchor.itemId))
        || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) return null;
      const items = value.items.map(decodeItem);
      const anchor = value.anchor;
      if (items.some((item) => item === null) || new Set(items.map((item) => item!.itemId)).size !== items.length
        || anchor.kind === 'after' && ((value.oldItemIds as string[]).includes(anchor.itemId as string)
          || items.some((item) => item!.itemId === anchor.itemId))) return null;
      return { kind: 'itemsReplaced', oldItemIds: value.oldItemIds as string[], anchor: value.anchor as { kind: 'start' } | { kind: 'after'; itemId: string }, items: items as SessionWireItem[] };
    }
    case 'toolUpdated':
      return hasExactKeys(value, ['kind', 'tool']) ? (() => { const tool = decodeTool(value.tool); return tool ? { kind: 'toolUpdated', tool } : null; })() : null;
    case 'approvalUpdated':
      return hasExactKeys(value, ['kind', 'approval']) ? (() => { const approval = decodeApproval(value.approval); return approval ? { kind: 'approvalUpdated', approval } : null; })() : null;
    case 'goalChanged':
      return hasExactKeys(value, ['kind', 'goal']) ? (() => { const goal = tryDecodeSessionGoalView(value.goal); return goal ? { kind: 'goalChanged', goal } : null; })() : null;
    case 'runtimeChanged':
      return hasExactKeys(value, ['kind', 'runtime']) ? (() => { const runtime = decodeRuntime(value.runtime); return runtime ? { kind: 'runtimeChanged', runtime } : null; })() : null;
    case 'runtimeNoticeUpdated':
      return hasExactKeys(value, ['kind', 'notice']) ? (() => { const notice = decodeRuntimeNotice(value.notice); return notice ? { kind: 'runtimeNoticeUpdated', notice } : null; })() : null;
    case 'windowChanged':
      return hasExactKeys(value, ['kind', 'window']) ? (() => { const window = decodeWindow(value.window); return window ? { kind: 'windowChanged', window } : null; })() : null;
    case 'recoveryRequired':
      return hasExactKeys(value, ['kind', 'reason']) && isRecoveryReason(value.reason)
        ? { kind: 'recoveryRequired', reason: value.reason }
        : null;
    default:
      return null;
  }
}

function isRecoveryReason(value: unknown): value is SessionRecoveryReason {
  return value === 'cursor_gap' || value === 'cursor_stale' || value === 'epoch_changed'
    || value === 'event_overflow' || value === 'native_unavailable' || value === 'native_unknown';
}

function decodeView(value: unknown): SessionView | null {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionKey', 'endpointSessionId', 'modelState', 'goal', 'ownership', 'identity', 'epoch', 'seq', 'cursor', 'items', 'tools', 'approvals', 'runtime', 'window', 'completeness'])) return null;
  const identity = decodeIdentity(value.identity);
  const modelState = value.modelState === null ? null : decodeModelState(value.modelState);
  const goal = tryDecodeSessionGoalView(value.goal);
  const items = decodeFact(value.items, (facts) => Array.isArray(facts) && facts.length <= MAX_ITEMS && facts.every((item) => decodeItem(item) !== null) ? facts.map((item) => decodeItem(item)!) : null);
  const tools = decodeFact(value.tools, (facts) => Array.isArray(facts) && facts.length <= MAX_TOOLS && facts.every((item) => decodeTool(item) !== null) ? facts.map((item) => decodeTool(item)!) : null);
  const approvals = decodeFact(value.approvals, (facts) => Array.isArray(facts) && facts.length <= MAX_APPROVALS && facts.every((item) => decodeApproval(item) !== null) ? facts.map((item) => decodeApproval(item)!) : null);
  const runtime = decodeFact(value.runtime, decodeRuntime);
  const window = decodeFact(value.window, decodeWindow);
  const completeness = decodeCompleteness(value.completeness);
  if (!identity || !isNonEmptyIdentifier(value.sessionKey, MAX_SESSION_KEY_BYTES)
    || (value.endpointSessionId !== null && !isNonEmptyIdentifier(value.endpointSessionId, MAX_SESSION_KEY_BYTES))
    || (value.modelState !== null && !modelState)
    || (value.ownership !== null && !isSessionOwnership(value.ownership))
    || identity.sessionKey !== value.sessionKey
    || !isSafeInteger(value.epoch) || value.epoch < 1 || value.epoch > MAX_SAFE_INTEGER
    || !isSafeInteger(value.seq) || value.seq < 0 || value.seq > MAX_SAFE_INTEGER
    || !isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > MAX_SAFE_INTEGER
    || !goal || !items || !tools || !approvals || !runtime || !window || !completeness) return null;
  return { sessionKey: value.sessionKey, endpointSessionId: value.endpointSessionId, modelState, goal, ownership: value.ownership, identity, epoch: value.epoch, seq: value.seq, cursor: value.cursor, items, tools, approvals, runtime, window, completeness };
}

function decodeDelta(value: unknown): SessionDelta | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  const required = ['sessionKey', 'identity', 'epoch', 'seq', 'cursor', 'changes'];
  const optional = ['runId'];
  if (!required.every((key) => Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) return null;
  const identity = decodeIdentity(value.identity);
  if (!identity || identity.sessionKey !== value.sessionKey
    || !isNonEmptyIdentifier(value.sessionKey, MAX_SESSION_KEY_BYTES)
    || (Object.hasOwn(value, 'runId') && !isNonEmptyIdentifier(value.runId))
    || !isSafeInteger(value.epoch) || value.epoch < 1 || value.epoch > MAX_SAFE_INTEGER
    || !isSafeInteger(value.seq) || value.seq < 1 || value.seq > MAX_SAFE_INTEGER
    || !isSafeInteger(value.cursor) || value.cursor < 1 || value.cursor > MAX_SAFE_INTEGER
    || !Array.isArray(value.changes) || value.changes.length === 0 || value.changes.length > MAX_CHANGE_COUNT) return null;
  const changes = value.changes.map(decodeChange);
  if (changes.some((change) => change === null)) return null;
  return {
    sessionKey: value.sessionKey,
    identity,
    epoch: value.epoch,
    seq: value.seq,
    cursor: value.cursor,
    ...(value.runId === undefined ? {} : { runId: value.runId as string }),
    changes: changes as SessionChange[],
  };
}

export function tryDecodeSessionView(value: unknown): SessionView | null {
  return decodeView(value);
}

export function decodeSessionView(value: unknown): SessionView {
  const decoded = decodeView(value);
  if (!decoded) throw new Error('Invalid SessionView payload');
  return decoded;
}

export function tryDecodeSessionDelta(value: unknown): SessionDelta | null {
  return decodeDelta(value);
}

export function decodeSessionDelta(value: unknown): SessionDelta {
  const decoded = decodeDelta(value);
  if (!decoded) throw new Error('Invalid SessionDelta payload');
  return decoded;
}
