import { buildRuntimeScopeKey, buildSessionIdentityRecordIndex } from './session-identity';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '../../../electron/desktop-contract/runtime-address';
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
  SessionRenderExecutionGraphItem,
  SessionRenderItem,
  SessionRenderSystemItem,
} from '../../types/session/render-item';
import type {
  SessionAssistantTurnSegment,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
} from '../../types/session/tool-card';
import type {
  SessionContextTokenSnapshot,
  SessionDelta,
  SessionFact,
  SessionStateSnapshot,
  SessionView,
  SessionWireContent,
  SessionWireItem,
  SessionWireRuntime,
  SessionWireTool,
  SessionWireWindow,
} from '../../types/session/snapshot';
import {
  containsTodoToolDebugSignal,
  logRendererTodoToolDebug,
  summarizeItemsForTodoToolDebug,
  summarizeSnapshotForTodoToolDebug,
} from './todo-tool-debug';
import { findLatestAssistantTextFromItems } from './timeline-message';
import { sanitizeCanonicalUserText } from './message-helpers';
import { projectSessionMedia } from './media-projection';
import { syncViewportState } from './viewport-state';
import { useTaskSnapshotStore } from './task-snapshot-store';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeIdentifier,
} from '@/lib/session-trace';
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

function largeTextSignature(value: { contentRef: string; totalBytes: number; loadedBytes: number } | null | undefined): string {
  return value ? `${value.contentRef}:${value.loadedBytes}:${value.totalBytes}` : '';
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
    if (segment.kind === 'message') {
      return `${segment.kind}:${segment.key}:${hashText(segment.text)}:${largeTextSignature(segment.largeText)}`;
    }
    if (segment.kind === 'thinking') {
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
      toolPayloadSignature(segment.tool.input),
      hashText(segment.tool.inputText),
      toolPayloadSignature(segment.tool.output),
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
    toolPayloadSignature(tool.input),
    hashText(tool.inputText),
    toolPayloadSignature(tool.output),
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
      item.clientId ?? '',
      item.status ?? '',
      item.createdAt ?? '',
      item.updatedAt ?? '',
      hashText(item.text),
      largeTextSignature(item.largeText),
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
  return item.kind === 'user-message' && (item.status === 'pending' || item.status === 'sending');
}

function isAuthoritativeUserItem(item: SessionRenderItem): boolean {
  return item.kind === 'user-message' && !isPendingUserItem(item);
}

function buildUserConfirmationKeys(item: SessionRenderItem): string[] {
  if (item.kind !== 'user-message') {
    return [];
  }
  const keys: string[] = [];
  const clientId = item.clientId?.trim();
  if (clientId) {
    keys.push(`client:${clientId}`);
  }
  const messageId = item.messageId?.trim();
  if (messageId) {
    keys.push(`message:${messageId}`);
  }
  return keys;
}

function addStableUserKeys(keys: Set<string>, item: SessionRenderItem): void {
  if (item.kind !== 'user-message') {
    return;
  }
  keys.add(`key:${item.key}`);
  for (const confirmationKey of buildUserConfirmationKeys(item)) {
    keys.add(confirmationKey);
  }
}

function hasStableUserKey(keys: Set<string>, item: SessionRenderItem): boolean {
  if (item.kind !== 'user-message') {
    return false;
  }
  if (keys.has(`key:${item.key}`)) {
    return true;
  }
  return buildUserConfirmationKeys(item).some((confirmationKey) => keys.has(confirmationKey));
}

type UserConfirmationState = {
  authoritativeConfirmationKeys: Set<string>;
  newAuthoritativeUsers: SessionRenderItem[];
  newAuthoritativeIndexesByConfirmationKey: Map<string, number>;
  consumedNewAuthoritativeIndexes: Set<number>;
  nextSequentialNewAuthoritativeIndex: number;
};

function createUserConfirmationState(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
): UserConfirmationState {
  const currentAuthoritativeUserKeys = new Set<string>();
  for (const item of currentItems) {
    if (isAuthoritativeUserItem(item)) {
      addStableUserKeys(currentAuthoritativeUserKeys, item);
    }
  }

  const authoritativeConfirmationKeys = new Set<string>();
  const newAuthoritativeUsers: SessionRenderItem[] = [];
  const newAuthoritativeIndexesByConfirmationKey = new Map<string, number>();
  for (const item of nextItems) {
    if (!isAuthoritativeUserItem(item)) {
      continue;
    }
    const confirmationKeys = buildUserConfirmationKeys(item);
    for (const confirmationKey of confirmationKeys) {
      authoritativeConfirmationKeys.add(confirmationKey);
    }
    if (hasStableUserKey(currentAuthoritativeUserKeys, item)) {
      continue;
    }
    const newAuthoritativeIndex = newAuthoritativeUsers.length;
    newAuthoritativeUsers.push(item);
    for (const confirmationKey of confirmationKeys) {
      newAuthoritativeIndexesByConfirmationKey.set(confirmationKey, newAuthoritativeIndex);
    }
  }

  return {
    authoritativeConfirmationKeys,
    newAuthoritativeUsers,
    newAuthoritativeIndexesByConfirmationKey,
    consumedNewAuthoritativeIndexes: new Set<number>(),
    nextSequentialNewAuthoritativeIndex: 0,
  };
}

function userTextMatches(left: SessionRenderItem, right: SessionRenderItem): boolean {
  if (left.kind !== 'user-message' || right.kind !== 'user-message') {
    return false;
  }
  const leftText = sanitizeCanonicalUserText(left.text).trim();
  return leftText.length > 0 && leftText === sanitizeCanonicalUserText(right.text).trim();
}

function isUserConfirmedByAuthoritativeItems(
  pending: SessionRenderItem,
  confirmationState: UserConfirmationState,
): boolean {
  if (pending.kind !== 'user-message') {
    return false;
  }
  for (const confirmationKey of buildUserConfirmationKeys(pending)) {
    if (confirmationState.authoritativeConfirmationKeys.has(confirmationKey)) {
      const newAuthoritativeIndex = confirmationState.newAuthoritativeIndexesByConfirmationKey.get(confirmationKey);
      if (newAuthoritativeIndex !== undefined) {
        confirmationState.consumedNewAuthoritativeIndexes.add(newAuthoritativeIndex);
      }
      return true;
    }
  }

  while (confirmationState.consumedNewAuthoritativeIndexes.has(
    confirmationState.nextSequentialNewAuthoritativeIndex,
  )) {
    confirmationState.nextSequentialNewAuthoritativeIndex += 1;
  }
  const authoritative = confirmationState.newAuthoritativeUsers[
    confirmationState.nextSequentialNewAuthoritativeIndex
  ];
  if (!authoritative || !userTextMatches(authoritative, pending)) {
    return false;
  }
  confirmationState.consumedNewAuthoritativeIndexes.add(
    confirmationState.nextSequentialNewAuthoritativeIndex,
  );
  confirmationState.nextSequentialNewAuthoritativeIndex += 1;
  return true;
}

function dropReconciledOptimisticItems(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
): SessionRenderItem[] {
  const confirmationState = createUserConfirmationState(currentItems, nextItems);
  const pendingItems = currentItems.filter((item) => (
    isPendingUserItem(item)
      && !isUserConfirmedByAuthoritativeItems(item, confirmationState)
  ));
  if (pendingItems.length === 0) {
    return nextItems;
  }
  const pendingItemKeys = new Set(pendingItems.map((item) => item.key));
  const nextByKey = new Map(nextItems.map((item) => [item.key, item] as const));
  const emittedNextKeys = new Set<string>();
  const emittedPendingKeys = new Set<string>();
  const merged: SessionRenderItem[] = [];
  for (const currentItem of currentItems) {
    if (pendingItemKeys.has(currentItem.key)) {
      emittedPendingKeys.add(currentItem.key);
      merged.push(currentItem);
      continue;
    }
    const nextItem = nextByKey.get(currentItem.key);
    if (nextItem) {
      emittedNextKeys.add(nextItem.key);
      merged.push(nextItem);
    }
  }
  for (const pending of pendingItems) {
    if (!emittedPendingKeys.has(pending.key)) {
      merged.push(pending);
    }
  }
  for (const nextItem of nextItems) {
    if (!emittedNextKeys.has(nextItem.key)) {
      merged.push(nextItem);
    }
  }
  return merged;
}

export function reconcileSessionItems(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
): SessionRenderItem[] {
  if (currentItems === nextItems) {
    return currentItems;
  }
  const canonicalNextItems = dropReconciledOptimisticItems(currentItems, nextItems);
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
  const receiptConfirmationState = createUserConfirmationState(currentItems, canonicalNextItems);
  const preservedReceipts = currentItems.filter((item) => (
    item.kind === 'user-message'
    && item.rendererReceiptRunId
    && !canonicalNextItems.some((nextItem) => nextItem.key === item.key)
    && !isUserConfirmedByAuthoritativeItems(item, receiptConfirmationState)
    && canonicalNextItems.some((nextItem) => (
      (
        nextItem.kind === 'assistant-turn'
        && nextItem.runId === item.rendererReceiptRunId
      )
      || (
        nextItem.kind === 'user-message'
        && !nextItem.runId
        && nextItem.text === item.text
        && nextItem.createdAt === item.createdAt
      )
    ))
  ));
  if (preservedReceipts.length > 0) {
    changed = true;
  }

  return changed ? [...reconciled, ...preservedReceipts] : currentItems;
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
    endpointSessionId: null,
    runtimeScopeKey: null,
    agentId: null,
    protocolId: null,
    runtimeEndpointId: null,
    sessionIdentity: null,
    kind: null,
    preferred: false,
    label: null,
    titleSource: 'none',
    manualLabel: false,
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
  return left.endpointSessionId === right.endpointSessionId
    && left.runtimeScopeKey === right.runtimeScopeKey
    && left.agentId === right.agentId
    && (left.protocolId ?? null) === (right.protocolId ?? null)
    && (left.runtimeEndpointId ?? null) === (right.runtimeEndpointId ?? null)
    && sessionIdentitiesEquivalent(left.sessionIdentity, right.sessionIdentity)
    && left.kind === right.kind
    && left.preferred === right.preferred
    && left.label === right.label
    && left.titleSource === right.titleSource
    && (left.manualLabel === true) === (right.manualLabel === true)
    && left.displayName === right.displayName
    && left.model === right.model
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

function areSessionRuntimeEquivalent(left: ChatSessionRuntimeState, right: ChatSessionRuntimeState): boolean {
  return left.activeRunId === right.activeRunId
    && left.runPhase === right.runPhase
    && left.activeTurnItemKey === right.activeTurnItemKey
    && left.pendingTurnKey === right.pendingTurnKey
    && left.pendingTurnLaneKey === right.pendingTurnLaneKey
    && left.runtimeActivity === right.runtimeActivity
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

type ChatSessionRecordPatch = Partial<Omit<ChatSessionRecord, 'contextTokens'>> & {
  contextTokens?: SessionContextTokenSnapshot | null;
};

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
    contextTokens: Object.prototype.hasOwnProperty.call(patch, 'contextTokens')
      ? patch.contextTokens ?? undefined
      : current.contextTokens,
  };
  if (
    current.meta === nextRecord.meta
    && current.runtime === nextRecord.runtime
    && current.items === nextRecord.items
    && current.window === nextRecord.window
    && areSessionContextTokensEquivalent(current.contextTokens, nextRecord.contextTokens)
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
    kind: catalog.kind,
    preferred: catalog.preferred,
    label: nextLabel,
    titleSource: nextTitleSource,
    manualLabel: hasManualLabel,
    displayName: catalog.displayName ?? current.meta.displayName,
    model: catalog.model ?? current.meta.model ?? null,
    lastActivityAt: typeof catalog.updatedAt === 'number' ? toMs(catalog.updatedAt) : current.meta.lastActivityAt,
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

type SessionProjectionState = SessionView;
type SessionProjectionStore = Map<string, SessionProjectionState>;

const sessionProjectionByStore = new WeakMap<() => ChatStoreState, SessionProjectionStore>();
const sessionProjectionStores = new Set<SessionProjectionStore>();

function projectionStore(get: () => ChatStoreState): SessionProjectionStore {
  const existing = sessionProjectionByStore.get(get);
  if (existing) {
    return existing;
  }
  const created: SessionProjectionStore = new Map();
  sessionProjectionByStore.set(get, created);
  sessionProjectionStores.add(created);
  return created;
}

export type SessionProjectionApplyResult =
  | { status: 'applied'; sessionKey: string; epoch: number; seq: number; cursor: number }
  | { status: 'duplicate' | 'stale'; sessionKey: string; epoch: number; seq: number; cursor: number }
  | { status: 'gap' | 'epoch-mismatch' | 'unavailable'; sessionKey: string; reason: string };

type SessionProjectionApplyInput = {
  set: (partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState)) => void;
  get: () => ChatStoreState;
};

function factValue<T>(fact: SessionFact<T>): T | null {
  if (fact === 'unknown' || fact === 'unavailable') return null;
  if ('complete' in fact) return fact.complete;
  return fact.incomplete.facts;
}

function sessionIdentityForProjection(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  view: SessionView,
): SessionIdentity | null {
  if (!view.identity.agentId || view.identity.endpoint.kind !== 'native-runtime') return null;
  const identity = {
    endpoint: {
      kind: 'native-runtime' as const,
      runtimeAdapterId: view.identity.endpoint.runtimeAdapterId,
      runtimeInstanceId: view.identity.endpoint.runtimeInstanceId,
    },
    agentId: view.identity.agentId,
    sessionKey: view.identity.sessionKey,
  };
  const identityKey = buildSessionIdentityKey(identity);
  return Object.values(state.loadedSessions).find((record) => (
    record.meta.sessionIdentity && buildSessionIdentityKey(record.meta.sessionIdentity) === identityKey
  ))?.meta.sessionIdentity ?? identity;
}

function projectionRecordKey(
  state: Pick<ChatStoreState, 'sessionRecordKeyByIdentityKey'>,
  identity: SessionIdentity | null,
): string | null {
  if (!identity) return null;
  const identityKey = buildSessionIdentityKey(identity);
  return state.sessionRecordKeyByIdentityKey[identityKey] ?? identityKey;
}

function projectionRuntimePhase(phase: SessionWireRuntime['phase']): ChatSessionRuntimeState['runPhase'] {
  switch (phase) {
    case 'queued': return 'submitted';
    case 'started': return 'streaming';
    case 'waiting_for_approval': return 'waiting_tool';
    case 'cancellation_requested': return 'stopping';
    case 'cancelled': return 'aborted';
    case 'completed': return 'done';
    case 'failed':
    case 'interrupted': return 'error';
  }
}

function projectionItemStatus(status: SessionWireItem['status']): SessionAssistantTurnItem['status'] {
  switch (status) {
    case 'pending':
    case 'streaming': return 'streaming';
    case 'waiting_for_tool': return 'waiting_tool';
    case 'final': return 'final';
    case 'error': return 'error';
    case 'aborted': return 'aborted';
  }
}

function projectionToolCard(tool: SessionWireTool): SessionRenderToolCard {
  const status = tool.phase === 'failed'
    ? 'error'
    : tool.phase === 'completed' ? 'completed' : 'running';
  const summary = tool.summary ?? undefined;
  const input = tool.input ?? {};
  const inputText = tool.inputText ?? stringifyToolPayload(tool.input);
  const outputText = stringifyToolPayload(tool.output) ?? summary;
  return {
    id: tool.toolCallId,
    toolCallId: tool.toolCallId,
    name: tool.name ?? 'tool',
    displayTitle: tool.name ?? 'tool',
    input,
    ...(inputText ? { inputText } : {}),
    status,
    ...(summary ? { summary } : {}),
    ...(tool.output === null ? {} : { output: tool.output }),
    result: outputText
      ? { kind: tool.output === null ? 'text' : 'json', surface: 'tool-card', collapsedPreview: summary ?? outputText, bodyText: outputText }
      : { kind: 'none', surface: 'tool-card' },
  };
}

function stringifyToolPayload(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function toolPayloadSignature(value: unknown): string {
  return hashText(stringifyToolPayload(value));
}

function projectionMedia(content: SessionWireContent): { images: SessionRenderImage[]; attachedFiles: SessionRenderAttachedFile[] } {
  return projectSessionMedia(content);
}

function projectionLargeText(content: SessionWireContent) {
  return content.kind === 'largeText'
    ? { contentRef: content.contentRef, totalBytes: content.totalBytes, loadedBytes: content.loadedBytes }
    : undefined;
}

export function projectSessionViewItems(view: SessionView): SessionRenderItem[] {
  const items = factValue(view.items);
  if (!items) {
    return [];
  }
  const tools = factValue(view.tools) ?? [];
  const toolsById = new Map(tools.map((tool) => [tool.toolCallId, projectionToolCard(tool)] as const));
  return items.map((item) => {
    if (item.kind === 'userMessage') {
      const media = item.content.flatMap((content) => projectionMedia(content));
      const largeText = item.content.map(projectionLargeText).find(Boolean);
      return {
        key: item.itemId,
        kind: 'user-message',
        role: 'user',
        sessionKey: view.sessionKey,
        text: sanitizeCanonicalUserText(largeText ? item.content.find((content) => content.kind === 'largeText')!.text : item.text),
        images: media.flatMap((entry) => entry.images),
        attachedFiles: media.flatMap((entry) => entry.attachedFiles),
        ...(largeText ? { largeText } : {}),
        ...(item.messageId ? { messageId: item.messageId } : {}),
      };
    }
    if (item.kind === 'system') {
      return {
        key: item.itemId,
        kind: 'system',
        role: 'system',
        sessionKey: view.sessionKey,
        text: item.text,
        level: item.status === 'error' ? 'error' : item.status === 'aborted' ? 'warning' : 'info',
      };
    }
    const segments: SessionAssistantTurnSegment[] = [];
    let messageIndex = 0;
    let thinkingIndex = 0;
    let mediaIndex = 0;
    for (const [index, content] of item.segments.entries()) {
      if (content.kind === 'text') {
        segments.push({ kind: 'message', key: `${item.itemId}:message:${messageIndex++}`, text: content.text });
      } else if (content.kind === 'largeText') {
        segments.push({
          kind: 'message',
          key: `${item.itemId}:message:${messageIndex++}`,
          text: content.text,
          largeText: { contentRef: content.contentRef, totalBytes: content.totalBytes, loadedBytes: content.loadedBytes },
        });
      } else if (content.kind === 'thinking') {
        segments.push({ kind: 'thinking', key: `${item.itemId}:thinking:${thinkingIndex++}`, text: content.text });
      } else if (content.kind === 'media') {
        const media = projectionMedia(content);
        if (media.images.length || media.attachedFiles.length) {
          segments.push({ kind: 'media', key: `${item.itemId}:media:${mediaIndex++}`, ...media });
        }
      } else if (content.kind === 'toolUse' || content.kind === 'toolResult') {
        const tool = toolsById.get(content.toolCallId);
        if (tool) {
          segments.push({ kind: 'tool', key: `${item.itemId}:tool:${content.toolCallId}:${index}`, tool });
        }
      }
    }
    const toolSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'tool' }> => segment.kind === 'tool');
    const thinkingSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking');
    const messageSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message');
    const mediaSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media');
    return {
      key: item.itemId,
      kind: 'assistant-turn',
      role: 'assistant',
      sessionKey: view.sessionKey,
      identitySource: item.runId ? 'run' : 'message',
      identityMode: item.runId ? 'run' : 'message',
      identityConfidence: 'strong',
      status: projectionItemStatus(item.status),
      segments,
      thinking: thinkingSegments.length ? thinkingSegments.map((segment) => segment.text).join('\\n') : null,
      tools: toolSegments.map((segment) => segment.tool),
      text: messageSegments.length ? messageSegments.map((segment) => segment.text).join('') : item.text,
      images: mediaSegments.flatMap((segment) => segment.images),
      attachedFiles: mediaSegments.flatMap((segment) => segment.attachedFiles),
      ...(item.messageId ? { messageId: item.messageId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
    };
  });
}

function projectionRuntime(
  current: ChatSessionRuntimeState,
  fact: SessionFact<SessionWireRuntime>,
): ChatSessionRuntimeState {
  const runtime = factValue(fact);
  if (!runtime) return createEmptySessionRuntime();
  const issueMessage = runtime.issue === null ? null : `Session runtime ${runtime.issue}`;
  return {
    ...current,
    activeRunId: runtime.activeRunId,
    runPhase: projectionRuntimePhase(runtime.phase),
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    runtimeActivity: null,
    lastUserMessageAt: null,
    lastError: runtime.issue === 'rejected' ? issueMessage : null,
    lastIssue: issueMessage ? { message: issueMessage, source: 'runtime', at: Date.now(), retryable: runtime.issue !== 'rejected' } : null,
    updatedAt: Date.now(),
  };
}

function projectionWindow(current: ChatSessionViewportState, fact: SessionFact<SessionWireWindow>): ChatSessionViewportState {
  const window = factValue(fact);
  if (!window) return createEmptySessionViewportState();
  return syncViewportState(current, {
    ...window,
    isLoadingMore: false,
    isLoadingNewer: false,
    anchorItemKey: current.anchorItemKey,
  });
}

function nativeApprovalOptionIdToDecision(optionId: string): ApprovalItem['allowedDecisions'][number] | null {
  switch (optionId) {
    case 'allow':
    case 'allow-once':
    case 'allow_once':
      return 'allow-once';
    case 'allow-always':
    case 'allow_always':
      return 'allow-always';
    case 'deny':
    case 'deny-once':
    case 'reject-once':
    case 'reject_once':
      return 'deny';
    default:
      return null;
  }
}

function approvalOptionIdsToDecisions(optionIds: string[]): ApprovalItem['allowedDecisions'] {
  return optionIds
    .map(nativeApprovalOptionIdToDecision)
    .filter((decision): decision is ApprovalItem['allowedDecisions'][number] => decision != null);
}

function projectionApprovals(
  state: ChatStoreState,
  recordKey: string,
  view: SessionView,
): Record<string, ApprovalItem[]> {
  const fact = factValue(view.approvals);
  if (!fact) {
    return { ...state.pendingApprovalsBySession, [recordKey]: [] };
  }
  const identity = sessionIdentityForProjection(state, view);
  if (!identity) {
    return { ...state.pendingApprovalsBySession, [recordKey]: [] };
  }
  const endpointSessionId = view.endpointSessionId ?? state.loadedSessions[recordKey]?.meta.endpointSessionId;
  const approvals = fact
    .filter((approval) => approval.phase === 'requested')
    .map((approval) => ({
      id: approval.approvalId,
      sessionKey: recordKey,
      ...(endpointSessionId ? { endpointSessionId } : {}),
      sessionIdentity: identity,
      ...(approval.runId ? { runId: approval.runId } : {}),
      title: 'Approval required',
      allowedDecisions: approvalOptionIdsToDecisions(approval.optionIds),
      request: { optionIds: approval.optionIds },
      createdAtMs: Date.now(),
    }));
  return { ...state.pendingApprovalsBySession, [recordKey]: approvals };
}

function applyDecodedSessionView(
  input: SessionProjectionApplyInput,
  view: SessionView,
  epochChanged = false,
): boolean {
  const state = input.get();
  const identity = sessionIdentityForProjection(state, view);
  const recordKey = projectionRecordKey(state, identity);
  if (!recordKey) return false;
  if (epochChanged) {
    useTaskSnapshotStore.getState().reset(recordKey);
  }
  input.set((nextState) => {
    const current = getSessionRecord(nextState, recordKey);
    const nextIdentity = identity ?? current.meta.sessionIdentity;
    const nextMeta = nextIdentity ? {
      ...current.meta,
      runtimeScopeKey: buildRuntimeScopeKey(nextIdentity.endpoint),
      agentId: nextIdentity.agentId,
      protocolId: null,
      runtimeEndpointId: nextIdentity.endpoint.runtimeInstanceId,
      endpointSessionId: view.endpointSessionId,
      sessionIdentity: nextIdentity,
    } : current.meta;
    const nextItems = reconcileSessionItems(current.items, projectSessionViewItems(view));
    const nextRuntime = projectionRuntime(current.runtime, view.runtime);
    const nextWindow = projectionWindow(current.window, view.window);
    const loadedSessions = patchSessionRecord(nextState, recordKey, {
      meta: nextMeta,
      items: nextItems,
      runtime: nextRuntime,
      window: nextWindow,
    });
    const nextApprovals = projectionApprovals(nextState, recordKey, view);
    return {
      loadedSessions,
      sessionRecordKeyByIdentityKey: buildSessionIdentityRecordIndex(loadedSessions),
      pendingApprovalsBySession: nextApprovals,
    };
  });
  return true;
}

export function applySessionView(
  input: SessionProjectionApplyInput,
  view: SessionView,
): SessionProjectionApplyResult {
  if (view.sessionKey !== view.identity.sessionKey) {
    return { status: 'unavailable', sessionKey: view.sessionKey, reason: 'identity mismatch' };
  }
  const store = projectionStore(input.get);
  const previous = store.get(view.sessionKey);
  if (previous) {
    if (view.epoch < previous.epoch) {
      return { status: 'stale', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor };
    }
    if (view.epoch === previous.epoch) {
      if (view.cursor < previous.cursor || view.seq < previous.seq) {
        return { status: 'stale', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor };
      }
      if (view.cursor === previous.cursor && view.seq === previous.seq) {
        return { status: 'duplicate', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor };
      }
    }
  }
  const epochChanged = previous !== undefined && view.epoch > previous.epoch;
  if (!applyDecodedSessionView(input, view, epochChanged)) {
    return { status: 'unavailable', sessionKey: view.sessionKey, reason: 'session identity unavailable' };
  }
  store.set(view.sessionKey, view);
  return { status: 'applied', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor };
}

function updateProjectionFact<T>(
  fact: SessionFact<T>,
  seed: () => T,
  update: (facts: T) => T,
): SessionFact<T> {
  if (fact === 'unknown' || fact === 'unavailable') {
    return { incomplete: { facts: update(seed()), gaps: ['event_only'] } };
  }
  if ('complete' in fact) return { complete: update(fact.complete) };
  return { incomplete: { facts: update(fact.incomplete.facts), gaps: fact.incomplete.gaps } };
}

function isTerminalRunPhase(phase: SessionWireRuntime['phase']): boolean {
  return phase === 'completed'
    || phase === 'failed'
    || phase === 'cancelled'
    || phase === 'interrupted';
}

function applyProjectionChange(view: SessionView, change: SessionDelta['changes'][number]): SessionView {
  switch (change.kind) {
    case 'messageDelta':
      return { ...view, items: updateProjectionFact(view.items, () => [], (items) => {
        const next = [...items];
        const index = next.findIndex((item) => item.itemId === change.itemId);
        if (index >= 0) {
          const current = next[index];
          if (current.kind !== 'assistantTurn'
            || current.runId !== change.runId
            || current.messageId !== change.messageId) {
            return next;
          }
          const text = change.replace ? change.text : `${current.text}${change.text}`;
          next[index] = { ...current, status: change.status, text, segments: [{ kind: 'text', text }] };
        } else {
          next.push({
            kind: 'assistantTurn',
            itemId: change.itemId,
            runId: change.runId,
            messageId: change.messageId,
            status: change.status,
            segments: [{ kind: 'text', text: change.text }],
            text: change.text,
          });
        }
        return next;
      }) };
    case 'messageUpdated':
      return { ...view, items: updateProjectionFact(view.items, () => [], (items) => {
        const next = [...items];
        const index = next.findIndex((item) => item.itemId === change.item.itemId);
        if (index >= 0) next[index] = change.item;
        else next.push(change.item);
        return next;
      }) };
    case 'toolUpdated':
      return { ...view, tools: updateProjectionFact(view.tools, () => [], (tools) => {
        const next = [...tools];
        const index = next.findIndex((tool) => tool.toolCallId === change.tool.toolCallId);
        if (index >= 0) next[index] = change.tool;
        else next.push(change.tool);
        return next;
      }) };
    case 'approvalUpdated':
      return { ...view, approvals: updateProjectionFact(view.approvals, () => [], (approvals) => {
        const next = [...approvals];
        const index = next.findIndex((approval) => approval.approvalId === change.approval.approvalId);
        if (index >= 0) next[index] = change.approval;
        else next.push(change.approval);
        return next;
      }) };
    case 'runtimeChanged':
      return { ...view, runtime: updateProjectionFact(view.runtime, () => ({ phase: 'started', activeRunId: null, issue: null }), () => change.runtime) };
    case 'windowChanged':
      return { ...view, window: { incomplete: { facts: change.window, gaps: ['bounded_history'] } } };
    case 'runPhaseChanged':
      return { ...view, runtime: updateProjectionFact(view.runtime, (): SessionWireRuntime => ({ phase: 'started', activeRunId: null, issue: null }), (runtime) => ({
        ...runtime,
        phase: change.phase,
        activeRunId: isTerminalRunPhase(change.phase) ? null : change.runId,
      })) };
    case 'recoveryRequired':
      return { ...view, completeness: change.reason === 'native_unavailable' ? 'unavailable' : change.reason === 'native_unknown' ? 'unknown' : { incomplete: { missing: ['replay_cursor'] } } };
  }
}

export function applySessionDelta(
  input: SessionProjectionApplyInput,
  delta: SessionDelta,
): SessionProjectionApplyResult {
  const traceId = createSessionTraceId('session.delta.apply-boundary');
  const store = projectionStore(input.get);
  const previous = store.get(delta.sessionKey);
  logSessionTrace('session.delta.apply.start', traceId, {
    sessionKey: summarizeIdentifier(delta.sessionKey),
    incomingEpoch: delta.epoch,
    incomingSeq: delta.seq,
    incomingCursor: delta.cursor,
    previousEpoch: previous?.epoch ?? null,
    previousSeq: previous?.seq ?? null,
    previousCursor: previous?.cursor ?? null,
    changeKinds: delta.changes.map((change) => change.kind),
    runtimePhase: previous ? projectionRuntimePhase(factValue(previous.runtime)?.phase ?? 'started') : null,
    activeRunId: summarizeIdentifier(factValue(previous?.runtime ?? 'unknown')?.activeRunId),
  });
  if (!previous) {
    const historyReason = 'session_delta_without_view';
    void input.get().loadHistory({ sessionKey: delta.sessionKey, mode: 'quiet', scope: 'background', reason: historyReason });
    logSessionTrace('session.delta.history-load', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      reason: historyReason,
    });
    return { status: 'gap', sessionKey: delta.sessionKey, reason: 'missing SessionView' };
  }
  if (delta.epoch < previous.epoch) {
    return { status: 'stale', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor };
  }
  if (delta.epoch > previous.epoch) {
    const historyReason = 'session_delta_epoch_mismatch';
    void input.get().loadHistory({ sessionKey: delta.sessionKey, mode: 'quiet', scope: 'background', reason: historyReason });
    logSessionTrace('session.delta.history-load', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      reason: historyReason,
    });
    return { status: 'epoch-mismatch', sessionKey: delta.sessionKey, reason: 'epoch mismatch' };
  }
  if (delta.cursor < previous.cursor || delta.seq < previous.seq) {
    return { status: 'stale', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor };
  }
  if (delta.cursor === previous.cursor && delta.seq === previous.seq) {
    return { status: 'duplicate', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor };
  }
  if (delta.cursor !== previous.cursor + 1 || delta.seq !== previous.seq + 1) {
    const historyReason = 'session_delta_gap';
    void input.get().loadHistory({ sessionKey: delta.sessionKey, mode: 'quiet', scope: 'background', reason: historyReason });
    logSessionTrace('session.delta.history-load', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      reason: historyReason,
    });
    return { status: 'gap', sessionKey: delta.sessionKey, reason: `expected seq ${previous.seq + 1}, cursor ${previous.cursor + 1}` };
  }
  const nextView = delta.changes.reduce(applyProjectionChange, previous);
  const projected: SessionView = {
    ...nextView,
    seq: delta.seq,
    cursor: delta.cursor,
  };
  if (!applyDecodedSessionView(input, projected)) {
    return { status: 'unavailable', sessionKey: delta.sessionKey, reason: 'session identity unavailable' };
  }
  store.set(delta.sessionKey, projected);
  return { status: 'applied', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor };
}

export function resetSessionProjection(sessionKey: string): void {
  for (const store of sessionProjectionStores) {
    store.delete(sessionKey);
  }
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
