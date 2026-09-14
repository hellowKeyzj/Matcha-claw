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
  sessionKeysAreEquivalent,
  shouldIgnoreRuntimeEvent,
} from './event-routing';
import {
  buildHydratedAttachmentItemsPatch,
  hasPendingItemPreviewLoads,
  hydrateAttachedFilesFromItems,
  loadMissingItemPreviews,
} from './attachment-helpers';
import { getSessionRuntime } from './store-state-helpers';
import { useTaskSnapshotStore } from './task-snapshot-store';
import { isAgentSessionTombstoned } from './session-actions';
import { buildSessionRecordKey, findSessionRecordKey } from './session-identity';
import {
  logRendererTodoToolDebug,
  summarizeAssistantTurnForTodoToolDebug,
  summarizeSnapshotForTodoToolDebug,
} from './todo-tool-debug';
import type { ChatStoreState } from './types';
import type {
  SessionItemChunkUpdateEvent,
  SessionItemUpdateEvent,
  SessionUpdateEvent,
} from '../../types/session/update-event';
import type { SessionStateSnapshot } from '../../types/session/snapshot';

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
  sourceSessionKey: string,
  sessionIdentity: SessionStateSnapshot['catalog']['sessionIdentity'],
): string {
  const identity = {
    ...sessionIdentity,
    sessionKey: sessionIdentity.sessionKey || sourceSessionKey,
  };
  const existingRecordKey = findSessionRecordKey(state, identity);
  if (existingRecordKey) {
    return existingRecordKey;
  }
  return buildSessionRecordKey(identity);
}

function scheduleMissingPreviewLoads(input: CreateStoreRuntimeEventActionsInput & {
  targetSessionKey: string;
  snapshot: SessionStateSnapshot;
}): void {
  const hydratedItems = hydrateAttachedFilesFromItems(input.snapshot.items);
  if (!hasPendingItemPreviewLoads(hydratedItems)) {
    return;
  }
  void loadMissingItemPreviews(hydratedItems, {
    sessionIdentity: input.snapshot.catalog.sessionIdentity,
  }).then((updatedItems) => {
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

function applySessionLifecycleEvent(
  input: CreateStoreRuntimeEventActionsInput & {
    targetSessionKey: string;
    targetEventSessionKey: string;
    currentSessionKey: string;
    event: Extract<SessionUpdateEvent, { sessionUpdate: 'session_info_update' }>;
  },
): void {
  const {
    set,
    get,
    targetSessionKey,
    targetEventSessionKey,
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
    targetEventSessionKey,
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

  scheduleMissingPreviewLoads({
    set,
    get,
    targetSessionKey,
    snapshot: event.snapshot,
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

  scheduleMissingPreviewLoads({
    ...input,
    targetSessionKey,
    snapshot: event.snapshot,
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
  if (eventSessionKey && snapshotSessionKey && !sessionKeysAreEquivalent(eventSessionKey, snapshotSessionKey)) {
    return;
  }
  const sourceSessionKey = eventSessionKey || snapshotSessionKey;
  if (!sourceSessionKey) {
    return;
  }
  if (isAgentSessionTombstoned(sessionUpdate.snapshot.catalog.sessionIdentity.agentId)) {
    return;
  }
  const targetSessionKey = resolveSessionUpdateRecordKey(
    stateBeforeHandle,
    sourceSessionKey,
    sessionUpdate.snapshot.catalog.sessionIdentity,
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
      targetEventSessionKey: sourceSessionKey,
      currentSessionKey,
      event: sessionUpdate,
    });
    return;
  }

  if (sessionUpdate.sessionUpdate === 'plan') {
    useTaskSnapshotStore.getState().reportSessionUpdate(sessionUpdate);
    if (shouldIgnoreRuntimeEvent({
      eventSessionKey: null,
      targetEventSessionKey: sourceSessionKey,
    })) {
      return;
    }
    scheduleMissingPreviewLoads({
      set,
      get,
      targetSessionKey,
      snapshot: sessionUpdate.snapshot,
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
    targetEventSessionKey: sourceSessionKey,
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
