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
import { useTaskSnapshotStore } from './task-snapshot-store';
import {
  logRendererTodoToolDebug,
  summarizeAssistantTurnForTodoToolDebug,
  summarizeItemsForTodoToolDebug,
  summarizeSnapshotForTodoToolDebug,
} from './todo-tool-debug';
import type { StoreHistoryCache } from './history-cache';
import type { ChatStoreState } from './types';
import type {
  SessionItemChunkUpdateEvent,
  SessionItemUpdateEvent,
  SessionStateSnapshot,
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
  historyRuntime: StoreHistoryCache;
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function patchSessionSnapshotWithTodoToolDebug(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  sessionKey: string,
  snapshot: SessionStateSnapshot,
  source: string,
): Record<string, ChatStoreState['loadedSessions'][string]> {
  const beforeItems = state.loadedSessions[sessionKey]?.items ?? [];
  logRendererTodoToolDebug('renderer.patch.before', {
    source,
    sessionKey,
    beforeItems: summarizeItemsForTodoToolDebug(beforeItems),
    incomingSnapshot: summarizeSnapshotForTodoToolDebug(snapshot),
  });
  const nextLoadedSessions = patchSessionSnapshot(state, sessionKey, snapshot);
  const afterItems = nextLoadedSessions[sessionKey]?.items ?? [];
  logRendererTodoToolDebug('renderer.patch.after', {
    source,
    sessionKey,
    afterItems: summarizeItemsForTodoToolDebug(afterItems),
  });
  return nextLoadedSessions;
}

function collectAssistantTurnToolCallIds(event: SessionItemChunkUpdateEvent | SessionItemUpdateEvent): string[] {
  if (event.item?.kind !== 'assistant-turn') {
    return [];
  }
  return event.item.segments
    .filter((segment) => segment.kind === 'tool')
    .map((segment) => segment.tool.toolCallId ?? segment.tool.id)
    .filter((value) => value.trim().length > 0);
}

function reconcileTerminalToolResultsIfNeeded(input: {
  get: ChatStoreGetFn;
  historyRuntime: StoreHistoryCache;
  sessionKey: string;
}): void {
  const { get, historyRuntime, sessionKey } = input;
  const target = historyRuntime.consumeTerminalHistoryReconcileNeeded(sessionKey);
  if (!target) {
    return;
  }
  void get().loadTurnToolResults(target);
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
    historyRuntime,
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

  if (event.phase === 'started') {
    historyRuntime.resetTerminalHistoryReconcile(targetSessionKey);
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
    loadedSessions: patchSessionSnapshotWithTodoToolDebug(
      state,
      targetSessionKey,
      event.snapshot,
      'session_info_update',
    ),
  }));

  if (event.phase === 'final') {
    finishChatRunTelemetry(targetSessionKey, 'completed', { stage: 'session_update_final' });
    reconcileTerminalToolResultsIfNeeded({
      get,
      historyRuntime,
      sessionKey: targetSessionKey,
    });
  } else if (event.phase === 'aborted') {
    finishChatRunTelemetry(targetSessionKey, 'aborted', { stage: 'session_update_aborted' });
  }
}

function applySessionMessageEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    targetSessionKey: string;
    event: SessionItemChunkUpdateEvent | SessionItemUpdateEvent;
  },
): void {
  const {
    set,
    historyRuntime,
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

  const toolCallIds = collectAssistantTurnToolCallIds(event);
  if (toolCallIds.length > 0 && event.item?.kind === 'assistant-turn') {
    historyRuntime.markTerminalHistoryReconcileNeeded({
      sessionKey: targetSessionKey,
      ...(normalizeIdentifier(event.runId) ? { runId: normalizeIdentifier(event.runId) } : {}),
      ...(event.item.turnKey ? { turnKey: event.item.turnKey } : {}),
      toolCallIds,
    });
  }

  if (
    hasAssistantOutput
  ) {
    maybeTrackSendToFirstToken(
      targetSessionKey,
      event.sessionUpdate === 'session_item_chunk' ? 'delta' : 'final',
    );
  }

  set((state) => ({
      loadedSessions: patchSessionSnapshotWithTodoToolDebug(
        state,
        targetSessionKey,
        event.snapshot,
        event.sessionUpdate,
      ),
  }));
}

export function handleStoreSessionUpdateEvent(
  input: CreateStoreRuntimeEventActionsInput,
  sessionUpdate: SessionUpdateEvent,
): void {
  if (!sessionUpdate || typeof sessionUpdate !== 'object') {
    return;
  }

  const { set, get, historyRuntime } = input;
  const stateBeforeHandle = get();
  const currentSessionKey = stateBeforeHandle.currentSessionKey;
  const eventSessionKey = normalizeIdentifier(sessionUpdate.sessionKey);
  const targetSessionKey = eventSessionKey || currentSessionKey;
  const eventRunId = normalizeIdentifier(sessionUpdate.runId);

  logRendererTodoToolDebug('renderer.session-update.received', {
    sessionUpdate: sessionUpdate.sessionUpdate,
    sessionKey: sessionUpdate.sessionKey,
    runId: sessionUpdate.runId,
    item: 'item' in sessionUpdate && sessionUpdate.item?.kind === 'assistant-turn'
      ? summarizeAssistantTurnForTodoToolDebug(sessionUpdate.item)
      : ('item' in sessionUpdate ? sessionUpdate.item : undefined),
    taskSnapshot: 'taskSnapshot' in sessionUpdate ? sessionUpdate.taskSnapshot : undefined,
    snapshot: summarizeSnapshotForTodoToolDebug(sessionUpdate.snapshot),
  });

  if (sessionUpdate.sessionUpdate === 'session_info_update') {
    useTaskSnapshotStore.getState().reportSessionUpdate(sessionUpdate);
    applySessionLifecycleEvent({
      set,
      get,
      targetSessionKey,
      currentSessionKey,
      event: sessionUpdate,
      historyRuntime,
    });
    return;
  }

  if (sessionUpdate.sessionUpdate === 'plan') {
    useTaskSnapshotStore.getState().reportSessionUpdate(sessionUpdate);
    if (shouldIgnoreRuntimeEvent({
      eventSessionKey,
      targetSessionKey,
    })) {
      return;
    }
    set((state) => ({
      loadedSessions: patchSessionSnapshotWithTodoToolDebug(
        state,
        targetSessionKey,
        sessionUpdate.snapshot,
        'plan',
      ),
    }));
    return;
  }

  if (
    sessionUpdate.sessionUpdate !== 'session_item_chunk'
    && sessionUpdate.sessionUpdate !== 'session_item'
  ) {
    return;
  }
  useTaskSnapshotStore.getState().reportSessionUpdate(sessionUpdate);

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
    targetSessionKey,
    event: sessionUpdate,
    historyRuntime,
  });

  if (sessionUpdate.sessionUpdate === 'session_item') {
    if (
      sessionUpdate.item?.kind === 'assistant-turn'
      && sessionUpdate.snapshot.runtime.runPhase === 'done'
    ) {
      finishChatRunTelemetry(targetSessionKey, 'completed', { stage: 'session_update_message_final' });
      clearHistoryPoll();
      reconcileTerminalToolResultsIfNeeded({
        get,
        historyRuntime,
        sessionKey: targetSessionKey,
      });
    }
  }
}
