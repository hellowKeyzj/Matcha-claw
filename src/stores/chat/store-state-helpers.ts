import { buildRuntimeScopeKey, buildSessionIdentityRecordIndex } from './session-identity';
import { buildSessionRuntimeGraph } from './session-runtime-graph';
import {
  buildSessionIdentityKey,
  type SessionIdentity,
} from '../../types/desktop/runtime-address';
import { isRunActive } from './types';
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
import {
  deriveSessionImageGenerationPendingStateFromItems,
  type SessionAssistantTurnItem,
  type SessionExecutionGraphStep,
  type SessionRenderExecutionGraphItem,
  type SessionRenderItem,
  type SessionRenderSystemItem,
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
import { useTaskCenterStore } from '../task-center-store';
import { getCronSessionBaseKey } from './cron-session-utils';
import {
  createSessionTraceId,
  logSessionTrace,
  summarizeIdentifier,
  summarizeSessionIdentity,
  summarizeSessionChanges,
  summarizeWireItem,
  summarizeRenderItem,
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
    file.previewStatus ?? '',
    file.attachmentStatus ?? '',
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
      segment.tool.runtimeAdapterId ?? '',
      segment.tool.status,
      String(segment.tool.updatedAt ?? ''),
      String(segment.tool.durationMs ?? ''),
      toolPayloadSignature(segment.tool.input),
      hashText(segment.tool.inputText),
      toolPayloadSignature(segment.tool.output),
      toolPayloadSignature(segment.tool.details),
      hashText(segment.tool.summary),
      buildAssistantToolResultSignature(segment.tool.result),
    ].join(':');
  });

  const toolParts = item.tools.map((tool) => [
    tool.id,
    tool.toolCallId ?? '',
    tool.name,
    tool.runtimeAdapterId ?? '',
    tool.status,
    String(tool.updatedAt ?? ''),
    String(tool.durationMs ?? ''),
    toolPayloadSignature(tool.input),
    hashText(tool.inputText),
    toolPayloadSignature(tool.output),
    toolPayloadSignature(tool.details),
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

function reconcileRuntimeProjection(
  current: ChatSessionRuntimeState,
  next: ChatSessionRuntimeState,
): ChatSessionRuntimeState {
  const sameRun = current.activeRunId === next.activeRunId
    || (current.activeRunId === null && current.pendingTurnKey !== null);
  if (!sameRun || !isRunActive(next)) return next;
  const stopping = current.runPhase === 'stopping';
  const abortIssue = current.lastIssue?.code?.startsWith('chat.abort.') === true;
  if (!stopping && !abortIssue) return next;
  return {
    ...next,
    ...(stopping ? { runPhase: 'stopping' as const, updatedAt: current.updatedAt }
      : abortIssue && next.runPhase === 'stopping' ? { runPhase: current.runPhase } : {}),
    ...(next.activeRunId === null && current.pendingTurnKey !== null ? {
      pendingTurnKey: current.pendingTurnKey,
      pendingTurnLaneKey: current.pendingTurnLaneKey,
    } : {}),
    ...(abortIssue ? { lastError: current.lastError, lastIssue: current.lastIssue, updatedAt: current.updatedAt } : {}),
  };
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
  const nextRuntime = reconcileRuntimeProjection(current.runtime, {
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
  });
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

type SessionProjectionState = Omit<SessionView, 'modelState'> & {
  runtimeNotice?: ChatSessionRuntimeState['runtimeNotice'] | null;
  retiredItemIds?: ReadonlySet<string>;
  recordKey?: string;
};
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

const sessionWindowsByStore = new WeakMap<() => ChatStoreState, Map<string, SessionProjectionState>>();

function windowStore(get: () => ChatStoreState): Map<string, SessionProjectionState> {
  let store = sessionWindowsByStore.get(get);
  if (!store) {
    store = new Map();
    sessionWindowsByStore.set(get, store);
    sessionProjectionStores.add(store);
  }
  return store;
}

function displayRecordKey(state: ChatStoreState, identity: SessionIdentity): string {
  const baseKey = getCronSessionBaseKey(identity.sessionKey);
  if (baseKey && baseKey !== identity.sessionKey) {
    const baseIdentity = { ...identity, sessionKey: baseKey };
    const key = projectionRecordKey(state, baseIdentity)!;
    if (state.loadedSessions[key]) return key;
  }
  return projectionRecordKey(state, identity)!;
}

function displayProjectionKey(state: ChatStoreState, identity: SessionIdentity): string {
  const recordKey = displayRecordKey(state, identity);
  return buildSessionIdentityKey(state.loadedSessions[recordKey]?.meta.sessionIdentity ?? identity);
}

function mergeWireItems(current: SessionWireItem[], incoming: SessionWireItem[]): SessionWireItem[] {
  const incomingIds = new Set(incoming.map((item) => item.itemId));
  return [...current.filter((item) => !incomingIds.has(item.itemId)), ...incoming];
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

function summarizeWireAssistantTurn(item: SessionWireItem) {
  return summarizeWireItem(item);
}

function summarizeWireAssistantTurns(items: SessionWireItem[] | null | undefined) {
  if (!items) return null;
  return { itemCount: items.length, summarizedItemCount: Math.min(items.length, 200), truncated: items.length > 200,
    items: items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, ...summarizeWireAssistantTurn(item) })) };
}

function summarizeRenderAssistantTurns(items: SessionRenderItem[] | null | undefined) {
  if (!items) return null;
  return { itemCount: items.length, summarizedItemCount: Math.min(items.length, 200), truncated: items.length > 200,
    items: items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, ...summarizeRenderItem(item) })) };
}

function summarizeDeltaTurnChanges(changes: SessionDelta['changes']) {
  return summarizeSessionChanges(changes);
}

function shouldTraceDeltaTurnState(delta: SessionDelta): boolean {
  return delta.changes.some((change) => change.kind === 'messageUpdated' || change.kind === 'messageReplaced'
    || change.kind === 'messageDelta' || change.kind === 'itemsReplaced' || change.kind === 'toolUpdated'
    || change.kind === 'windowChanged' || change.kind === 'runtimeChanged' || change.kind === 'runPhaseChanged');
}

function sessionIdentityForProjection(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  view: SessionProjectionState,
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

function projectionToolCard(
  tool: SessionWireTool,
  runtimeAdapterId: SessionRenderToolCard['runtimeAdapterId'],
): SessionRenderToolCard {
  const status = tool.phase === 'failed'
    ? 'error'
    : tool.phase === 'completed' ? 'completed' : 'running';
  const summary = tool.summary ?? undefined;
  const input = tool.input ?? {};
  const inputText = tool.inputText ?? stringifyToolPayload(tool.input);
  const outputText = typeof tool.output === 'string' ? tool.output : stringifyToolPayload(tool.output) ?? summary;
  const resultKind = typeof tool.output === 'string' || tool.output === null ? 'text' : 'json';
  return {
    id: tool.toolCallId,
    toolCallId: tool.toolCallId,
    ...(tool.runId ? { runId: tool.runId } : {}),
    name: tool.name ?? 'tool',
    displayTitle: tool.name ?? 'tool',
    input,
    ...(inputText ? { inputText } : {}),
    status,
    ...(summary ? { summary } : {}),
    ...(runtimeAdapterId ? { runtimeAdapterId } : {}),
    ...(tool.output === null ? {} : { output: tool.output }),
    ...(tool.details == null ? {} : { details: tool.details }),
    result: outputText
      ? { kind: resultKind, surface: 'tool-card', collapsedPreview: summary ?? outputText, bodyText: outputText }
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

export function projectSessionViewItems(view: SessionProjectionState): SessionRenderItem[] {
  const items = factValue(view.items);
  if (!items) {
    return [];
  }
  const tools = factValue(view.tools) ?? [];
  const runtimeAdapterId = view.identity.endpoint.runtimeAdapterId;
  const toolsById = new Map(tools.map((tool) => [tool.toolCallId, projectionToolCard(tool, runtimeAdapterId)] as const));
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
      } else if (content.kind === 'media' || content.kind === 'omitted') {
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
    const tools = toolSegments.map((segment) => segment.tool);
    const thinkingSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking');
    const messageSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message');
    const mediaSegments = segments.filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media');
    const assistantTurn: SessionAssistantTurnItem = {
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
      tools,
      text: messageSegments.length ? messageSegments.map((segment) => segment.text).join('') : item.text,
      images: mediaSegments.flatMap((segment) => segment.images),
      attachedFiles: mediaSegments.flatMap((segment) => segment.attachedFiles),
      ...(item.messageId ? { messageId: item.messageId } : {}),
      ...(item.runId ? { runId: item.runId } : {}),
    };
    return assistantTurn;
  });
}

function projectionRuntime(
  current: ChatSessionRuntimeState,
  fact: SessionFact<SessionWireRuntime>,
  items: SessionRenderItem[],
  runtimeNotice: ChatSessionRuntimeState['runtimeNotice'],
  pendingTurnTerminated = false,
): ChatSessionRuntimeState {
  const runtime = factValue(fact);
  if (!runtime) return current;
  if (!pendingTurnTerminated && !isRunActive({ ...current, runPhase: projectionRuntimePhase(runtime.phase) })
    && isRunActive(current) && current.pendingTurnKey !== null && current.activeRunId === null) return current;
  const issueMessage = runtime.issue === null ? null : `Session runtime ${runtime.issue}`;
  const imageGeneration = deriveSessionImageGenerationPendingStateFromItems(items, current.imageGeneration);
  return reconcileRuntimeProjection(current, {
    ...current,
    activeRunId: runtime.activeRunId,
    runPhase: projectionRuntimePhase(runtime.phase),
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    runProgress: runtime.runProgress,
    runtimeActivity: runtime.runtimeActivity,
    errorDetail: runtime.errorDetail,
    runtimeNotice,
    imageGeneration: imageGeneration.active ? imageGeneration : undefined,
    lastUserMessageAt: null,
    lastError: runtime.issue === 'rejected' ? issueMessage : null,
    lastIssue: issueMessage ? { message: issueMessage, source: 'runtime', at: Date.now(), retryable: runtime.issue !== 'rejected' } : null,
    updatedAt: Date.now(),
  });
}

function projectionWindow(current: ChatSessionViewportState, fact: SessionFact<SessionWireWindow>): ChatSessionViewportState {
  const window = factValue(fact);
  if (!window) return current;
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
  view: SessionProjectionState,
): Record<string, ApprovalItem[]> {
  const fact = factValue(view.approvals);
  if (!fact) {
    return state.pendingApprovalsBySession;
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

function refreshSessionTasks(input: SessionProjectionApplyInput, view: SessionProjectionState, invalidate: boolean): void {
  const identity = sessionIdentityForProjection(input.get(), view);
  const recordKey = projectionRecordKey(input.get(), identity);
  if (!identity || !recordKey) return;
  void useTaskCenterStore.getState().refreshTasks({
    sessionKey: recordKey,
    sessionIdentity: identity,
    background: true,
    invalidate,
  }).catch(() => { /* The refresh owner logs failures and preserves the last snapshot. */ });
}

// Reads also restore the plugin's current plan after compaction; never parse their output.
const TASK_SNAPSHOT_TOOLS = new Set(['todowrite', 'todoget', 'taskcreate', 'taskupdate', 'tasklist', 'taskget']);

function isTaskToolTerminalTransition(tool: SessionWireTool, previous?: SessionWireTool): boolean {
  if (tool.phase !== 'completed' && tool.phase !== 'failed') return false;
  if (!TASK_SNAPSHOT_TOOLS.has((tool.name ?? previous?.name ?? '').trim().toLowerCase())) return false;
  return !previous || previous.runId !== tool.runId
    || (previous.phase !== 'completed' && previous.phase !== 'failed');
}

function applyDecodedSessionView(
  input: SessionProjectionApplyInput,
  view: SessionProjectionState,
  modelState?: SessionView['modelState'],
  display: SessionProjectionState = view,
  traceId?: string | null,
  timing?: { projectionElapsedMs: number; reconcileElapsedMs: number; traceEmitElapsedMs: number },
  pendingTurnTerminated = false,
): boolean {
  const state = input.get();
  const identity = sessionIdentityForProjection(state, view);
  const recordKey = identity ? displayRecordKey(state, identity) : null;
  if (!recordKey) return false;
  input.set((nextState) => {
    const current = getSessionRecord(nextState, recordKey);
    const nextIdentity = current.meta.sessionIdentity ?? identity;
    const nextMeta = nextIdentity ? {
      ...current.meta,
      runtimeScopeKey: buildRuntimeScopeKey(nextIdentity.endpoint),
      agentId: nextIdentity.agentId,
      protocolId: null,
      runtimeEndpointId: view.identity.endpoint.runtimeInstanceId,
      endpointSessionId: view.endpointSessionId,
      goal: view.goal,
      goalReadRevision: current.meta.goalReadRevision + (modelState !== undefined ? 1 : 0),
      modelState: current.meta.modelState?.overrideSource === 'user' ? current.meta.modelState : modelState ?? current.meta.modelState,
      ...(modelState !== undefined ? { ownership: view.ownership } : {}),
      sessionIdentity: nextIdentity,
    } : current.meta;
    const windows = windowStore(input.get);
    const displayKey = displayProjectionKey(nextState, view.identity);
    const projectionStartedAt = timing ? performance.now() : 0;
    let projectedItems = factValue(display.items) ? projectSessionViewItems(display) : current.items;
    if (pendingTurnTerminated) projectedItems = projectedItems.filter((item) => (
      item.kind !== 'assistant-turn' || item.key !== current.runtime.pendingTurnKey
    ));
    if (buildSessionIdentityKey(nextIdentity!) !== buildSessionIdentityKey(view.identity)) {
      const incomingIds = new Set(projectedItems.map((item) => item.key));
      const retiredIds = display.retiredItemIds ?? new Set<string>();
      projectedItems = [...current.items.filter((item) => !incomingIds.has(item.key) && !retiredIds.has(item.key)), ...projectedItems];
    }
    const reconcileStartedAt = timing ? performance.now() : 0;
    if (timing) timing.projectionElapsedMs += reconcileStartedAt - projectionStartedAt;
    const nextItems = reconcileSessionItems(current.items, projectedItems);
    const traceStartedAt = timing ? performance.now() : 0;
    if (timing) timing.reconcileElapsedMs += traceStartedAt - reconcileStartedAt;
    if (traceId) logSessionTrace('session.assembly.reconcile', traceId, {
      identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
      recordKey: summarizeIdentifier(recordKey), displayEpoch: display.epoch, displaySeq: display.seq, displayCursor: display.cursor,
      display: summarizeWireAssistantTurns(factValue(display.items)),
      before: summarizeRenderAssistantTurns(current.items), projected: summarizeRenderAssistantTurns(projectedItems),
      reconciled: summarizeRenderAssistantTurns(nextItems),
    });
    if (timing) timing.traceEmitElapsedMs += performance.now() - traceStartedAt;
    const nextRuntime = projectionRuntime(current.runtime, view.runtime, nextItems, view.runtimeNotice ?? null, pendingTurnTerminated);
    const pendingAssistant = current.items.find((item) => item.kind === 'assistant-turn' && item.key === current.runtime.pendingTurnKey);
    if (pendingAssistant && isRunActive(nextRuntime)
      && (pendingAssistant.status === 'streaming' || pendingAssistant.status === 'waiting_tool')
      && !view.retiredItemIds?.has(pendingAssistant.key) && !display.retiredItemIds?.has(pendingAssistant.key)
      && (pendingAssistant.runId ? pendingAssistant.runId === nextRuntime.activeRunId
        : nextRuntime.activeRunId === null && nextRuntime.pendingTurnKey === pendingAssistant.key)
      && !nextItems.some((item) => item.key === pendingAssistant.key
        || item.kind === 'assistant-turn' && item.runId && item.runId === nextRuntime.activeRunId)) nextItems.push(pendingAssistant);
    const placeholderTraceStartedAt = timing ? performance.now() : 0;
    if (traceId) logSessionTrace('session.assembly.placeholder.after', traceId, {
      identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
      pendingItemHash: summarizeIdentifier(pendingAssistant?.key).hash, pendingTurnHash: summarizeIdentifier(current.runtime.pendingTurnKey).hash,
      items: summarizeRenderAssistantTurns(nextItems),
    });
    if (timing) timing.traceEmitElapsedMs += performance.now() - placeholderTraceStartedAt;
    const nextWindow = projectionWindow(current.window, display.window);
    windows.set(displayKey, { ...display, recordKey });
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
      ...(nextState.sessionRuntimeCatalog ? { sessionRuntimeGraph: buildSessionRuntimeGraph(nextState.sessionRuntimeCatalog, loadedSessions) } : {}),
      pendingApprovalsBySession: nextApprovals,
    };
  });
  return true;
}

export function applySessionView(
  input: SessionProjectionApplyInput,
  view: SessionView,
  options: { windowOnly?: boolean; direction?: 'older' | 'newer' | 'latest' } = {},
): SessionProjectionApplyResult {
  const traceId = createSessionTraceId('session.view.apply-boundary');
  const timing = traceId ? { projectionElapsedMs: 0, reconcileElapsedMs: 0, traceEmitElapsedMs: 0 } : undefined;
  const beforeTraceStartedAt = traceId ? performance.now() : 0;
  let applyStartedAt = 0;
  let beforeTraceEmitElapsedMs = 0;
  const finish = (result: SessionProjectionApplyResult): SessionProjectionApplyResult => {
    if (traceId && timing) {
      const applyElapsedMs = performance.now() - applyStartedAt - timing.traceEmitElapsedMs;
      const summaryStartedAt = performance.now();
      const payload = {
        identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
        windowOnly: !!options.windowOnly, direction: options.direction ?? null, status: result.status,
        reason: 'reason' in result ? summarizeIdentifier(result.reason) : result.status === 'stale' ? 'older-watermark' : result.status === 'duplicate' ? 'same-watermark' : null,
        items: summarizeRenderAssistantTurns(getSessionRecord(input.get(), displayRecordKey(input.get(), view.identity)).items),
      };
      logSessionTrace('session.view.apply.result', traceId, {
        ...payload, applyElapsedMs, projectionElapsedMs: timing.projectionElapsedMs, reconcileElapsedMs: timing.reconcileElapsedMs,
        traceEmitElapsedMsBeforeResult: beforeTraceEmitElapsedMs + timing.traceEmitElapsedMs,
        resultSummaryElapsedMs: performance.now() - summaryStartedAt,
      });
    }
    return result;
  };
  if (traceId) logSessionTrace('session.view.apply.before', traceId, {
    identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
    windowOnly: !!options.windowOnly, direction: options.direction ?? null,
    incoming: summarizeWireAssistantTurns(factValue(view.items)),
    before: summarizeRenderAssistantTurns(getSessionRecord(input.get(), displayRecordKey(input.get(), view.identity)).items),
  });
  if (traceId) {
    applyStartedAt = performance.now();
    beforeTraceEmitElapsedMs = applyStartedAt - beforeTraceStartedAt;
  }
  if (view.sessionKey !== view.identity.sessionKey) {
    return finish({ status: 'unavailable', sessionKey: view.sessionKey, reason: 'identity mismatch' });
  }
  const identity = sessionIdentityForProjection(input.get(), view);
  const recordKey = identity ? displayRecordKey(input.get(), identity) : null;
  if (!recordKey) {
    return finish({ status: 'unavailable', sessionKey: view.sessionKey, reason: 'session identity unavailable' });
  }
  const store = projectionStore(input.get);
  const projectionKey = buildSessionIdentityKey(view.identity);
  const previous = store.get(projectionKey);
  if (options.windowOnly) {
    const items = factValue(view.items);
    const window = factValue(view.window);
    if (!items || !window) return finish({ status: 'unavailable', sessionKey: recordKey, reason: 'window unavailable' });
    if (previous && (view.epoch < previous.epoch || options.direction === 'latest' && view.epoch === previous.epoch
      && (view.seq < previous.seq || view.cursor < previous.cursor))) {
      return finish({ status: 'stale', sessionKey: recordKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
    }
    const currentItems = new Map((previous ? factValue(previous.items) : [])?.map((item) => [item.itemId, item]) ?? []);
    const preserveLive = previous && view.epoch === previous.epoch && (view.seq <= previous.seq || view.cursor <= previous.cursor);
    const display: SessionProjectionState = {
      ...view,
      items: { complete: items.filter((item) => !preserveLive || !previous.retiredItemIds?.has(item.itemId))
        .map((item) => preserveLive ? currentItems.get(item.itemId) ?? item : item) },
      tools: preserveLive ? { complete: [...new Map([...(factValue(view.tools) ?? []), ...(factValue(previous.tools) ?? [])]
        .map((tool) => [tool.toolCallId, tool])).values()] } : view.tools,
      recordKey,
    };
    windowStore(input.get).set(displayProjectionKey(input.get(), view.identity), display);
    input.set((state) => {
      const current = getSessionRecord(state, recordKey);
      const projectionStartedAt = timing ? performance.now() : 0;
      const projectedItems = projectSessionViewItems(display);
      const reconcileStartedAt = timing ? performance.now() : 0;
      if (timing) timing.projectionElapsedMs += reconcileStartedAt - projectionStartedAt;
      const items = reconcileSessionItems(current.items, projectedItems);
      const traceStartedAt = timing ? performance.now() : 0;
      if (timing) timing.reconcileElapsedMs += traceStartedAt - reconcileStartedAt;
      if (traceId) logSessionTrace('session.view.window.assembly', traceId, {
        identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
        direction: options.direction ?? null, preserveLive: !!preserveLive,
        display: summarizeWireAssistantTurns(factValue(display.items)), before: summarizeRenderAssistantTurns(current.items),
        projected: summarizeRenderAssistantTurns(projectedItems), reconciled: summarizeRenderAssistantTurns(items),
      });
      if (timing) timing.traceEmitElapsedMs += performance.now() - traceStartedAt;
      return { loadedSessions: patchSessionRecord(state, recordKey, {
        items,
        window: projectionWindow(current.window, view.window),
      }) };
    });
    return finish({ status: 'applied', sessionKey: recordKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
  }
  if (previous) {
    if (view.epoch < previous.epoch) {
      return finish({ status: 'stale', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
    }
    if (view.epoch === previous.epoch) {
      if (view.cursor < previous.cursor || view.seq < previous.seq) {
        return finish({ status: 'stale', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      }
      if (view.cursor === previous.cursor && view.seq === previous.seq) {
        input.set((state) => {
          const current = getSessionRecord(state, recordKey);
          const loadedSessions = patchSessionMeta(state, recordKey, {
            ownership: view.ownership,
            goal: view.goal,
            goalReadRevision: current.meta.goalReadRevision + 1,
            modelState: current.meta.modelState?.overrideSource === 'user' ? current.meta.modelState : view.modelState ?? current.meta.modelState,
          });
          return loadedSessions === state.loadedSessions ? state : {
            loadedSessions,
            ...(state.sessionRuntimeCatalog ? { sessionRuntimeGraph: buildSessionRuntimeGraph(state.sessionRuntimeCatalog, loadedSessions) } : {}),
          };
        });
        refreshSessionTasks(input, view, false);
        return finish({ status: 'duplicate', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      }
    }
  }
  const { modelState, ...facts } = view;
  const retiredItemIds = new Set(view.epoch === previous?.epoch ? previous.retiredItemIds : undefined);
  factValue(view.items)?.forEach((item) => retiredItemIds.delete(item.itemId));
  const projection: SessionProjectionState = { ...facts, recordKey, retiredItemIds };
  const windows = windowStore(input.get);
  const loaded = windows.get(displayProjectionKey(input.get(), view.identity));
  const reading = loaded && loaded.epoch === projection.epoch
    && buildSessionIdentityKey(loaded.identity) === projectionKey
    && !input.get().loadedSessions[recordKey]?.window.isAtLatest;
  let display = reading ? reconcileReadingWindow(loaded, projection) : projection;
  if (loaded && projectionKey !== displayProjectionKey(input.get(), view.identity)) {
    const previousIds = new Set((previous ? factValue(previous.items) : [])?.map((item) => item.itemId) ?? []);
    const retained = (factValue(loaded.items) ?? []).filter((item) => !previousIds.has(item.itemId));
    display = {
      ...projection,
      items: factValue(view.items) ? { complete: mergeWireItems(retained, factValue(view.items)!) } : loaded.items,
      tools: { complete: [...new Map([...(factValue(loaded.tools) ?? []), ...(factValue(view.tools) ?? [])]
        .map((tool) => [tool.toolCallId, tool])).values()] },
      window: loaded.window,
    };
  }
  if (!reading && projectionKey === displayProjectionKey(input.get(), view.identity)) {
    for (const [key, run] of store) {
      if (key === projectionKey || getCronSessionBaseKey(run.identity.sessionKey) !== view.sessionKey
        || buildSessionIdentityKey({ ...run.identity, sessionKey: view.sessionKey }) !== projectionKey) continue;
      const retained = (factValue(display.items) ?? []).filter((item) => !run.retiredItemIds?.has(item.itemId));
      display = {
        ...display,
        items: { complete: mergeWireItems(retained, factValue(run.items) ?? []) },
        tools: { complete: [...new Map([...(factValue(display.tools) ?? []), ...(factValue(run.tools) ?? [])]
          .map((tool) => [tool.toolCallId, tool])).values()] },
      };
    }
  }
  store.set(projectionKey, projection);
  if (!applyDecodedSessionView(input, projection, modelState, display, traceId, timing)) {
    return finish({ status: 'unavailable', sessionKey: view.sessionKey, reason: 'session identity unavailable' });
  }
  refreshSessionTasks(input, view, true);
  return finish({ status: 'applied', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
}

function reconcileReadingWindow(
  loaded: SessionProjectionState,
  projected: SessionProjectionState,
  previous?: SessionProjectionState,
  change?: SessionDelta['changes'][number],
): SessionProjectionState {
  const incoming = new Map((factValue(projected.items) ?? []).map((item) => [item.itemId, item]));
  const updated = change?.kind === 'messageDelta' && factValue(loaded.items)?.some((item) => item.itemId === change.itemId)
    ? applyProjectionChange(loaded, change).items : loaded.items;
  const items = updateProjectionFact<SessionWireItem[]>(updated, () => [], (items) => {
    if (change?.kind === 'messageDelta') return items;
    if (change?.kind !== 'itemsReplaced') return items.map((item) => incoming.get(item.itemId) ?? item);
    const oldIds = new Set(change.oldItemIds);
    const removedIds = new Set([...oldIds, ...change.items.map((item) => item.itemId)]);
    const canonical = factValue(previous?.items ?? 'unknown') ?? [];
    const anchor = change.anchor;
    const start = anchor.kind === 'start' ? 0 : canonical.findIndex((item) => item.itemId === anchor.itemId) + 1;
    let end = start;
    while (end < canonical.length && removedIds.has(canonical[end].itemId)) end += 1;
    const slot = canonical.slice(start, end);
    const index = slot.length ? items.findIndex((item) => item.itemId === slot[0].itemId) : -1;
    const slotIds = new Set(slot.map((item) => item.itemId));
    // Canonical anchors are not page anchors; only a complete existing slot can change identity.
    const replaceSlot = index >= 0 && slot.every((item, offset) => items[index + offset]?.itemId === item.itemId)
      && !items.some((item) => removedIds.has(item.itemId) && !oldIds.has(item.itemId) && !slotIds.has(item.itemId));
    if (replaceSlot) {
      const remainingCount = items.filter((item) => !removedIds.has(item.itemId)).length;
      if (remainingCount + change.items.length > 200) return items;
      const next = items.filter((item) => !removedIds.has(item.itemId));
      const position = items.slice(0, index).filter((item) => !removedIds.has(item.itemId)).length;
      next.splice(position, 0, ...change.items);
      return next;
    }
    return items.filter((item) => !oldIds.has(item.itemId) || incoming.has(item.itemId))
      .map((item) => incoming.get(item.itemId) ?? item);
  });
  const toolIds = new Set((factValue(items) ?? []).flatMap((item) => item.kind === 'assistantTurn'
    ? item.segments.flatMap((segment) => segment.kind === 'toolUse' || segment.kind === 'toolResult' ? [segment.toolCallId] : []) : []));
  const incomingTools = new Map((factValue(projected.tools) ?? []).map((tool) => [tool.toolCallId, tool]));
  const tools = updateProjectionFact<SessionWireTool[]>(loaded.tools, () => [], (tools) => {
    const next = tools.filter((tool) => toolIds.has(tool.toolCallId)).map((tool) => incomingTools.get(tool.toolCallId) ?? tool);
    const existing = new Set(next.map((tool) => tool.toolCallId));
    for (const tool of incomingTools.values()) {
      if (toolIds.has(tool.toolCallId) && !existing.has(tool.toolCallId)) next.push(tool);
    }
    return next;
  });
  if ((factValue(tools)?.length ?? 0) > 128) return { ...projected, items: loaded.items, tools: loaded.tools, window: loaded.window };
  return { ...projected, items, tools, window: loaded.window };
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

function runtimeNoticeAfterRuntimeChange(
  notice: ChatSessionRuntimeState['runtimeNotice'],
  runtime: SessionWireRuntime,
): ChatSessionRuntimeState['runtimeNotice'] {
  if (!notice || runtime.activeRunId !== notice.runId || isTerminalRunPhase(runtime.phase)) return null;
  return notice;
}

function runtimeNoticeAfterRunPhaseChange(
  notice: ChatSessionRuntimeState['runtimeNotice'],
  runId: string,
  phase: SessionWireRuntime['phase'],
): ChatSessionRuntimeState['runtimeNotice'] {
  if (!notice) return null;
  if (notice.runId === runId) return isTerminalRunPhase(phase) ? null : notice;
  return isTerminalRunPhase(phase) ? notice : null;
}

function applyProjectionChange(view: SessionProjectionState, change: SessionDelta['changes'][number]): SessionProjectionState {
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
    case 'messageReplaced':
      return { ...view, items: updateProjectionFact(view.items, () => [], (items) => {
        const next = [...items];
        let index = next.findIndex((item) => item.itemId === change.item.itemId);
        if (index < 0 && change.item.kind === 'assistantTurn' && change.item.runId !== null) {
          const incoming = change.item;
          index = next.findIndex((item) => item.kind === 'assistantTurn' && item.runId === incoming.runId
            && item.messageId === null && item.text.length === 0 && item.segments.length > 0
            && item.segments.every((segment) => segment.kind === 'toolUse' || segment.kind === 'toolResult'));
        }
        if (index < 0) next.push(change.item);
        else next[index] = change.item;
        return next;
      }) };
    case 'itemsReplaced': {
      const oldIds = new Set(change.oldItemIds);
      const incomingIds = new Set(change.items.map((item) => item.itemId));
      const anchor = change.anchor;
      if (oldIds.size !== change.oldItemIds.length || incomingIds.size !== change.items.length
        || change.oldItemIds.length > 200 || change.items.length > 200
        || anchor.kind === 'after' && (oldIds.has(anchor.itemId) || incomingIds.has(anchor.itemId))) {
        throw new Error('invalid replacement');
      }
      const items = updateProjectionFact(view.items, () => [], (items) => {
        const remaining = items.filter((item) => !oldIds.has(item.itemId) && !incomingIds.has(item.itemId));
        const index = anchor.kind === 'start' ? 0 : remaining.findIndex((item) => item.itemId === anchor.itemId) + 1;
        if (anchor.kind === 'after' && index === 0) throw new Error('replacement anchor missing');
        if (remaining.length + change.items.length > 200) throw new Error('invalid replacement');
        remaining.splice(index, 0, ...change.items);
        return remaining;
      });
      const retiredItemIds = new Set(view.retiredItemIds);
      oldIds.forEach((id) => retiredItemIds.add(id));
      incomingIds.forEach((id) => retiredItemIds.delete(id));
      return { ...view, items, retiredItemIds };
    }
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
    case 'goalChanged':
      return { ...view, goal: change.goal };
    case 'runtimeChanged':
      return {
        ...view,
        runtime: updateProjectionFact(view.runtime, () => ({ phase: 'started', activeRunId: null, issue: null, runProgress: null, runtimeActivity: null, errorDetail: null }), () => change.runtime),
        runtimeNotice: runtimeNoticeAfterRuntimeChange(view.runtimeNotice ?? null, change.runtime),
      };
    case 'runtimeNoticeUpdated':
      return { ...view, runtimeNotice: change.notice };
    case 'windowChanged':
      return { ...view, window: { incomplete: { facts: change.window, gaps: ['bounded_history'] } } };
    case 'runPhaseChanged':
      return {
        ...view,
        runtime: updateProjectionFact(view.runtime, (): SessionWireRuntime => ({ phase: 'started', activeRunId: null, issue: null, runProgress: null, runtimeActivity: null, errorDetail: null }), (runtime) => (
          isTerminalRunPhase(change.phase) && runtime.activeRunId !== null && runtime.activeRunId !== change.runId
            ? runtime
            : {
                ...runtime,
                phase: change.phase,
                activeRunId: isTerminalRunPhase(change.phase) ? null : change.runId,
                runProgress: null,
                runtimeActivity: null,
                errorDetail: null,
              }
        )),
        runtimeNotice: runtimeNoticeAfterRunPhaseChange(view.runtimeNotice ?? null, change.runId, change.phase),
      };
    case 'recoveryRequired':
      return { ...view, completeness: change.reason === 'native_unavailable' ? 'unavailable' : change.reason === 'native_unknown' ? 'unknown' : { incomplete: { missing: ['replay_cursor'] } } };
  }
}

export function applySessionDelta(
  input: SessionProjectionApplyInput,
  delta: SessionDelta,
): SessionProjectionApplyResult {
  const traceId = createSessionTraceId('session.delta.apply-boundary');
  const finish = (result: SessionProjectionApplyResult): SessionProjectionApplyResult => {
    if (traceId) logSessionTrace('session.delta.apply.result', traceId, {
      identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor,
      status: result.status, reason: 'reason' in result ? summarizeIdentifier(result.reason) : result.status === 'stale' ? 'older-watermark' : result.status === 'duplicate' ? 'same-watermark' : null,
    });
    return result;
  };
  const store = projectionStore(input.get);
  const state = input.get();
  if (delta.identity.sessionKey !== delta.sessionKey) return finish({ status: 'unavailable', sessionKey: delta.sessionKey, reason: 'identity mismatch' });
  const projectionKey = buildSessionIdentityKey(delta.identity);
  const recordKey = displayRecordKey(state, delta.identity);
  let previous = store.get(projectionKey);
  if (!previous && delta.seq === 1 && delta.cursor === 1) {
    previous = { sessionKey: delta.sessionKey, identity: delta.identity, endpointSessionId: state.loadedSessions[recordKey]?.meta.endpointSessionId ?? null, ownership: state.loadedSessions[recordKey]?.meta.ownership ?? null, goal: { kind: 'unknown' }, epoch: delta.epoch, seq: 0, cursor: 0, items: 'unknown', tools: 'unknown', approvals: 'unknown', runtime: 'unknown', window: 'unknown', completeness: { incomplete: { missing: ['event_only'] } } };
  }
  const traceTurnState = !!traceId && shouldTraceDeltaTurnState(delta);
  const traceRuntimeState = traceId && delta.changes.some((change) => (
    change.kind === 'runtimeChanged'
    || (change.kind === 'runPhaseChanged' && isTerminalRunPhase(change.phase))
  ));
  if (traceId) logSessionTrace('session.delta.apply.start', traceId, {
    identity: summarizeSessionIdentity(delta.identity),
    recordKey: summarizeIdentifier(recordKey),
    sessionKey: summarizeIdentifier(delta.sessionKey),
    incomingEpoch: delta.epoch,
    incomingSeq: delta.seq,
    incomingCursor: delta.cursor,
    previousEpoch: previous?.epoch ?? null,
    previousSeq: previous?.seq ?? null,
    previousCursor: previous?.cursor ?? null,
    changeKinds: delta.changes.map((change) => change.kind),
    previousRuntimePhase: previous ? projectionRuntimePhase(factValue(previous.runtime)?.phase ?? 'started') : null,
    previousActiveRunId: summarizeIdentifier(factValue(previous?.runtime ?? 'unknown')?.activeRunId),
    ...(traceRuntimeState ? {
      incomingRuntimePhases: delta.changes
        .filter((change) => change.kind === 'runtimeChanged' || change.kind === 'runPhaseChanged')
        .map((change) => ({
          kind: change.kind,
          phase: change.kind === 'runtimeChanged' ? change.runtime.phase : change.phase,
          runId: summarizeIdentifier(change.kind === 'runtimeChanged' ? change.runtime.activeRunId : change.runId),
        })),
    } : {}),
  });
  if (traceTurnState) {
    logSessionTrace('session.delta.apply.turns.before', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      seq: delta.seq,
      cursor: delta.cursor,
      delta: summarizeDeltaTurnChanges(delta.changes),
      projectionTurns: summarizeWireAssistantTurns(previous ? factValue(previous.items) : null),
      identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch,
      displayTurns: summarizeWireAssistantTurns(factValue(windowStore(input.get).get(displayProjectionKey(state, delta.identity))?.items ?? 'unknown')),
      renderTurns: summarizeRenderAssistantTurns(getSessionRecord(state, recordKey).items),
    });
  }
  if (!previous) {
    const historyReason = 'session_delta_without_view';
    if (traceId) logSessionTrace('session.delta.recovery-required', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      reason: historyReason,
    });
    return finish({ status: 'gap', sessionKey: delta.sessionKey, reason: 'missing SessionView' });
  }
  if (delta.epoch < previous.epoch) {
    return finish({ status: 'stale', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
  }
  const epochChanged = delta.epoch > previous.epoch;
  if (epochChanged && (delta.cursor !== 1 || delta.seq !== 1)) {
    const historyReason = 'session_delta_epoch_gap';
    if (traceId) logSessionTrace('session.delta.recovery-required', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      reason: historyReason,
    });
    return finish({ status: 'gap', sessionKey: delta.sessionKey, reason: 'new epoch delta did not start at seq 1, cursor 1' });
  }
  if (!epochChanged) {
    if (delta.cursor < previous.cursor || delta.seq < previous.seq) {
      return finish({ status: 'stale', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
    }
    if (delta.cursor === previous.cursor && delta.seq === previous.seq) {
      return finish({ status: 'duplicate', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
    }
    if (delta.cursor !== previous.cursor + 1 || delta.seq !== previous.seq + 1) {
      const historyReason = 'session_delta_gap';
      if (traceId) logSessionTrace('session.delta.recovery-required', traceId, {
        sessionKey: summarizeIdentifier(delta.sessionKey),
        reason: historyReason,
      });
      return finish({ status: 'gap', sessionKey: delta.sessionKey, reason: `expected seq ${previous.seq + 1}, cursor ${previous.cursor + 1}` });
    }
  }
  let tasksChanged = epochChanged;
  const windows = windowStore(input.get);
  const displayKey = displayProjectionKey(state, delta.identity);
  const loaded = windows.get(displayKey);
  const reading = loaded && !epochChanged && loaded.epoch === delta.epoch
    && buildSessionIdentityKey(loaded.identity) === projectionKey
    && !state.loadedSessions[recordKey]?.window.isAtLatest;
  let readingDisplay = loaded;
  let nextView: SessionProjectionState;
  try {
    nextView = delta.changes.reduce((view, change) => {
    if (change.kind === 'toolUpdated'
      && (change.tool.phase === 'completed' || change.tool.phase === 'failed')
      && (change.tool.name === null || TASK_SNAPSHOT_TOOLS.has(change.tool.name.trim().toLowerCase()))
      && isTaskToolTerminalTransition(
        change.tool,
        factValue(view.tools)?.find((tool) => tool.toolCallId === change.tool.toolCallId),
      )) tasksChanged = true;
    if (change.kind === 'recoveryRequired') tasksChanged = true;
    const projected = applyProjectionChange(view, change);
    if (reading && readingDisplay) readingDisplay = reconcileReadingWindow(readingDisplay, projected, view, change);
    return projected;
    }, { ...previous, epoch: delta.epoch });
  } catch (error) {
    return finish({ status: 'gap', sessionKey: recordKey, reason: error instanceof Error ? error.message : 'invalid replacement' });
  }
  const projected: SessionProjectionState = {
    ...nextView,
    epoch: delta.epoch,
    seq: delta.seq,
    cursor: delta.cursor,
  };
  let display = projected;
  if (reading && readingDisplay) {
    display = { ...readingDisplay, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor };
  } else if (loaded && !epochChanged && buildSessionIdentityKey(loaded.identity) !== projectionKey) {
    try {
      display = delta.changes.reduce((view, change) => applyProjectionChange(view, change), loaded);
      display = { ...display, runtime: projected.runtime, approvals: projected.approvals, runtimeNotice: projected.runtimeNotice };
      if (!state.loadedSessions[recordKey]?.window.isAtLatest) display = { ...display, window: loaded.window };
    } catch (error) {
      return finish({ status: 'gap', sessionKey: recordKey, reason: error instanceof Error ? error.message : 'invalid replacement' });
    }
  }
  const currentRecord = state.loadedSessions[recordKey];
  const pendingTurnTerminated = currentRecord?.meta.sessionIdentity != null
    && buildSessionIdentityKey(currentRecord.meta.sessionIdentity) === projectionKey
    && delta.changes.some((change) => change.kind === 'runPhaseChanged' && isTerminalRunPhase(change.phase)
      && (currentRecord.runtime.activeRunId === null || currentRecord.runtime.activeRunId === change.runId)
      && currentRecord.runtime.pendingTurnKey === `renderer-assistant:${change.runId}`);
  store.set(projectionKey, { ...projected, recordKey });
  if (!applyDecodedSessionView(input, projected, undefined, display, traceId, undefined, pendingTurnTerminated)) {
    return finish({ status: 'unavailable', sessionKey: delta.sessionKey, reason: 'session identity unavailable' });
  }
  if (traceRuntimeState) {
    const appliedState = input.get();
    const recordKey = projectionRecordKey(appliedState, sessionIdentityForProjection(appliedState, projected));
    const appliedRuntime = recordKey ? appliedState.loadedSessions[recordKey]?.runtime : null;
    logSessionTrace('session.delta.apply.runtime.after', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      seq: delta.seq,
      cursor: delta.cursor,
      projectionPhase: factValue(projected.runtime)?.phase ?? null,
      projectionActiveRunId: summarizeIdentifier(factValue(projected.runtime)?.activeRunId),
      runtimePhase: appliedRuntime?.runPhase ?? null,
      activeRunId: summarizeIdentifier(appliedRuntime?.activeRunId),
    });
  }
  if (traceTurnState) {
    logSessionTrace('session.delta.apply.turns.after', traceId, {
      sessionKey: summarizeIdentifier(delta.sessionKey),
      seq: delta.seq,
      cursor: delta.cursor,
      projectionTurns: summarizeWireAssistantTurns(factValue(projected.items)),
      identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch,
      displayTurns: summarizeWireAssistantTurns(factValue(display.items)),
      renderTurns: summarizeRenderAssistantTurns(getSessionRecord(input.get(), recordKey).items),
    });
  }
  if (tasksChanged) refreshSessionTasks(input, projected, true);
  return finish({ status: 'applied', sessionKey: recordKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
}

export function resetSessionProjection(sessionKey: string): void {
  for (const store of sessionProjectionStores) {
    const identities = new Set([...store].filter(([key, view]) => key === sessionKey || view.recordKey === sessionKey)
      .map(([, view]) => buildSessionIdentityKey(view.identity)));
    for (const [key, view] of store) {
      const baseKey = getCronSessionBaseKey(view.identity.sessionKey);
      const baseIdentityKey = baseKey ? buildSessionIdentityKey({ ...view.identity, sessionKey: baseKey }) : null;
      if (key === sessionKey || view.recordKey === sessionKey || buildSessionIdentityKey(view.identity) === sessionKey
        || identities.has(buildSessionIdentityKey(view.identity))
        || baseIdentityKey === sessionKey || baseIdentityKey !== null && identities.has(baseIdentityKey)) store.delete(key);
    }
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
