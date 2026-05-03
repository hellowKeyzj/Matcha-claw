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
  SessionRenderRow,
  SessionStateSnapshot,
} from '../../../runtime-host/shared/session-adapter-types';
import { findLatestAssistantTextFromRows } from './timeline-message';
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
      || (a.label ?? null) !== (b.label ?? null)
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

export function buildRowHistoryFingerprint(
  rows: SessionRenderRow[],
  thinkingLevel: string | null,
): string {
  const count = rows.length;
  const first = count > 0 ? rows[0] : null;
  const last = count > 0 ? rows[count - 1] : null;
  return [
    count,
    thinkingLevel ?? '',
    first?.key ?? '',
    first?.kind ?? '',
    first?.createdAt ?? '',
    last?.key ?? '',
    last?.kind ?? '',
    last?.createdAt ?? '',
    findLatestAssistantTextFromRows(rows),
  ].join('|');
}

export function buildRowRenderFingerprint(rows: SessionRenderRow[]): string {
  const count = rows.length;
  if (count === 0) {
    return hashStringDjb2('0');
  }
  const first = rows[0];
  const last = rows[count - 1];
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
    const row = rows[index];
    parts.push([
      row?.key ?? '',
      row?.kind ?? '',
      row?.role ?? '',
      String(row?.createdAt ?? ''),
      hashStringDjb2(safeStableStringify(row)),
    ].join(':'));
  }
  return hashStringDjb2(parts.join('|'));
}

const EMPTY_ROWS: SessionRenderRow[] = [];
const EMPTY_APPROVALS: ApprovalItem[] = [];
const EMPTY_VIEWPORT_STATE: ChatSessionViewportState = {
  totalMessageCount: 0,
  windowStartOffset: 0,
  windowEndOffset: 0,
  hasMore: false,
  hasNewer: false,
  isLoadingMore: false,
  isLoadingNewer: false,
  isAtLatest: true,
  lastVisibleMessageId: null,
};

export function createEmptySessionRuntime(): ChatSessionRuntimeState {
  return {
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingMessageId: null,
    pendingFinal: false,
    lastUserMessageAt: null,
  };
}

export function createEmptySessionMeta(): ChatSessionMetaState {
  return {
    label: null,
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
    rows: EMPTY_ROWS,
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

export function resolveSessionRows(
  session: ChatSessionRecord | undefined,
): SessionRenderRow[] {
  return Array.isArray(session?.rows) ? session.rows : EMPTY_ROWS;
}

export function getSessionMessageCount(
  session: Pick<ChatSessionRecord, 'rows'> | undefined,
): number {
  return Array.isArray(session?.rows) ? session.rows.length : 0;
}

export function resolveSessionRecord(session: ChatSessionRecord | undefined): ChatSessionRecord {
  if (!session) {
    return createEmptySessionRecord();
  }
  return {
    meta: resolveSessionMeta(session),
    runtime: resolveSessionRuntime(session),
    rows: resolveSessionRows(session),
    window: resolveSessionViewportState(session),
  };
}

export function resolveSessionViewportState(session: ChatSessionRecord | undefined): ChatSessionViewportState {
  return session?.window ?? EMPTY_VIEWPORT_STATE;
}

export function getSessionRecord(state: Pick<ChatStoreState, 'loadedSessions'>, sessionKey: string): ChatSessionRecord {
  return resolveSessionRecord(state.loadedSessions[sessionKey]);
}

export function getSessionRows(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
): SessionRenderRow[] {
  return resolveSessionRows(state.loadedSessions[sessionKey]);
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
      rows: patch.rows ?? current.rows,
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

export function selectViewportRows(
  record: Pick<ChatSessionRecord, 'rows' | 'window'>,
): SessionRenderRow[] {
  const rows = resolveSessionRows(record as ChatSessionRecord);
  if (rows.length === 0) {
    return EMPTY_ROWS;
  }
  const totalCount = Math.max(record.window.totalMessageCount, rows.length);
  const start = Math.max(0, Math.min(record.window.windowStartOffset, rows.length));
  const end = Math.max(start, Math.min(record.window.windowEndOffset, rows.length));
  const expectedWindowSize = Math.max(0, Math.min(record.window.windowEndOffset, totalCount) - Math.min(record.window.windowStartOffset, totalCount));
  const isAuthoritativeWindowSlice = (
    totalCount > rows.length
    && rows.length === expectedWindowSize
  );
  if (isAuthoritativeWindowSlice) {
    return rows;
  }
  if (start === 0 && end === rows.length) {
    return rows;
  }
  return rows.slice(start, end);
}

export function patchSessionRowsAndViewport(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  rows: SessionRenderRow[],
  viewportPatch?: Partial<ChatSessionViewportState>,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  const nextRowCount = rows.length;
  const nextViewport = syncViewportState(current.window, {
    totalMessageCount: viewportPatch?.totalMessageCount ?? Math.max(current.window.totalMessageCount, rows.length),
    windowStartOffset: viewportPatch?.windowStartOffset ?? current.window.windowStartOffset,
    windowEndOffset: viewportPatch?.windowEndOffset ?? (
      (viewportPatch?.windowStartOffset ?? current.window.windowStartOffset) + nextRowCount
    ),
    hasMore: viewportPatch?.hasMore ?? current.window.hasMore,
    hasNewer: viewportPatch?.hasNewer ?? current.window.hasNewer,
    isLoadingMore: viewportPatch?.isLoadingMore ?? current.window.isLoadingMore,
    isLoadingNewer: viewportPatch?.isLoadingNewer ?? current.window.isLoadingNewer,
    isAtLatest: viewportPatch?.isAtLatest ?? current.window.isAtLatest,
    lastVisibleMessageId: viewportPatch?.lastVisibleMessageId ?? current.window.lastVisibleMessageId,
  });
  return patchSessionRecord(state, sessionKey, {
    rows,
    window: nextViewport,
  });
}

export function patchSessionSnapshot(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  snapshot: SessionStateSnapshot,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  return patchSessionRecord(state, sessionKey, {
    rows: snapshot.rows,
    runtime: {
      ...current.runtime,
      sending: snapshot.runtime.sending,
      activeRunId: snapshot.runtime.activeRunId,
      runPhase: snapshot.runtime.runPhase,
      streamingMessageId: snapshot.runtime.streamingMessageId,
      pendingFinal: snapshot.runtime.pendingFinal,
      lastUserMessageAt: snapshot.runtime.lastUserMessageAt,
    },
    window: syncViewportState(current.window, {
      totalMessageCount: snapshot.window.totalEntryCount,
      windowStartOffset: snapshot.window.windowStartOffset,
      windowEndOffset: snapshot.window.windowEndOffset,
      hasMore: snapshot.window.hasMore,
      hasNewer: snapshot.window.hasNewer,
      isLoadingMore: false,
      isLoadingNewer: false,
      isAtLatest: snapshot.window.isAtLatest,
      lastVisibleMessageId: current.window.lastVisibleMessageId,
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
