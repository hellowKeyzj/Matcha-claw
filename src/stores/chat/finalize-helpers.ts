import {
  createIntermediateToolTurnSnapshot,
  hasAssistantToolCall,
  normalizeAssistantFinalTextForDedup,
  normalizeUserTextForReconcile,
  sanitizeIntermediateToolFillerMessage,
} from './message-helpers';
import {
  reduceRuntimeOverlay,
} from './overlay-reducer';
import { upsertToolStatuses } from './event-helpers';
import { toMs } from './store-state-helpers';
import type { AttachedFileMeta, ChatStoreState, RawMessage, ToolStatus } from './types';

type RuntimeStateLike = ChatStoreState;

export function hasAssistantSemanticDuplicate(
  messages: RawMessage[],
  incoming: RawMessage,
  runtime: { sending: boolean; pendingFinal: boolean },
): boolean {
  if (incoming.role !== 'assistant' || (!runtime.sending && !runtime.pendingFinal)) {
    return false;
  }
  const incomingText = normalizeAssistantFinalTextForDedup(incoming.content);
  if (!incomingText) {
    return false;
  }
  const scanStart = Math.max(0, messages.length - 6);
  for (let index = messages.length - 1; index >= scanStart; index -= 1) {
    const candidate = messages[index];
    if (candidate.role !== 'assistant') {
      continue;
    }
    const candidateText = normalizeAssistantFinalTextForDedup(candidate.content);
    if (candidateText && candidateText === incomingText) {
      return true;
    }
  }
  return false;
}

export function findOptimisticUserMessageIndex(
  messages: RawMessage[],
  incoming: RawMessage,
  lastUserMessageAt: number | null,
  windowMs = 30_000,
): number {
  if (incoming.role !== 'user') {
    return -1;
  }
  if (lastUserMessageAt == null) {
    return -1;
  }
  const sentAtMs = toMs(lastUserMessageAt);
  const incomingText = normalizeUserTextForReconcile(incoming.content);
  if (!incomingText) {
    return -1;
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (candidate.role !== 'user' || !candidate.timestamp) {
      continue;
    }
    const candidateTsMs = toMs(candidate.timestamp);
    if (Math.abs(candidateTsMs - sentAtMs) > windowMs) {
      continue;
    }
    const candidateText = normalizeUserTextForReconcile(candidate.content);
    if (!candidateText || candidateText !== incomingText) {
      continue;
    }
    return index;
  }
  return -1;
}

export function mergeOptimisticUserMessage(
  optimisticUser: RawMessage | undefined,
  incoming: RawMessage,
): RawMessage {
  const optimisticUserId = (
    optimisticUser
    && typeof optimisticUser.id === 'string'
    && optimisticUser.id.trim()
  )
    ? optimisticUser.id.trim()
    : '';

  return {
    ...incoming,
    ...(optimisticUserId ? { id: optimisticUserId } : {}),
    _attachedFiles: incoming._attachedFiles && incoming._attachedFiles.length > 0
      ? incoming._attachedFiles
      : optimisticUser?._attachedFiles,
  };
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

export function buildFinalMessageCommitPatch(
  input: BuildFinalMessageCommitPatchInput,
): Partial<ChatStoreState> {
  const { state, finalMessage, messageId, updates, hasOutput, toolOnly } = input;
  const nextTools = updates.length > 0
    ? upsertToolStatuses(state.streamingTools, updates)
    : state.streamingTools;
  const streamingTools = hasOutput ? [] : nextTools;

  const pendingImages = state.pendingToolImages;
  const messageWithImages: RawMessage = pendingImages.length > 0
    ? {
      ...finalMessage,
      role: (finalMessage.role || 'assistant') as RawMessage['role'],
      id: messageId,
      _attachedFiles: [...(finalMessage._attachedFiles || []), ...pendingImages],
    }
    : { ...finalMessage, role: (finalMessage.role || 'assistant') as RawMessage['role'], id: messageId };

  const assistantSemanticDuplicate = hasAssistantSemanticDuplicate(
    state.messages,
    messageWithImages,
    { sending: state.sending, pendingFinal: state.pendingFinal },
  );
  const alreadyExists = state.messages.some((message) => message.id === messageId) || assistantSemanticDuplicate;
  const buildFinalRuntimePatch = (messages?: RawMessage[]) => reduceRuntimeOverlay(state, {
    type: 'final_message_committed',
    hasOutput,
    toolOnly,
    streamingTools,
    messages,
  });

  if (alreadyExists) {
    return buildFinalRuntimePatch();
  }

  const optimisticUserIndex = findOptimisticUserMessageIndex(
    state.messages,
    messageWithImages,
    state.lastUserMessageAt,
  );
  if (optimisticUserIndex >= 0) {
    const mergedUserMessage = mergeOptimisticUserMessage(
      state.messages[optimisticUserIndex],
      messageWithImages,
    );
    const nextMessages = [...state.messages];
    nextMessages[optimisticUserIndex] = mergedUserMessage;
    return buildFinalRuntimePatch(nextMessages);
  }

  return buildFinalRuntimePatch([...state.messages, messageWithImages]);
}

interface ReconcileOptimisticHistoryInput {
  historyMessages: RawMessage[];
  currentMessages: RawMessage[];
  lastUserMessageAt: number | null;
  windowMs: number;
}

export function reconcileOptimisticUserInHistory(
  input: ReconcileOptimisticHistoryInput,
): RawMessage[] {
  const { historyMessages, currentMessages, lastUserMessageAt, windowMs } = input;
  if (lastUserMessageAt == null) {
    return historyMessages;
  }

  const sentAtMs = toMs(lastUserMessageAt);
  const optimistic = [...currentMessages].reverse().find(
    (message) => (
      message.role === 'user'
      && message.timestamp
      && Math.abs(toMs(message.timestamp) - sentAtMs) <= windowMs
    ),
  );

  if (!optimistic) {
    return historyMessages;
  }

  const optimisticText = normalizeUserTextForReconcile(optimistic.content);
  const matchedHistoryIndex = historyMessages.findIndex((candidate) => {
    if (candidate.role !== 'user' || !candidate.timestamp) {
      return false;
    }
    const candidateTsMs = toMs(candidate.timestamp);
    if (Math.abs(candidateTsMs - sentAtMs) > windowMs) {
      return false;
    }
    if (candidate.id && optimistic.id && candidate.id === optimistic.id) {
      return true;
    }
    if (!optimisticText) {
      return false;
    }
    const candidateText = normalizeUserTextForReconcile(candidate.content);
    return candidateText !== '' && candidateText === optimisticText;
  });

  if (matchedHistoryIndex < 0) {
    return [...historyMessages, optimistic];
  }

  const matchedHistoryMessage = historyMessages[matchedHistoryIndex];
  const optimisticFiles = optimistic._attachedFiles ?? [];
  const historyFiles = matchedHistoryMessage?._attachedFiles ?? [];
  const optimisticId = typeof optimistic.id === 'string' && optimistic.id.trim()
    ? optimistic.id.trim()
    : '';
  const shouldPreserveOptimisticId = Boolean(
    optimisticId
    && matchedHistoryMessage?.id !== optimisticId,
  );
  const shouldHydrateOptimisticFiles = optimisticFiles.length > 0 && historyFiles.length === 0;
  if (!shouldPreserveOptimisticId && !shouldHydrateOptimisticFiles) {
    return historyMessages;
  }

  const merged = [...historyMessages];
  merged[matchedHistoryIndex] = {
    ...matchedHistoryMessage,
    ...(shouldPreserveOptimisticId ? { id: optimisticId } : {}),
    ...(shouldHydrateOptimisticFiles
      ? { _attachedFiles: optimisticFiles.map((file) => ({ ...file })) }
      : {}),
  };
  return merged;
}

interface BuildToolResultFinalPatchInput {
  state: RuntimeStateLike;
  runId: string;
  shouldCommitToolSnapshot: boolean;
  updates: ToolStatus[];
  toolFiles: AttachedFileMeta[];
}

export function buildToolResultFinalPatch(
  input: BuildToolResultFinalPatchInput,
): Partial<ChatStoreState> {
  const {
    state,
    runId,
    shouldCommitToolSnapshot,
    updates,
    toolFiles,
  } = input;
  const currentStream = state.streamingMessage as RawMessage | null;
  const snapshotMessages: RawMessage[] = [];
  const nextPendingToolImages = toolFiles.length > 0
    ? [...state.pendingToolImages, ...toolFiles]
    : state.pendingToolImages;
  const nextStreamingTools = updates.length > 0
    ? upsertToolStatuses(state.streamingTools, updates)
    : state.streamingTools;

  if (shouldCommitToolSnapshot && currentStream) {
    const streamRole = currentStream.role;
    const shouldSnapshotIntermediateToolTurn = (
      (streamRole === 'assistant' || streamRole === undefined)
      && hasAssistantToolCall(currentStream)
    );
    if (shouldSnapshotIntermediateToolTurn) {
      const snapshotId = currentStream.id || `${runId || 'run'}-turn-${state.messages.length}`;
      const snapshot = buildSanitizedIntermediateSnapshot(
        currentStream,
        state.messages,
        snapshotId,
      );
      if (snapshot) {
        snapshotMessages.push(snapshot);
      }
    }
  }

  return {
    messages: snapshotMessages.length > 0
      ? [...state.messages, ...snapshotMessages]
      : state.messages,
    ...reduceRuntimeOverlay(state, {
      type: 'tool_result_committed',
      pendingToolImages: nextPendingToolImages,
      streamingTools: nextStreamingTools,
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


