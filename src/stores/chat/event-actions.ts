import {
  syncActiveStreamPacer,
} from './stream-pacer';
import {
  reduceRuntimeOverlay,
} from './overlay-reducer';
import {
  clearHistoryPoll,
  setLastChatEventAt,
} from './timers';
import {
  handleRuntimeAbortedEvent,
  handleRuntimeDeltaEvent,
  handleRuntimeErrorEvent,
  handleRuntimeFinalEvent,
  handleRuntimeStartedEvent,
  handleRuntimeUnknownEvent,
} from './event-dispatch';
import {
  canRuntimeEventReuseActiveRunId,
  isUnboundLifecycleEvent,
  normalizeRuntimeEvent,
  isRuntimeEventUsefulForPolling,
  shouldIgnoreRuntimeEvent,
} from './event-routing';
import {
  beginFinalToHistoryTelemetry,
  bindChatRunIdTelemetry,
  finishChatRunTelemetry,
} from './telemetry';
import { getSessionRuntime, patchSessionRecord } from './store-state-helpers';
import type { ChatStoreState } from './types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreRuntimeEventActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
}

type StoreRuntimeEventActions = Pick<ChatStoreState, 'handleChatEvent'>;

export function createStoreEventActions(
  input: CreateStoreRuntimeEventActionsInput,
): StoreRuntimeEventActions {
  const { set, get } = input;

  return {
    handleChatEvent: (event: Record<string, unknown>) => {
      const normalizedEvent = normalizeRuntimeEvent(event);
      const {
        runId,
        eventSessionKey,
        kind,
        message,
      } = normalizedEvent;
      const { currentSessionKey } = get();
      const activeRunId = getSessionRuntime(get(), currentSessionKey).activeRunId;

      if (shouldIgnoreRuntimeEvent({
        activeRunId,
        currentSessionKey,
        runId,
        eventSessionKey,
      })) return;

      bindChatRunIdTelemetry(currentSessionKey, runId);
      setLastChatEventAt(Date.now());

      // Only pause the history poll when we receive actual streaming data.
      // The gateway sends "agent" events with { phase, startedAt } that carry
      // no message — these must NOT kill the poll, since the poll is our only
      // way to track progress when the gateway doesn't stream intermediate turns.
      if (isRuntimeEventUsefulForPolling(kind)) {
        clearHistoryPoll();
        // Adopt run started from another client (e.g. console at 127.0.0.1:18789):
        // show loading/streaming in the app when this session has an active run.
        set((state) => {
          const runtime = getSessionRuntime(state, currentSessionKey);
          const runtimePatch = reduceRuntimeOverlay(runtime, { type: 'run_started', runId });
          return {
            sessionsByKey: patchSessionRecord(state, currentSessionKey, {
              runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
            }),
          };
        });
        if (kind !== 'delta') {
          syncActiveStreamPacer(set, get);
        }
      }
      const eventRunId = runId || (canRuntimeEventReuseActiveRunId(kind) ? (activeRunId || '') : '');

      if (isUnboundLifecycleEvent(kind, runId)) {
        void get().loadHistory({
          sessionKey: currentSessionKey,
          mode: 'quiet',
          scope: 'foreground',
          reason: `unbound_${kind}_event_reconcile`,
        });
        syncActiveStreamPacer(set, get);
        return;
      }

      switch (kind) {
        case 'started': {
          handleRuntimeStartedEvent({
            set,
            get,
            event,
            message,
            currentSessionKey,
            eventRunId,
          });
          break;
        }
        case 'delta': {
          handleRuntimeDeltaEvent({
            set,
            get,
            event,
            message,
            currentSessionKey,
            eventRunId,
          });
          break;
        }
        case 'final': {
          handleRuntimeFinalEvent({
            set,
            get,
            event,
            message,
            currentSessionKey,
            eventRunId,
            onBeginFinalToHistory: () => {
              beginFinalToHistoryTelemetry(currentSessionKey);
            },
          });
          break;
        }
        case 'error': {
          handleRuntimeErrorEvent({
            set,
            get,
            event,
            message,
            currentSessionKey,
            eventRunId,
            onFinishFailedTelemetry: (errorMsg) => {
              finishChatRunTelemetry(currentSessionKey, 'failed', { stage: 'event_error', error: errorMsg });
            },
          });
          break;
        }
        case 'aborted': {
          handleRuntimeAbortedEvent({
            set,
            get,
            event,
            message,
            currentSessionKey,
            eventRunId,
            onFinishAbortedTelemetry: () => {
              finishChatRunTelemetry(currentSessionKey, 'aborted', { stage: 'event_aborted' });
            },
          });
          break;
        }
        default: {
          handleRuntimeUnknownEvent({
            set,
            get,
            event,
            message,
            eventState: normalizedEvent.eventState,
            currentSessionKey,
            eventRunId,
          });
          break;
        }
      }
      syncActiveStreamPacer(set, get);
    },
  };
}
