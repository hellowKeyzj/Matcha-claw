import { hasNonToolAssistantContent } from './event-helpers';
import { normalizeAssistantFinalTextForDedup } from './message-helpers';
import { reduceRuntimeOverlay } from './overlay-reducer';
import {
  areMessagesEquivalent,
  getSessionMeta,
  getSessionRuntime,
  getSessionTranscript,
  mergeMessageReferences,
  patchSessionRecord,
  toMs,
} from './store-state-helpers';
import type {
  ChatHistoryLoadScope,
  PendingUserMessageOverlay,
  ChatStoreState,
  RawMessage,
} from './types';

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
  thinkingLevel: string | null;
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
  const didMessageListChange = (
    input.previousRenderFingerprint !== input.renderFingerprint
    || nextTranscript !== currentTranscript
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
  ) {
    patch.sessionsByKey = patchSessionRecord(state, input.requestedSessionKey, {
      transcript: nextTranscript,
      meta: nextMeta,
      runtime: resolvedRuntime,
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
  finalMessages: RawMessage[],
): Partial<ChatStoreState> | ChatStoreState {
  const hydratedMessages = finalMessages.map((message) => (
    message._attachedFiles
      ? { ...message, _attachedFiles: message._attachedFiles.map((file) => ({ ...file })) }
      : message
  ));
  const currentTranscript = getSessionTranscript(state, requestedSessionKey);
  if (currentTranscript !== finalMessages) {
    return state;
  }
  return {
    sessionsByKey: patchSessionRecord(state, requestedSessionKey, {
      transcript: hydratedMessages,
    }),
  };
}
