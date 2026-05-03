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
  getSessionTimelineEntries,
  patchSessionRecord,
  patchSessionTimelineAndViewport,
  upsertSessionTimelineEntry,
} from './store-state-helpers';
import type { ChatStoreState } from './types';
import type {
  SessionMessageChunkUpdateEvent,
  SessionMessageUpdateEvent,
  SessionUpdateEvent,
} from '../../../runtime-host/shared/session-adapter-types';

type ChatStoreSetFn = (
  partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState),
  replace?: false,
) => void;

type ChatStoreGetFn = () => ChatStoreState;

interface BufferedSessionUpdateEvent {
  sequenceId: number;
  event: SessionMessageChunkUpdateEvent | SessionMessageUpdateEvent;
}

interface CreateStoreRuntimeEventActionsInput {
  set: ChatStoreSetFn;
  get: ChatStoreGetFn;
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSequenceId(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}

function buildSessionUpdateSequenceKey(
  event: SessionMessageChunkUpdateEvent | SessionMessageUpdateEvent,
): string | null {
  const sessionKey = normalizeIdentifier(event.sessionKey);
  const laneKey = normalizeIdentifier(event.entry?.laneKey);
  const turnKey = normalizeIdentifier(event.entry?.turnKey);
  const role = normalizeIdentifier(event.entry?.role);
  if (!sessionKey || !laneKey || !turnKey || !role) {
    return null;
  }
  return [sessionKey, laneKey, turnKey, role].join('|');
}

function readBufferedSessionUpdateEvents(
  runtime: ReturnType<typeof getSessionRuntime>,
  sequenceKey: string,
): BufferedSessionUpdateEvent[] {
  const buffered = runtime.bufferedMessageEventsByKey?.[sequenceKey];
  if (!Array.isArray(buffered)) {
    return [];
  }
  return buffered
    .map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return null;
      }
      const record = item as Record<string, unknown>;
      const sequenceId = normalizeSequenceId(record.sequenceId);
      const event = record.event;
      if (sequenceId == null || !event || typeof event !== 'object' || Array.isArray(event)) {
        return null;
      }
      const sessionUpdate = (event as { sessionUpdate?: unknown }).sessionUpdate;
      if (sessionUpdate !== 'agent_message_chunk' && sessionUpdate !== 'agent_message') {
        return null;
      }
      return {
        sequenceId,
        event: event as SessionMessageChunkUpdateEvent | SessionMessageUpdateEvent,
      } satisfies BufferedSessionUpdateEvent;
    })
    .filter((item): item is BufferedSessionUpdateEvent => item != null)
    .sort((left, right) => left.sequenceId - right.sequenceId);
}

function writeBufferedSessionUpdateEvents(
  runtime: ReturnType<typeof getSessionRuntime>,
  sequenceKey: string,
  bufferedEvents: BufferedSessionUpdateEvent[],
): Pick<ReturnType<typeof getSessionRuntime>, 'bufferedMessageEventsByKey'> {
  const nextBufferedByKey = { ...(runtime.bufferedMessageEventsByKey ?? {}) };
  if (bufferedEvents.length === 0) {
    delete nextBufferedByKey[sequenceKey];
  } else {
    nextBufferedByKey[sequenceKey] = bufferedEvents.map((item) => ({
      sequenceId: item.sequenceId,
      event: item.event,
    }));
  }
  return {
    bufferedMessageEventsByKey: nextBufferedByKey,
  };
}

function writePendingMessageSequence(
  runtime: ReturnType<typeof getSessionRuntime>,
  sequenceKey: string,
  nextSequenceId: number,
): Pick<ReturnType<typeof getSessionRuntime>, 'pendingMessageSequenceByKey'> {
  return {
    pendingMessageSequenceByKey: {
      ...(runtime.pendingMessageSequenceByKey ?? {}),
      [sequenceKey]: nextSequenceId,
    },
  };
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
    loadedSessions: patchSessionRecord(state, currentSessionKey, {
      runtime: {
        ...getSessionRuntime(state, currentSessionKey),
        sending: event.runtime.sending,
        activeRunId: event.runtime.activeRunId,
        runPhase: event.runtime.runPhase,
        streamingMessageId: event.runtime.streamingMessageId,
        pendingFinal: event.runtime.pendingFinal,
        lastUserMessageAt: event.runtime.lastUserMessageAt,
      },
    }),
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
    event: SessionMessageChunkUpdateEvent | SessionMessageUpdateEvent;
  },
): void {
  const {
    set,
    currentSessionKey,
    event,
  } = input;

  const authoritativeEntry = {
    ...event.entry,
    message: {
      ...event.entry.message,
      id: event.entry.message.id ?? event.entry.entryId,
    },
  };

  if (
    authoritativeEntry.role === 'assistant'
    && typeof authoritativeEntry.text === 'string'
    && authoritativeEntry.text.trim()
  ) {
    maybeTrackSendToFirstToken(
      currentSessionKey,
      event.sessionUpdate === 'agent_message_chunk' ? 'delta' : 'final',
    );
  }

  set((state) => {
    const nextTimelineEntries = upsertSessionTimelineEntry(
      getSessionTimelineEntries(state, currentSessionKey),
      authoritativeEntry,
    );
    return {
      error: null,
      loadedSessions: patchSessionRecord(
        {
          loadedSessions: patchSessionTimelineAndViewport(
            state,
            currentSessionKey,
            nextTimelineEntries,
            {
              totalMessageCount: event.window.totalEntryCount,
              windowStartOffset: event.window.windowStartOffset,
              windowEndOffset: event.window.windowEndOffset,
              hasMore: event.window.hasMore,
              hasNewer: event.window.hasNewer,
              isAtLatest: event.window.isAtLatest,
            },
          ),
        },
        currentSessionKey,
        {
          runtime: {
            ...getSessionRuntime(state, currentSessionKey),
            sending: event.runtime.sending,
            activeRunId: event.runtime.activeRunId,
            runPhase: event.runtime.runPhase,
            streamingMessageId: event.runtime.streamingMessageId,
            pendingFinal: event.runtime.pendingFinal,
            lastUserMessageAt: event.runtime.lastUserMessageAt,
          },
        },
      ),
    };
  });
}

function dispatchBufferedOrDirectSessionMessageEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    currentSessionKey: string;
    event: SessionMessageChunkUpdateEvent | SessionMessageUpdateEvent;
  },
): void {
  const { set, currentSessionKey, event } = input;
  const sequenceKey = buildSessionUpdateSequenceKey(event);
  const sequenceId = normalizeSequenceId(event.entry.sequenceId);

  if (sequenceKey && sequenceId != null) {
    set((state) => {
      const runtime = getSessionRuntime(state, currentSessionKey);
      const expectedSequenceId = runtime.pendingMessageSequenceByKey?.[sequenceKey] ?? 1;
      const existingBuffered = readBufferedSessionUpdateEvents(runtime, sequenceKey);
      const deduped = existingBuffered.filter((item) => item.sequenceId !== sequenceId);
      const nextBuffered = [...deduped, { sequenceId, event }].sort((left, right) => left.sequenceId - right.sequenceId);

      let nextExpectedSequenceId = expectedSequenceId;
      const remaining: BufferedSessionUpdateEvent[] = [];
      const drainedEvents: Array<SessionMessageChunkUpdateEvent | SessionMessageUpdateEvent> = [];
      for (const item of nextBuffered) {
        if (item.sequenceId === nextExpectedSequenceId) {
          drainedEvents.push(item.event);
          nextExpectedSequenceId += 1;
          continue;
        }
        remaining.push(item);
      }

      if (drainedEvents.length === 0) {
        return {
          loadedSessions: patchSessionRecord(state, currentSessionKey, {
            runtime: {
              ...runtime,
              ...writeBufferedSessionUpdateEvents(runtime, sequenceKey, nextBuffered),
              ...writePendingMessageSequence(runtime, sequenceKey, expectedSequenceId),
            },
          }),
        };
      }

      let workingState = state;
      let workingRuntime = runtime;
      for (const drainedEvent of drainedEvents) {
        applySessionMessageEvent({
          set: (partial) => {
            const patch = typeof partial === 'function' ? partial(workingState) : partial;
            workingState = { ...workingState, ...patch } as ChatStoreState;
          },
          get: () => workingState,
          currentSessionKey,
          event: drainedEvent,
        });
        workingRuntime = getSessionRuntime(workingState, currentSessionKey);
      }

      return {
        loadedSessions: patchSessionRecord(workingState, currentSessionKey, {
          runtime: {
            ...workingRuntime,
            ...writeBufferedSessionUpdateEvents(workingRuntime, sequenceKey, remaining),
            ...writePendingMessageSequence(workingRuntime, sequenceKey, nextExpectedSequenceId),
          },
        }),
      };
    });
    return;
  }

  applySessionMessageEvent(input);
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
    sessionUpdate.sessionUpdate !== 'agent_message_chunk'
    && sessionUpdate.sessionUpdate !== 'agent_message'
  ) {
    return;
  }
  if (!sessionUpdate.entry || !sessionUpdate.entry.message) {
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

  dispatchBufferedOrDirectSessionMessageEvent({
    set,
    get,
    currentSessionKey,
    event: sessionUpdate,
  });

  if (sessionUpdate.sessionUpdate === 'agent_message') {
    const role = normalizeIdentifier(sessionUpdate.entry.role);
    if (role === 'assistant') {
      finishChatRunTelemetry(currentSessionKey, 'completed', { stage: 'session_update_message_final' });
      clearHistoryPoll();
    }
  }
}
