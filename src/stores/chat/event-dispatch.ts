import { getMessageText } from './message-helpers';
import {
  clearPendingStreamFinalCommit,
} from './stream-pacer';
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
  const { set, eventRunId } = input;
  set((state) => reduceRuntimeOverlay(state, { type: 'run_started', runId: eventRunId }));
}

export function handleRuntimeDeltaEvent(input: RuntimeEventDispatchBaseInput): void {
  const {
    set,
    message,
    currentSessionKey,
    eventRunId,
  } = input;

  if (hasErrorRecoveryTimer()) {
    clearErrorRecoveryTimer();
  }
  set((state) => reduceRuntimeOverlay(state, { type: 'delta_received' }));
  if (hasTokenContent(message)) {
    maybeTrackSendToFirstToken(currentSessionKey, 'delta');
  }
  const updates = collectToolUpdates(message, 'delta');
  set((state) => reduceRuntimeOverlay(state, {
    type: 'stream_delta_queued',
    sessionKey: currentSessionKey,
    runId: eventRunId,
    text: getMessageText((message as RawMessage | undefined)?.content),
    updates,
  }));
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
  const { set, get, onFinishAbortedTelemetry } = input;
  resetToolSnapshotTxnState();
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  onFinishAbortedTelemetry();
  clearPendingStreamFinalCommit(get().currentSessionKey, get().activeRunId);
  set((state) => reduceRuntimeOverlay(state, { type: 'run_aborted' }));
}

export function handleRuntimeUnknownEvent(input: RuntimeEventUnknownDispatchInput): void {
  const { set, get, message } = input;
  const { sending } = get();
  if (sending && message && typeof message === 'object') {
    const updates = collectToolUpdates(message, 'delta');
    set((state) => reduceRuntimeOverlay(state, {
      type: 'stream_delta_queued',
      sessionKey: get().currentSessionKey,
      runId: get().activeRunId ?? '',
      text: getMessageText((message as RawMessage).content),
      updates,
    }));
  }
}
