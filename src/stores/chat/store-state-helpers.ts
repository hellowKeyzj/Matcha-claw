import type {
  AttachedFileMeta,
  ChatSession,
  ChatStoreState,
  RawMessage,
  SessionRuntimeSnapshot,
  ToolStatus,
} from './types';

/** Normalize a timestamp to milliseconds. Handles both seconds and ms. */
export function toMs(ts: number): number {
  // Timestamps < 1e12 are in seconds (before ~2033); >= 1e12 are milliseconds
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

export function areMessagesEquivalent(left: RawMessage[], right: RawMessage[]): boolean {
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
      (a.id ?? null) !== (b.id ?? null)
      || a.role !== b.role
      || (a.timestamp ?? null) !== (b.timestamp ?? null)
      || (a.toolCallId ?? null) !== (b.toolCallId ?? null)
      || (a.toolName ?? null) !== (b.toolName ?? null)
      || (a.isError ?? null) !== (b.isError ?? null)
    ) {
      return false;
    }
    if (safeStableStringify(a.content) !== safeStableStringify(b.content)) {
      return false;
    }
    if (!areAttachedFilesEqual(a._attachedFiles, b._attachedFiles)) {
      return false;
    }
  }

  return true;
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

export function createEmptySessionRuntime(): SessionRuntimeSnapshot {
  return {
    messages: EMPTY_MESSAGES,
    sending: false,
    activeRunId: null,
    runPhase: 'idle',
    streamingText: '',
    streamingMessage: null,
    streamingTools: EMPTY_STREAMING_TOOLS,
    pendingFinal: false,
    lastUserMessageAt: null,
    pendingToolImages: EMPTY_PENDING_TOOL_IMAGES,
    approvalStatus: 'idle',
  };
}

export function snapshotCurrentSessionRuntime(state: ChatStoreState): SessionRuntimeSnapshot {
  // Session switch is on the hot path. Reuse immutable references instead of deep cloning.
  return {
    messages: state.messages,
    sending: state.sending,
    activeRunId: state.activeRunId,
    runPhase: state.runPhase,
    streamingText: state.streamingText,
    streamingMessage: state.streamingMessage,
    streamingTools: state.streamingTools,
    pendingFinal: state.pendingFinal,
    lastUserMessageAt: state.lastUserMessageAt,
    pendingToolImages: state.pendingToolImages,
    approvalStatus: state.approvalStatus,
  };
}

export function resolveSessionRuntime(snapshot: SessionRuntimeSnapshot | undefined): SessionRuntimeSnapshot {
  if (!snapshot) {
    return createEmptySessionRuntime();
  }
  const hasApprovalStatus = typeof snapshot.approvalStatus === 'string';
  const hasPendingToolImages = Array.isArray(snapshot.pendingToolImages);
  const hasRunPhase = typeof snapshot.runPhase === 'string';
  if (hasApprovalStatus && hasPendingToolImages && hasRunPhase) {
    return snapshot;
  }
  return {
    messages: Array.isArray(snapshot.messages) ? snapshot.messages : EMPTY_MESSAGES,
    sending: snapshot.sending,
    activeRunId: snapshot.activeRunId,
    runPhase: hasRunPhase
      ? snapshot.runPhase
      : (snapshot.sending ? 'submitted' : 'idle'),
    streamingText: snapshot.streamingText,
    streamingMessage: snapshot.streamingMessage,
    streamingTools: Array.isArray(snapshot.streamingTools) ? snapshot.streamingTools : EMPTY_STREAMING_TOOLS,
    pendingFinal: snapshot.pendingFinal,
    lastUserMessageAt: snapshot.lastUserMessageAt,
    pendingToolImages: hasPendingToolImages ? snapshot.pendingToolImages : EMPTY_PENDING_TOOL_IMAGES,
    approvalStatus: snapshot.approvalStatus ?? 'idle',
  };
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
