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
import { getSessionRuntime, patchSessionRecord } from './store-state-helpers';
import type { ChatStoreState, RawMessage } from './types';

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
    const runtimePatch = reduceRuntimeOverlay(runtime, {
      type: 'stream_delta_queued',
      runId: eventRunId,
      text: getMessageText((message as RawMessage | undefined)?.content),
      messageId: (message as RawMessage | undefined)?.id,
      message: (message as RawMessage | undefined) ?? null,
      updates,
    });
    return {
      sessionsByKey: patchSessionRecord(state, currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
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
    const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'run_aborted' });
    return {
      sessionsByKey: patchSessionRecord(state, state.currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
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
      const currentRuntime = getSessionRuntime(state, sessionKey);
      const runtimePatch = reduceRuntimeOverlay(currentRuntime, {
        type: 'stream_delta_queued',
        runId,
        text: getMessageText((message as RawMessage).content),
        messageId: (message as RawMessage).id,
        message: message as RawMessage,
        updates,
      });
      return {
        sessionsByKey: patchSessionRecord(state, sessionKey, {
          runtime: runtimePatch === currentRuntime ? currentRuntime : { ...currentRuntime, ...runtimePatch },
        }),
      };
    });
  }
}
