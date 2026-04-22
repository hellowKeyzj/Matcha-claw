import { collectToolResultPendingFiles } from './attachment-helpers';
import {
  buildErrorStreamSnapshot,
  buildFinalMessageCommitPatch,
  buildToolResultFinalPatch,
} from './finalize-helpers';
import { requestFinalHistoryRefresh } from './final-history-refresh';
import {
  reduceRuntimeOverlay,
} from './overlay-reducer';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  setErrorRecoveryTimer,
} from './timers';
import {
  collectToolUpdates,
  hasNonToolAssistantContent,
  isToolResultRole,
} from './event-helpers';
import { getMessageText, isToolOnlyMessage } from './message-helpers';
import {
  clearPendingStreamFinalCommit,
  queuePendingStreamFinalCommit,
} from './stream-pacer';
import type { ChatStoreState, RawMessage } from './types';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

interface StoreToolSnapshotAdapter {
  reset: () => void;
  armIfIdle: (sessionKey: string, runId: string, message: unknown) => void;
  consume: (sessionKey: string, runId: string) => RawMessage | null;
}

interface HandleStoreFinalEventParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  event: Record<string, unknown>;
  resolvedState: string;
  currentSessionKey: string;
  eventRunId: string;
  snapshot: StoreToolSnapshotAdapter;
  onMaybeTrackFirstTokenFinal: () => void;
  onBeginFinalToHistory: () => void;
}

export function handleStoreFinalEvent(params: HandleStoreFinalEventParams): void {
  const {
    set,
    get,
    event,
    resolvedState,
    currentSessionKey,
    eventRunId,
    snapshot,
    onMaybeTrackFirstTokenFinal,
    onBeginFinalToHistory,
  } = params;

  clearErrorRecoveryTimer();
  set((state) => reduceRuntimeOverlay(state, { type: 'event_error_cleared' }));

  const finalMsg = event.message as RawMessage | undefined;
  if (!finalMsg) {
    snapshot.reset();
    set((state) => reduceRuntimeOverlay(state, {
      type: 'final_without_message',
      completedSignal: Boolean(eventRunId),
    }));
    void get().loadHistory({
      sessionKey: get().currentSessionKey,
      mode: 'active',
      scope: 'foreground',
      reason: 'final_event_without_message',
    });
    return;
  }

  const updates = collectToolUpdates(finalMsg, resolvedState);
  if (isToolResultRole(finalMsg.role)) {
    clearPendingStreamFinalCommit(currentSessionKey, eventRunId);
    const currentStreamForPath = get().streamingMessage as RawMessage | null;
    const toolFiles = collectToolResultPendingFiles(finalMsg, currentStreamForPath);
    const currentStreamForSnapshot = get().streamingMessage as RawMessage | null;
    snapshot.armIfIdle(currentSessionKey, eventRunId, currentStreamForSnapshot);
    const toolSnapshot = snapshot.consume(currentSessionKey, eventRunId);
    set((state) => buildToolResultFinalPatch({
      state,
      runId: eventRunId || 'run',
      toolSnapshot,
      updates,
      toolFiles,
    }));
    return;
  }

  snapshot.reset();
  clearPendingStreamFinalCommit(currentSessionKey, eventRunId);
  const toolOnly = isToolOnlyMessage(finalMsg);
  const hasOutput = hasNonToolAssistantContent(finalMsg);
  if (hasOutput) {
    onMaybeTrackFirstTokenFinal();
  }
  const fallbackRole = typeof finalMsg.role === 'string' ? finalMsg.role : 'assistant';
  const msgId = finalMsg.id || (toolOnly
    ? `run-${eventRunId}-tool-${Date.now()}`
    : `run-${eventRunId}-${fallbackRole}`);
  const finalText = getMessageText(finalMsg.content);
  const currentDisplayedTextChars = get().streamRuntime?.displayedChars
    ?? getMessageText((get().streamingMessage as RawMessage | null)?.content).length;

  if (hasOutput && !toolOnly && finalText.length > currentDisplayedTextChars) {
    queuePendingStreamFinalCommit(currentSessionKey, eventRunId, {
      finalMessage: finalMsg,
      messageId: msgId,
      updates,
      onBeginFinalToHistory,
    });
    set((state) => reduceRuntimeOverlay(state, {
      type: 'stream_final_queued',
      sessionKey: currentSessionKey,
      runId: eventRunId,
      text: finalText,
      updates,
    }));
    return;
  }

  set((state) => buildFinalMessageCommitPatch({
    state,
    finalMessage: finalMsg,
    messageId: msgId,
    updates,
    hasOutput,
    toolOnly,
  }));

  if (hasOutput && !toolOnly) {
    requestFinalHistoryRefresh(set, get, onBeginFinalToHistory);
  }
}

interface HandleStoreErrorEventParams {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  event: Record<string, unknown>;
  onFinishFailedTelemetry: (errorMsg: string) => void;
  onResetSnapshotTxn: () => void;
}

export function handleStoreErrorEvent(params: HandleStoreErrorEventParams): void {
  const {
    set,
    get,
    event,
    onFinishFailedTelemetry,
    onResetSnapshotTxn,
  } = params;
  onResetSnapshotTxn();
  const errorMsg = String(event.errorMessage || 'An error occurred');
  const wasSending = get().sending;
  onFinishFailedTelemetry(errorMsg);

  const currentStream = get().streamingMessage as RawMessage | null;
  const snapshot = buildErrorStreamSnapshot(
    get().messages,
    currentStream,
    `error-snap-${Date.now()}`,
  );
  if (snapshot) {
    set((state) => ({
      messages: [...state.messages, snapshot],
    }));
  }

  set((state) => reduceRuntimeOverlay(state, { type: 'event_error', error: errorMsg }));

  if (wasSending) {
    clearPendingStreamFinalCommit(get().currentSessionKey, get().activeRunId);
    clearErrorRecoveryTimer();
    const ERROR_RECOVERY_GRACE_MS = 15_000;
    setErrorRecoveryTimer(setTimeout(() => {
      setErrorRecoveryTimer(null);
      const state = get();
      if (state.sending && !state.streamingMessage && !state.streamRuntime) {
        clearHistoryPoll();
        set((current) => reduceRuntimeOverlay(current, { type: 'error_recovery_timeout' }));
        void state.loadHistory({
          sessionKey: state.currentSessionKey,
          mode: 'quiet',
          scope: 'foreground',
          reason: 'error_recovery_timeout',
        });
      }
    }, ERROR_RECOVERY_GRACE_MS));
    return;
  }

  clearHistoryPoll();
  set((state) => reduceRuntimeOverlay(state, { type: 'error_recovery_timeout' }));
}
