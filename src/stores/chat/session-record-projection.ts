import { buildRuntimeScopeKey } from './session-identity';
import { buildSessionIdentityKey, type SessionIdentity } from '../../types/desktop/runtime-address';
import { deriveSessionRuntime, getSessionTextModel } from './session-presentation';
import type { ApprovalItem, ChatSession, ChatSessionHistoryStatus, ChatSessionMetaState, ChatSessionRecord, ChatSessionRuntimeState, ChatSessionViewportState, ChatStoreState } from './types';
import { deriveSessionImageGenerationPendingStateFromItems, type SessionRenderItem } from '../../types/session/render-item';
import type { SessionContextTokenSnapshot, SessionStateSnapshot } from '../../types/session/snapshot';
import { containsTodoToolDebugSignal, logRendererTodoToolDebug, summarizeItemsForTodoToolDebug, summarizeSnapshotForTodoToolDebug } from './todo-tool-debug';
import { findLatestAssistantTextFromItems } from './timeline-message';
import { syncViewportState } from './viewport-state';
import { reconcileSessionItems, isPendingUserItem } from './session-item-reconciliation';
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function sessionIdentitiesEquivalent(left: SessionIdentity | null | undefined, right: SessionIdentity | null | undefined): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return buildSessionIdentityKey(left) === buildSessionIdentityKey(right);
}

function shallowRecordsEquivalent(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }
  return true;
}

function resolveTodoToolDebugCaller(): string {
  const stack = new Error().stack?.split('\n').slice(2, 8).map((line) => line.trim()) ?? [];
  return stack.join(' | ');
}

function logPatchSessionSnapshotTodoToolDebug(input: {
  sessionKey: string;
  currentItems: readonly SessionRenderItem[];
  snapshot: SessionStateSnapshot;
  nextItems: readonly SessionRenderItem[];
}): void {
  if (
    !containsTodoToolDebugSignal(input.currentItems)
    && !containsTodoToolDebugSignal(input.snapshot)
    && !containsTodoToolDebugSignal(input.nextItems)
  ) {
    return;
  }
  logRendererTodoToolDebug('renderer.patchSessionSnapshot.global', () => ({
    sessionKey: input.sessionKey,
    caller: resolveTodoToolDebugCaller(),
    beforeItems: summarizeItemsForTodoToolDebug(input.currentItems),
    incomingSnapshot: summarizeSnapshotForTodoToolDebug(input.snapshot),
    afterItems: summarizeItemsForTodoToolDebug(input.nextItems),
  }));
}

export function areSessionOwnershipsEquivalent(
  left: ChatSessionMetaState['ownership'],
  right: ChatSessionMetaState['ownership'],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === 'ordinary' || (right.kind === 'team'
    && left.teamId === right.teamId
    && left.teamRunId === right.teamRunId
    && left.roleId === right.roleId
    && left.sessionRef === right.sessionRef);
}

export function areSessionModelStatesEquivalent(
  left: ChatSessionMetaState['modelState'] | ChatSession['modelState'],
  right: ChatSessionMetaState['modelState'] | ChatSession['modelState'],
): boolean {
  return left === right || (
    (left?.overrideSource ?? null) === (right?.overrideSource ?? null)
    && (left?.selectionId ?? null) === (right?.selectionId ?? null)
    && (left?.selected?.provider ?? null) === (right?.selected?.provider ?? null)
    && (left?.selected?.model ?? null) === (right?.selected?.model ?? null)
    && (left?.selected?.ref ?? null) === (right?.selected?.ref ?? null)
    && (left?.active?.provider ?? null) === (right?.active?.provider ?? null)
    && (left?.active?.model ?? null) === (right?.active?.model ?? null)
    && (left?.active?.ref ?? null) === (right?.active?.ref ?? null)
  );
}

export function areSessionsEquivalent(left: ChatSession[], right: ChatSession[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.key !== b.key
      || (a.agentId ?? null) !== (b.agentId ?? null)
      || (a.protocolId ?? null) !== (b.protocolId ?? null)
      || (a.runtimeEndpointId ?? null) !== (b.runtimeEndpointId ?? null)
      || !sessionIdentitiesEquivalent(a.sessionIdentity, b.sessionIdentity)
      || !areSessionOwnershipsEquivalent(a.ownership, b.ownership)
      || (a.kind ?? null) !== (b.kind ?? null)
      || (a.preferred ?? false) !== (b.preferred ?? false)
      || (a.label ?? null) !== (b.label ?? null)
      || (a.titleSource ?? null) !== (b.titleSource ?? null)
      || (a.displayName ?? null) !== (b.displayName ?? null)
      || (a.thinkingLevel ?? null) !== (b.thinkingLevel ?? null)
      || !areSessionModelStatesEquivalent(a.modelState, b.modelState)
      || (a.updatedAt ?? null) !== (b.updatedAt ?? null)
    ) {
      return false;
    }
  }
  return true;
}

export function buildItemHistoryFingerprint(
  items: SessionRenderItem[],
  thinkingLevel: string | null,
): string {
  const count = items.length;
  const first = count > 0 ? items[0] : null;
  const last = count > 0 ? items[count - 1] : null;
  return [
    count,
    thinkingLevel ?? '',
    first?.key ?? '',
    first?.kind ?? '',
    first?.createdAt ?? '',
    last?.key ?? '',
    last?.kind ?? '',
    last?.createdAt ?? '',
    findLatestAssistantTextFromItems(items),
  ].join('|');
}

const EMPTY_ITEMS: SessionRenderItem[] = [];
const EMPTY_APPROVALS: ApprovalItem[] = [];
const EMPTY_VIEWPORT_STATE: ChatSessionViewportState = {
  totalItemCount: 0,
  windowStartOffset: 0,
  windowEndOffset: 0,
  hasMore: false,
  hasNewer: false,
  isLoadingMore: false,
  isLoadingNewer: false,
  isAtLatest: true,
  anchorItemKey: null,
};

export function createEmptySessionRuntime(): ChatSessionRuntimeState {
  return {
    activeRunId: null,
    runPhase: 'idle',
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    runProgress: null,
    runtimeActivity: null,
    errorDetail: null,
    runtimeNotice: null,
    lastUserMessageAt: null,
    lastError: null,
    lastIssue: null,
    updatedAt: null,
  };
}

export function createEmptySessionMeta(): ChatSessionMetaState {
  return {
    endpointSessionId: null,
    runtimeScopeKey: null,
    agentId: null,
    protocolId: null,
    runtimeEndpointId: null,
    sessionIdentity: null,
    ownership: null,
    kind: null,
    preferred: false,
    label: null,
    titleSource: 'none',
    manualLabel: false,
    displayName: null,
    modelState: null,
    goal: { kind: 'unknown' },
    goalReadRevision: 0,
    lastActivityAt: null,
    historyStatus: 'idle',
    thinkingLevel: null,
  };
}

export function isSessionHistoryReady(status: ChatSessionHistoryStatus | null | undefined): boolean {
  return status === 'ready';
}

export function createEmptySessionRecord(): ChatSessionRecord {
  return {
    meta: createEmptySessionMeta(),
    runtime: createEmptySessionRuntime(),
    items: EMPTY_ITEMS,
    window: createEmptySessionViewportState(),
  };
}

export function createEmptySessionViewportState(): ChatSessionViewportState {
  return EMPTY_VIEWPORT_STATE;
}

function areSessionMetaEquivalent(left: ChatSessionMetaState, right: ChatSessionMetaState): boolean {
  return left.endpointSessionId === right.endpointSessionId
    && left.runtimeScopeKey === right.runtimeScopeKey
    && left.agentId === right.agentId
    && (left.protocolId ?? null) === (right.protocolId ?? null)
    && (left.runtimeEndpointId ?? null) === (right.runtimeEndpointId ?? null)
    && sessionIdentitiesEquivalent(left.sessionIdentity, right.sessionIdentity)
    && areSessionOwnershipsEquivalent(left.ownership, right.ownership)
    && left.kind === right.kind
    && left.preferred === right.preferred
    && left.label === right.label
    && left.titleSource === right.titleSource
    && (left.manualLabel === true) === (right.manualLabel === true)
    && left.displayName === right.displayName
    && areSessionModelStatesEquivalent(left.modelState, right.modelState)
    && JSON.stringify(left.goal) === JSON.stringify(right.goal)
    && left.goalReadRevision === right.goalReadRevision
    && left.lastActivityAt === right.lastActivityAt
    && left.historyStatus === right.historyStatus
    && left.thinkingLevel === right.thinkingLevel;
}

function areTransportIssuesEquivalent(
  left: ChatSessionRuntimeState['lastIssue'],
  right: ChatSessionRuntimeState['lastIssue'],
): boolean {
  return left === right
    || (!!left
      && !!right
      && left.message === right.message
      && left.source === right.source
      && left.at === right.at
      && (left.code ?? null) === (right.code ?? null)
      && (left.retryable ?? null) === (right.retryable ?? null)
      && (left.retryAfterMs ?? null) === (right.retryAfterMs ?? null)
      && left.details === right.details);
}

function areRunProgressEquivalent(
  left: ChatSessionRuntimeState['runProgress'],
  right: ChatSessionRuntimeState['runProgress'],
): boolean {
  if (left === right) return true;
  if (!left || !right || left.kind !== right.kind) return false;
  return left.kind === 'startup'
    ? right.kind === 'startup' && left.phase === right.phase
    : right.kind === 'retrying' && left.attempt === right.attempt && left.maxAttempts === right.maxAttempts;
}

function areRuntimeErrorDetailsEquivalent(
  left: ChatSessionRuntimeState['errorDetail'],
  right: ChatSessionRuntimeState['errorDetail'],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind
    && left.failoverReason === right.failoverReason
    && left.providerRuntimeFailureKind === right.providerRuntimeFailureKind
    && left.providerErrorType === right.providerErrorType
    && left.providerErrorMessagePreview === right.providerErrorMessagePreview
    && left.httpStatus === right.httpStatus;
}

function areRuntimeNoticesEquivalent(
  left: ChatSessionRuntimeState['runtimeNotice'],
  right: ChatSessionRuntimeState['runtimeNotice'],
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.runId === right.runId
    && left.kind === right.kind
    && left.command === right.command
    && left.riskLevel === right.riskLevel
    && left.rationale === right.rationale
    && left.message === right.message;
}

function areImageGenerationRuntimeEquivalent(
  left: ChatSessionRuntimeState['imageGeneration'],
  right: ChatSessionRuntimeState['imageGeneration'],
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.active === right.active
    && left.pendingTaskIds.length === right.pendingTaskIds.length
    && left.pendingTaskIds.every((taskId, index) => taskId === right.pendingTaskIds[index]);
}

function areSessionRuntimeEquivalent(left: ChatSessionRuntimeState, right: ChatSessionRuntimeState): boolean {
  return left.activeRunId === right.activeRunId
    && left.runPhase === right.runPhase
    && left.activeTurnItemKey === right.activeTurnItemKey
    && left.pendingTurnKey === right.pendingTurnKey
    && left.pendingTurnLaneKey === right.pendingTurnLaneKey
    && areRunProgressEquivalent(left.runProgress, right.runProgress)
    && left.runtimeActivity === right.runtimeActivity
    && areRuntimeErrorDetailsEquivalent(left.errorDetail, right.errorDetail)
    && areRuntimeNoticesEquivalent(left.runtimeNotice, right.runtimeNotice)
    && areImageGenerationRuntimeEquivalent(left.imageGeneration, right.imageGeneration)
    && left.lastUserMessageAt === right.lastUserMessageAt
    && left.lastError === right.lastError
    && areTransportIssuesEquivalent(left.lastIssue, right.lastIssue)
    && left.updatedAt === right.updatedAt;
}

function areSessionContextTokensEquivalent(
  left: SessionContextTokenSnapshot | undefined,
  right: SessionContextTokenSnapshot | undefined,
): boolean {
  return (left?.totalTokens ?? null) === (right?.totalTokens ?? null)
    && (left?.totalTokensFresh ?? null) === (right?.totalTokensFresh ?? null)
    && (left?.contextTokens ?? null) === (right?.contextTokens ?? null);
}

function areSessionViewportEquivalent(left: ChatSessionViewportState, right: ChatSessionViewportState): boolean {
  return left.totalItemCount === right.totalItemCount
    && left.windowStartOffset === right.windowStartOffset
    && left.windowEndOffset === right.windowEndOffset
    && left.hasMore === right.hasMore
    && left.hasNewer === right.hasNewer
    && left.isLoadingMore === right.isLoadingMore
    && left.isLoadingNewer === right.isLoadingNewer
    && left.isAtLatest === right.isAtLatest
    && left.anchorItemKey === right.anchorItemKey;
}

type ApprovalComparable = Omit<ApprovalItem, 'allowedDecisions'> & {
  allowedDecisions: readonly ApprovalItem['allowedDecisions'][number][];
};

function areApprovalItemsEquivalent(left: ApprovalComparable, right: ApprovalComparable): boolean {
  return left.id === right.id
    && left.sessionKey === right.sessionKey
    && left.runId === right.runId
    && left.title === right.title
    && left.command === right.command
    && left.createdAtMs === right.createdAtMs
    && left.expiresAtMs === right.expiresAtMs
    && left.decision === right.decision
    && sessionIdentitiesEquivalent(left.sessionIdentity, right.sessionIdentity)
    && left.allowedDecisions.length === right.allowedDecisions.length
    && left.allowedDecisions.every((decision, index) => decision === right.allowedDecisions[index])
    && shallowRecordsEquivalent(left.request, right.request);
}

function areApprovalListsEquivalent(left: readonly ApprovalComparable[], right: readonly ApprovalComparable[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (!leftItem || !rightItem || !areApprovalItemsEquivalent(leftItem, rightItem)) {
      return false;
    }
  }
  return true;
}

export function resolveSessionRuntime(session: ChatSessionRecord | undefined): ChatSessionRuntimeState {
  return session ? deriveSessionRuntime(session) : createEmptySessionRuntime();
}

export function resolveSessionMeta(session: ChatSessionRecord | undefined): ChatSessionMetaState {
  return session?.meta ?? createEmptySessionMeta();
}

export function resolveSessionItems(
  session: ChatSessionRecord | undefined,
): SessionRenderItem[] {
  if (Array.isArray(session?.items)) {
    return session.items;
  }
  return EMPTY_ITEMS;
}

export function getSessionItemCount(
  session: Pick<ChatSessionRecord, 'items'> | undefined,
): number {
  if (Array.isArray(session?.items)) {
    return session.items.length;
  }
  return 0;
}

export function resolveSessionRecord(session: ChatSessionRecord | undefined): ChatSessionRecord {
  return session ?? createEmptySessionRecord();
}

export function resolveSessionViewportState(session: ChatSessionRecord | undefined): ChatSessionViewportState {
  return session?.window ?? EMPTY_VIEWPORT_STATE;
}

export function getSessionRecord(state: Pick<ChatStoreState, 'loadedSessions'>, sessionKey: string): ChatSessionRecord {
  return resolveSessionRecord(state.loadedSessions[sessionKey]);
}

export function getSessionItems(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
): SessionRenderItem[] {
  return resolveSessionItems(state.loadedSessions[sessionKey]);
}

export function getSessionMeta(state: Pick<ChatStoreState, 'loadedSessions'>, sessionKey: string): ChatSessionMetaState {
  return resolveSessionMeta(state.loadedSessions[sessionKey]);
}

export function getSessionRuntime(state: Pick<ChatStoreState, 'loadedSessions'>, sessionKey: string): ChatSessionRuntimeState {
  return resolveSessionRuntime(state.loadedSessions[sessionKey]);
}

export function getSessionViewportState(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
): ChatSessionViewportState {
  return resolveSessionViewportState(state.loadedSessions[sessionKey]);
}

export function upsertSessionRecord(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  nextRecord: ChatSessionRecord,
): Record<string, ChatSessionRecord> {
  return {
    ...state.loadedSessions,
    [sessionKey]: nextRecord,
  };
}

export type ChatSessionRecordPatch = Partial<Omit<ChatSessionRecord, 'contextTokens'>> & {
  contextTokens?: SessionContextTokenSnapshot | null;
};

export function patchSessionRecordValue(
  current: ChatSessionRecord,
  patch: ChatSessionRecordPatch,
): ChatSessionRecord {
  const nextRecord = {
    meta: patch.meta ?? current.meta,
    runtime: patch.runtime ?? current.runtime,
    send: patch.send === undefined ? current.send : patch.send,
    abort: patch.abort === undefined ? current.abort : patch.abort,
    items: patch.items ?? current.items,
    window: patch.window ?? current.window,
    contextTokens: Object.prototype.hasOwnProperty.call(patch, 'contextTokens')
      ? patch.contextTokens ?? undefined
      : current.contextTokens,
  };
  if (
    current.meta === nextRecord.meta
    && current.runtime === nextRecord.runtime
    && current.send === nextRecord.send
    && current.abort === nextRecord.abort
    && current.items === nextRecord.items
    && current.window === nextRecord.window
    && areSessionContextTokensEquivalent(current.contextTokens, nextRecord.contextTokens)
  ) {
    return current;
  }
  return nextRecord;
}

export function patchSessionRecord(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  patch: ChatSessionRecordPatch,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const nextRecord = patchSessionRecordValue(current, patch);
  return current === nextRecord ? state.loadedSessions : {
    ...state.loadedSessions,
    [sessionKey]: nextRecord,
  };
}

export function patchSessionMetaValue(
  current: ChatSessionRecord,
  patch: Partial<ChatSessionMetaState>,
): ChatSessionRecord {
  const nextMeta = {
    ...current.meta,
    ...patch,
  };
  if (areSessionMetaEquivalent(current.meta, nextMeta)) {
    return current;
  }
  const identityChanged = !sessionIdentitiesEquivalent(current.meta.sessionIdentity, nextMeta.sessionIdentity);
  return {
    ...current,
    meta: nextMeta,
    ...(identityChanged ? {
      send: null,
      abort: null,
      items: current.items.filter((item) => !item.key.startsWith('renderer-assistant:')
        && !(item.kind === 'user-message' && isPendingUserItem(item))),
    } : {}),
  };
}

export function patchSessionMeta(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  patch: Partial<ChatSessionMetaState>,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const nextRecord = patchSessionMetaValue(current, patch);
  return current === nextRecord ? state.loadedSessions : {
    ...state.loadedSessions,
    [sessionKey]: nextRecord,
  };
}

export function patchCurrentSessionMeta(
  state: Pick<ChatStoreState, 'currentSessionKey' | 'loadedSessions'>,
  patch: Partial<ChatSessionMetaState>,
): Record<string, ChatSessionRecord> {
  return patchSessionMeta(state, state.currentSessionKey, patch);
}

export function patchSessionViewportState(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  viewport: ChatSessionViewportState,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  if (current.window === viewport || areSessionViewportEquivalent(current.window, viewport)) {
    return state.loadedSessions;
  }
  return {
    ...state.loadedSessions,
    [sessionKey]: {
      ...current,
      window: viewport,
    },
  };
}

export function removeSessionRecord(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
): Record<string, ChatSessionRecord> {
  return Object.fromEntries(
    Object.entries(state.loadedSessions).filter(([key]) => key !== sessionKey),
  );
}

export function removeSessionViewportState(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
): Record<string, ChatSessionRecord> {
  return removeSessionRecord(state, sessionKey);
}

export function selectViewportItems(
  record: Pick<ChatSessionRecord, 'items' | 'window'>,
): SessionRenderItem[] {
  void record.window;
  return resolveSessionItems(record as ChatSessionRecord);
}


export function patchSessionItemsAndViewport(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  items: SessionRenderItem[],
  viewportPatch?: Partial<ChatSessionViewportState>,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const nextItemCount = items.length;
  const nextViewport = syncViewportState(current.window, {
    totalItemCount: viewportPatch?.totalItemCount ?? Math.max(current.window.totalItemCount, items.length),
    windowStartOffset: viewportPatch?.windowStartOffset ?? current.window.windowStartOffset,
    windowEndOffset: viewportPatch?.windowEndOffset ?? (
      (viewportPatch?.windowStartOffset ?? current.window.windowStartOffset) + nextItemCount
    ),
    hasMore: viewportPatch?.hasMore ?? current.window.hasMore,
    hasNewer: viewportPatch?.hasNewer ?? current.window.hasNewer,
    isLoadingMore: viewportPatch?.isLoadingMore ?? current.window.isLoadingMore,
    isLoadingNewer: viewportPatch?.isLoadingNewer ?? current.window.isLoadingNewer,
    isAtLatest: viewportPatch?.isAtLatest ?? current.window.isAtLatest,
    anchorItemKey: viewportPatch?.anchorItemKey ?? current.window.anchorItemKey,
  });
  return patchSessionRecord(state, sessionKey, {
    items,
    window: nextViewport,
  });
}

export function patchSessionTurnItem(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  item: SessionRenderItem,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const index = current.items.findIndex((candidate) => candidate.key === item.key);
  if (index < 0) {
    return state.loadedSessions;
  }
  const items = [...current.items];
  items[index] = item;
  return patchSessionRecord(state, sessionKey, { items });
}

export function patchSessionSnapshot(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  snapshot: SessionStateSnapshot,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const catalog = snapshot.catalog;
  const nextItems = reconcileSessionItems(current.items, snapshot.items, getSessionTextModel(catalog.sessionIdentity).user);
  const hasManualLabel = current.meta.manualLabel === true;
  const nextLabel = hasManualLabel ? current.meta.label : catalog.label ?? null;
  const nextTitleSource = hasManualLabel ? current.meta.titleSource : catalog.titleSource ?? 'none';
  const nextMeta = {
    ...current.meta,
    endpointSessionId: catalog.endpointSessionId ?? current.meta.endpointSessionId,
    runtimeScopeKey: buildRuntimeScopeKey(catalog.sessionIdentity.endpoint),
    agentId: catalog.agentId,
    protocolId: catalog.protocolId ?? null,
    runtimeEndpointId: catalog.runtimeEndpointId ?? null,
    sessionIdentity: catalog.sessionIdentity,
    ownership: catalog.ownership,
    kind: catalog.kind,
    preferred: catalog.preferred,
    label: nextLabel,
    titleSource: nextTitleSource,
    manualLabel: hasManualLabel,
    displayName: catalog.displayName ?? current.meta.displayName,
    modelState: catalog.modelState ?? current.meta.modelState,
    lastActivityAt: typeof catalog.updatedAt === 'number' ? toMs(catalog.updatedAt) : current.meta.lastActivityAt,
  };
  const nextImageGenerationRuntime = deriveSessionImageGenerationPendingStateFromItems(
    nextItems,
    current.runtime.imageGeneration,
  );
  const nextRuntime = {
    ...current.runtime,
    activeRunId: snapshot.runtime.activeRunId,
    runPhase: snapshot.runtime.runPhase,
    activeTurnItemKey: snapshot.runtime.activeTurnItemKey,
    pendingTurnKey: snapshot.runtime.pendingTurnKey,
    pendingTurnLaneKey: snapshot.runtime.pendingTurnLaneKey,
    imageGeneration: nextImageGenerationRuntime.active ? nextImageGenerationRuntime : undefined,
    lastUserMessageAt: snapshot.runtime.lastUserMessageAt,
    runProgress: snapshot.runtime.runProgress,
    runtimeActivity: snapshot.runtime.runtimeActivity,
    errorDetail: snapshot.runtime.errorDetail,
    runtimeNotice: snapshot.runtime.runtimeNotice ?? null,
    lastError: snapshot.runtime.lastError,
    lastIssue: snapshot.runtime.lastIssue,
    updatedAt: snapshot.runtime.updatedAt,
  };
  const nextWindow = syncViewportState(current.window, {
    totalItemCount: snapshot.window.totalItemCount,
    windowStartOffset: snapshot.window.windowStartOffset,
    windowEndOffset: snapshot.window.windowEndOffset,
    hasMore: snapshot.window.hasMore,
    hasNewer: snapshot.window.hasNewer,
    isLoadingMore: false,
    isLoadingNewer: false,
    isAtLatest: snapshot.window.isAtLatest,
    anchorItemKey: current.window.anchorItemKey,
  });
  logPatchSessionSnapshotTodoToolDebug({
    sessionKey,
    currentItems: current.items,
    snapshot,
    nextItems,
  });
  const nextContextTokens = snapshot.contextTokens ?? catalog.contextTokens ?? current.contextTokens;
  return patchSessionRecord(state, sessionKey, {
    meta: areSessionMetaEquivalent(current.meta, nextMeta) ? current.meta : nextMeta,
    items: nextItems,
    runtime: areSessionRuntimeEquivalent(current.runtime, nextRuntime) ? current.runtime : nextRuntime,
    window: areSessionViewportEquivalent(current.window, nextWindow) ? current.window : nextWindow,
    contextTokens: areSessionContextTokensEquivalent(current.contextTokens, nextContextTokens) ? current.contextTokens : nextContextTokens,
  });
}

export function patchPendingApprovalsFromSnapshot(
  state: Pick<ChatStoreState, 'pendingApprovalsBySession' | 'loadedSessions'>,
  sessionKey: string,
  snapshot: SessionStateSnapshot,
): Record<string, ApprovalItem[]> {
  const current = state.pendingApprovalsBySession[sessionKey] ?? EMPTY_APPROVALS;
  const sessionEndpointId = getSessionMeta(state, sessionKey).endpointSessionId;
  const nextApprovals = snapshot.approvals.map((approval) => ({
    ...approval,
    sessionKey,
    endpointSessionId: state.pendingApprovalsBySession[sessionKey]?.find((currentApproval) => currentApproval.id === approval.id)?.endpointSessionId ?? sessionEndpointId ?? undefined,
    allowedDecisions: [...approval.allowedDecisions],
  }));
  if (areApprovalListsEquivalent(current, nextApprovals)) {
    return state.pendingApprovalsBySession;
  }
  return {
    ...state.pendingApprovalsBySession,
    [sessionKey]: nextApprovals,
  };
}

