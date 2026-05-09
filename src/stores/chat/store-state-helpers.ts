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
import { findLatestAssistantTextFromItems } from './timeline-message';
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
  if (item.kind === 'task-completion') {
    return hashStringDjb2([
      item.key,
      item.kind,
      item.role,
      item.createdAt ?? '',
      item.updatedAt ?? '',
      hashText(item.text),
      item.childSessionKey,
      item.childSessionId ?? '',
      item.childAgentId ?? '',
      item.taskLabel ?? '',
      item.statusLabel ?? '',
      item.result ?? '',
      item.statsLine ?? '',
      item.replyInstruction ?? '',
      item.anchorItemKey ?? '',
      item.triggerItemKey ?? '',
      item.replyItemKey ?? '',
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

export function reconcileSessionItems(
  currentItems: SessionRenderItem[],
  nextItems: SessionRenderItem[],
): SessionRenderItem[] {
  if (currentItems === nextItems) {
    return currentItems;
  }
  if (nextItems.length === 0) {
    return currentItems.length === 0 ? currentItems : nextItems;
  }

  const currentByKey = new Map(
    currentItems.map((item) => [item.key, item] as const),
  );
  let changed = currentItems.length !== nextItems.length;

  const reconciled = nextItems.map((nextItem, index) => {
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
  const count = items.length;
  if (count === 0) {
    return hashStringDjb2('0');
  }
  const first = items[0];
  const last = items[count - 1];
  const stride = Math.max(1, Math.floor(count / 8));
  const parts: string[] = [
    String(count),
    String(stride),
    first?.key ?? '',
    String(first?.createdAt ?? ''),
    last?.key ?? '',
    String(last?.createdAt ?? ''),
  ];
  for (let index = 0; index < count; index += stride) {
    const item = items[index];
    parts.push([
      item?.key ?? '',
      item?.kind ?? '',
      item?.role ?? '',
      String(item?.createdAt ?? ''),
      hashStringDjb2(safeStableStringify(item)),
    ].join(':'));
  }
  return hashStringDjb2(parts.join('|'));
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
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    pendingFinal: false,
    lastUserMessageAt: null,
    lastError: null,
    lastIssue: null,
  };
}

export function createEmptySessionMeta(): ChatSessionMetaState {
  return {
    agentId: null,
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

export function resolveSessionRuntime(session: ChatSessionRecord | undefined): ChatSessionRuntimeState {
  if (!session?.runtime) {
    return createEmptySessionRuntime();
  }
  return {
    ...createEmptySessionRuntime(),
    ...session.runtime,
  };
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
  if (!session) {
    return createEmptySessionRecord();
  }
  return {
    meta: resolveSessionMeta(session),
    runtime: resolveSessionRuntime(session),
    items: resolveSessionItems(session),
    window: resolveSessionViewportState(session),
  };
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
  return {
    ...state.loadedSessions,
    [sessionKey]: {
      meta: patch.meta ?? current.meta,
      runtime: patch.runtime ?? current.runtime,
      items: patch.items ?? current.items,
      window: patch.window ?? current.window,
    },
  };
}

export function patchSessionMeta(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  patch: Partial<ChatSessionMetaState>,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  return {
    ...state.loadedSessions,
    [sessionKey]: {
      ...current,
      meta: {
        ...current.meta,
        ...patch,
      },
    },
  };
}

export function patchCurrentSessionMeta(
  state: Pick<ChatStoreState, 'currentSessionKey' | 'loadedSessions'>,
  patch: Partial<ChatSessionMetaState>,
): Record<string, ChatSessionRecord> {
  return patchSessionMeta(state, state.currentSessionKey, patch);
}

export function patchSessionRuntime(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  patch: Partial<ChatSessionRuntimeState>,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  return {
    ...state.loadedSessions,
    [sessionKey]: {
      ...current,
      runtime: {
        ...current.runtime,
        ...patch,
      },
    },
  };
}

export function patchCurrentSessionRuntime(
  state: Pick<ChatStoreState, 'currentSessionKey' | 'loadedSessions'>,
  patch: Partial<ChatSessionRuntimeState>,
): Record<string, ChatSessionRecord> {
  return patchSessionRuntime(state, state.currentSessionKey, patch);
}

export function patchSessionViewportState(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  viewport: ChatSessionViewportState,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  if (current.window === viewport) {
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

export function patchSessionSnapshot(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  snapshot: SessionStateSnapshot,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const catalog = snapshot.catalog;
  const nextItems = reconcileSessionItems(current.items, snapshot.items);
  return patchSessionRecord(state, sessionKey, {
    meta: {
      ...current.meta,
      agentId: catalog.agentId,
      kind: catalog.kind,
      preferred: catalog.preferred,
      label: catalog.label ?? null,
      titleSource: catalog.titleSource ?? 'none',
      displayName: catalog.displayName ?? current.meta.displayName,
      model: catalog.model ?? current.meta.model ?? null,
      lastActivityAt: typeof catalog.updatedAt === 'number' ? catalog.updatedAt : current.meta.lastActivityAt,
    },
    items: nextItems,
    runtime: {
      ...current.runtime,
      sending: snapshot.runtime.sending,
      activeRunId: snapshot.runtime.activeRunId,
      runPhase: snapshot.runtime.runPhase,
      activeTurnItemKey: snapshot.runtime.activeTurnItemKey,
      pendingTurnKey: snapshot.runtime.pendingTurnKey,
      pendingTurnLaneKey: snapshot.runtime.pendingTurnLaneKey,
      pendingFinal: snapshot.runtime.pendingFinal,
      lastUserMessageAt: snapshot.runtime.lastUserMessageAt,
      lastError: snapshot.runtime.lastError,
      lastIssue: snapshot.runtime.lastIssue,
    },
    window: syncViewportState(current.window, {
      totalItemCount: snapshot.window.totalItemCount,
      windowStartOffset: snapshot.window.windowStartOffset,
      windowEndOffset: snapshot.window.windowEndOffset,
      hasMore: snapshot.window.hasMore,
      hasNewer: snapshot.window.hasNewer,
      isLoadingMore: false,
      isLoadingNewer: false,
      isAtLatest: snapshot.window.isAtLatest,
      anchorItemKey: current.window.anchorItemKey,
    }),
  });
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
