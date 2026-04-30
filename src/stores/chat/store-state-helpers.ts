import type {
  ApprovalItem,
  AttachedFileMeta,
  ChatSession,
  ChatSessionHistoryStatus,
  ChatSessionMetaState,
  ChatSessionRecord,
  ChatSessionRuntimeState,
  ChatSessionViewportState,
  ChatStoreState,
  RawMessage,
  ToolStatus,
} from './types';
import {
  appendViewportMessage,
  createViewportWindowState,
  syncViewportMessages,
} from './viewport-state';

/** Normalize a timestamp to milliseconds. Handles both seconds and ms. */
export function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** Monotonic-ish timer for perf sampling with Date fallback. */
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

function areAttachedFilesEqual(
  left: AttachedFileMeta[] | undefined,
  right: AttachedFileMeta[] | undefined,
): boolean {
  const leftItems = Array.isArray(left) ? left : [];
  const rightItems = Array.isArray(right) ? right : [];
  if (leftItems.length !== rightItems.length) {
    return false;
  }
  for (let index = 0; index < leftItems.length; index += 1) {
    const a = leftItems[index];
    const b = rightItems[index];
    if (
      a.fileName !== b.fileName
      || a.mimeType !== b.mimeType
      || a.fileSize !== b.fileSize
      || (a.preview ?? null) !== (b.preview ?? null)
      || (a.filePath ?? null) !== (b.filePath ?? null)
    ) {
      return false;
    }
  }
  return true;
}

function areMessagesEqualAtIndex(left: RawMessage, right: RawMessage): boolean {
  return (
    (left.id ?? null) === (right.id ?? null)
    && left.role === right.role
    && (left.timestamp ?? null) === (right.timestamp ?? null)
    && (left.toolCallId ?? null) === (right.toolCallId ?? null)
    && (left.toolName ?? null) === (right.toolName ?? null)
    && (left.isError ?? null) === (right.isError ?? null)
    && safeStableStringify(left.content) === safeStableStringify(right.content)
    && areAttachedFilesEqual(left._attachedFiles, right._attachedFiles)
  );
}

export function areMessagesEquivalent(left: RawMessage[], right: RawMessage[]): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (!areMessagesEqualAtIndex(left[index], right[index])) {
      return false;
    }
  }

  return true;
}

export function mergeMessageReferences(
  current: RawMessage[],
  next: RawMessage[],
): RawMessage[] {
  if (current === next) {
    return current;
  }
  if (areMessagesEquivalent(current, next)) {
    return current;
  }

  const merged: RawMessage[] = new Array(next.length);
  let changed = current.length !== next.length;
  for (let index = 0; index < next.length; index += 1) {
    const currentMessage = current[index];
    const nextMessage = next[index];
    if (currentMessage && areMessagesEqualAtIndex(currentMessage, nextMessage)) {
      merged[index] = currentMessage;
      continue;
    }
    merged[index] = nextMessage;
    changed = true;
  }

  return changed ? merged : current;
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

export function buildHistoryFingerprint(messages: RawMessage[], thinkingLevel: string | null): string {
  const count = messages.length;
  const first = count > 0 ? messages[0] : null;
  const last = count > 0 ? messages[count - 1] : null;
  return [
    count,
    thinkingLevel ?? '',
    first?.id ?? '',
    first?.role ?? '',
    first?.timestamp ?? '',
    last?.id ?? '',
    last?.role ?? '',
    last?.timestamp ?? '',
  ].join('|');
}

function hashStringDjb2(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

export function buildQuickRawHistoryFingerprint(messages: RawMessage[], thinkingLevel: string | null): string {
  const count = messages.length;
  if (count === 0) {
    return hashStringDjb2(`0|${thinkingLevel ?? ''}`);
  }

  const sampleStride = Math.max(1, Math.floor(count / 6));
  const parts: string[] = [String(count), String(sampleStride), thinkingLevel ?? ''];
  for (let index = 0; index < count; index += sampleStride) {
    const msg = messages[index];
    parts.push([
      msg?.id ?? '',
      msg?.role ?? '',
      msg?.timestamp ?? '',
      msg?.toolCallId ?? '',
      msg?.toolName ?? '',
      msg?.isError ? '1' : '0',
    ].join(':'));
  }
  if ((count - 1) % sampleStride !== 0) {
    const tail = messages[count - 1];
    parts.push([
      tail?.id ?? '',
      tail?.role ?? '',
      tail?.timestamp ?? '',
      tail?.toolCallId ?? '',
      tail?.toolName ?? '',
      tail?.isError ? '1' : '0',
    ].join(':'));
  }

  return hashStringDjb2(parts.join('|'));
}

export function buildRenderMessagesFingerprint(messages: RawMessage[]): string {
  const count = messages.length;
  if (count === 0) {
    return hashStringDjb2('0');
  }

  const first = messages[0];
  const last = messages[count - 1];
  const stride = Math.max(1, Math.floor(count / 8));
  const parts: string[] = [
    String(count),
    String(stride),
    first?.id ?? '',
    String(first?.timestamp ?? ''),
    last?.id ?? '',
    String(last?.timestamp ?? ''),
  ];
  for (let index = 0; index < count; index += stride) {
    const message = messages[index];
    const attached = message?._attachedFiles;
    parts.push([
      message?.id ?? '',
      message?.role ?? '',
      String(message?.timestamp ?? ''),
      message?.toolCallId ?? '',
      message?.toolName ?? '',
      message?.isError ? '1' : '0',
      String(attached?.length ?? 0),
      attached?.[0]?.filePath ?? '',
      attached?.[0]?.preview ? '1' : '0',
    ].join(':'));
  }
  return hashStringDjb2(parts.join('|'));
}

const EMPTY_MESSAGES: RawMessage[] = [];
const EMPTY_STREAMING_TOOLS: ToolStatus[] = [];
const EMPTY_PENDING_TOOL_IMAGES: AttachedFileMeta[] = [];
const EMPTY_APPROVALS: ApprovalItem[] = [];
const EMPTY_VIEWPORT_STATE: ChatSessionViewportState = {
  messages: EMPTY_MESSAGES,
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
    pendingUserMessage: null,
    streamingMessageId: null,
    streamingTools: EMPTY_STREAMING_TOOLS,
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: EMPTY_PENDING_TOOL_IMAGES,
    approvalStatus: 'idle',
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

export function resolveSessionTranscript(session: ChatSessionRecord | undefined): RawMessage[] {
  return Array.isArray(session?.window?.messages) ? session.window.messages : EMPTY_MESSAGES;
}

export function resolveSessionRecord(session: ChatSessionRecord | undefined): ChatSessionRecord {
  if (!session) {
    return createEmptySessionRecord();
  }
  return {
    meta: resolveSessionMeta(session),
    runtime: resolveSessionRuntime(session),
    window: resolveSessionViewportState(session),
  };
}

export function resolveSessionViewportState(session: ChatSessionRecord | undefined): ChatSessionViewportState {
  return session?.window ?? EMPTY_VIEWPORT_STATE;
}

export function getSessionRecord(state: Pick<ChatStoreState, 'loadedSessions'>, sessionKey: string): ChatSessionRecord {
  return resolveSessionRecord(state.loadedSessions[sessionKey]);
}

export function getSessionMessages(state: Pick<ChatStoreState, 'loadedSessions'>, sessionKey: string): RawMessage[] {
  return resolveSessionTranscript(state.loadedSessions[sessionKey]);
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

export function patchSessionRecord(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  patch: Partial<ChatSessionRecord>,
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  return {
    ...state.loadedSessions,
    [sessionKey]: {
      meta: patch.meta ?? current.meta,
      runtime: patch.runtime ?? current.runtime,
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

export function patchSessionTranscript(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  messages: RawMessage[],
): Record<string, ChatSessionRecord> {
  const current = getSessionRecord(state, sessionKey);
  return {
    ...state.loadedSessions,
    [sessionKey]: {
      ...current,
      window: syncViewportMessages(current.window, messages),
    },
  };
}

export function patchCurrentSessionTranscript(
  state: Pick<ChatStoreState, 'currentSessionKey' | 'loadedSessions'>,
  messages: RawMessage[],
): Record<string, ChatSessionRecord> {
  return patchSessionTranscript(state, state.currentSessionKey, messages);
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

export function buildTranscriptBackedViewportState(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  messages: RawMessage[],
  runtime: ChatSessionRuntimeState,
): ChatSessionViewportState {
  const baseViewport = state.loadedSessions?.[sessionKey]?.window;
  let nextViewport = !baseViewport
    ? createViewportWindowState({
      messages,
      totalMessageCount: messages.length,
      windowStartOffset: 0,
      windowEndOffset: messages.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    })
    : syncViewportMessages(baseViewport, messages);

  const pendingUserMessage = runtime.pendingUserMessage?.message ?? null;
  if (pendingUserMessage) {
    nextViewport = appendViewportMessage(nextViewport, pendingUserMessage);
  }

  return nextViewport;
}
export function getPendingApprovals(
  state: Pick<ChatStoreState, 'pendingApprovalsBySession'>,
  sessionKey: string,
): ApprovalItem[] {
  return state.pendingApprovalsBySession[sessionKey] ?? EMPTY_APPROVALS;
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

