import { getMessageText } from './message-helpers';
import {
  reduceSessionRuntime,
} from './runtime-state-reducer';
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
  getSessionMessages,
  getSessionRuntime,
  getSessionViewportState,
  patchSessionRecord,
} from './store-state-helpers';
import type { ChatStoreState, RawMessage } from './types';
import { syncViewportMessages } from './viewport-state';
import {
  findCurrentStreamingMessage,
  getStreamingMessageText,
  removeMessageById,
  resolveNextStreamingText,
  resolveStreamingMessage,
  upsertMessageById,
} from './streaming-message';

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

type RuntimeEventFinalDispatchInput = RuntimeEventDispatchBaseInput;

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

function buildNextStreamingState(params: {
  state: ChatStoreState;
  sessionKey: string;
  runId: string;
  message: RawMessage;
  updates: ReturnType<typeof collectToolUpdates>;
}): {
  nextRuntime: ReturnType<typeof getSessionRuntime>;
  nextMessages: RawMessage[];
} {
  const {
    state,
    sessionKey,
    runId,
    message,
    updates,
  } = params;
  const runtime = getSessionRuntime(state, sessionKey);
  const currentMessages = getSessionMessages(state, sessionKey);
  const currentStreamingMessage = findCurrentStreamingMessage(currentMessages, runtime.streamingMessageId);
  const currentStreamingText = getStreamingMessageText(currentStreamingMessage);
  const textUpdate = resolveStreamDeltaTextUpdate(currentStreamingText, message);
  const resolvedMessageId = (message.id || runtime.streamingMessageId || `stream:${runId}`).trim();
  const nextStreamingMessage = resolveStreamingMessage({
    previousMessage: currentStreamingMessage,
    incomingMessage: message,
    messageId: resolvedMessageId,
    targetText: resolveNextStreamingText(currentStreamingText, textUpdate),
    lastUserMessageAt: runtime.lastUserMessageAt,
  });
  const runtimePatch = reduceSessionRuntime(runtime, {
    type: 'stream_delta_queued',
    runId,
    messageId: resolvedMessageId,
    updates,
  });
  return {
    nextRuntime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
    nextMessages: upsertMessageById(currentMessages, nextStreamingMessage),
  };
}

export function handleRuntimeStartedEvent(input: RuntimeEventDispatchBaseInput): void {
  const { set, currentSessionKey, eventRunId } = input;
  set((state) => {
    const runtime = getSessionRuntime(state, currentSessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'run_started', runId: eventRunId });
    return {
      loadedSessions: patchSessionRecord(state, currentSessionKey, {
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
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'delta_received' });
    return {
      loadedSessions: patchSessionRecord(state, currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
  if (hasTokenContent(message)) {
    maybeTrackSendToFirstToken(currentSessionKey, 'delta');
  }
  const updates = collectToolUpdates(message, 'delta');
  set((state) => {
    const { nextRuntime, nextMessages } = buildNextStreamingState({
      state,
      sessionKey: currentSessionKey,
      runId: eventRunId || (getSessionRuntime(state, currentSessionKey).activeRunId ?? 'run'),
      message: (message as RawMessage | undefined) ?? { role: 'assistant', content: '' },
      updates,
    });
    return {
      loadedSessions: patchSessionRecord(state, currentSessionKey, {
        runtime: nextRuntime,
        window: syncViewportMessages(
          getSessionViewportState(state, currentSessionKey),
          nextMessages,
        ),
      }),
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
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'run_aborted' });
    return {
      loadedSessions: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
        window: syncViewportMessages(
          getSessionViewportState(state, state.currentSessionKey),
          removeMessageById(
            getSessionMessages(state, state.currentSessionKey),
            runtime.streamingMessageId,
          ),
        ),
      }),
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
      const { nextRuntime, nextMessages } = buildNextStreamingState({
        state,
        sessionKey,
        runId: runId || 'run',
        message: message as RawMessage,
        updates,
      });
      return {
        loadedSessions: patchSessionRecord(state, sessionKey, {
          runtime: nextRuntime,
          window: syncViewportMessages(
            getSessionViewportState(state, sessionKey),
            nextMessages,
          ),
        }),
      };
    });
  }
}
