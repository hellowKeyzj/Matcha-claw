import { collectToolResultPendingFiles } from './attachment-helpers';
import { prewarmAssistantMarkdownBody } from '@/lib/chat-markdown-body';
import { prewarmStaticRowsForMessages } from '@/pages/Chat/chat-rows-cache';
import {
  buildAuthoritativeUserCommitPatch,
  buildErrorStreamSnapshot,
  buildFinalMessageCommitPatch,
  buildToolResultFinalPatch,
} from './finalize-helpers';
import { reduceSessionRuntime } from './runtime-state-reducer';
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
import {
  buildTranscriptBackedViewportState,
  getSessionMessages,
  getSessionRuntime,
  patchSessionRecord,
} from './store-state-helpers';
import type { ChatStoreState, RawMessage } from './types';
import { findCurrentStreamingMessage } from './streaming-message';

export type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

export type ChatStoreGetFn = () => ChatStoreState;

function prewarmCurrentSessionRows(
  sessionKey: string,
  messages: RawMessage[],
): void {
  prewarmStaticRowsForMessages(sessionKey, messages);
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
  } = params;

  void resolvedState;
  clearErrorRecoveryTimer();
  set({ error: null });

  const finalMsg = event.message as RawMessage | undefined;
  if (!finalMsg) {
    snapshot.reset();
    set((state) => {
      const runtime = getSessionRuntime(state, currentSessionKey);
      const runtimePatch = reduceSessionRuntime(runtime, {
        type: 'final_without_message',
        completedSignal: Boolean(eventRunId),
      });
      return {
        loadedSessions: patchSessionRecord(state, currentSessionKey, {
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
    const currentStreamForPath = findCurrentStreamingMessage(
      getSessionMessages(get(), currentSessionKey),
      currentRuntime.streamingMessageId,
    );
    const toolFiles = collectToolResultPendingFiles(finalMsg, currentStreamForPath);
    const currentStreamForSnapshot = currentStreamForPath;
    snapshot.armIfIdle(currentSessionKey, eventRunId, currentStreamForSnapshot);
    const toolSnapshot = snapshot.consume(currentSessionKey, eventRunId);
    set((state) => buildToolResultFinalPatch({
      state,
      runId: eventRunId || 'run',
      toolSnapshot,
      updates,
      toolFiles,
    }));
    prewarmCurrentSessionRows(currentSessionKey, getSessionMessages(get(), currentSessionKey));
    return;
  }

  if (finalMsg.role === 'user') {
    snapshot.reset();
    set((state) => buildAuthoritativeUserCommitPatch({
      state,
      finalMessage: finalMsg,
    }));
    prewarmCurrentSessionRows(currentSessionKey, getSessionMessages(get(), currentSessionKey));
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
  const msgId = currentRuntime.streamingMessageId || finalMsg.id || (toolOnly
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
  prewarmCurrentSessionRows(currentSessionKey, getSessionMessages(get(), currentSessionKey));

  if (hasOutput && !toolOnly) {
    prewarmAssistantMarkdownBody({
      ...finalMsg,
      id: msgId,
    });
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
  const currentStream = findCurrentStreamingMessage(
    getSessionMessages(get(), currentSessionKey),
    currentRuntime.streamingMessageId,
  );
  const snapshot = buildErrorStreamSnapshot(
    getSessionMessages(get(), currentSessionKey),
    currentStream,
    `error-snap-${Date.now()}`,
  );
  if (snapshot) {
    set((state) => {
      const nextMessages = [...getSessionMessages(state, currentSessionKey), snapshot];
      const runtime = getSessionRuntime(state, currentSessionKey);
      return {
        loadedSessions: patchSessionRecord(state, currentSessionKey, {
          window: buildTranscriptBackedViewportState(state, currentSessionKey, nextMessages, runtime),
        }),
      };
    });
    prewarmCurrentSessionRows(currentSessionKey, getSessionMessages(get(), currentSessionKey));
  }

  set((state) => {
    const runtime = getSessionRuntime(state, currentSessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'event_error', error: errorMsg });
    return {
      error: errorMsg,
      loadedSessions: patchSessionRecord(state, currentSessionKey, {
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
          const runtimePatch = reduceSessionRuntime(currentRuntimeState, { type: 'error_recovery_timeout' });
          return {
            loadedSessions: patchSessionRecord(current, current.currentSessionKey, {
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
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'error_recovery_timeout' });
    return {
      loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}

