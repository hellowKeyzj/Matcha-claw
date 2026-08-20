import type { SessionIdentity } from '../../../electron/desktop-contract/runtime-address';
import type { SessionRenderItem } from './render-item';
import type { SessionRuntimeStateSnapshot } from './runtime-state';
import type { TaskSnapshotEvent } from './task-snapshot';

export type SessionCatalogKind = 'main' | 'subsession' | 'session' | 'named';
export type SessionCatalogTitleSource = 'user' | 'assistant' | 'none';

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
  kind: SessionCatalogKind;
  preferred: boolean;
  status?: 'active' | 'completed' | 'archived' | 'deleted';
  label?: string;
  titleSource?: SessionCatalogTitleSource;
  displayName?: string;
  model?: string;
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
    kind: string;
    runtimeAdapterId: 'openclaw' | 'matcha-agent';
    runtimeInstanceId: string;
  };
  agentId?: string;
};

export type SessionWireContent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
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
  summary: string | null;
  isError: boolean | null;
};

export type SessionWireApproval = {
  approvalId: string;
  runId: string | null;
  phase: 'requested' | 'resolved';
  optionIds: string[];
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
  | { kind: 'toolUpdated'; tool: SessionWireTool }
  | { kind: 'approvalUpdated'; approval: SessionWireApproval }
  | { kind: 'runtimeChanged'; runtime: SessionWireRuntime }
  | { kind: 'windowChanged'; window: SessionWireWindow }
  | { kind: 'recoveryRequired'; reason: SessionRecoveryReason };

export type SessionDelta = {
  sessionKey: string;
  routeKey?: string;
  epoch: number;
  seq: number;
  cursor: number;
  runId?: string;
  changes: SessionChange[];
};

export type SessionProjectionSnapshot = {
  sessionKey: string;
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

const MAX_SESSION_KEY_BYTES = 4096;
const MAX_ID_BYTES = 256;
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

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isNonEmptyIdentifier(value: unknown, maxBytes = MAX_ID_BYTES): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxBytes
    && value.trim() === value
    && ![...value].some((character) => (character.codePointAt(0) ?? 0) < 32 || character === '\\0');
}

function isPayloadText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= MAX_TEXT_BYTES
    && !value.includes('\\0');
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

function decodeIdentity(value: unknown): SessionWireIdentity | null {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionKey', 'endpoint'])
    && !hasExactKeys(value, ['sessionKey', 'endpoint', 'agentId'])) return null;
  if (!isNonEmptyIdentifier(value.sessionKey, MAX_SESSION_KEY_BYTES)
    || !isRecord(value.endpoint)
    || !hasExactKeys(value.endpoint, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    || !isNonEmptyIdentifier(value.endpoint.kind)
    || (value.endpoint.runtimeAdapterId !== 'openclaw' && value.endpoint.runtimeAdapterId !== 'matcha-agent')
    || !isNonEmptyIdentifier(value.endpoint.runtimeInstanceId)
    || (Object.hasOwn(value, 'agentId')
      && value.agentId !== undefined
      && !isNonEmptyIdentifier(value.agentId))) return null;
  return {
    sessionKey: value.sessionKey,
    endpoint: {
      kind: value.endpoint.kind,
      runtimeAdapterId: value.endpoint.runtimeAdapterId,
      runtimeInstanceId: value.endpoint.runtimeInstanceId,
    },
    ...(value.agentId === undefined ? {} : { agentId: value.agentId as string }),
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
    && hasExactKeys(value, ['toolCallId', 'runId', 'name', 'phase', 'summary', 'isError'])
    && isNonEmptyIdentifier(value.toolCallId)
    && (value.runId === null || isNonEmptyIdentifier(value.runId))
    && (value.name === null || isNonEmptyIdentifier(value.name))
    && (value.phase === 'started' || value.phase === 'updated' || value.phase === 'completed' || value.phase === 'failed')
    && (value.summary === null || isPayloadText(value.summary))
    && (value.isError === null || typeof value.isError === 'boolean')
    ? { toolCallId: value.toolCallId, runId: value.runId, name: value.name, phase: value.phase, summary: value.summary, isError: value.isError }
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

function decodeRuntime(value: unknown): SessionWireRuntime | null {
  return isRecord(value)
    && hasExactKeys(value, ['phase', 'activeRunId', 'issue'])
    && isRuntimePhase(value.phase)
    && (value.activeRunId === null || isNonEmptyIdentifier(value.activeRunId))
    && (value.issue === null || value.issue === 'unknown' || value.issue === 'unavailable' || value.issue === 'timeout' || value.issue === 'rejected')
    ? { phase: value.phase, activeRunId: value.activeRunId, issue: value.issue }
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
      return hasExactKeys(value, ['kind', 'item']) ? (() => { const item = decodeItem(value.item); return item ? { kind: 'messageUpdated', item } : null; })() : null;
    case 'toolUpdated':
      return hasExactKeys(value, ['kind', 'tool']) ? (() => { const tool = decodeTool(value.tool); return tool ? { kind: 'toolUpdated', tool } : null; })() : null;
    case 'approvalUpdated':
      return hasExactKeys(value, ['kind', 'approval']) ? (() => { const approval = decodeApproval(value.approval); return approval ? { kind: 'approvalUpdated', approval } : null; })() : null;
    case 'runtimeChanged':
      return hasExactKeys(value, ['kind', 'runtime']) ? (() => { const runtime = decodeRuntime(value.runtime); return runtime ? { kind: 'runtimeChanged', runtime } : null; })() : null;
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
  if (!isRecord(value) || !hasExactKeys(value, ['sessionKey', 'identity', 'epoch', 'seq', 'cursor', 'items', 'tools', 'approvals', 'runtime', 'window', 'completeness'])) return null;
  const identity = decodeIdentity(value.identity);
  const items = decodeFact(value.items, (facts) => Array.isArray(facts) && facts.length <= MAX_ITEMS && facts.every((item) => decodeItem(item) !== null) ? facts.map((item) => decodeItem(item)!) : null);
  const tools = decodeFact(value.tools, (facts) => Array.isArray(facts) && facts.length <= MAX_TOOLS && facts.every((item) => decodeTool(item) !== null) ? facts.map((item) => decodeTool(item)!) : null);
  const approvals = decodeFact(value.approvals, (facts) => Array.isArray(facts) && facts.length <= MAX_APPROVALS && facts.every((item) => decodeApproval(item) !== null) ? facts.map((item) => decodeApproval(item)!) : null);
  const runtime = decodeFact(value.runtime, decodeRuntime);
  const window = decodeFact(value.window, decodeWindow);
  const completeness = decodeCompleteness(value.completeness);
  if (!identity || !isNonEmptyIdentifier(value.sessionKey, MAX_SESSION_KEY_BYTES) || identity.sessionKey !== value.sessionKey
    || !isSafeInteger(value.epoch) || value.epoch < 1 || value.epoch > MAX_SAFE_INTEGER
    || !isSafeInteger(value.seq) || value.seq < 0 || value.seq > MAX_SAFE_INTEGER
    || !isSafeInteger(value.cursor) || value.cursor < 0 || value.cursor > MAX_SAFE_INTEGER
    || !items || !tools || !approvals || !runtime || !window || !completeness) return null;
  return { sessionKey: value.sessionKey, identity, epoch: value.epoch, seq: value.seq, cursor: value.cursor, items, tools, approvals, runtime, window, completeness };
}

function decodeDelta(value: unknown): SessionDelta | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  const required = ['sessionKey', 'epoch', 'seq', 'cursor', 'changes'];
  const optional = ['routeKey', 'runId'];
  if (!required.every((key) => Object.hasOwn(value, key)) || keys.some((key) => !required.includes(key) && !optional.includes(key))) return null;
  if (!isNonEmptyIdentifier(value.sessionKey, MAX_SESSION_KEY_BYTES)
    || (Object.hasOwn(value, 'routeKey') && !isNonEmptyIdentifier(value.routeKey, 128))
    || (Object.hasOwn(value, 'runId') && !isNonEmptyIdentifier(value.runId))
    || !isSafeInteger(value.epoch) || value.epoch < 1 || value.epoch > MAX_SAFE_INTEGER
    || !isSafeInteger(value.seq) || value.seq < 1 || value.seq > MAX_SAFE_INTEGER
    || !isSafeInteger(value.cursor) || value.cursor < 1 || value.cursor > MAX_SAFE_INTEGER
    || !Array.isArray(value.changes) || value.changes.length === 0 || value.changes.length > MAX_CHANGE_COUNT) return null;
  const changes = value.changes.map(decodeChange);
  if (changes.some((change) => change === null)) return null;
  return {
    sessionKey: value.sessionKey,
    ...(value.routeKey === undefined ? {} : { routeKey: value.routeKey as string }),
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
