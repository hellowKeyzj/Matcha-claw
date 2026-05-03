import {
  clearHistoryPoll,
  setLastChatEventAt,
} from './timers';
import {
  bindChatRunIdTelemetry,
  finishChatRunTelemetry,
  maybeTrackSendToFirstToken,
} from './telemetry';
import {
  isUnboundLifecycleEvent,
  shouldIgnoreRuntimeEvent,
} from './event-routing';
import {
  getSessionRuntime,
  patchSessionSnapshot,
} from './store-state-helpers';
import type { ChatStoreState } from './types';
import type {
  SessionRowChunkUpdateEvent,
  SessionRowUpdateEvent,
  SessionUpdateEvent,
} from '../../../runtime-host/shared/session-adapter-types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface CreateStoreRuntimeEventActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function applySessionLifecycleEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    currentSessionKey: string;
    event: Extract<SessionUpdateEvent, { sessionUpdate: 'session_info_update' }>;
  },
): void {
  const {
    set,
    get,
    currentSessionKey,
    event,
  } = input;

  const eventSessionKey = normalizeIdentifier(event.sessionKey);
  const eventRunId = normalizeIdentifier(event.runId);
  const stateBeforeHandle = get();

  if (
    eventSessionKey
    && (
      event.phase === 'started'
      || event.phase === 'final'
      || event.phase === 'error'
      || event.phase === 'aborted'
    )
    && (
      eventSessionKey !== currentSessionKey
      || !Object.prototype.hasOwnProperty.call(stateBeforeHandle.loadedSessions, eventSessionKey)
    )
  ) {
    void stateBeforeHandle.loadSessions();
  }

  if (
    (event.phase === 'error' || event.phase === 'aborted')
    && (
      !eventSessionKey
      || eventSessionKey === currentSessionKey
      || (eventRunId && getSessionRuntime(stateBeforeHandle, currentSessionKey).activeRunId === eventRunId)
    )
  ) {
    void stateBeforeHandle.loadHistory({
      sessionKey: currentSessionKey,
      mode: 'quiet',
      scope: 'foreground',
      reason: 'session_runtime_lifecycle_reconcile',
    });
  }

  const activeRunId = getSessionRuntime(stateBeforeHandle, currentSessionKey).activeRunId;
  if (shouldIgnoreRuntimeEvent({
    activeRunId,
    currentSessionKey,
    runId: eventRunId,
    eventSessionKey,
  })) {
    return;
  }

  bindChatRunIdTelemetry(currentSessionKey, eventRunId);
  setLastChatEventAt(Date.now());

  if (event.phase === 'final' || event.phase === 'error' || event.phase === 'aborted') {
    clearHistoryPoll();
  }

  if (isUnboundLifecycleEvent(event.phase, eventRunId)) {
    void get().loadHistory({
      sessionKey: currentSessionKey,
      mode: 'quiet',
      scope: 'foreground',
      reason: `session_runtime_unbound_${event.phase}_reconcile`,
    });
    return;
  }

  set((state) => ({
    error: event.phase === 'started' || event.phase === 'final' ? null : state.error,
    loadedSessions: patchSessionSnapshot(state, currentSessionKey, event.snapshot),
  }));

  if (event.phase === 'final') {
    finishChatRunTelemetry(currentSessionKey, 'completed', { stage: 'session_update_final' });
  } else if (event.phase === 'aborted') {
    finishChatRunTelemetry(currentSessionKey, 'aborted', { stage: 'session_update_aborted' });
  }
}

function applySessionMessageEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    currentSessionKey: string;
    event: SessionRowChunkUpdateEvent | SessionRowUpdateEvent;
  },
): void {
  const {
    set,
    currentSessionKey,
    event,
  } = input;

  if (
    event.row?.role === 'assistant'
    && event.row.kind === 'message'
    && event.row.text.trim()
  ) {
    maybeTrackSendToFirstToken(
      currentSessionKey,
      event.sessionUpdate === 'session_row_chunk' ? 'delta' : 'final',
    );
  }

  set((state) => ({
      error: null,
      loadedSessions: patchSessionSnapshot(state, currentSessionKey, event.snapshot),
  }));
}

export function handleStoreSessionUpdateEvent(
  input: CreateStoreRuntimeEventActionsInput,
  sessionUpdate: SessionUpdateEvent,
): void {
  if (!sessionUpdate || typeof sessionUpdate !== 'object') {
    return;
  }

  const { set, get } = input;
  const stateBeforeHandle = get();
  const currentSessionKey = stateBeforeHandle.currentSessionKey;
  const eventSessionKey = normalizeIdentifier(sessionUpdate.sessionKey);
  const eventRunId = normalizeIdentifier(sessionUpdate.runId);
  const activeRunId = getSessionRuntime(stateBeforeHandle, currentSessionKey).activeRunId;

  if (sessionUpdate.sessionUpdate === 'session_info_update') {
    applySessionLifecycleEvent({
      set,
      get,
      currentSessionKey,
      event: sessionUpdate,
    });
    return;
  }

  if (
    sessionUpdate.sessionUpdate !== 'session_row_chunk'
    && sessionUpdate.sessionUpdate !== 'session_row'
  ) {
    return;
  }

  if (shouldIgnoreRuntimeEvent({
    activeRunId,
    currentSessionKey,
    runId: eventRunId,
    eventSessionKey,
  })) {
    return;
  }

  bindChatRunIdTelemetry(currentSessionKey, eventRunId);
  setLastChatEventAt(Date.now());

  applySessionMessageEvent({
    set,
    get,
    currentSessionKey,
    event: sessionUpdate,
  });

  if (sessionUpdate.sessionUpdate === 'session_row') {
    const role = normalizeIdentifier(sessionUpdate.row?.role);
    if (role === 'assistant') {
      finishChatRunTelemetry(currentSessionKey, 'completed', { stage: 'session_update_message_final' });
      clearHistoryPoll();
    }
  }
}
