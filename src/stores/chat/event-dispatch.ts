import { getMessageText } from './message-helpers';
import {
  reduceRuntimeOverlay,
} from './overlay-reducer';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  hasErrorRecoveryTimer,
} from './timers';
import { collectToolUpdates } from './event-helpers';
import {
  handleStoreErrorEvent,
  handleStoreFinalEvent,
} from './event-handlers';
import {
  armToolSnapshotTxnState,
  consumeToolSnapshotTxnState,
  getToolSnapshotTxnPhase,
  resetToolSnapshotTxnState,
} from './tool-snapshot-txn';
import { maybeTrackSendToFirstToken } from './telemetry';
import {
  getSessionRuntime,
  getSessionTranscript,
  getSessionViewportState,
  patchSessionRecord,
  patchSessionViewportState,
} from './store-state-helpers';
import { selectStreamingRenderMessage } from './stream-overlay-message';
import type { ChatStoreState, RawMessage } from './types';
import { removeViewportMessageById, upsertViewportMessage } from './viewport-state';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface RuntimeEventDispatchBaseInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  event: Record<string, unknown>;
  message: unknown;
  currentSessionKey: string;
  eventRunId: string;
}

interface RuntimeEventFinalDispatchInput extends RuntimeEventDispatchBaseInput {
  onBeginFinalToHistory: () => void;
}

interface RuntimeEventErrorDispatchInput extends RuntimeEventDispatchBaseInput {
  onFinishFailedTelemetry: (errorMsg: string) => void;
}

interface RuntimeEventAbortedDispatchInput extends RuntimeEventDispatchBaseInput {
  onFinishAbortedTelemetry: () => void;
}

interface RuntimeEventUnknownDispatchInput extends RuntimeEventDispatchBaseInput {
  eventState: string;
}

function resolveStreamDeltaTextUpdate(
  previousTargetText: string,
  message: RawMessage | undefined,
): {
  text: string;
  textMode: 'append' | 'snapshot' | 'keep';
} {
  const nextText = getMessageText(message?.content);
  if (!nextText.trim()) {
    return {
      text: '',
      textMode: 'keep',
    };
  }
  if (!previousTargetText) {
    return {
      text: nextText,
      textMode: 'snapshot',
    };
  }
  if (nextText.startsWith(previousTargetText)) {
    return {
      text: nextText,
      textMode: 'snapshot',
    };
  }
  if (previousTargetText.startsWith(nextText)) {
    return {
      text: '',
      textMode: 'keep',
    };
  }
  return {
    text: nextText,
    textMode: 'append',
  };
}

function hasTokenContent(message: unknown): boolean {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const content = getMessageText((message as RawMessage).content);
  return content.trim().length > 0;
}

export function handleRuntimeStartedEvent(input: RuntimeEventDispatchBaseInput): void {
  const { set, currentSessionKey, eventRunId } = input;
  set((state) => {
    const runtime = getSessionRuntime(state, currentSessionKey);
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'run_started', runId: eventRunId });
    return {
      sessionsByKey: patchSessionRecord(state, currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}

export function handleRuntimeDeltaEvent(input: RuntimeEventDispatchBaseInput): void {
  const {
    set,
    get,
    message,
    currentSessionKey,
    eventRunId,
  } = input;

  if (hasErrorRecoveryTimer()) {
    clearErrorRecoveryTimer();
  }
  if (get().error) {
    set({ error: null });
  }
  set((state) => {
    const runtime = getSessionRuntime(state, currentSessionKey);
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'delta_received' });
    return {
      sessionsByKey: patchSessionRecord(state, currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
  if (hasTokenContent(message)) {
    maybeTrackSendToFirstToken(currentSessionKey, 'delta');
  }
  const updates = collectToolUpdates(message, 'delta');
  set((state) => {
    const runtime = getSessionRuntime(state, currentSessionKey);
    const textUpdate = resolveStreamDeltaTextUpdate(
      runtime.assistantOverlay?.targetText ?? '',
      (message as RawMessage | undefined),
    );
    const runtimePatch = reduceRuntimeOverlay(runtime, {
      type: 'stream_delta_queued',
      runId: eventRunId,
      text: textUpdate.text,
      textMode: textUpdate.textMode,
      messageId: (message as RawMessage | undefined)?.id,
      message: (message as RawMessage | undefined) ?? null,
      updates,
    });
    const nextRuntime = runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch };
    const streamingMessage = selectStreamingRenderMessage(nextRuntime);
    return {
      sessionsByKey: patchSessionRecord(state, currentSessionKey, {
        runtime: nextRuntime,
      }),
      ...(streamingMessage
        ? {
            viewportBySession: patchSessionViewportState(
              state,
              currentSessionKey,
              upsertViewportMessage(
                getSessionViewportState(state, currentSessionKey),
                streamingMessage,
              ),
            ),
          }
        : {}),
    };
  });
  armToolSnapshotTxnState(
    currentSessionKey,
    eventRunId,
    message,
  );
}

export function handleRuntimeFinalEvent(input: RuntimeEventFinalDispatchInput): void {
  const {
    set,
    get,
    event,
    currentSessionKey,
    eventRunId,
    onBeginFinalToHistory,
  } = input;

  handleStoreFinalEvent({
    set,
    get,
    event,
    resolvedState: 'final',
    currentSessionKey,
    eventRunId,
    snapshot: {
      reset: resetToolSnapshotTxnState,
      armIfIdle: (sessionKey, normalizedRunId, message) => {
        if (getToolSnapshotTxnPhase() !== 'idle') {
          return;
        }
        armToolSnapshotTxnState(sessionKey, normalizedRunId, message);
      },
      consume: consumeToolSnapshotTxnState,
    },
    onMaybeTrackFirstTokenFinal: () => {
      maybeTrackSendToFirstToken(currentSessionKey, 'final');
    },
    onBeginFinalToHistory,
  });
}

export function handleRuntimeErrorEvent(input: RuntimeEventErrorDispatchInput): void {
  const {
    set,
    get,
    event,
    onFinishFailedTelemetry,
  } = input;

  handleStoreErrorEvent({
    set,
    get,
    event,
    onFinishFailedTelemetry,
    onResetSnapshotTxn: resetToolSnapshotTxnState,
  });
}

export function handleRuntimeAbortedEvent(input: RuntimeEventAbortedDispatchInput): void {
  const { set, onFinishAbortedTelemetry } = input;
  resetToolSnapshotTxnState();
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  onFinishAbortedTelemetry();
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const overlayMessageId = runtime.assistantOverlay?.messageId ?? null;
    const transcript = getSessionTranscript(state, state.currentSessionKey);
    const transcriptHasOverlayMessage = overlayMessageId
      ? transcript.some((message) => message.id === overlayMessageId)
      : false;
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'run_aborted' });
    return {
      sessionsByKey: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
      ...(!transcriptHasOverlayMessage && overlayMessageId
        ? {
            viewportBySession: patchSessionViewportState(
              state,
              state.currentSessionKey,
              removeViewportMessageById(
                getSessionViewportState(state, state.currentSessionKey),
                overlayMessageId,
              ),
            ),
          }
        : {}),
    };
  });
}

export function handleRuntimeUnknownEvent(input: RuntimeEventUnknownDispatchInput): void {
  const { set, get, message } = input;
  const runtime = getSessionRuntime(get(), get().currentSessionKey);
  const { sending } = runtime;
  if (sending && message && typeof message === 'object') {
    const updates = collectToolUpdates(message, 'delta');
    const sessionKey = get().currentSessionKey;
    const runId = getSessionRuntime(get(), sessionKey).activeRunId ?? '';
    set((state) => {
      const currentRuntime = getSessionRuntime(state, sessionKey);
      const textUpdate = resolveStreamDeltaTextUpdate(
        currentRuntime.assistantOverlay?.targetText ?? '',
        (message as RawMessage | undefined),
      );
      const runtimePatch = reduceRuntimeOverlay(currentRuntime, {
        type: 'stream_delta_queued',
        runId,
        text: textUpdate.text,
        textMode: textUpdate.textMode,
        messageId: (message as RawMessage).id,
        message: message as RawMessage,
        updates,
      });
      const nextRuntime = runtimePatch === currentRuntime ? currentRuntime : { ...currentRuntime, ...runtimePatch };
      const streamingMessage = selectStreamingRenderMessage(nextRuntime);
      return {
        sessionsByKey: patchSessionRecord(state, sessionKey, {
          runtime: nextRuntime,
        }),
        ...(streamingMessage
          ? {
              viewportBySession: patchSessionViewportState(
                state,
                sessionKey,
                upsertViewportMessage(
                  getSessionViewportState(state, sessionKey),
                  streamingMessage,
                ),
              ),
            }
          : {}),
      };
    });
  }
}
