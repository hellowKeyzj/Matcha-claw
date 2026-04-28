import { hasNonToolAssistantContent } from './event-helpers';
import { normalizeAssistantFinalTextForDedup } from './message-helpers';
import { reduceRuntimeOverlay } from './overlay-reducer';
import {
  areMessagesEquivalent,
  getSessionMeta,
  getSessionRuntime,
  getSessionTranscript,
  getSessionViewportState,
  mergeMessageReferences,
  patchSessionRecord,
  patchSessionViewportState,
  toMs,
} from './store-state-helpers';
import { selectStreamingRenderMessage } from './stream-overlay-message';
import type {
  ChatHistoryLoadScope,
  PendingUserMessageOverlay,
  ChatStoreState,
  RawMessage,
} from './types';
import {
  appendViewportMessage,
  syncViewportMessages,
  upsertViewportMessage,
} from './viewport-state';

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
  const {
    normalizedMessages,
    isSendingNow,
    pendingFinal,
    lastUserMessageAt,
  } = input;

  const userMsTs = lastUserMessageAt ? toMs(lastUserMessageAt) : 0;
  const isAfterUserMsg = (message: RawMessage): boolean => {
    if (!userMsTs || !message.timestamp) return true;
    return toMs(message.timestamp) >= userMsTs;
  };

  const shouldTrackRecentAssistantActivity = isSendingNow && !pendingFinal;
  let hasRecentAssistantActivity = false;
  let hasRecentFinalAssistantMessage = false;
  for (let index = normalizedMessages.length - 1; index >= 0; index -= 1) {
    const message = normalizedMessages[index];
    if (message.role !== 'assistant') {
      continue;
    }
    if (!isAfterUserMsg(message)) {
      continue;
    }
    if (shouldTrackRecentAssistantActivity && !hasRecentAssistantActivity) {
      hasRecentAssistantActivity = true;
    }
    if (!hasRecentFinalAssistantMessage && hasNonToolAssistantContent(message)) {
      hasRecentFinalAssistantMessage = true;
    }
    if (hasRecentFinalAssistantMessage && (!shouldTrackRecentAssistantActivity || hasRecentAssistantActivity)) {
      break;
    }
  }

  return {
    hasRecentAssistantActivity,
    hasRecentFinalAssistantMessage,
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
  pendingUserMessage?: PendingUserMessageOverlay | null;
  flags: HistoryActivityFlags;
}

export interface BuildHistoryApplyPatchOutput {
  patch: Partial<ChatStoreState> | null;
  didMessageListChange: boolean;
}

function resolveNextPendingUserMessage(input: {
  currentRuntime: ReturnType<typeof getSessionRuntime>;
  nextRuntime: ReturnType<typeof getSessionRuntime>;
  pendingUserMessage: PendingUserMessageOverlay | null | undefined;
}): PendingUserMessageOverlay | null {
  const { currentRuntime, nextRuntime, pendingUserMessage } = input;
  const runtimeClearedPendingUser = (
    currentRuntime.pendingUserMessage != null
    && nextRuntime.pendingUserMessage == null
  );
  if (runtimeClearedPendingUser) {
    return null;
  }
  return pendingUserMessage ?? null;
}

function shouldClearSettledAssistantOverlay(
  currentRuntime: ReturnType<typeof getSessionRuntime>,
  nextTranscript: RawMessage[],
  isCurrentSession: boolean,
): boolean {
  if (!isCurrentSession) {
    return false;
  }
  const overlay = currentRuntime.assistantOverlay;
  if (!overlay || currentRuntime.sending || currentRuntime.pendingFinal || currentRuntime.activeRunId != null) {
    return false;
  }

  const overlayMessageId = overlay.messageId.trim();
  const overlayText = normalizeAssistantFinalTextForDedup(overlay.targetText || overlay.committedText);
  if (!overlayText) {
    return false;
  }

  const matchedTranscriptMessage = [...nextTranscript].reverse().find((message) => (
    message.role === 'assistant'
    && (
      (overlayMessageId && message.id === overlayMessageId)
      || normalizeAssistantFinalTextForDedup(message.content) === overlayText
    )
  ));
  if (!matchedTranscriptMessage) {
    return false;
  }

  return normalizeAssistantFinalTextForDedup(matchedTranscriptMessage.content) === overlayText;
}

export function buildHistoryApplyPatch(
  state: ChatStoreState,
  input: BuildHistoryApplyPatchInput,
): BuildHistoryApplyPatchOutput {
  const patch: Partial<ChatStoreState> = {};
  let changed = false;
  const isCurrentSession = state.currentSessionKey === input.requestedSessionKey;

  if (!state.snapshotReady) {
    patch.snapshotReady = true;
    changed = true;
  }
  if (isCurrentSession && (state.initialLoading || state.refreshing)) {
    patch.initialLoading = false;
    patch.refreshing = false;
    changed = true;
  }

  const currentTranscript = getSessionTranscript(state, input.requestedSessionKey);
  const nextTranscript = areMessagesEquivalent(currentTranscript, input.finalMessages)
    ? currentTranscript
    : mergeMessageReferences(currentTranscript, input.finalMessages);
  const currentViewport = getSessionViewportState(state, input.requestedSessionKey);
  const nextViewportMessages = areMessagesEquivalent(currentViewport.messages, input.viewportMessages)
    ? currentViewport.messages
    : mergeMessageReferences(currentViewport.messages, input.viewportMessages);
  const didMessageListChange = (
    input.previousRenderFingerprint !== input.renderFingerprint
    || nextViewportMessages !== currentViewport.messages
  );
  const currentMeta = getSessionMeta(state, input.requestedSessionKey);
  const currentRuntime = getSessionRuntime(state, input.requestedSessionKey);
  const runtimePatch = (isCurrentSession && input.scope === 'foreground' && (
    currentRuntime.sending
    || currentRuntime.pendingFinal
    || currentRuntime.activeRunId != null
    || input.flags.hasRecentAssistantActivity
    || input.flags.hasRecentFinalAssistantMessage
  ))
    ? reduceRuntimeOverlay(currentRuntime, {
        type: 'history_snapshot',
        hasRecentAssistantActivity: input.flags.hasRecentAssistantActivity,
        hasRecentFinalAssistantMessage: input.flags.hasRecentFinalAssistantMessage,
      })
    : currentRuntime;

  const nextMeta = {
    ...currentMeta,
    ready: true,
    thinkingLevel: input.thinkingLevel,
    label: input.resolvedLabel ?? currentMeta.label,
    lastActivityAt: input.lastAt ?? currentMeta.lastActivityAt,
  };
  const nextRuntime = runtimePatch === currentRuntime
    ? currentRuntime
    : { ...currentRuntime, ...runtimePatch };
  const shouldClearAssistantOverlay = shouldClearSettledAssistantOverlay(
    nextRuntime,
    nextTranscript,
    isCurrentSession,
  );
  const nextPendingUserMessage = isCurrentSession
    ? resolveNextPendingUserMessage({
        currentRuntime,
        nextRuntime,
        pendingUserMessage: input.pendingUserMessage,
      })
    : (nextRuntime.pendingUserMessage ?? null);
  const shouldPatchPendingUser = isCurrentSession
    && nextRuntime.pendingUserMessage !== nextPendingUserMessage;
  let resolvedRuntime = shouldPatchPendingUser
    ? { ...nextRuntime, pendingUserMessage: nextPendingUserMessage }
    : nextRuntime;
  if (shouldClearAssistantOverlay) {
    resolvedRuntime = resolvedRuntime.assistantOverlay == null
      ? resolvedRuntime
      : { ...resolvedRuntime, assistantOverlay: null };
  }
  const didMetaChange = (
    nextMeta.ready !== currentMeta.ready
    || nextMeta.thinkingLevel !== currentMeta.thinkingLevel
    || nextMeta.label !== currentMeta.label
    || nextMeta.lastActivityAt !== currentMeta.lastActivityAt
  );
  if (
    nextTranscript !== currentTranscript
    || didMetaChange
    || resolvedRuntime !== currentRuntime
    || nextViewportMessages !== currentViewport.messages
  ) {
    const nextViewport = {
      ...currentViewport,
      messages: nextViewportMessages,
      totalMessageCount: input.totalMessageCount,
      windowStartOffset: input.windowStartOffset,
      windowEndOffset: input.windowEndOffset,
      hasMore: input.hasMore,
      hasNewer: input.hasNewer,
      isLoadingMore: false,
      isLoadingNewer: false,
      isAtLatest: input.isAtLatest,
      anchorRestore: null,
    };
    const viewportWithPendingUser = nextPendingUserMessage
      ? appendViewportMessage(nextViewport, nextPendingUserMessage.message)
      : nextViewport;
    const streamingMessage = selectStreamingRenderMessage(resolvedRuntime);
    const resolvedViewport = streamingMessage
      ? upsertViewportMessage(viewportWithPendingUser, streamingMessage)
      : viewportWithPendingUser;
    Object.assign(patch, {
      sessionsByKey: patchSessionRecord(state, input.requestedSessionKey, {
        transcript: nextTranscript,
        meta: nextMeta,
        runtime: resolvedRuntime,
      }),
      viewportBySession: patchSessionViewportState(
        state,
        input.requestedSessionKey,
        resolvedViewport,
      ),
    });
    changed = true;
  }

  return {
    patch: changed ? patch : null,
    didMessageListChange,
  };
}

export function buildHistoryPreviewHydrationPatch(
  state: ChatStoreState,
  requestedSessionKey: string,
  viewportMessages: RawMessage[],
): Partial<ChatStoreState> | ChatStoreState {
  const hydratedMessages = viewportMessages.map((message) => (
    message._attachedFiles
      ? { ...message, _attachedFiles: message._attachedFiles.map((file) => ({ ...file })) }
      : message
  ));
  const currentViewport = getSessionViewportState(state, requestedSessionKey);
  if (currentViewport.messages !== viewportMessages) {
    return state;
  }
  return {
    viewportBySession: patchSessionViewportState(
      state,
      requestedSessionKey,
      syncViewportMessages(
        currentViewport,
        hydratedMessages,
      ),
    ),
  };
}
