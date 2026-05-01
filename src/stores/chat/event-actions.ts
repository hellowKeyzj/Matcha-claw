import { reduceSessionRuntime } from './runtime-state-reducer';
import {
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  setLastChatEventAt,
} from './timers';
import {
  canRuntimeEventReuseActiveRunId,
  isRuntimeEventUsefulForPolling,
  isUnboundLifecycleEvent,
  shouldIgnoreRuntimeEvent,
} from './event-routing';
import { getMessageText, normalizeIncomingMessage } from './message-helpers';
import { collectToolUpdates, upsertToolStatuses } from './event-helpers';
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
import {
  bindChatRunIdTelemetry,
  finishChatRunTelemetry,
  maybeTrackSendToFirstToken,
} from './telemetry';
import {
  getSessionMessages,
  getSessionRuntime,
  getSessionTooling,
  patchSessionMessagesAndViewport,
  patchSessionRecord,
} from './store-state-helpers';
import type {
  ChatHistoryLoadMode,
  ChatRuntimeEventPhase,
  ChatStoreState,
  RawMessage,
} from './types';
import {
  findCurrentStreamingMessage,
  getStreamingMessageText,
  removeMessageById,
  resolveNextStreamingText,
  resolveStreamingMessage,
  upsertMessageById,
} from './streaming-message';
import { asRecord } from './value';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

type ConversationEventKind = 'chat.message' | 'chat.runtime.lifecycle';

interface NormalizedConversationIngressEvent {
  kind: ConversationEventKind;
  phase: ChatRuntimeEventPhase;
  runId: string;
  sessionKey: string | null;
  event: Record<string, unknown>;
  message: unknown;
}

interface CreateStoreRuntimeEventActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
}

interface RuntimeEventDispatchBaseInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
  event: Record<string, unknown>;
  message: unknown;
  currentSessionKey: string;
  eventRunId: string;
}

interface RuntimeEventFinalDispatchInput extends RuntimeEventDispatchBaseInput {
  historyLoadModeOnMissingMessage?: ChatHistoryLoadMode;
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

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRuntimeEventMessage(
  message: unknown,
  event: Record<string, unknown>,
): RawMessage | undefined {
  const candidate = asRecord(message);
  if (!candidate) {
    return undefined;
  }
  return normalizeIncomingMessage(candidate as unknown as RawMessage, {
    fallbackId: normalizeIdentifier(event.id || event.messageId) || null,
  });
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
  nextTooling: ReturnType<typeof getSessionTooling>;
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
  const tooling = getSessionTooling(state, sessionKey);
  const currentMessages = getSessionMessages(state, sessionKey);
  const currentStreamingMessage = findCurrentStreamingMessage(currentMessages, runtime.streamingMessageId);
  const currentStreamingText = getStreamingMessageText(currentStreamingMessage);
  const textUpdate = resolveStreamDeltaTextUpdate(currentStreamingText, message);
  const resolvedMessageId = (
    message.id
    || message.messageId
    || runtime.streamingMessageId
    || `stream:${runId}`
  ).trim();
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
  });
  return {
    nextRuntime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
    nextTooling: updates.length > 0
      ? { ...tooling, streamingTools: upsertToolStatuses(tooling.streamingTools, updates) }
      : tooling,
    nextMessages: upsertMessageById(currentMessages, nextStreamingMessage),
  };
}

function normalizeConversationIngressEvent(
  event: Record<string, unknown>,
): NormalizedConversationIngressEvent | null {
  const kind = event.kind;
  if (kind !== 'chat.message' && kind !== 'chat.runtime.lifecycle') {
    return null;
  }
  const phase = event.phase;
  if (
    phase !== 'started'
    && phase !== 'delta'
    && phase !== 'final'
    && phase !== 'error'
    && phase !== 'aborted'
    && phase !== 'unknown'
  ) {
    return null;
  }
  const payload = event.event;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const payloadRecord = payload as Record<string, unknown>;
  const normalizedMessage = normalizeRuntimeEventMessage(payloadRecord.message, payloadRecord);
  return {
    kind,
    phase,
    runId: normalizeIdentifier(event.runId),
    sessionKey: normalizeIdentifier(event.sessionKey) || null,
    event: normalizedMessage
      ? { ...payloadRecord, message: normalizedMessage }
      : payloadRecord,
    message: normalizedMessage,
  };
}

function markRuntimePollingActivity(
  set: ChatStoreSetFn,
  currentSessionKey: string,
  runId: string,
): void {
  clearHistoryPoll();
  set((state) => {
    const runtime = getSessionRuntime(state, currentSessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, {
      type: 'run_started',
      runId,
    });
    return {
      loadedSessions: patchSessionRecord(state, currentSessionKey, {
        runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
      }),
    };
  });
}

function handleRuntimeStartedEvent(input: RuntimeEventDispatchBaseInput): void {
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

function handleRuntimeDeltaEvent(input: RuntimeEventDispatchBaseInput): void {
  const {
    set,
    get,
    message,
    currentSessionKey,
    eventRunId,
  } = input;

  clearErrorRecoveryTimer();
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
    const { nextRuntime, nextTooling, nextMessages } = buildNextStreamingState({
      state,
      sessionKey: currentSessionKey,
      runId: eventRunId || (getSessionRuntime(state, currentSessionKey).activeRunId ?? 'run'),
      message: (message as RawMessage | undefined) ?? { role: 'assistant', content: '' },
      updates,
    });
    return {
      loadedSessions: patchSessionRecord(
        { loadedSessions: patchSessionMessagesAndViewport(state, currentSessionKey, nextMessages) },
        currentSessionKey,
        { runtime: nextRuntime, tooling: nextTooling },
      ),
    };
  });
  armToolSnapshotTxnState(
    currentSessionKey,
    eventRunId,
    message,
  );
}

function handleRuntimeFinalEvent(input: RuntimeEventFinalDispatchInput): void {
  const {
    set,
    get,
    event,
    currentSessionKey,
    eventRunId,
    historyLoadModeOnMissingMessage,
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
    historyLoadModeOnMissingMessage,
  });
}

function handleRuntimeErrorEvent(input: RuntimeEventErrorDispatchInput): void {
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

function handleRuntimeAbortedEvent(input: RuntimeEventAbortedDispatchInput): void {
  const { set, onFinishAbortedTelemetry } = input;
  resetToolSnapshotTxnState();
  clearHistoryPoll();
  clearErrorRecoveryTimer();
  onFinishAbortedTelemetry();
  set((state) => {
    const runtime = getSessionRuntime(state, state.currentSessionKey);
    const tooling = getSessionTooling(state, state.currentSessionKey);
    const runtimePatch = reduceSessionRuntime(runtime, { type: 'run_aborted' });
    return {
      loadedSessions: patchSessionRecord(
        {
          loadedSessions: patchSessionMessagesAndViewport(
            state,
            state.currentSessionKey,
            removeMessageById(
              getSessionMessages(state, state.currentSessionKey),
              runtime.streamingMessageId,
            ),
          ),
        },
        state.currentSessionKey,
        {
          runtime: runtimePatch === runtime ? runtime : { ...runtime, ...runtimePatch },
          tooling: {
            ...tooling,
            streamingTools: [],
            pendingToolImages: [],
          },
        },
      ),
    };
  });
}

function handleRuntimeUnknownEvent(input: RuntimeEventUnknownDispatchInput): void {
  const { set, get, message } = input;
  const runtime = getSessionRuntime(get(), get().currentSessionKey);
  if (runtime.sending && message && typeof message === 'object') {
    const updates = collectToolUpdates(message, 'delta');
    const sessionKey = get().currentSessionKey;
    const runId = getSessionRuntime(get(), sessionKey).activeRunId ?? '';
    set((state) => {
      const { nextRuntime, nextTooling, nextMessages } = buildNextStreamingState({
        state,
        sessionKey,
        runId: runId || 'run',
        message: message as RawMessage,
        updates,
      });
      return {
        loadedSessions: patchSessionRecord(
          { loadedSessions: patchSessionMessagesAndViewport(state, sessionKey, nextMessages) },
          sessionKey,
          { runtime: nextRuntime, tooling: nextTooling },
        ),
      };
    });
  }
}

export function handleStoreConversationEvent(
  input: CreateStoreRuntimeEventActionsInput,
  incomingEvent: Record<string, unknown>,
): void {
  const { set, get } = input;

  const normalizedEvent = normalizeConversationIngressEvent(incomingEvent);
  if (!normalizedEvent) {
    return;
  }

  const stateBeforeHandle = get();
  if (
    normalizedEvent.kind === 'chat.runtime.lifecycle'
    && normalizedEvent.sessionKey
    && (
      normalizedEvent.phase === 'started'
      || normalizedEvent.phase === 'final'
      || normalizedEvent.phase === 'error'
      || normalizedEvent.phase === 'aborted'
    )
    && (
      normalizedEvent.sessionKey !== stateBeforeHandle.currentSessionKey
      || !Object.prototype.hasOwnProperty.call(stateBeforeHandle.loadedSessions, normalizedEvent.sessionKey)
    )
  ) {
    void stateBeforeHandle.loadSessions();
  }
  if (
    normalizedEvent.kind === 'chat.runtime.lifecycle'
    && (normalizedEvent.phase === 'error' || normalizedEvent.phase === 'aborted')
  ) {
    const currentRuntime = getSessionRuntime(stateBeforeHandle, stateBeforeHandle.currentSessionKey);
    const matchesCurrentSession = (
      normalizedEvent.sessionKey == null
      || normalizedEvent.sessionKey === stateBeforeHandle.currentSessionKey
    );
    const matchesActiveRun = (
      Boolean(normalizedEvent.runId)
      && currentRuntime.activeRunId != null
      && normalizedEvent.runId === currentRuntime.activeRunId
    );
    if (matchesCurrentSession || matchesActiveRun || normalizedEvent.sessionKey == null) {
      void stateBeforeHandle.loadHistory({
        sessionKey: stateBeforeHandle.currentSessionKey,
        mode: 'quiet',
        scope: 'foreground',
        reason: 'gateway_runtime_phase_refresh',
      });
    }
  }

  const { currentSessionKey } = get();
  const activeRunId = getSessionRuntime(get(), currentSessionKey).activeRunId;

  if (shouldIgnoreRuntimeEvent({
    activeRunId,
    currentSessionKey,
    runId: normalizedEvent.runId,
    eventSessionKey: normalizedEvent.sessionKey,
  })) {
    return;
  }

  bindChatRunIdTelemetry(currentSessionKey, normalizedEvent.runId);
  setLastChatEventAt(Date.now());

  const isChatMessage = normalizedEvent.kind === 'chat.message';
  if (isChatMessage && isRuntimeEventUsefulForPolling(normalizedEvent.phase)) {
    markRuntimePollingActivity(set, currentSessionKey, normalizedEvent.runId);
  } else if (!isChatMessage && (
    normalizedEvent.phase === 'final'
    || normalizedEvent.phase === 'error'
    || normalizedEvent.phase === 'aborted'
  )) {
    clearHistoryPoll();
  }

  if (isUnboundLifecycleEvent(normalizedEvent.phase, normalizedEvent.runId)) {
    void get().loadHistory({
      sessionKey: currentSessionKey,
      mode: 'quiet',
      scope: 'foreground',
      reason: isChatMessage
        ? `unbound_${normalizedEvent.phase}_event_reconcile`
        : `unbound_${normalizedEvent.phase}_lifecycle_reconcile`,
    });
    return;
  }

  const eventRunId = normalizedEvent.runId || (
    isChatMessage && canRuntimeEventReuseActiveRunId(normalizedEvent.phase)
      ? (activeRunId || '')
      : ''
  );
  const normalizedMessage = isChatMessage ? normalizedEvent.message : undefined;
  switch (normalizedEvent.phase) {
    case 'started':
      handleRuntimeStartedEvent({
        set,
        get,
        event: normalizedEvent.event,
        message: normalizedMessage,
        currentSessionKey,
        eventRunId,
      });
      return;
    case 'delta':
      handleRuntimeDeltaEvent({
        set,
        get,
        event: normalizedEvent.event,
        message: normalizedMessage,
        currentSessionKey,
        eventRunId,
      });
      return;
    case 'final':
      handleRuntimeFinalEvent({
        set,
        get,
        event: normalizedEvent.event,
        message: normalizedMessage,
        currentSessionKey,
        eventRunId,
        historyLoadModeOnMissingMessage: normalizedEvent.kind === 'chat.runtime.lifecycle' ? 'quiet' : 'active',
      });
      return;
    case 'error':
      handleRuntimeErrorEvent({
        set,
        get,
        event: normalizedEvent.event,
        message: normalizedMessage,
        currentSessionKey,
        eventRunId,
        onFinishFailedTelemetry: (errorMsg) => {
          finishChatRunTelemetry(currentSessionKey, 'failed', {
            stage: normalizedEvent.kind === 'chat.runtime.lifecycle' ? 'runtime_phase_error' : 'event_error',
            error: errorMsg,
          });
        },
      });
      return;
    case 'aborted':
      handleRuntimeAbortedEvent({
        set,
        get,
        event: normalizedEvent.event,
        message: normalizedMessage,
        currentSessionKey,
        eventRunId,
        onFinishAbortedTelemetry: () => {
          finishChatRunTelemetry(currentSessionKey, 'aborted', {
            stage: normalizedEvent.kind === 'chat.runtime.lifecycle' ? 'runtime_phase_aborted' : 'event_aborted',
          });
        },
      });
      return;
    default:
      handleRuntimeUnknownEvent({
        set,
        get,
        event: normalizedEvent.event,
        message: normalizedMessage,
        eventState: normalizedEvent.phase,
        currentSessionKey,
        eventRunId,
      });
  }
}
