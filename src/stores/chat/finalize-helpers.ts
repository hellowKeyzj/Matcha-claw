import {
  extractUserMessageClientId,
  createIntermediateToolTurnSnapshot,
  hasAssistantToolCall,
  normalizeAssistantFinalTextForDedup,
  sanitizeIntermediateToolFillerMessage,
} from './message-helpers';
import { reduceRuntimeOverlay } from './overlay-reducer';
import { upsertToolStatuses } from './event-helpers';
import {
  getSessionRuntime,
  getSessionTranscript,
  patchSessionRecord,
} from './store-state-helpers';
import type {
  AttachedFileMeta,
  ChatStoreState,
  PendingUserMessageOverlay,
  RawMessage,
  ToolStatus,
} from './types';

type RuntimeStateLike = ChatStoreState;

export function hasAssistantSemanticDuplicate(
  messages: RawMessage[],
  incoming: RawMessage,
  runtime: { sending: boolean; pendingFinal: boolean },
): boolean {
  return findAssistantSemanticDuplicateIndex(messages, incoming, runtime) >= 0;
}

function findAssistantSemanticDuplicateIndex(
  messages: RawMessage[],
  incoming: RawMessage,
  runtime: { sending: boolean; pendingFinal: boolean },
): number {
  if (incoming.role !== 'assistant' || (!runtime.sending && !runtime.pendingFinal)) {
    return -1;
  }
  const incomingText = normalizeAssistantFinalTextForDedup(incoming.content);
  if (!incomingText) {
    return -1;
  }
  const scanStart = Math.max(0, messages.length - 6);
  for (let index = messages.length - 1; index >= scanStart; index -= 1) {
    const candidate = messages[index];
    if (candidate.role !== 'assistant') {
      continue;
    }
    const candidateText = normalizeAssistantFinalTextForDedup(candidate.content);
    if (candidateText && candidateText === incomingText) {
      return index;
    }
  }
  return -1;
}

function mergeAttachedFiles(
  existingFiles: AttachedFileMeta[] | undefined,
  incomingFiles: AttachedFileMeta[] | undefined,
): AttachedFileMeta[] | undefined {
  const merged: AttachedFileMeta[] = [];
  const pushUnique = (file: AttachedFileMeta) => {
    const alreadyExists = merged.some((candidate) => (
      candidate.fileName === file.fileName
      && candidate.mimeType === file.mimeType
      && candidate.fileSize === file.fileSize
      && (candidate.preview ?? null) === (file.preview ?? null)
      && (candidate.filePath ?? null) === (file.filePath ?? null)
    ));
    if (!alreadyExists) {
      merged.push(file);
    }
  };
  for (const file of existingFiles ?? []) {
    pushUnique(file);
  }
  for (const file of incomingFiles ?? []) {
    pushUnique(file);
  }
  return merged.length > 0 ? merged : undefined;
}

function mergeCommittedMessage(
  existingMessage: RawMessage,
  incomingMessage: RawMessage,
): RawMessage {
  const incomingId = typeof incomingMessage.id === 'string' && incomingMessage.id.trim()
    ? incomingMessage.id
    : undefined;
  return {
    ...existingMessage,
    ...incomingMessage,
    ...(incomingId ? { id: incomingId } : {}),
    _attachedFiles: mergeAttachedFiles(existingMessage._attachedFiles, incomingMessage._attachedFiles),
  };
}

export function mergePendingUserMessage(
  pendingUserMessage: PendingUserMessageOverlay,
  incoming: RawMessage,
): RawMessage {
  const pendingUserId = pendingUserMessage.clientMessageId.trim();
  const pendingFiles = pendingUserMessage.message._attachedFiles ?? [];

  return {
    ...incoming,
    ...(pendingUserId ? { id: pendingUserId } : {}),
    _attachedFiles: incoming._attachedFiles && incoming._attachedFiles.length > 0
      ? incoming._attachedFiles
      : pendingFiles,
  };
}

function matchesPendingUserMessage(
  pendingUserMessage: PendingUserMessageOverlay,
  message: RawMessage,
): boolean {
  if (message.role !== 'user') {
    return false;
  }
  const pendingId = pendingUserMessage.clientMessageId.trim();
  if (!pendingId) {
    return false;
  }
  if (typeof message.id === 'string' && message.id.trim() === pendingId) {
    return true;
  }
  return extractUserMessageClientId(message.content) === pendingId;
}

export function buildSanitizedIntermediateSnapshot(
  currentStream: RawMessage | null | undefined,
  existingMessages: RawMessage[],
  snapshotId: string,
): RawMessage | null {
  if (!currentStream) {
    return null;
  }
  if (existingMessages.some((message) => message.id === snapshotId)) {
    return null;
  }
  return sanitizeIntermediateToolFillerMessage(
    createIntermediateToolTurnSnapshot(currentStream, snapshotId),
    { trackPhrase: true },
  );
}

interface BuildFinalMessageCommitPatchInput {
  state: RuntimeStateLike;
  finalMessage: RawMessage;
  messageId: string;
  updates: ToolStatus[];
  hasOutput: boolean;
  toolOnly: boolean;
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
  const transcript = getSessionTranscript(state, sessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  const pendingUserMessage = runtime.pendingUserMessage ?? null;
  const matchedPending = pendingUserMessage && matchesPendingUserMessage(pendingUserMessage, finalMessage)
    ? pendingUserMessage
    : null;
  const nextMessage = matchedPending
    ? mergePendingUserMessage(matchedPending, finalMessage)
    : finalMessage;
  const alreadyExists = transcript.some((message) => (
    (typeof nextMessage.id === 'string' && nextMessage.id.trim() && message.id === nextMessage.id)
    || (matchedPending != null && matchesPendingUserMessage(matchedPending, message))
  ));
  if (alreadyExists) {
    return {
      sessionsByKey: patchSessionRecord(state, sessionKey, {
        runtime: matchedPending ? { ...runtime, pendingUserMessage: null } : runtime,
      }),
    };
  }
  return {
    sessionsByKey: patchSessionRecord(state, sessionKey, {
      transcript: [...transcript, nextMessage],
      runtime: matchedPending ? { ...runtime, pendingUserMessage: null } : runtime,
    }),
  };
}

export function buildFinalMessageCommitPatch(
  input: BuildFinalMessageCommitPatchInput,
): Partial<ChatStoreState> {
  const { state, finalMessage, messageId, updates, hasOutput, toolOnly } = input;
  const sessionKey = state.currentSessionKey;
  const transcript = getSessionTranscript(state, sessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  const nextTools = updates.length > 0
    ? upsertToolStatuses(runtime.streamingTools, updates)
    : runtime.streamingTools;
  const streamingTools = hasOutput ? [] : nextTools;

  const pendingImages = runtime.pendingToolImages;
  const messageWithImages: RawMessage = pendingImages.length > 0
    ? {
        ...finalMessage,
        role: (finalMessage.role || 'assistant') as RawMessage['role'],
        id: messageId,
        _attachedFiles: [...(finalMessage._attachedFiles || []), ...pendingImages],
      }
    : { ...finalMessage, role: (finalMessage.role || 'assistant') as RawMessage['role'], id: messageId };

  const duplicateMessageIndexById = transcript.findIndex((message) => message.id === messageId);
  const assistantSemanticDuplicateIndex = findAssistantSemanticDuplicateIndex(
    transcript,
    messageWithImages,
    { sending: runtime.sending, pendingFinal: runtime.pendingFinal },
  );
  const existingMessageIndex = duplicateMessageIndexById >= 0
    ? duplicateMessageIndexById
    : assistantSemanticDuplicateIndex;
  const runtimePatch = reduceRuntimeOverlay(runtime, {
    type: 'final_message_committed',
    hasOutput,
    toolOnly,
    streamingTools,
  });
  const nextRuntimeBase = runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch };
  const pendingUserMessage = runtime.pendingUserMessage ?? null;
  const nextRuntime = nextRuntimeBase;

  if (existingMessageIndex >= 0) {
    const mergedTranscript = [...transcript];
    mergedTranscript[existingMessageIndex] = mergeCommittedMessage(
      transcript[existingMessageIndex]!,
      messageWithImages,
    );
    return {
      sessionsByKey: patchSessionRecord(state, sessionKey, {
        transcript: mergedTranscript,
        runtime: nextRuntime,
      }),
    };
  }

  if (messageWithImages.role === 'user' && pendingUserMessage && matchesPendingUserMessage(pendingUserMessage, messageWithImages)) {
    const mergedPendingUser = mergePendingUserMessage(pendingUserMessage, messageWithImages);
    return {
      sessionsByKey: patchSessionRecord(state, sessionKey, {
        transcript: [...transcript, mergedPendingUser],
        runtime: { ...nextRuntime, pendingUserMessage: null },
      }),
    };
  }

  return {
    sessionsByKey: patchSessionRecord(state, sessionKey, {
      transcript: [...transcript, messageWithImages],
      runtime: nextRuntime,
    }),
  };
}

interface ReconcilePendingUserHistoryInput {
  historyMessages: RawMessage[];
  pendingUserMessage: PendingUserMessageOverlay | null | undefined;
}

export function reconcilePendingUserWithHistory(
  input: ReconcilePendingUserHistoryInput,
): {
  historyMessages: RawMessage[];
  pendingUserMessage: PendingUserMessageOverlay | null;
} {
  const { historyMessages, pendingUserMessage } = input;
  if (!pendingUserMessage) {
    return {
      historyMessages,
      pendingUserMessage: null,
    };
  }

  const pendingUser = pendingUserMessage.message;
  const matchedHistoryIndex = [...historyMessages].reverse().findIndex((candidate) => {
    return matchesPendingUserMessage(pendingUserMessage, candidate)
      || (candidate.role === 'user' && pendingUser.id != null && candidate.id === pendingUser.id);
  });

  if (matchedHistoryIndex < 0) {
    return {
      historyMessages,
      pendingUserMessage,
    };
  }

  const historyIndex = historyMessages.length - 1 - matchedHistoryIndex;
  const matchedHistoryMessage = historyMessages[historyIndex];
  const pendingFiles = pendingUser._attachedFiles ?? [];
  const historyFiles = matchedHistoryMessage?._attachedFiles ?? [];
  const pendingId = pendingUserMessage.clientMessageId.trim();
  const shouldPreservePendingId = Boolean(
    pendingId
    && matchedHistoryMessage?.id !== pendingId,
  );
  const shouldHydratePendingFiles = pendingFiles.length > 0 && historyFiles.length === 0;
  if (!shouldPreservePendingId && !shouldHydratePendingFiles) {
    return {
      historyMessages,
      pendingUserMessage: null,
    };
  }

  const merged = [...historyMessages];
  merged[historyIndex] = {
    ...matchedHistoryMessage,
    ...(shouldPreservePendingId ? { id: pendingId } : {}),
    ...(shouldHydratePendingFiles
      ? { _attachedFiles: pendingFiles.map((file) => ({ ...file })) }
      : {}),
  };
  return {
    historyMessages: merged,
    pendingUserMessage: null,
  };
}

interface ReconcileAssistantHistoryInput {
  historyMessages: RawMessage[];
  currentMessages: RawMessage[];
}

export function reconcileLatestAssistantInHistory(
  input: ReconcileAssistantHistoryInput,
): RawMessage[] {
  const { historyMessages, currentMessages } = input;
  const currentAssistant = [...currentMessages].reverse().find((message) => (
    message.role === 'assistant'
    && normalizeAssistantFinalTextForDedup(message.content) !== ''
  ));
  if (!currentAssistant) {
    return historyMessages;
  }

  const currentAssistantId = typeof currentAssistant.id === 'string' && currentAssistant.id.trim()
    ? currentAssistant.id.trim()
    : '';
  const currentAssistantText = normalizeAssistantFinalTextForDedup(currentAssistant.content);
  if (!currentAssistantId || !currentAssistantText) {
    return historyMessages;
  }

  const matchedHistoryIndex = [...historyMessages].reverse().findIndex((candidate) => (
    candidate.role === 'assistant'
    && normalizeAssistantFinalTextForDedup(candidate.content) === currentAssistantText
  ));
  if (matchedHistoryIndex < 0) {
    return historyMessages;
  }

  const historyIndex = historyMessages.length - 1 - matchedHistoryIndex;
  const matchedHistoryMessage = historyMessages[historyIndex];
  const historyAssistantId = typeof matchedHistoryMessage?.id === 'string' && matchedHistoryMessage.id.trim()
    ? matchedHistoryMessage.id.trim()
    : '';
  const currentFiles = currentAssistant._attachedFiles ?? [];
  const historyFiles = matchedHistoryMessage?._attachedFiles ?? [];
  const shouldPreserveCurrentId = historyAssistantId !== currentAssistantId;
  const shouldHydrateCurrentFiles = currentFiles.length > 0 && historyFiles.length === 0;
  if (!shouldPreserveCurrentId && !shouldHydrateCurrentFiles) {
    return historyMessages;
  }

  const merged = [...historyMessages];
  merged[historyIndex] = {
    ...matchedHistoryMessage,
    ...(shouldPreserveCurrentId ? { id: currentAssistantId } : {}),
    ...(shouldHydrateCurrentFiles
      ? { _attachedFiles: currentFiles.map((file) => ({ ...file })) }
      : {}),
  };
  return merged;
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
  const {
    state,
    runId,
    toolSnapshot,
    updates,
    toolFiles,
  } = input;
  const sessionKey = state.currentSessionKey;
  const transcript = getSessionTranscript(state, sessionKey);
  const runtime = getSessionRuntime(state, sessionKey);
  const snapshotMessages: RawMessage[] = [];
  const nextPendingToolImages = toolFiles.length > 0
    ? [...runtime.pendingToolImages, ...toolFiles]
    : runtime.pendingToolImages;
  const nextStreamingTools = updates.length > 0
    ? upsertToolStatuses(runtime.streamingTools, updates)
    : runtime.streamingTools;

  if (toolSnapshot) {
    const streamRole = toolSnapshot.role;
    const shouldSnapshotIntermediateToolTurn = (
      (streamRole === 'assistant' || streamRole === undefined)
      && hasAssistantToolCall(toolSnapshot)
    );
    if (shouldSnapshotIntermediateToolTurn) {
      const snapshotId = toolSnapshot.id || `${runId || 'run'}-turn-${transcript.length}`;
      const snapshot = buildSanitizedIntermediateSnapshot(
        toolSnapshot,
        transcript,
        snapshotId,
      );
      if (snapshot) {
        snapshotMessages.push(snapshot);
      }
    }
  }

  const runtimePatch = reduceRuntimeOverlay(runtime, {
    type: 'tool_result_committed',
    pendingToolImages: nextPendingToolImages,
    streamingTools: nextStreamingTools,
  });
  return {
    sessionsByKey: patchSessionRecord(state, sessionKey, {
      transcript: snapshotMessages.length > 0
        ? [...transcript, ...snapshotMessages]
        : transcript,
      runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
    }),
  };
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
  return buildSanitizedIntermediateSnapshot(currentStream, currentMessages, snapshotId);
}
