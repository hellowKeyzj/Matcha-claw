const MAX_SESSION_KEY_BYTES = 4096;
const MAX_ID_BYTES = 256;
const MAX_CONTENT_REF_BYTES = 512;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_ITEMS = 200;
const MAX_TOOLS = 128;
const MAX_SEGMENTS = 64;
const MAX_APPROVALS = 32;
const MAX_CHANGE_COUNT = 16;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_RENDERER_ROUTE_KEY_BYTES = 128;

export type SessionView = Readonly<{
  sessionKey: string;
  endpointSessionId: string | null;
  identity: Readonly<{
    sessionKey: string;
    endpoint: Readonly<{
      kind: string;
      runtimeAdapterId: 'openclaw' | 'matcha-agent';
      runtimeInstanceId: string;
    }>;
    agentId?: string;
  }>;
  epoch: number;
  seq: number;
  cursor: number;
  items: unknown;
  tools: unknown;
  approvals: unknown;
  runtime: unknown;
  window: unknown;
  completeness: unknown;
}>;

export type SessionItem = Readonly<{
  readonly kind: 'userMessage' | 'assistantTurn' | 'system';
  readonly itemId: string;
  readonly runId?: string | null;
}>;
export type ToolView = Readonly<{
  toolCallId: string;
  runId: string | null;
  name: string | null;
  phase: string;
  input: unknown | null;
  inputText: string | null;
  summary: string | null;
  output: unknown | null;
  isError: boolean | null;
}>;
export type ApprovalView = Readonly<{ approvalId: string; runId?: string | null; phase: string }>;
export type RuntimeView = Readonly<{ phase: string; activeRunId?: string | null }>;
export type SessionWindow = Readonly<{ totalItemCount: number; windowStartOffset: number; windowEndOffset: number }>;
export type SessionContentLoadResponse = Readonly<{
  contentRef: string;
  offset: number;
  text: string;
  nextOffset: number;
  totalBytes: number;
  complete: boolean;
}>;

export type SessionChange =
  | Readonly<{ kind: 'runPhaseChanged'; runId: string; phase: SessionRunPhase }>
  | Readonly<{ kind: 'messageDelta'; itemId: string; runId: string | null; messageId: string | null; text: string; replace: boolean; status: SessionItemStatus }>
  | Readonly<{ kind: 'messageUpdated'; item: SessionItem }>
  | Readonly<{ kind: 'toolUpdated'; tool: ToolView }>
  | Readonly<{ kind: 'approvalUpdated'; approval: ApprovalView }>
  | Readonly<{ kind: 'runtimeChanged'; runtime: RuntimeView }>
  | Readonly<{ kind: 'windowChanged'; window: SessionWindow }>
  | Readonly<{ kind: 'recoveryRequired'; reason: SessionRecoveryReason }>;

export type SessionDelta = Readonly<{
  sessionKey: string;
  routeKey?: string;
  epoch: number;
  seq: number;
  cursor: number;
  runId?: string;
  changes: readonly SessionChange[];
}>;

 type SessionRunPhase =
  | 'queued'
  | 'started'
  | 'waiting_for_approval'
  | 'cancellation_requested'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'interrupted';

type SessionItemStatus = 'pending' | 'streaming' | 'waiting_for_tool' | 'final' | 'error' | 'aborted';

type SessionRecoveryReason =
  | 'cursor_gap'
  | 'cursor_stale'
  | 'epoch_changed'
  | 'event_overflow'
  | 'native_unavailable'
  | 'native_unknown';

export function isSessionView(value: unknown): value is SessionView {
  return decodeSessionView(value) !== null;
}

export function decodeSessionContentLoadResponse(value: unknown): SessionContentLoadResponse | null {
  if (!isRecord(value)
    || !hasExactKeys(value, ['contentRef', 'offset', 'text', 'nextOffset', 'totalBytes', 'complete'])
    || !isContentRef(value.contentRef)
    || !isSafeNonNegativeInteger(value.offset)
    || !isText(value.text)
    || !isSafeNonNegativeInteger(value.nextOffset)
    || !isSafeNonNegativeInteger(value.totalBytes)
    || value.offset > value.nextOffset
    || value.nextOffset > value.totalBytes
    || value.offset + Buffer.byteLength(value.text, 'utf8') !== value.nextOffset
    || typeof value.complete !== 'boolean'
    || (value.complete && value.nextOffset !== value.totalBytes)) {
    return null;
  }
  return value as SessionContentLoadResponse;
}

export function decodeSessionView(value: unknown): SessionView | null {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'sessionKey', 'endpointSessionId', 'identity', 'epoch', 'seq', 'cursor', 'items', 'tools', 'approvals',
      'runtime', 'window', 'completeness',
    ])
    || typeof value.sessionKey !== 'string'
    || !isSessionKey(value.sessionKey)
    || !isNullableSessionKey(value.endpointSessionId)
    || !isSessionIdentity(value.identity)
    || value.identity.sessionKey !== value.sessionKey
    || !isEpoch(value.epoch)
    || !isSafeNonNegativeInteger(value.seq)
    || !isSafeNonNegativeInteger(value.cursor)
    || !isFact(value.items, (entry) => isItems(entry))
    || !isFact(value.tools, (entry) => isTools(entry))
    || !isFact(value.approvals, (entry) => isApprovals(entry))
    || !isFact(value.runtime, isRuntime)
    || !isFact(value.window, isWindow)
    || !isCompleteness(value.completeness)) {
    return null;
  }
  return value as SessionView;
}

export function isSessionDelta(value: unknown): value is SessionDelta {
  return decodeSessionDelta(value) !== null;
}

export function decodeSessionDelta(value: unknown): SessionDelta | null {
  return decodeCanonicalSessionDelta(value);
}

export function decodeLegacySessionUpdateDelta(value: unknown): SessionDelta | null {
  if (isRecord(value) && value.kind === 'delta' && Object.prototype.hasOwnProperty.call(value, 'delta')) {
    return decodeCanonicalSessionDelta(value.delta);
  }
  return decodeCanonicalSessionDelta(value);
}

function decodeCanonicalSessionDelta(value: unknown): SessionDelta | null {
  if (!isRecord(value)
    || !hasAllowedKeys(value, ['sessionKey', 'epoch', 'seq', 'cursor', 'changes'], ['routeKey', 'runId'])
    || !isSessionKey(value.sessionKey)
    || !isEpoch(value.epoch)
    || !isPositiveSafeInteger(value.seq)
    || !isPositiveSafeInteger(value.cursor)
    || (value.routeKey !== undefined && !isRouteKey(value.routeKey))
    || (value.runId !== undefined && !isId(value.runId))
    || !Array.isArray(value.changes)
    || value.changes.length === 0
    || value.changes.length > MAX_CHANGE_COUNT
    || !value.changes.every((change) => isChange(change, value.runId as string | undefined))) {
    return null;
  }
  return value as SessionDelta;
}

function isChange(value: unknown, outerRunId: string | undefined): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  let changeRunId: string | undefined;
  switch (value.kind) {
    case 'runPhaseChanged':
      if (!hasExactKeys(value, ['kind', 'runId', 'phase']) || !isId(value.runId) || !isRunPhase(value.phase)) return false;
      changeRunId = value.runId;
      break;
    case 'messageDelta':
      if (!hasExactKeys(value, ['kind', 'itemId', 'runId', 'messageId', 'text', 'replace', 'status'])
        || !isId(value.itemId)
        || !isNullableId(value.runId)
        || !isNullableId(value.messageId)
        || !isText(value.text)
        || typeof value.replace !== 'boolean'
        || !isItemStatus(value.status)) return false;
      changeRunId = value.runId ?? undefined;
      break;
    case 'messageUpdated':
      if (!hasExactKeys(value, ['kind', 'item']) || !isItem(value.item)) return false;
      changeRunId = itemRunId(value.item);
      break;
    case 'toolUpdated':
      if (!hasExactKeys(value, ['kind', 'tool']) || !isTool(value.tool)) return false;
      changeRunId = value.tool.runId ?? undefined;
      break;
    case 'approvalUpdated':
      if (!hasExactKeys(value, ['kind', 'approval']) || !isApproval(value.approval)) return false;
      changeRunId = value.approval.runId ?? undefined;
      break;
    case 'runtimeChanged':
      if (!hasExactKeys(value, ['kind', 'runtime']) || !isRuntime(value.runtime)) return false;
      changeRunId = value.runtime.activeRunId ?? undefined;
      break;
    case 'windowChanged':
      return hasExactKeys(value, ['kind', 'window']) && isWindow(value.window);
    case 'recoveryRequired':
      return hasExactKeys(value, ['kind', 'reason']) && isRecoveryReason(value.reason);
    default:
      return false;
  }
  return outerRunId === undefined || changeRunId === undefined || outerRunId === changeRunId;
}

function isFact(value: unknown, isValue: (value: unknown) => boolean): boolean {
  if (typeof value === 'string') return value === 'unavailable' || value === 'unknown';
  if (!isRecord(value)) return false;
  if (hasExactKeys(value, ['complete'])) return isValue(value.complete);
  return hasExactKeys(value, ['incomplete'])
    && isRecord(value.incomplete)
    && hasExactKeys(value.incomplete, ['facts', 'gaps'])
    && isValue(value.incomplete.facts)
    && isGaps(value.incomplete.gaps);
}

function isItems(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_ITEMS && value.every(isItem);
}

function isTools(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_TOOLS && value.every(isTool);
}

function isApprovals(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_APPROVALS && value.every(isApproval);
}

function isItem(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'userMessage') {
    return hasExactKeys(value, ['kind', 'itemId', 'messageId', 'text', 'content', 'status'])
      && isId(value.itemId)
      && isNullableId(value.messageId)
      && isText(value.text)
      && isSegments(value.content)
      && isItemStatus(value.status);
  }
  if (value.kind === 'assistantTurn') {
    return hasExactKeys(value, ['kind', 'itemId', 'runId', 'messageId', 'status', 'segments', 'text'])
      && isId(value.itemId)
      && isNullableId(value.runId)
      && isNullableId(value.messageId)
      && isItemStatus(value.status)
      && isSegments(value.segments)
      && isText(value.text);
  }
  return value.kind === 'system'
    && hasExactKeys(value, ['kind', 'itemId', 'text', 'status'])
    && isId(value.itemId)
    && isText(value.text)
    && isItemStatus(value.status);
}

function itemRunId(value: unknown): string | undefined {
  return isRecord(value) && value.kind === 'assistantTurn' && typeof value.runId === 'string'
    ? value.runId
    : undefined;
}

function isSegments(value: unknown): boolean {
  return Array.isArray(value) && value.length <= MAX_SEGMENTS && value.every(isContent);
}

function isContent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'text':
    case 'thinking':
      return hasExactKeys(value, ['kind', 'text']) && isText(value.text);
    case 'largeText':
      return hasExactKeys(value, ['kind', 'text', 'contentRef', 'totalBytes', 'loadedBytes'])
        && isText(value.text)
        && isContentRef(value.contentRef)
        && isSafeNonNegativeInteger(value.totalBytes)
        && isSafeNonNegativeInteger(value.loadedBytes)
        && value.loadedBytes <= value.totalBytes
        && Buffer.byteLength(value.text, 'utf8') === value.loadedBytes;
    case 'toolUse':
      return hasExactKeys(value, ['kind', 'name', 'toolCallId'])
        && isId(value.name) && isId(value.toolCallId);
    case 'toolResult':
      return hasExactKeys(value, ['kind', 'toolCallId', 'summary', 'isError'])
        && isId(value.toolCallId)
        && isNullableText(value.summary)
        && (value.isError === null || typeof value.isError === 'boolean');
    case 'media':
      return hasExactKeys(value, ['kind', 'mediaType', 'reference'])
        && isNullableId(value.mediaType)
        && isId(value.reference);
    case 'omitted':
      return hasExactKeys(value, ['kind', 'reason']) && isOmissionReason(value.reason);
    default:
      return false;
  }
}

function isTool(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['toolCallId', 'runId', 'name', 'phase', 'input', 'inputText', 'summary', 'output', 'isError'])
    && isId(value.toolCallId)
    && isNullableId(value.runId)
    && isNullableId(value.name)
    && isToolPhase(value.phase)
    && (value.input === null || isPayloadValue(value.input))
    && isNullableText(value.inputText)
    && isNullableText(value.summary)
    && (value.output === null || isPayloadValue(value.output))
    && (value.isError === null || typeof value.isError === 'boolean');
}

function isApproval(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['approvalId', 'runId', 'phase', 'optionIds'])
    && isId(value.approvalId)
    && isNullableId(value.runId)
    && isApprovalPhase(value.phase)
    && Array.isArray(value.optionIds)
    && value.optionIds.length <= MAX_APPROVALS
    && value.optionIds.every(isId);
}

function isRuntime(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['phase', 'activeRunId', 'issue'])
    && isRunPhase(value.phase)
    && isNullableId(value.activeRunId)
    && (value.issue === null || isRuntimeIssue(value.issue));
}

function isWindow(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['totalItemCount', 'windowStartOffset', 'windowEndOffset', 'hasMore', 'hasNewer', 'isAtLatest'])
    && isSafeNonNegativeInteger(value.totalItemCount)
    && isSafeNonNegativeInteger(value.windowStartOffset)
    && isSafeNonNegativeInteger(value.windowEndOffset)
    && value.windowStartOffset <= value.windowEndOffset
    && value.windowEndOffset <= value.totalItemCount
    && value.windowEndOffset - value.windowStartOffset <= MAX_ITEMS
    && typeof value.hasMore === 'boolean'
    && typeof value.hasNewer === 'boolean'
    && typeof value.isAtLatest === 'boolean';
}

function isSessionIdentity(value: unknown): boolean {
  return isRecord(value)
    && hasAllowedKeys(value, ['sessionKey', 'endpoint'], ['agentId'])
    && isSessionKey(value.sessionKey)
    && isEndpoint(value.endpoint)
    && (value.agentId === undefined || isId(value.agentId));
}

function isEndpoint(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'runtimeAdapterId', 'runtimeInstanceId'])
    && typeof value.kind === 'string'
    && isId(value.kind)
    && (value.runtimeAdapterId === 'openclaw' || value.runtimeAdapterId === 'matcha-agent')
    && typeof value.runtimeInstanceId === 'string'
    && isId(value.runtimeInstanceId);
}

function isCompleteness(value: unknown): boolean {
  if (value === 'complete' || value === 'unavailable' || value === 'unknown') return true;
  return isRecord(value)
    && hasExactKeys(value, ['incomplete'])
    && isRecord(value.incomplete)
    && hasExactKeys(value.incomplete, ['missing'])
    && isGaps(value.incomplete.missing);
}

function isGaps(value: unknown): boolean {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 16
    && value.every(isMissingFact)
    && new Set(value).size === value.length;
}

function isRunPhase(value: unknown): boolean {
  return value === 'queued' || value === 'started' || value === 'waiting_for_approval'
    || value === 'cancellation_requested' || value === 'cancelled' || value === 'completed'
    || value === 'failed' || value === 'interrupted';
}

function isItemStatus(value: unknown): boolean {
  return value === 'pending' || value === 'streaming' || value === 'waiting_for_tool'
    || value === 'final' || value === 'error' || value === 'aborted';
}

function isToolPhase(value: unknown): boolean {
  return value === 'started' || value === 'updated' || value === 'completed' || value === 'failed';
}

function isApprovalPhase(value: unknown): boolean {
  return value === 'requested' || value === 'resolved';
}

function isRuntimeIssue(value: unknown): boolean {
  return value === 'unknown' || value === 'unavailable' || value === 'timeout' || value === 'rejected';
}

function isRecoveryReason(value: unknown): boolean {
  return value === 'cursor_gap' || value === 'cursor_stale' || value === 'epoch_changed'
    || value === 'event_overflow' || value === 'native_unavailable' || value === 'native_unknown';
}

function isOmissionReason(value: unknown): boolean {
  return value === 'thinking' || value === 'unsafe_media' || value === 'unknown';
}

function isMissingFact(value: unknown): boolean {
  return value === 'session_identity' || value === 'catalog' || value === 'usage'
    || value === 'artifacts' || value === 'context_tokens' || value === 'tasks'
    || value === 'replay_cursor' || value === 'bounded_history' || value === 'partial_runtime'
    || value === 'event_only';
}

function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && isBoundedString(value, MAX_SESSION_KEY_BYTES, true);
}

function isContentRef(value: unknown): value is string {
  return typeof value === 'string' && isBoundedString(value, MAX_CONTENT_REF_BYTES, true);
}

function isNullableSessionKey(value: unknown): boolean {
  return value === null || isSessionKey(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && isBoundedString(value, MAX_ID_BYTES, true);
}

function isNullableId(value: unknown): boolean {
  return value === null || isId(value);
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES && !value.includes('\0');
}

function isNullableText(value: unknown): boolean {
  return value === null || isText(value);
}

function isPayloadValue(value: unknown): boolean {
  const text = JSON.stringify(value);
  return text !== undefined
    && Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES
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

function isBoundedString(value: string, maxBytes: number, rejectControl: boolean): boolean {
  return value.length > 0
    && Buffer.byteLength(value, 'utf8') <= maxBytes
    && value.trim() === value
    && (!rejectControl || ![...value].some((character) => (character.codePointAt(0) ?? 0) < 32 || (character.codePointAt(0) ?? 0) === 127));
}

function isRouteKey(value: unknown): value is string {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= MAX_RENDERER_ROUTE_KEY_BYTES
    && /^renderer-route:[A-Za-z0-9_-]+$/.test(value);
}

function isEpoch(value: unknown): value is number {
  return isPositiveSafeInteger(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_SAFE_INTEGER;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_INTEGER;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function hasAllowedKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key));
}
