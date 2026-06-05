import { buildRuntimeScopeKey } from './session-identity';
import type {
  ApprovalStatus,
  ApprovalItem,
  ChatSession,
  ChatSessionHistoryStatus,
  ChatSessionMetaState,
  ChatSessionRecord,
  ChatSessionRuntimeState,
  ChatSessionViewportState,
  ChatStoreState,
} from './types';
import type {
  SessionAssistantTurnItem,
  SessionExecutionGraphStep,
  SessionRenderAttachedFile,
  SessionRenderExecutionGraphItem,
  SessionRenderImage,
  SessionRenderItem,
  SessionRenderSystemItem,
  SessionStateSnapshot,
} from '../../../runtime-host/shared/session-adapter-types';
import {
  containsTodoToolDebugSignal,
  logRendererTodoToolDebug,
  summarizeItemsForTodoToolDebug,
  summarizeSnapshotForTodoToolDebug,
} from './todo-tool-debug';
import { findLatestAssistantTextFromItems } from './timeline-message';
import { sanitizeCanonicalUserText } from './message-helpers';
import { syncViewportState } from './viewport-state';

export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

export function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function safeStableStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function hashText(value: string | null | undefined): string {
  return hashStringDjb2(value ?? '');
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
  logRendererTodoToolDebug('renderer.patchSessionSnapshot.global', {
    sessionKey: input.sessionKey,
    caller: resolveTodoToolDebugCaller(),
    beforeItems: summarizeItemsForTodoToolDebug(input.currentItems),
    incomingSnapshot: summarizeSnapshotForTodoToolDebug(input.snapshot),
    afterItems: summarizeItemsForTodoToolDebug(input.nextItems),
  });
}

function buildAttachedFilesSignature(
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>,
): string {
  if (attachedFiles.length === 0) {
    return '';
  }
  const parts = attachedFiles.map((file) => [
    file.fileName,
    file.filePath ?? '',
    file.gatewayUrl ?? '',
    file.mimeType,
    String(file.fileSize),
    file.preview ?? '',
    file.source ?? '',
  ].join(':'));
  return hashStringDjb2(parts.join('|'));
}

function buildImageSignature(images: ReadonlyArray<SessionRenderImage>): string {
  if (images.length === 0) {
    return '';
  }
  const parts = images.map((image) => [
    image.mimeType,
    image.url ?? '',
    String(image.data?.length ?? 0),
  ].join(':'));
  return hashStringDjb2(parts.join('|'));
}

function buildAssistantToolResultSignature(result: SessionAssistantTurnItem['tools'][number]['result']): string {
  switch (result.kind) {
    case 'text':
      return `${result.kind}:${hashText(result.bodyText)}`;
    case 'json':
      return `${result.kind}:${hashText(result.bodyText)}`;
    case 'canvas':
      return [
        result.kind,
        result.surface,
        result.preview.kind,
        result.preview.surface,
        result.preview.viewId,
        hashText(result.rawText),
      ].join(':');
    default:
      return result.kind;
  }
}

function buildAssistantTurnSignature(item: SessionAssistantTurnItem): string {
  const segmentParts = item.segments.map((segment) => {
    if (segment.kind === 'message' || segment.kind === 'thinking') {
      return `${segment.kind}:${segment.key}:${hashText(segment.text)}`;
    }
    if (segment.kind === 'media') {
      return [
        segment.kind,
        segment.key,
        buildImageSignature(segment.images),
        buildAttachedFilesSignature(segment.attachedFiles),
      ].join(':');
    }
    return [
      segment.kind,
      segment.key,
      segment.tool.id,
      segment.tool.toolCallId ?? '',
      segment.tool.name,
      segment.tool.status,
      String(segment.tool.updatedAt ?? ''),
      String(segment.tool.durationMs ?? ''),
      hashText(segment.tool.summary),
      buildAssistantToolResultSignature(segment.tool.result),
    ].join(':');
  });

  const toolParts = item.tools.map((tool) => [
    tool.id,
    tool.toolCallId ?? '',
    tool.name,
    tool.status,
    String(tool.updatedAt ?? ''),
    String(tool.durationMs ?? ''),
    hashText(tool.summary),
    buildAssistantToolResultSignature(tool.result),
  ].join(':'));

  const embeddedToolResultParts = (item.embeddedToolResults ?? []).map((result) => [
    result.key,
    result.toolCallId ?? '',
    result.toolName,
    result.preview.kind,
    result.preview.viewId,
    result.rawText ? hashText(result.rawText) : '',
  ].join(':'));

  return hashStringDjb2([
    item.key,
    item.kind,
    item.role,
    item.status,
    item.createdAt ?? '',
    item.updatedAt ?? '',
    item.turnKey ?? '',
    item.laneKey ?? '',
    item.agentId ?? '',
    item.pendingState ?? '',
    hashText(item.text),
    buildImageSignature(item.images),
    buildAttachedFilesSignature(item.attachedFiles),
    segmentParts.join('|'),
    toolParts.join('|'),
    embeddedToolResultParts.join('|'),
  ].join('|'));
}

function buildExecutionGraphStepSignature(step: SessionExecutionGraphStep): string {
  return [
    step.id,
    step.label,
    step.status,
    step.kind,
    step.detail ?? '',
    String(step.depth),
    step.parentId ?? '',
  ].join(':');
}

function buildExecutionGraphSignature(item: SessionRenderExecutionGraphItem): string {
  return hashStringDjb2([
    item.key,
    item.kind,
    item.role,
    item.createdAt ?? '',
    item.graphId,
    item.completionItemKey,
    item.anchorItemKey ?? '',
    item.childSessionKey,
    item.childSessionId ?? '',
    item.childAgentId ?? '',
    item.agentId ?? '',
    item.agentLabel,
    item.sessionLabel,
    item.triggerItemKey ?? '',
    item.replyItemKey ?? '',
    item.active ? '1' : '0',
    item.steps.map(buildExecutionGraphStepSignature).join('|'),
  ].join('|'));
}

function buildProtocolItemSignature(item: SessionRenderItem): string {
  if (item.kind === 'assistant-turn') {
    return buildAssistantTurnSignature(item);
  }
  if (item.kind === 'execution-graph') {
    return buildExecutionGraphSignature(item);
  }
  if (item.kind === 'user-message') {
    return hashStringDjb2([
      item.key,
      item.kind,
      item.role,
      item.messageId ?? '',
      item.createdAt ?? '',
      item.updatedAt ?? '',
      hashText(item.text),
      buildImageSignature(item.images),
      buildAttachedFilesSignature(item.attachedFiles),
    ].join('|'));
  }
  const systemItem: SessionRenderSystemItem = item;
  return hashStringDjb2([
    systemItem.key,
    systemItem.kind,
    systemItem.role,
    systemItem.createdAt ?? '',
    systemItem.level,
    hashText(systemItem.text),
  ].join('|'));
}

function isPendingUserItem(item: SessionRenderItem): boolean {
  if (item.kind !== 'user-message') {
    return false;
  }
  const status = (item as { status?: unknown }).status;
  return status === 'pending' || status === 'sending';
}

function buildUserConfirmationKey(item: SessionRenderItem): string | null {
  if (item.kind !== 'user-message') {
    return null;
  }
  const messageId = item.messageId?.trim();
  if (messageId) {
    return `message:${messageId}`;
  }
  const text = sanitizeCanonicalUserText(item.text).trim();
  const createdAt = item.createdAt ?? null;
  if (!text || createdAt == null) {
    return null;
  }
  return `echo:${hashStringDjb2(text)}:${createdAt}`;
}

function dropReconciledOptimisticUserItems(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
): SessionRenderItem[] {
  const pendingUserKeys = new Set(
    currentItems.flatMap((item) => {
      const key = buildUserConfirmationKey(item);
      return key && isPendingUserItem(item) ? [key] : [];
    }),
  );
  if (pendingUserKeys.size === 0) {
    return nextItems;
  }
  const authoritativeUserKeys = new Set(
    nextItems.flatMap((item) => {
      const key = buildUserConfirmationKey(item);
      return key && !isPendingUserItem(item) ? [key] : [];
    }),
  );
  if (authoritativeUserKeys.size === 0) {
    return nextItems;
  }
  return nextItems.filter((item) => {
    const key = buildUserConfirmationKey(item);
    return !key || !isPendingUserItem(item) || !pendingUserKeys.has(key) || !authoritativeUserKeys.has(key);
  });
}

export function reconcileSessionItems(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
): SessionRenderItem[] {
  if (currentItems === nextItems) {
    return currentItems;
  }
  const canonicalNextItems = dropReconciledOptimisticUserItems(currentItems, nextItems);
  if (canonicalNextItems.length === 0) {
    return currentItems.length === 0 ? currentItems : canonicalNextItems;
  }

  const currentByKey = new Map(
    currentItems.map((item) => [item.key, item] as const),
  );
  let changed = currentItems.length !== canonicalNextItems.length || canonicalNextItems.length !== nextItems.length;

  const reconciled = canonicalNextItems.map((nextItem, index) => {
    const currentItem = currentByKey.get(nextItem.key);
    if (!currentItem || currentItem.kind !== nextItem.kind) {
      changed = true;
      return nextItem;
    }
    if (buildProtocolItemSignature(currentItem) !== buildProtocolItemSignature(nextItem)) {
      changed = true;
      return nextItem;
    }
    if (currentItems[index] !== currentItem) {
      changed = true;
    }
    return currentItem;
  });

  return changed ? reconciled : currentItems;
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
      || safeStableStringify(a.runtimeAddress ?? null) !== safeStableStringify(b.runtimeAddress ?? null)
      || (a.kind ?? null) !== (b.kind ?? null)
      || (a.preferred ?? false) !== (b.preferred ?? false)
      || (a.label ?? null) !== (b.label ?? null)
      || (a.titleSource ?? null) !== (b.titleSource ?? null)
      || (a.displayName ?? null) !== (b.displayName ?? null)
      || (a.thinkingLevel ?? null) !== (b.thinkingLevel ?? null)
      || (a.model ?? null) !== (b.model ?? null)
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

export function buildItemRenderFingerprint(items: SessionRenderItem[]): string {
  if (items.length === 0) {
    return hashStringDjb2('0');
  }
  return hashStringDjb2(items.map(buildProtocolItemSignature).join('|'));
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
    runtimeActivity: null,
    lastUserMessageAt: null,
    lastError: null,
    lastIssue: null,
    updatedAt: null,
  };
}

export function createEmptySessionMeta(): ChatSessionMetaState {
  return {
    backendSessionKey: '',
    runtimeScopeKey: null,
    agentId: null,
    protocolId: null,
    runtimeEndpointId: null,
    runtimeAddress: null,
    kind: null,
    preferred: false,
    label: null,
    titleSource: 'none',
    displayName: null,
    model: null,
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
  return left.backendSessionKey === right.backendSessionKey
    && left.runtimeScopeKey === right.runtimeScopeKey
    && left.agentId === right.agentId
    && (left.protocolId ?? null) === (right.protocolId ?? null)
    && (left.runtimeEndpointId ?? null) === (right.runtimeEndpointId ?? null)
    && safeStableStringify(left.runtimeAddress) === safeStableStringify(right.runtimeAddress)
    && left.kind === right.kind
    && left.preferred === right.preferred
    && left.label === right.label
    && left.titleSource === right.titleSource
    && left.displayName === right.displayName
    && left.model === right.model
    && left.lastActivityAt === right.lastActivityAt
    && left.historyStatus === right.historyStatus
    && left.thinkingLevel === right.thinkingLevel;
}

function areSessionRuntimeEquivalent(left: ChatSessionRuntimeState, right: ChatSessionRuntimeState): boolean {
  return left.activeRunId === right.activeRunId
    && left.runPhase === right.runPhase
    && left.activeTurnItemKey === right.activeTurnItemKey
    && left.pendingTurnKey === right.pendingTurnKey
    && left.pendingTurnLaneKey === right.pendingTurnLaneKey
    && left.runtimeActivity === right.runtimeActivity
    && left.lastUserMessageAt === right.lastUserMessageAt
    && left.lastError === right.lastError
    && safeStableStringify(left.lastIssue) === safeStableStringify(right.lastIssue)
    && left.updatedAt === right.updatedAt;
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
    && left.backendSessionKey === right.backendSessionKey
    && left.runId === right.runId
    && left.title === right.title
    && left.command === right.command
    && left.createdAtMs === right.createdAtMs
    && left.expiresAtMs === right.expiresAtMs
    && left.decision === right.decision
    && safeStableStringify(left.runtimeAddress) === safeStableStringify(right.runtimeAddress)
    && left.allowedDecisions.length === right.allowedDecisions.length
    && left.allowedDecisions.every((decision, index) => decision === right.allowedDecisions[index])
    && safeStableStringify(left.request) === safeStableStringify(right.request);
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
  return session?.runtime ?? createEmptySessionRuntime();
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

type ChatSessionRecordPatch = Partial<ChatSessionRecord>;

export function patchSessionRecord(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  patch: ChatSessionRecordPatch,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const nextRecord = {
    meta: patch.meta ?? current.meta,
    runtime: patch.runtime ?? current.runtime,
    items: patch.items ?? current.items,
    window: patch.window ?? current.window,
  };
  if (
    current.meta === nextRecord.meta
    && current.runtime === nextRecord.runtime
    && current.items === nextRecord.items
    && current.window === nextRecord.window
  ) {
    return state.loadedSessions;
  }
  return {
    ...state.loadedSessions,
    [sessionKey]: nextRecord,
  };
}

export function patchSessionMeta(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  patch: Partial<ChatSessionMetaState>,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const nextMeta = {
    ...current.meta,
    ...patch,
  };
  if (areSessionMetaEquivalent(current.meta, nextMeta)) {
    return state.loadedSessions;
  }
  return {
    ...state.loadedSessions,
    [sessionKey]: {
      ...current,
      meta: nextMeta,
    },
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
  const nextItems = reconcileSessionItems(current.items, snapshot.items);
  const nextMeta = {
    ...current.meta,
    backendSessionKey: snapshot.sessionKey,
    runtimeScopeKey: buildRuntimeScopeKey(catalog.runtimeAddress),
    agentId: catalog.agentId,
    protocolId: catalog.protocolId ?? null,
    runtimeEndpointId: catalog.runtimeEndpointId ?? null,
    runtimeAddress: catalog.runtimeAddress,
    kind: catalog.kind,
    preferred: catalog.preferred,
    label: catalog.label ?? null,
    titleSource: catalog.titleSource ?? 'none',
    displayName: catalog.displayName ?? current.meta.displayName,
    model: catalog.model ?? current.meta.model ?? null,
    lastActivityAt: typeof catalog.updatedAt === 'number' ? catalog.updatedAt : current.meta.lastActivityAt,
  };
  const nextRuntime = {
    ...current.runtime,
    activeRunId: snapshot.runtime.activeRunId,
    runPhase: snapshot.runtime.runPhase,
    activeTurnItemKey: snapshot.runtime.activeTurnItemKey,
    pendingTurnKey: snapshot.runtime.pendingTurnKey,
    pendingTurnLaneKey: snapshot.runtime.pendingTurnLaneKey,
    lastUserMessageAt: snapshot.runtime.lastUserMessageAt,
    runtimeActivity: snapshot.runtime.runtimeActivity,
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
  return patchSessionRecord(state, sessionKey, {
    meta: areSessionMetaEquivalent(current.meta, nextMeta) ? current.meta : nextMeta,
    items: nextItems,
    runtime: areSessionRuntimeEquivalent(current.runtime, nextRuntime) ? current.runtime : nextRuntime,
    window: areSessionViewportEquivalent(current.window, nextWindow) ? current.window : nextWindow,
  });
}

export function patchPendingApprovalsFromSnapshot(
  state: Pick<ChatStoreState, 'pendingApprovalsBySession'>,
  sessionKey: string,
  snapshot: SessionStateSnapshot,
): Record<string, ApprovalItem[]> {
  const current = state.pendingApprovalsBySession[sessionKey] ?? EMPTY_APPROVALS;
  const nextApprovals = snapshot.approvals.map((approval) => ({
    ...approval,
    sessionKey,
    backendSessionKey: approval.sessionKey,
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

export function getPendingApprovals(
  state: Pick<ChatStoreState, 'pendingApprovalsBySession'>,
  sessionKey: string,
): ApprovalItem[] {
  return state.pendingApprovalsBySession[sessionKey] ?? EMPTY_APPROVALS;
}

export function getSessionApprovalStatus(
  state: Pick<ChatStoreState, 'pendingApprovalsBySession'>,
  sessionKey: string,
): ApprovalStatus {
  return getPendingApprovals(state, sessionKey).length > 0
    ? 'awaiting_approval'
    : 'idle';
}

export function findStreamingAssistantTurn(items: SessionRenderItem[]): SessionAssistantTurnItem | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.kind === 'assistant-turn' && item.status === 'streaming') {
      return item;
    }
  }
  return null;
}

export function hasTimeoutSignal(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const err = error as Error & { code?: unknown };
  const msg = String(err.message || error);
  const code = typeof err.code === 'string' ? err.code.toUpperCase() : '';
  return code.includes('TIMEOUT') || msg.toLowerCase().includes('timeout');
}

export function isRecoverableChatSendTimeout(errorMessage: string): boolean {
  const normalized = errorMessage.trim();
  return (
    normalized.includes('RPC timeout: chat.send')
    || normalized.includes('Gateway RPC timeout: chat.send')
  );
}
