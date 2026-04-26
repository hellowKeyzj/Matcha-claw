import { collectToolResultPendingFiles } from './attachment-helpers';
import { prewarmAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import { EMPTY_EXECUTION_GRAPHS } from '@/pages/Chat/exec-graph-types';
import { prewarmStaticRowsForMessages } from '@/pages/Chat/chat-rows-cache';
import { projectLiveThreadMessages } from '@/pages/Chat/live-thread-projection';
import {
  buildAuthoritativeUserCommitPatch,
  buildErrorStreamSnapshot,
  buildFinalMessageCommitPatch,
  buildToolResultFinalPatch,
} from './finalize-helpers';
import { requestFinalHistoryRefresh } from './final-history-refresh';
import { reduceRuntimeOverlay } from './overlay-reducer';
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
import { isToolOnlyMessage } from './message-helpers';
import { hasActiveStreamingRun } from './runtime-stream-state';
import { getSessionRuntime, getSessionTranscript, patchSessionRecord } from './store-state-helpers';
import type { ChatStoreState, RawMessage } from './types';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

function prewarmCurrentSessionRows(
  sessionKey: string,
  transcript: RawMessage[],
): void {
  const liveMessages = projectLiveThreadMessages(transcript).messages;
  prewarmStaticRowsForMessages(sessionKey, liveMessages, EMPTY_EXECUTION_GRAPHS);
}

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

  void resolvedState;
  clearErrorRecoveryTimer();
  set({ error: null });

  const finalMsg = event.message as RawMessage | undefined;
  if (!finalMsg) {
    snapshot.reset();
    set((state) => {
      const runtime = getSessionRuntime(state, currentSessionKey);
      const runtimePatch = reduceRuntimeOverlay(runtime, {
        type: 'final_without_message',
        completedSignal: Boolean(eventRunId),
      });
      return {
        sessionsByKey: patchSessionRecord(state, currentSessionKey, {
          runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
        }),
      };
    });
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
    const currentRuntime = getSessionRuntime(get(), currentSessionKey);
    const currentStreamForPath = currentRuntime.assistantOverlay?.sourceMessage ?? null;
    const toolFiles = collectToolResultPendingFiles(finalMsg, currentStreamForPath);
    const currentStreamForSnapshot = currentRuntime.assistantOverlay?.sourceMessage ?? null;
    snapshot.armIfIdle(currentSessionKey, eventRunId, currentStreamForSnapshot);
    const toolSnapshot = snapshot.consume(currentSessionKey, eventRunId);
    set((state) => buildToolResultFinalPatch({
      state,
      runId: eventRunId || 'run',
      toolSnapshot,
      updates,
      toolFiles,
    }));
    prewarmCurrentSessionRows(currentSessionKey, getSessionTranscript(get(), currentSessionKey));
    return;
  }

  if (finalMsg.role === 'user') {
    snapshot.reset();
    set((state) => buildAuthoritativeUserCommitPatch({
      state,
      finalMessage: finalMsg,
    }));
    prewarmCurrentSessionRows(currentSessionKey, getSessionTranscript(get(), currentSessionKey));
    return;
  }

  snapshot.reset();
  const toolOnly = isToolOnlyMessage(finalMsg);
  const hasOutput = hasNonToolAssistantContent(finalMsg);
  if (hasOutput) {
    onMaybeTrackFirstTokenFinal();
  }
  const fallbackRole = typeof finalMsg.role === 'string' ? finalMsg.role : 'assistant';
  const currentRuntime = getSessionRuntime(get(), currentSessionKey);
  const overlayMessageId = currentRuntime.assistantOverlay?.messageId ?? null;
  const msgId = overlayMessageId || finalMsg.id || (toolOnly
    ? `run-${eventRunId}-tool-${Date.now()}`
    : `run-${eventRunId}-${fallbackRole}`);

  set((state) => buildFinalMessageCommitPatch({
    state,
    finalMessage: finalMsg,
    messageId: msgId,
    updates,
    hasOutput,
    toolOnly,
  }));
  prewarmCurrentSessionRows(currentSessionKey, getSessionTranscript(get(), currentSessionKey));

  if (hasOutput && !toolOnly) {
    prewarmAssistantMarkdownBody({
      ...finalMsg,
      id: msgId,
    }, 'settled');
  }

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
  const currentSessionKey = get().currentSessionKey;
  const wasSending = getSessionRuntime(get(), currentSessionKey).sending;
  onFinishFailedTelemetry(errorMsg);

  const currentRuntime = getSessionRuntime(get(), currentSessionKey);
  const currentStream = currentRuntime.assistantOverlay?.sourceMessage ?? null;
  const snapshot = buildErrorStreamSnapshot(
    getSessionTranscript(get(), currentSessionKey),
    currentStream,
    `error-snap-${Date.now()}`,
  );
  if (snapshot) {
    set((state) => ({
      sessionsByKey: patchSessionRecord(state, currentSessionKey, {
        transcript: [...getSessionTranscript(state, currentSessionKey), snapshot],
      }),
    }));
    prewarmCurrentSessionRows(currentSessionKey, getSessionTranscript(get(), currentSessionKey));
  }

  set((state) => {
    const runtime = getSessionRuntime(state, currentSessionKey);
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'event_error', error: errorMsg });
    return {
      error: errorMsg,
      sessionsByKey: patchSessionRecord(state, currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });

  if (wasSending) {
    clearErrorRecoveryTimer();
    const ERROR_RECOVERY_GRACE_MS = 15_000;
    setErrorRecoveryTimer(setTimeout(() => {
      setErrorRecoveryTimer(null);
      const state = get();
      const runtime = getSessionRuntime(state, state.currentSessionKey);
      if (runtime.sending && !hasActiveStreamingRun(runtime)) {
        clearHistoryPoll();
        set((current) => {
          const currentRuntimeState = getSessionRuntime(current, current.currentSessionKey);
          const runtimePatch = reduceRuntimeOverlay(currentRuntimeState, { type: 'error_recovery_timeout' });
          return {
            sessionsByKey: patchSessionRecord(current, current.currentSessionKey, {
              runtime: runtimePatch === currentRuntimeState ? currentRuntimeState : { ...currentRuntimeState, ...runtimePatch },
            }),
          };
        });
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
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'error_recovery_timeout' });
    return {
      sessionsByKey: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}
