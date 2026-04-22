import { hasNonToolAssistantContent } from './event-helpers';
import { reduceRuntimeOverlay } from './overlay-reducer';
import {
  resolveSessionRuntime,
  snapshotCurrentSessionRuntime,
  toMs,
} from './store-state-helpers';
import type {
  ChatHistoryLoadScope,
  ChatStoreState,
  RawMessage,
  SessionRuntimeSnapshot,
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
    const isAfterUser = isAfterUserMsg(message);
    if (!isAfterUser) {
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
  const patch: Partial<ChatStoreState> = {};
  let changed = false;
  let didMessageListChange = false;
  const isCurrentSession = state.currentSessionKey === input.requestedSessionKey;
  const shouldUpdateForeground = isCurrentSession && input.scope === 'foreground';

  if (!state.snapshotReady) {
    patch.snapshotReady = true;
    changed = true;
  }
  if (!state.sessionReadyByKey[input.requestedSessionKey]) {
    patch.sessionReadyByKey = {
      ...state.sessionReadyByKey,
      [input.requestedSessionKey]: true,
    };
    changed = true;
  }
  if (shouldUpdateForeground && (state.initialLoading || state.refreshing)) {
    patch.initialLoading = false;
    patch.refreshing = false;
    changed = true;
  }
  if (
    shouldUpdateForeground
    && input.previousRenderFingerprint !== input.renderFingerprint
    && state.messages !== input.finalMessages
  ) {
    patch.messages = input.finalMessages;
    didMessageListChange = true;
    changed = true;
  }
  if (shouldUpdateForeground && state.thinkingLevel !== input.thinkingLevel) {
    patch.thinkingLevel = input.thinkingLevel;
    changed = true;
  }
  if (input.resolvedLabel && state.sessionLabels[input.requestedSessionKey] !== input.resolvedLabel) {
    patch.sessionLabels = {
      ...state.sessionLabels,
      [input.requestedSessionKey]: input.resolvedLabel,
    };
    changed = true;
  }
  if (input.lastAt != null && state.sessionLastActivity[input.requestedSessionKey] !== input.lastAt) {
    patch.sessionLastActivity = {
      ...state.sessionLastActivity,
      [input.requestedSessionKey]: input.lastAt,
    };
    changed = true;
  }

  const shouldCheckRuntimeOverlay = shouldUpdateForeground && (
    state.sending
    || state.pendingFinal
    || state.activeRunId != null
    || input.flags.hasRecentAssistantActivity
    || input.flags.hasRecentFinalAssistantMessage
  );
  if (shouldCheckRuntimeOverlay) {
    const runtimePatch = reduceRuntimeOverlay(state, {
      type: 'history_snapshot',
      hasRecentAssistantActivity: input.flags.hasRecentAssistantActivity,
      hasRecentFinalAssistantMessage: input.flags.hasRecentFinalAssistantMessage,
    });
    if (runtimePatch !== state) {
      Object.assign(patch, runtimePatch);
      changed = true;
    }
  }

  const currentRuntimeSnapshot: SessionRuntimeSnapshot = isCurrentSession
    ? snapshotCurrentSessionRuntime({
        ...state,
        ...patch,
      } as ChatStoreState)
    : resolveSessionRuntime(state.sessionRuntimeByKey[input.requestedSessionKey]);
  const hasRuntimeEntry = Object.prototype.hasOwnProperty.call(state.sessionRuntimeByKey, input.requestedSessionKey);
  if (!hasRuntimeEntry || currentRuntimeSnapshot.messages !== input.finalMessages) {
    patch.sessionRuntimeByKey = {
      ...state.sessionRuntimeByKey,
      [input.requestedSessionKey]: {
        ...currentRuntimeSnapshot,
        messages: input.finalMessages,
      },
    };
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
  const patch: Partial<ChatStoreState> = {};
  let changed = false;

  const currentRuntime = state.sessionRuntimeByKey[requestedSessionKey];
  if (currentRuntime && currentRuntime.messages === finalMessages) {
    patch.sessionRuntimeByKey = {
      ...state.sessionRuntimeByKey,
      [requestedSessionKey]: {
        ...currentRuntime,
        messages: hydratedMessages,
      },
    };
    changed = true;
  }

  if (state.currentSessionKey === requestedSessionKey && state.messages === finalMessages) {
    patch.messages = hydratedMessages;
    changed = true;
  }

  return changed ? patch : state;
}
