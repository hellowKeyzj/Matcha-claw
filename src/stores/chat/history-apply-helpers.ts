import { hasNonToolAssistantContent } from './event-helpers';
import { reduceSessionRuntime } from './runtime-state-reducer';
import {
  areMessagesEquivalent,
  getSessionMeta,
  getSessionMessages,
  getSessionRuntime,
  getSessionViewportState,
  mergeMessageReferences,
  patchSessionRecord,
  patchSessionViewportState,
  toMs,
} from './store-state-helpers';
import type {
  ChatHistoryLoadScope,
  PendingUserMessageOverlay,
  ChatStoreState,
  RawMessage,
} from './types';
import {
  appendViewportMessage,
  syncViewportMessages,
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

export function buildHistoryApplyPatch(
  state: ChatStoreState,
  input: BuildHistoryApplyPatchInput,
): BuildHistoryApplyPatchOutput {
  const patch: Partial<ChatStoreState> = {};
  let changed = false;
  const isCurrentSession = state.currentSessionKey === input.requestedSessionKey;

  const currentMessages = getSessionMessages(state, input.requestedSessionKey);
  const nextMessages = areMessagesEquivalent(currentMessages, input.finalMessages)
    ? currentMessages
    : mergeMessageReferences(currentMessages, input.finalMessages);
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
    ? reduceSessionRuntime(currentRuntime, {
        type: 'history_snapshot',
        hasRecentAssistantActivity: input.flags.hasRecentAssistantActivity,
        hasRecentFinalAssistantMessage: input.flags.hasRecentFinalAssistantMessage,
      })
    : currentRuntime;

  const nextMeta = {
    ...currentMeta,
    historyStatus: 'ready' as const,
    thinkingLevel: input.thinkingLevel,
    label: input.resolvedLabel ?? currentMeta.label,
    lastActivityAt: input.lastAt ?? currentMeta.lastActivityAt,
  };
  const nextRuntime = runtimePatch === currentRuntime
    ? currentRuntime
    : { ...currentRuntime, ...runtimePatch };
  const nextPendingUserMessage = isCurrentSession
    ? resolveNextPendingUserMessage({
        currentRuntime,
        nextRuntime,
        pendingUserMessage: input.pendingUserMessage,
      })
    : (nextRuntime.pendingUserMessage ?? null);
  const shouldPatchPendingUser = isCurrentSession
    && nextRuntime.pendingUserMessage !== nextPendingUserMessage;
  const resolvedRuntime = shouldPatchPendingUser
    ? { ...nextRuntime, pendingUserMessage: nextPendingUserMessage }
    : nextRuntime;
  const didMetaChange = (
    nextMeta.historyStatus !== currentMeta.historyStatus
    || nextMeta.thinkingLevel !== currentMeta.thinkingLevel
    || nextMeta.label !== currentMeta.label
    || nextMeta.lastActivityAt !== currentMeta.lastActivityAt
  );
  if (
    nextMessages !== currentMessages
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
    };
    const viewportWithPendingUser = nextPendingUserMessage
      ? appendViewportMessage(nextViewport, nextPendingUserMessage.message)
      : nextViewport;
    Object.assign(patch, {
      loadedSessions: patchSessionRecord(state, input.requestedSessionKey, {
        meta: nextMeta,
        runtime: resolvedRuntime,
        window: viewportWithPendingUser,
      }),
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
    loadedSessions: patchSessionViewportState(
      state,
      requestedSessionKey,
      syncViewportMessages(
        currentViewport,
        hydratedMessages,
      ),
    ),
  };
}

