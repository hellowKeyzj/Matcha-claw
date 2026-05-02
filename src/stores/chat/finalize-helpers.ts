import {
  createIntermediateToolTurnSnapshot,
  extractUserMessageClientId,
  hasAssistantToolCall,
  resolveSessionLabelFromMessages,
  sanitizeCanonicalUserMessage,
  sanitizeIntermediateToolFillerMessage,
} from './message-helpers';
import { reduceSessionRuntime } from './runtime-state-reducer';
import { upsertToolStatuses } from './event-helpers';
import {
  getSessionMeta,
  getSessionMessages,
  getSessionRuntime,
  getSessionTooling,
  patchSessionMessagesAndViewport,
  patchSessionRecord,
  toMs,
} from './store-state-helpers';
import type { AttachedFileMeta, ChatStoreState, RawMessage, ToolStatus } from './types';
import {
  commitMessageToTranscript,
  findCurrentStreamingMessage,
  findMessageIndexForCommit,
  mergeMessagesPreservingLocalIdentity,
  removeMessageById,
  settleMessage,
  upsertMessageById,
} from './streaming-message';

type RuntimeStateLike = ChatStoreState;

function mergeAttachedFiles(
  existingFiles: AttachedFileMeta[] | undefined,
  incomingFiles: AttachedFileMeta[] | undefined,
): AttachedFileMeta[] | undefined {
  const merged: AttachedFileMeta[] = [];
  for (const file of existingFiles ?? []) {
    merged.push(file);
  }
  for (const file of incomingFiles ?? []) {
    const exists = merged.some((candidate) => (
      candidate.fileName === file.fileName
      && candidate.mimeType === file.mimeType
      && candidate.fileSize === file.fileSize
      && (candidate.preview ?? null) === (file.preview ?? null)
      && (candidate.filePath ?? null) === (file.filePath ?? null)
    ));
    if (!exists) {
      merged.push(file);
    }
  }
  return merged.length > 0 ? merged : undefined;
}

function patchSessionState(input: {
  state: RuntimeStateLike;
  sessionKey: string;
  messages: RawMessage[];
  runtime: ReturnType<typeof getSessionRuntime>;
  tooling?: ReturnType<typeof getSessionTooling>;
  metaPatch?: Partial<ReturnType<typeof getSessionMeta>>;
}): Partial<ChatStoreState> {
  const { state, sessionKey, messages, runtime, tooling, metaPatch } = input;
  const currentMeta = getSessionMeta(state, sessionKey);
  return {
    loadedSessions: patchSessionRecord(
      { loadedSessions: patchSessionMessagesAndViewport(state, sessionKey, messages) },
      sessionKey,
      {
        runtime,
        ...(tooling ? { tooling } : {}),
        ...(metaPatch
          ? {
            meta: {
              ...currentMeta,
              ...metaPatch,
            },
          }
          : {}),
      },
    ),
  };
}

interface BuildAuthoritativeUserCommitPatchInput {
  state: RuntimeStateLike;
  finalMessage: RawMessage;
}

export function buildAuthoritativeUserCommitPatch(
  input: BuildAuthoritativeUserCommitPatchInput,
): Partial<ChatStoreState> {
  const { state, finalMessage } = input;
  const sessionKey = state.currentSessionKey;
  const messages = getSessionMessages(state, sessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  const extractedClientMessageId = extractUserMessageClientId(finalMessage.content);
  const sanitizedFinalMessage = sanitizeCanonicalUserMessage(finalMessage);
  const matchedIndex = findMessageIndexForCommit(messages, sanitizedFinalMessage, {
    preferredMessageId: extractedClientMessageId,
  });
  const nextMessage = matchedIndex >= 0
    ? { ...mergeMessagesPreservingLocalIdentity(messages[matchedIndex]!, sanitizedFinalMessage), status: 'sent' as const }
    : { ...sanitizedFinalMessage, status: 'sent' as const };
  const nextMessages = commitMessageToTranscript(messages, nextMessage, {
    preferredMessageId: matchedIndex >= 0 ? messages[matchedIndex]!.id ?? messages[matchedIndex]!.messageId ?? null : null,
  });
  const nextLastActivityAt = typeof finalMessage.timestamp === 'number'
    ? toMs(finalMessage.timestamp)
    : getSessionMeta(state, sessionKey).lastActivityAt;
  return patchSessionState({
    state,
    sessionKey,
    messages: nextMessages,
    runtime,
    metaPatch: { lastActivityAt: nextLastActivityAt },
  });
}

interface BuildFinalMessageCommitPatchInput {
  state: RuntimeStateLike;
  finalMessage: RawMessage;
  messageId: string;
  updates: ToolStatus[];
  hasOutput: boolean;
  toolOnly: boolean;
}

export function buildFinalMessageCommitPatch(
  input: BuildFinalMessageCommitPatchInput,
): Partial<ChatStoreState> {
  const { state, finalMessage, messageId, updates, hasOutput, toolOnly } = input;
  const sessionKey = state.currentSessionKey;
  const messages = getSessionMessages(state, sessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  const tooling = getSessionTooling(state, sessionKey);
  const nextTools = updates.length > 0
    ? upsertToolStatuses(tooling.streamingTools, updates)
    : tooling.streamingTools;
  const runtimePatch = reduceSessionRuntime(runtime, {
    type: 'final_message_committed',
    hasOutput,
    toolOnly,
  });
  const nextRuntime = runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch };
  const nextTooling = {
    streamingTools: hasOutput ? [] : nextTools,
    pendingToolImages: hasOutput ? [] : tooling.pendingToolImages,
  };
  const protocolMessageId = (
    typeof finalMessage.messageId === 'string' && finalMessage.messageId.trim()
      ? finalMessage.messageId.trim()
      : (typeof finalMessage.id === 'string' && finalMessage.id.trim() ? finalMessage.id.trim() : '')
  );
  const currentStreamingMessage = findCurrentStreamingMessage(messages, runtime.streamingMessageId);
  const preferredMessageId = currentStreamingMessage?.id || runtime.streamingMessageId || messageId;
  const messageWithImages: RawMessage = {
    ...finalMessage,
    id: preferredMessageId,
    ...(protocolMessageId
      ? { messageId: protocolMessageId }
      : (typeof currentStreamingMessage?.messageId === 'string' && currentStreamingMessage.messageId.trim()
        ? { messageId: currentStreamingMessage.messageId.trim() }
        : {})),
    streaming: false,
    _attachedFiles: mergeAttachedFiles(finalMessage._attachedFiles, tooling.pendingToolImages),
  };
  const nextMessages = commitMessageToTranscript(messages, messageWithImages, {
    preferredMessageId,
  });
  const nextLastActivityAt = typeof finalMessage.timestamp === 'number'
    ? toMs(finalMessage.timestamp)
    : getSessionMeta(state, sessionKey).lastActivityAt;
  const nextLabel = sessionKey.endsWith(':main')
    ? getSessionMeta(state, sessionKey).label
    : resolveSessionLabelFromMessages(nextMessages);
  return patchSessionState({
    state,
    sessionKey,
    messages: nextMessages,
    runtime: nextRuntime,
    tooling: nextTooling,
    metaPatch: {
      label: nextLabel,
      lastActivityAt: nextLastActivityAt,
    },
  });
}

interface BuildToolResultFinalPatchInput {
  state: RuntimeStateLike;
  runId: string;
  toolSnapshot: RawMessage | null;
  updates: ToolStatus[];
  toolFiles: AttachedFileMeta[];
}

export function buildToolResultFinalPatch(
  input: BuildToolResultFinalPatchInput,
): Partial<ChatStoreState> {
  const { state, runId, toolSnapshot, updates, toolFiles } = input;
  const sessionKey = state.currentSessionKey;
  const messages = getSessionMessages(state, sessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  const tooling = getSessionTooling(state, sessionKey);
  const nextPendingToolImages = toolFiles.length > 0
    ? [...tooling.pendingToolImages, ...toolFiles]
    : tooling.pendingToolImages;
  const nextStreamingTools = updates.length > 0
    ? upsertToolStatuses(tooling.streamingTools, updates)
    : tooling.streamingTools;
  const runtimePatch = reduceSessionRuntime(runtime, {
    type: 'tool_result_committed',
  });
  const nextRuntime = runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch };
  const nextTooling = {
    pendingToolImages: nextPendingToolImages,
    streamingTools: nextStreamingTools,
  };

  if (!toolSnapshot || !hasAssistantToolCall(toolSnapshot)) {
    return patchSessionState({
      state,
      sessionKey,
      messages: runtime.streamingMessageId ? removeMessageById(messages, runtime.streamingMessageId) : messages,
      runtime: nextRuntime,
      tooling: nextTooling,
    });
  }

  const snapshotId = toolSnapshot.id || runtime.streamingMessageId || `${runId || 'run'}-turn-${messages.length}`;
  const snapshot = sanitizeIntermediateToolFillerMessage(
    settleMessage(createIntermediateToolTurnSnapshot(toolSnapshot, snapshotId)),
    { trackPhrase: true },
  );
  return patchSessionState({
    state,
    sessionKey,
    messages: upsertMessageById(
      runtime.streamingMessageId ? removeMessageById(messages, runtime.streamingMessageId) : messages,
      snapshot,
    ),
    runtime: nextRuntime,
    tooling: nextTooling,
  });
}

export function buildErrorStreamSnapshot(
  currentMessages: RawMessage[],
  currentStream: RawMessage | null | undefined,
  fallbackSnapshotId: string,
): RawMessage | null {
  if (!currentStream) {
    return null;
  }
  if (currentStream.role !== 'assistant' && currentStream.role !== undefined) {
    return null;
  }
  const snapshotId = (
    typeof currentStream.id === 'string'
    && currentStream.id.trim()
  )
    ? currentStream.id
    : fallbackSnapshotId;
  if (currentMessages.some((message) => message.id === snapshotId)) {
    return null;
  }
  return sanitizeIntermediateToolFillerMessage(
    createIntermediateToolTurnSnapshot(currentStream, snapshotId),
    { trackPhrase: true },
  );
}
