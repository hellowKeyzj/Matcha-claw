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
  buildHydratedAttachmentItemsPatch,
  hasPendingItemPreviewLoads,
  hydrateAttachedFilesFromItems,
  loadMissingItemPreviews,
} from './attachment-helpers';
import {
  getSessionRuntime,
  patchPendingApprovalsFromSnapshot,
  patchSessionSnapshot,
} from './store-state-helpers';
import { useTaskSnapshotStore } from './task-snapshot-store';
import { buildSessionRecordKey, findSessionRecordKey } from './session-identity';
import {
  logRendererTodoToolDebug,
  summarizeAssistantTurnForTodoToolDebug,
  summarizeItemsForTodoToolDebug,
  summarizeSnapshotForTodoToolDebug,
} from './todo-tool-debug';
import { isRunActive, type ChatStoreState } from './types';
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
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveSessionUpdateRecordKey(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  backendSessionKey: string,
  runtimeAddress: SessionStateSnapshot['catalog']['runtimeAddress'],
): string {
  if (Object.prototype.hasOwnProperty.call(state.loadedSessions, backendSessionKey)) {
    return backendSessionKey;
  }
  const existingRecordKey = findSessionRecordKey(state, backendSessionKey, runtimeAddress);
  if (existingRecordKey) {
    return existingRecordKey;
  }
  return buildSessionRecordKey(runtimeAddress, backendSessionKey);
}

function shouldPreserveRuntimeOnInfoUpdate(input: {
  event: Extract<SessionUpdateEvent, { sessionUpdate: 'session_info_update' }>;
  current: ChatStoreState['loadedSessions'][string] | undefined;
}): boolean {
  const runtime = input.current?.runtime;
  if (input.event.phase !== 'unknown' || !runtime || !isRunActive(runtime)) {
    return false;
  }
  const eventRunId = normalizeIdentifier(input.event.runId);
  return !eventRunId || eventRunId === runtime.activeRunId;
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

function scheduleMissingPreviewLoads(input: CreateStoreRuntimeEventActionsInput & {
  targetSessionKey: string;
  items: SessionStateSnapshot['items'];
}): void {
  const hydratedItems = hydrateAttachedFilesFromItems(input.items);
  if (!hasPendingItemPreviewLoads(hydratedItems)) {
    return;
  }
  void loadMissingItemPreviews(hydratedItems).then((updatedItems) => {
    if (!updatedItems) {
      return;
    }
    input.set((state) => buildHydratedAttachmentItemsPatch(
      state,
      input.targetSessionKey,
      updatedItems,
    ));
  });
}

function applySessionSnapshotPatch(
  input: CreateStoreRuntimeEventActionsInput & {
    targetSessionKey: string;
    snapshot: SessionStateSnapshot;
    source: string;
  },
): void {
  const hydratedItems = hydrateAttachedFilesFromItems(input.snapshot.items);
  const snapshot = hydratedItems === input.snapshot.items
    ? input.snapshot
    : { ...input.snapshot, items: hydratedItems };
  input.set((state) => ({
    loadedSessions: patchSessionSnapshotWithTodoToolDebug(
      state,
      input.targetSessionKey,
      snapshot,
      input.source,
    ),
    pendingApprovalsBySession: patchPendingApprovalsFromSnapshot(state, input.targetSessionKey, snapshot),
  }));
  scheduleMissingPreviewLoads({
    set: input.set,
    get: input.get,
    targetSessionKey: input.targetSessionKey,
    items: hydratedItems,
  });
}

function applySessionLifecycleEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    targetSessionKey: string;
    targetBackendSessionKey: string;
    currentSessionKey: string;
    event: Extract<SessionUpdateEvent, { sessionUpdate: 'session_info_update' }>;
  },
): void {
  const {
    set,
    get,
    targetSessionKey,
    targetBackendSessionKey,
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
      targetSessionKey !== currentSessionKey
      || !Object.prototype.hasOwnProperty.call(stateBeforeHandle.loadedSessions, targetSessionKey)
    )
  ) {
    void stateBeforeHandle.loadSessions();
  }

  if (
    (event.phase === 'error' || event.phase === 'aborted')
    && (
      !eventSessionKey
      || targetSessionKey === currentSessionKey
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
    targetBackendSessionKey,
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

  const currentRecord = get().loadedSessions[targetSessionKey];
  const snapshot = shouldPreserveRuntimeOnInfoUpdate({ event, current: currentRecord })
    ? {
        ...event.snapshot,
        runtime: {
          ...event.snapshot.runtime,
          activeRunId: currentRecord!.runtime.activeRunId,
          runPhase: currentRecord!.runtime.runPhase,
          activeTurnItemKey: currentRecord!.runtime.activeTurnItemKey,
          pendingTurnKey: currentRecord!.runtime.pendingTurnKey,
          pendingTurnLaneKey: currentRecord!.runtime.pendingTurnLaneKey,
          lastUserMessageAt: currentRecord!.runtime.lastUserMessageAt,
          runtimeActivity: currentRecord!.runtime.runtimeActivity,
        },
      }
    : event.snapshot;
  applySessionSnapshotPatch({
    set,
    get,
    targetSessionKey,
    snapshot,
    source: 'session_info_update',
  });

  if (event.phase === 'final') {
    finishChatRunTelemetry(targetSessionKey, 'completed', { stage: 'session_update_final' });
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

  applySessionSnapshotPatch({
    ...input,
    targetSessionKey,
    snapshot: event.snapshot,
    source: event.sessionUpdate,
  });
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
  const snapshotSessionKey = normalizeIdentifier(sessionUpdate.snapshot.sessionKey);
  if (eventSessionKey && snapshotSessionKey && eventSessionKey !== snapshotSessionKey) {
    return;
  }
  const backendSessionKey = eventSessionKey || snapshotSessionKey;
  if (!backendSessionKey) {
    return;
  }
  const targetSessionKey = resolveSessionUpdateRecordKey(
    stateBeforeHandle,
    backendSessionKey,
    sessionUpdate.snapshot.catalog.runtimeAddress,
  );
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
      targetBackendSessionKey: backendSessionKey,
      currentSessionKey,
      event: sessionUpdate,
    });
    return;
  }

  if (sessionUpdate.sessionUpdate === 'plan') {
    useTaskSnapshotStore.getState().reportSessionUpdate(sessionUpdate);
    if (shouldIgnoreRuntimeEvent({
      eventSessionKey: null,
      targetBackendSessionKey: backendSessionKey,
    })) {
      return;
    }
    applySessionSnapshotPatch({
      set,
      get,
      targetSessionKey,
      snapshot: sessionUpdate.snapshot,
      source: 'plan',
    });
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
    targetBackendSessionKey: backendSessionKey,
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
  });

  if (sessionUpdate.sessionUpdate === 'session_item') {
    if (
      sessionUpdate.item?.kind === 'assistant-turn'
      && sessionUpdate.snapshot.runtime.runPhase === 'done'
    ) {
      finishChatRunTelemetry(targetSessionKey, 'completed', { stage: 'session_update_message_final' });
      clearHistoryPoll();
    }
  }
}
