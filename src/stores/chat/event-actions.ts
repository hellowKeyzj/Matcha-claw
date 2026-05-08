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
import {
  UNKNOWN_ABORTED_RUN_MARKER,
  type StoreSessionRunCache,
} from './session-run-cache';
import type { ChatStoreState } from './types';
import type {
  SessionItemChunkUpdateEvent,
  SessionItemUpdateEvent,
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
  sessionRunCache: StoreSessionRunCache;
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function applySessionLifecycleEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    targetSessionKey: string;
    currentSessionKey: string;
    event: Extract<SessionUpdateEvent, { sessionUpdate: 'session_info_update' }>;
  },
): void {
  const {
    set,
    get,
    targetSessionKey,
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

  if (shouldIgnoreRuntimeEvent({
    eventSessionKey,
    targetSessionKey,
  })) {
    return;
  }

  bindChatRunIdTelemetry(targetSessionKey, eventRunId);
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
    loadedSessions: patchSessionSnapshot(state, targetSessionKey, event.snapshot),
  }));

  if (event.phase === 'final') {
    finishChatRunTelemetry(targetSessionKey, 'completed', { stage: 'session_update_final' });
  } else if (event.phase === 'aborted') {
    finishChatRunTelemetry(targetSessionKey, 'aborted', { stage: 'session_update_aborted' });
  }
}

function shouldBlockAbortedRunEvent(input: {
  event: SessionUpdateEvent;
  eventRunId: string;
  targetSessionKey: string;
  targetRuntime: ReturnType<typeof getSessionRuntime>;
  sessionRunCache: StoreSessionRunCache;
}): boolean {
  const {
    event,
    eventRunId,
    targetSessionKey,
    targetRuntime,
    sessionRunCache,
  } = input;
  if (!eventRunId) {
    return false;
  }

  const abortedRunMarker = sessionRunCache.getAbortedRunMarker(targetSessionKey);
  if (!abortedRunMarker) {
    return false;
  }
  if (abortedRunMarker !== UNKNOWN_ABORTED_RUN_MARKER && abortedRunMarker !== eventRunId) {
    return false;
  }

  if (event.sessionUpdate === 'session_info_update' && event.phase === 'aborted') {
    if (abortedRunMarker === UNKNOWN_ABORTED_RUN_MARKER) {
      sessionRunCache.setAbortedRunMarker(targetSessionKey, eventRunId);
    }
    return false;
  }

  if (
    abortedRunMarker === UNKNOWN_ABORTED_RUN_MARKER
    && targetRuntime.sending
    && !targetRuntime.activeRunId
  ) {
    sessionRunCache.queueBlockedSessionUpdate(targetSessionKey, eventRunId, event);
  }
  return true;
}

function applySessionMessageEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    targetSessionKey: string;
    event: SessionItemChunkUpdateEvent | SessionItemUpdateEvent;
  },
): void {
  const {
    set,
    targetSessionKey,
    event,
  } = input;
  const hasAssistantOutput = event.item?.kind === 'assistant-turn'
    ? event.item.segments.some((segment) => {
        if (segment.kind === 'tool') {
          return true;
        }
        if (segment.kind === 'message' || segment.kind === 'thinking') {
          return segment.text.trim().length > 0;
        }
        return segment.images.length > 0 || segment.attachedFiles.length > 0;
      })
    : false;

  if (
    hasAssistantOutput
  ) {
    maybeTrackSendToFirstToken(
      targetSessionKey,
      event.sessionUpdate === 'session_item_chunk' ? 'delta' : 'final',
    );
  }

  set((state) => ({
      loadedSessions: patchSessionSnapshot(state, targetSessionKey, event.snapshot),
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
  const targetSessionKey = eventSessionKey || currentSessionKey;
  const eventRunId = normalizeIdentifier(sessionUpdate.runId);
  const targetRuntime = getSessionRuntime(stateBeforeHandle, targetSessionKey);

  if (shouldBlockAbortedRunEvent({
    event: sessionUpdate,
    eventRunId,
    targetSessionKey,
    targetRuntime,
    sessionRunCache: input.sessionRunCache,
  })) {
    return;
  }

  if (sessionUpdate.sessionUpdate === 'session_info_update') {
    if (eventRunId && targetRuntime.activeRunId && targetRuntime.activeRunId !== eventRunId) {
      return;
    }
    applySessionLifecycleEvent({
      set,
      get,
      sessionRunCache: input.sessionRunCache,
      targetSessionKey,
      currentSessionKey,
      event: sessionUpdate,
    });
    return;
  }

  if (
    sessionUpdate.sessionUpdate !== 'session_item_chunk'
    && sessionUpdate.sessionUpdate !== 'session_item'
  ) {
    return;
  }

  if (eventRunId && targetRuntime.activeRunId && targetRuntime.activeRunId !== eventRunId) {
    return;
  }

  if (shouldIgnoreRuntimeEvent({
    eventSessionKey,
    targetSessionKey,
  })) {
    return;
  }

  bindChatRunIdTelemetry(targetSessionKey, eventRunId);
  setLastChatEventAt(Date.now());

  applySessionMessageEvent({
    set,
    get,
    sessionRunCache: input.sessionRunCache,
    targetSessionKey,
    event: sessionUpdate,
  });

  if (sessionUpdate.sessionUpdate === 'session_item') {
    if (sessionUpdate.item?.kind === 'assistant-turn') {
      finishChatRunTelemetry(targetSessionKey, 'completed', { stage: 'session_update_message_final' });
      clearHistoryPoll();
    }
  }
}
