import { hasNonToolAssistantContent } from './event-helpers';
import { reduceRuntimeOverlay } from './overlay-reducer';
import { toMs } from './store-state-helpers';
import type {
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
  if (state.currentSessionKey !== input.requestedSessionKey) {
    return {
      patch: null,
      didMessageListChange: false,
    };
  }

  const patch: Partial<ChatStoreState> = {};
  let changed = false;
  let didMessageListChange = false;

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
  if (state.initialLoading || state.refreshing) {
    patch.initialLoading = false;
    patch.refreshing = false;
    changed = true;
  }
  if (input.previousRenderFingerprint !== input.renderFingerprint && state.messages !== input.finalMessages) {
    patch.messages = input.finalMessages;
    didMessageListChange = true;
    changed = true;
  }
  if (state.thinkingLevel !== input.thinkingLevel) {
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

  const shouldCheckRuntimeOverlay = (
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
  if (state.currentSessionKey !== requestedSessionKey) {
    return state;
  }
  if (state.messages !== finalMessages) {
    return state;
  }
  return {
    messages: finalMessages.map((message) => (
      message._attachedFiles
        ? { ...message, _attachedFiles: message._attachedFiles.map((file) => ({ ...file })) }
        : message
    )),
  };
}


