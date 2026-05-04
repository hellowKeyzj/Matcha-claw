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
  SessionRenderItem,
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
  lastVisibleItemKey: null,
};

export function createEmptySessionRuntime(): ChatSessionRuntimeState {
  return {
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingAnchorKey: null,
    pendingFinal: false,
    lastUserMessageAt: null,
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
  const items = resolveSessionItems(record as ChatSessionRecord);
  if (items.length === 0) {
    return EMPTY_ITEMS;
  }
  const totalCount = Math.max(record.window.totalItemCount, items.length);
  const start = Math.max(0, Math.min(record.window.windowStartOffset, items.length));
  const end = Math.max(start, Math.min(record.window.windowEndOffset, items.length));
  const expectedWindowSize = Math.max(
    0,
    Math.min(record.window.windowEndOffset, totalCount) - Math.min(record.window.windowStartOffset, totalCount),
  );
  const isAuthoritativeWindowSlice = (
    totalCount > items.length
    && items.length === expectedWindowSize
  );
  if (isAuthoritativeWindowSlice) {
    return items;
  }
  if (start === 0 && end === items.length) {
    return items;
  }
  return items.slice(start, end);
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
    lastVisibleItemKey: viewportPatch?.lastVisibleItemKey ?? current.window.lastVisibleItemKey,
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
  return patchSessionRecord(state, sessionKey, {
    meta: {
      ...current.meta,
      agentId: catalog.agentId,
      kind: catalog.kind,
      preferred: catalog.preferred,
      label: catalog.label ?? null,
      titleSource: catalog.titleSource ?? 'none',
      displayName: catalog.displayName ?? current.meta.displayName,
      lastActivityAt: typeof catalog.updatedAt === 'number' ? catalog.updatedAt : current.meta.lastActivityAt,
    },
    items: snapshot.items,
    runtime: {
      ...current.runtime,
      sending: snapshot.runtime.sending,
      activeRunId: snapshot.runtime.activeRunId,
      runPhase: snapshot.runtime.runPhase,
      streamingAnchorKey: snapshot.runtime.streamingAnchorKey,
      pendingFinal: snapshot.runtime.pendingFinal,
      lastUserMessageAt: snapshot.runtime.lastUserMessageAt,
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
      lastVisibleItemKey: current.window.lastVisibleItemKey,
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
