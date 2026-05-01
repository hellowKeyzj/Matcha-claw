import { hasNonToolAssistantContent } from './event-helpers';
import { reduceSessionRuntime } from './runtime-state-reducer';
import {
  areMessagesEquivalent,
  getSessionMessages,
  getSessionMeta,
  getSessionRuntime,
  mergeMessageReferences,
  patchSessionMessagesAndViewport,
  patchSessionRecord,
  selectViewportMessages,
  toMs,
} from './store-state-helpers';
import { createViewportWindowState } from './viewport-state';
import type {
  ChatHistoryLoadScope,
  ChatSessionViewportState,
  ChatStoreState,
  RawMessage,
} from './types';
import {
  findMessageIndexForCommit,
  findCurrentStreamingMessage,
  mergeMessagesPreservingLocalIdentity,
} from './streaming-message';

interface ResolveHistoryActivityFlagsInput {
  normalizedMessages: RawMessage[];
  isSendingNow: boolean;
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
}

export interface HistoryActivityFlags {
  hasRecentAssistantActivity: boolean;
  hasRecentFinalAssistantMessage: boolean;
}

export function resolveHistoryActivityFlags(input: ResolveHistoryActivityFlagsInput): HistoryActivityFlags {
  const { normalizedMessages, isSendingNow, pendingFinal, lastUserMessageAt } = input;
  const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
  const shouldTrackRecentAssistantActivity = isSendingNow && !pendingFinal;
  let hasRecentAssistantActivity = false;
  let hasRecentFinalAssistantMessage = false;
  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    const message = normalizedMessages[index];
    if (message.role !== 'assistant') {
      continue;
    }
    if (userMsTs && message.timestamp && toMs(message.timestamp) < userMsTs) {
      continue;
    }
    if (shouldTrackRecentAssistantActivity) {
      hasRecentAssistantActivity = true;
    }
    if (hasNonToolAssistantContent(message)) {
      hasRecentFinalAssistantMessage = true;
    }
    if (hasRecentFinalAssistantMessage && (!shouldTrackRecentAssistantActivity || hasRecentAssistantActivity)) {
      break;
    }
  }
  return { hasRecentAssistantActivity, hasRecentFinalAssistantMessage };
}

function shouldPreserveLocalMessage(message: RawMessage): boolean {
  const normalizedId = typeof message.id === 'string' ? message.id.trim() : '';
  if (message.status === 'sending' || message.status === 'timeout') {
    return true;
  }
  if (message.role !== 'user') {
    return false;
  }
  return Boolean(
    normalizedId.startsWith('user-')
    || (typeof message.clientId === 'string' && message.clientId.trim())
    || (typeof message.messageId === 'string' && message.messageId.trim()),
  );
}

function findLocalMatchIndex(
  localMessages: RawMessage[],
  canonicalMessage: RawMessage,
  usedLocalIndexes: Set<number>,
  runtime: ReturnType<typeof getSessionRuntime>,
): number {
  const unmatchedLocalIndexes: number[] = [];
  const unmatchedLocalMessages: RawMessage[] = [];
  for (let index = 0; index < localMessages.length; index += 1) {
    if (usedLocalIndexes.has(index)) {
      continue;
    }
    unmatchedLocalIndexes.push(index);
    unmatchedLocalMessages.push(localMessages[index]!);
  }
  const preferredAssistantMessageId = canonicalMessage.role === 'assistant'
    ? (findCurrentStreamingMessage(unmatchedLocalMessages, runtime.streamingMessageId)?.id ?? runtime.streamingMessageId)
    : null;
  const matchedFilteredIndex = findMessageIndexForCommit(unmatchedLocalMessages, canonicalMessage, {
    preferredMessageId: preferredAssistantMessageId,
  });
  return matchedFilteredIndex >= 0
    ? unmatchedLocalIndexes[matchedFilteredIndex]!
    : -1;
}

function shouldKeepUnmatchedLocalMessage(
  localMessages: RawMessage[],
  localIndex: number,
  _runtime: ReturnType<typeof getSessionRuntime>,
): boolean {
  return shouldPreserveLocalMessage(localMessages[localIndex]!);
}

function hasPreservedLocalUserBefore(
  localMessages: RawMessage[],
  localIndex: number,
  runtime: ReturnType<typeof getSessionRuntime>,
): boolean {
  for (let index = localIndex - 1; index >= 0; index -= 1) {
    const message = localMessages[index]!;
    if (!shouldKeepUnmatchedLocalMessage(localMessages, index, runtime)) {
      continue;
    }
    if (message.role === 'user') {
      return true;
    }
    if (message.role === 'assistant') {
      return false;
    }
  }
  return false;
}

function mergeCanonicalMessageOntoLocal(
  localMessage: RawMessage,
  canonicalMessage: RawMessage,
  runtime: ReturnType<typeof getSessionRuntime>,
  preserveStreamingAssistantIdentity: boolean,
): RawMessage {
  const localMessageId = typeof localMessage.messageId === 'string' ? localMessage.messageId.trim() : '';
  const canonicalMessageId = typeof canonicalMessage.messageId === 'string' && canonicalMessage.messageId.trim()
    ? canonicalMessage.messageId.trim()
    : (typeof canonicalMessage.id === 'string' ? canonicalMessage.id.trim() : '');
  if (
    localMessage.role === 'assistant'
    && runtime.streamingMessageId === localMessage.id
    && !localMessageId
    && canonicalMessageId
    && !preserveStreamingAssistantIdentity
  ) {
    return canonicalMessage._attachedFiles?.length
      ? canonicalMessage
      : { ...canonicalMessage, _attachedFiles: localMessage._attachedFiles };
  }
  const merged = mergeMessagesPreservingLocalIdentity(localMessage, canonicalMessage);
  if (
    localMessage.role !== 'assistant'
    || runtime.streamingMessageId !== localMessage.id
    || (typeof merged.messageId === 'string' && merged.messageId.trim())
  ) {
    return merged;
  }
  const protocolMessageId = (
    typeof canonicalMessage.messageId === 'string' && canonicalMessage.messageId.trim()
      ? canonicalMessage.messageId.trim()
      : (typeof canonicalMessage.id === 'string' ? canonicalMessage.id.trim() : '')
  );
  return protocolMessageId
    ? { ...merged, messageId: protocolMessageId }
    : merged;
}

export function mergeCanonicalHistoryWithLocalState(input: {
  canonicalMessages: RawMessage[];
  localMessages: RawMessage[];
  runtime: ReturnType<typeof getSessionRuntime>;
}): RawMessage[] {
  const { canonicalMessages, localMessages, runtime } = input;
  const usedLocalIndexes = new Set<number>();
  const nextMessages: RawMessage[] = [];
  let localCursor = 0;

  for (const canonicalMessage of canonicalMessages) {
    const localIndex = findLocalMatchIndex(localMessages, canonicalMessage, usedLocalIndexes, runtime);

    if (localIndex >= 0) {
      for (let index = localCursor; index < localIndex; index += 1) {
        if (usedLocalIndexes.has(index) || !shouldKeepUnmatchedLocalMessage(localMessages, index, runtime)) {
          continue;
        }
        nextMessages.push(localMessages[index]!);
      }
      const localMessage = localMessages[localIndex]!;
      nextMessages.push(mergeCanonicalMessageOntoLocal(
        localMessage,
        canonicalMessage,
        runtime,
        hasPreservedLocalUserBefore(localMessages, localIndex, runtime),
      ));
      usedLocalIndexes.add(localIndex);
      localCursor = localIndex + 1;
      continue;
    }

    if (canonicalMessage.role === 'assistant') {
      while (localCursor < localMessages.length) {
        const localMessage = localMessages[localCursor]!;
        if (
          usedLocalIndexes.has(localCursor)
          || localMessage.role !== 'user'
          || !shouldKeepUnmatchedLocalMessage(localMessages, localCursor, runtime)
        ) {
          break;
        }
        nextMessages.push(localMessage);
        localCursor += 1;
      }
    }

    nextMessages.push(canonicalMessage);
  }

  for (let index = localCursor; index < localMessages.length; index += 1) {
    if (usedLocalIndexes.has(index) || !shouldKeepUnmatchedLocalMessage(localMessages, index, runtime)) {
      continue;
    }
    nextMessages.push(localMessages[index]!);
  }

  return nextMessages;
}

interface ReconcileHistoryWindowInput {
  currentMessages: RawMessage[];
  currentViewport: ChatSessionViewportState;
  canonicalMessages: RawMessage[];
  totalMessageCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
  runtime?: ReturnType<typeof getSessionRuntime>;
}

export function reconcileHistoryWindow(input: ReconcileHistoryWindowInput): {
  messages: RawMessage[];
  viewport: ChatSessionViewportState;
  viewportMessages: RawMessage[];
} {
  const authoritativeMessages = input.runtime
    ? mergeCanonicalHistoryWithLocalState({
        canonicalMessages: input.canonicalMessages,
        localMessages: input.currentMessages,
        runtime: input.runtime,
      })
    : input.canonicalMessages;
  const nextMessages = mergeMessageReferences(input.currentMessages, authoritativeMessages);
  const reconciledWindowDelta = nextMessages.length - input.canonicalMessages.length;
  const windowStartOffset = Math.min(Math.max(input.windowStartOffset, 0), nextMessages.length);
  const windowEndOffset = Math.min(
    Math.max(input.windowEndOffset + Math.max(reconciledWindowDelta, 0), windowStartOffset),
    nextMessages.length,
  );
  const viewport = createViewportWindowState({
    ...input.currentViewport,
    totalMessageCount: input.totalMessageCount,
    windowStartOffset,
    windowEndOffset,
    hasMore: input.hasMore,
    hasNewer: input.hasNewer,
    isLoadingMore: false,
    isLoadingNewer: false,
    isAtLatest: input.isAtLatest,
  });
  return {
    messages: nextMessages,
    viewport,
    viewportMessages: selectViewportMessages({
      messages: nextMessages,
      window: viewport,
    }),
  };
}

interface BuildHistoryApplyPatchInput {
  requestedSessionKey: string;
  scope: ChatHistoryLoadScope;
  finalMessages: RawMessage[];
  viewportMessages: RawMessage[];
  thinkingLevel: string | null;
  totalMessageCount: number;
  windowStartOffset: number;
  windowEndOffset: number;
  hasMore: boolean;
  hasNewer: boolean;
  isAtLatest: boolean;
  resolvedLabel: string | null;
  lastAt: number | null;
  previousRenderFingerprint: string | null;
  renderFingerprint: string;
  flags: HistoryActivityFlags;
}

export interface BuildHistoryApplyPatchOutput {
  patch: Partial<ChatStoreState> | null;
  didMessageListChange: boolean;
}

export function buildHistoryApplyPatch(
  state: ChatStoreState,
  input: BuildHistoryApplyPatchInput,
): BuildHistoryApplyPatchOutput {
  const isCurrentSession = state.currentSessionKey === input.requestedSessionKey;
  const currentMessages = getSessionMessages(state, input.requestedSessionKey);
  const currentMeta = getSessionMeta(state, input.requestedSessionKey);
  const currentRuntime = getSessionRuntime(state, input.requestedSessionKey);
  const nextMessages = areMessagesEquivalent(currentMessages, input.finalMessages)
    ? currentMessages
    : mergeMessageReferences(currentMessages, input.finalMessages);
  const runtimePatch = (isCurrentSession && input.scope === 'foreground' && (
    currentRuntime.sending
    || currentRuntime.pendingFinal
    || currentRuntime.activeRunId != null
    || input.flags.hasRecentAssistantActivity
    || input.flags.hasRecentFinalAssistantMessage
  ))
    ? reduceSessionRuntime(currentRuntime, {
      type: 'history_snapshot',
      hasRecentAssistantActivity: input.flags.hasRecentAssistantActivity,
      hasRecentFinalAssistantMessage: input.flags.hasRecentFinalAssistantMessage,
    })
    : currentRuntime;
  const nextRuntime = runtimePatch === currentRuntime ? currentRuntime : { ...currentRuntime, ...runtimePatch };
  const nextMeta = {
    ...currentMeta,
    historyStatus: 'ready' as const,
    thinkingLevel: input.thinkingLevel,
    label: input.resolvedLabel ?? currentMeta.label,
    lastActivityAt: input.lastAt ?? currentMeta.lastActivityAt,
  };
  const didMetaChange = (
    nextMeta.historyStatus !== currentMeta.historyStatus
    || nextMeta.thinkingLevel !== currentMeta.thinkingLevel
    || nextMeta.label !== currentMeta.label
    || nextMeta.lastActivityAt !== currentMeta.lastActivityAt
  );
  const didMessageListChange = input.previousRenderFingerprint !== input.renderFingerprint || nextMessages !== currentMessages;
  if (!didMetaChange && nextRuntime === currentRuntime && nextMessages === currentMessages) {
    return { patch: null, didMessageListChange };
  }
  return {
    didMessageListChange,
    patch: {
      loadedSessions: patchSessionRecord(
        {
          loadedSessions: patchSessionMessagesAndViewport(state, input.requestedSessionKey, nextMessages, {
            totalMessageCount: input.totalMessageCount,
            windowStartOffset: input.windowStartOffset,
            windowEndOffset: input.windowEndOffset,
            hasMore: input.hasMore,
            hasNewer: input.hasNewer,
            isLoadingMore: false,
            isLoadingNewer: false,
            isAtLatest: input.isAtLatest,
          }),
        },
        input.requestedSessionKey,
        {
          meta: nextMeta,
          runtime: nextRuntime,
        },
      ),
    },
  };
}

export function buildHistoryPreviewHydrationPatch(
  state: ChatStoreState,
  requestedSessionKey: string,
  viewportMessages: RawMessage[],
): Partial<ChatStoreState> | ChatStoreState {
  const currentMessages = getSessionMessages(state, requestedSessionKey);
  if (currentMessages !== viewportMessages) {
    return state;
  }
  const hydratedMessages = viewportMessages.map((message) => (
    message._attachedFiles
      ? { ...message, _attachedFiles: message._attachedFiles.map((file) => ({ ...file })) }
      : message
  ));
  return {
    loadedSessions: patchSessionMessagesAndViewport(state, requestedSessionKey, hydratedMessages),
  };
}
