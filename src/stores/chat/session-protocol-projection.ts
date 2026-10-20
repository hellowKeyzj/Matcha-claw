import { buildRuntimeScopeKey } from './session-identity';
import { buildSessionIdentityKey, type SessionIdentity } from '../../types/desktop/runtime-address';
import { currentSessionSend, recordSendTerminals } from './send-state';
import { getSessionMessageReplacementIndex, getSessionTextModel, prepareSessionProjectionItems, projectSessionMessages, sessionTerminalRunIds } from './session-presentation';
import type { ApprovalItem, ChatSessionRuntimeState, ChatSessionViewportState, ChatStoreState } from './types';
import { deriveSessionImageGenerationPendingStateFromItems, type SessionRenderItem } from '../../types/session/render-item';
import type { SessionDelta, SessionFact, SessionView, SessionWireItem, SessionWireRuntime, SessionWireTool, SessionWireWindow } from '../../types/session/snapshot';
import { syncViewportState } from './viewport-state';
import { useTaskCenterStore } from '../task-center-store';
import { getCronSessionBaseKey } from './cron-session-utils';
import { createSessionTraceId, logSessionTrace, summarizeIdentifier, summarizeSessionIdentity, summarizeSessionChanges, summarizeWireItem, summarizeRenderItem } from '@/lib/session-trace';
import { reconcileSessionDirectory } from './session-directory';
import { getSessionRecord, patchSessionMeta, patchSessionRecord } from './session-record-projection';
import { reconcileSessionItems } from './session-item-reconciliation';
import { projectControlledSessionViewItems } from './session-render-projection';
import { adoptSessionProjectionFact } from './session-projection-facts';
import { factValue, projectionStore, windowStore, renderProjectionStore, type SessionProjectionState } from './session-projection-state';
export { getSessionProjectionWatermark, resetSessionProjection, getSessionWindowCacheStats } from './session-projection-state';
import type { SessionProjectionApplyResult } from './types';
export type { SessionProjectionApplyResult } from './types';

function displayRecordKey(state: ChatStoreState, identity: SessionIdentity): string {
  const baseKey = getCronSessionBaseKey(identity.sessionKey);
  if (baseKey && baseKey !== identity.sessionKey) {
    const baseIdentity = { ...identity, sessionKey: baseKey };
    const key = projectionRecordKey(state, baseIdentity)!;
    if (state.loadedSessions[key]) return key;
  }
  return projectionRecordKey(state, identity)!;
}

function displayProjectionKey(state: ChatStoreState, identity: SessionIdentity): string {
  const recordKey = displayRecordKey(state, identity);
  return buildSessionIdentityKey(state.loadedSessions[recordKey]?.meta.sessionIdentity ?? identity);
}

function mergeWireItems(current: SessionWireItem[], incoming: SessionWireItem[]): SessionWireItem[] {
  const incomingIds = new Set(incoming.map((item) => item.itemId));
  return [...current.filter((item) => !incomingIds.has(item.itemId)), ...incoming];
}

type SessionProjectionApplyInput = {
  set: (partial: Partial<ChatStoreState> | ((state: ChatStoreState) => Partial<ChatStoreState> | ChatStoreState)) => void;
  get: () => ChatStoreState;
};

function summarizeWireAssistantTurn(item: SessionWireItem) {
  return summarizeWireItem(item);
}

function summarizeWireAssistantTurns(items: SessionWireItem[] | null | undefined) {
  if (!items) return null;
  return { itemCount: items.length, summarizedItemCount: Math.min(items.length, 200), truncated: items.length > 200,
    items: items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, ...summarizeWireAssistantTurn(item) })) };
}

function summarizeRenderAssistantTurns(items: SessionRenderItem[] | null | undefined) {
  if (!items) return null;
  return { itemCount: items.length, summarizedItemCount: Math.min(items.length, 200), truncated: items.length > 200,
    items: items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, ...summarizeRenderItem(item) })) };
}

function summarizeDeltaTurnChanges(changes: SessionDelta['changes']) {
  return summarizeSessionChanges(changes);
}

function shouldTraceDeltaTurnState(delta: SessionDelta): boolean {
  return delta.changes.some((change) => change.kind === 'messageUpdated' || change.kind === 'messageReplaced'
    || change.kind === 'messageDelta' || change.kind === 'itemsReplaced' || change.kind === 'toolUpdated'
    || change.kind === 'windowChanged' || change.kind === 'runtimeChanged' || change.kind === 'runPhaseChanged');
}

function sessionIdentityForProjection(
  state: Pick<ChatStoreState, 'loadedSessions'>,
  view: SessionProjectionState,
): SessionIdentity | null {
  if (!view.identity.agentId || view.identity.endpoint.kind !== 'native-runtime') return null;
  const identity = {
    endpoint: {
      kind: 'native-runtime' as const,
      runtimeAdapterId: view.identity.endpoint.runtimeAdapterId,
      runtimeInstanceId: view.identity.endpoint.runtimeInstanceId,
    },
    agentId: view.identity.agentId,
    sessionKey: view.identity.sessionKey,
  };
  const identityKey = buildSessionIdentityKey(identity);
  return Object.values(state.loadedSessions).find((record) => (
    record.meta.sessionIdentity && buildSessionIdentityKey(record.meta.sessionIdentity) === identityKey
  ))?.meta.sessionIdentity ?? identity;
}

function projectionRecordKey(
  state: Pick<ChatStoreState, 'sessionRecordKeyByIdentityKey'>,
  identity: SessionIdentity | null,
): string | null {
  if (!identity) return null;
  const identityKey = buildSessionIdentityKey(identity);
  return state.sessionRecordKeyByIdentityKey[identityKey] ?? identityKey;
}

function projectionRuntimePhase(phase: SessionWireRuntime['phase']): ChatSessionRuntimeState['runPhase'] {
  switch (phase) {
    case 'queued': return 'submitted';
    case 'started': return 'streaming';
    case 'waiting_for_approval': return 'waiting_tool';
    case 'cancellation_requested': return 'stopping';
    case 'cancelled': return 'aborted';
    case 'completed': return 'done';
    case 'failed':
    case 'interrupted': return 'error';
  }
}

function projectionRuntime(
  current: ChatSessionRuntimeState,
  fact: SessionFact<SessionWireRuntime>,
  items: SessionRenderItem[],
  runtimeNotice: ChatSessionRuntimeState['runtimeNotice'],
): ChatSessionRuntimeState {
  const runtime = factValue(fact);
  if (!runtime) return current;
  const imageGeneration = deriveSessionImageGenerationPendingStateFromItems(items, current.imageGeneration);
  const issueMessage = runtime.issue === null ? null : `Session runtime ${runtime.issue}`;
  return {
    ...current,
    activeRunId: runtime.activeRunId,
    runPhase: projectionRuntimePhase(runtime.phase),
    activeTurnItemKey: null,
    pendingTurnKey: null,
    pendingTurnLaneKey: null,
    runProgress: runtime.runProgress,
    runtimeActivity: runtime.runtimeActivity,
    errorDetail: runtime.errorDetail,
    runtimeNotice,
    imageGeneration: imageGeneration.active ? imageGeneration : undefined,
    lastUserMessageAt: null,
    lastError: runtime.issue === 'rejected' ? issueMessage : null,
    lastIssue: issueMessage ? { message: issueMessage, source: 'runtime', at: Date.now(), retryable: runtime.issue !== 'rejected' } : null,
    updatedAt: Date.now(),
  };
}

function projectionWindow(current: ChatSessionViewportState, fact: SessionFact<SessionWireWindow>): ChatSessionViewportState {
  const window = factValue(fact);
  if (!window) return current;
  return syncViewportState(current, {
    ...window,
    isLoadingMore: false,
    isLoadingNewer: false,
    anchorItemKey: current.anchorItemKey,
  });
}

function nativeApprovalOptionIdToDecision(optionId: string): ApprovalItem['allowedDecisions'][number] | null {
  switch (optionId) {
    case 'allow':
    case 'allow-once':
    case 'allow_once':
      return 'allow-once';
    case 'allow-always':
    case 'allow_always':
      return 'allow-always';
    case 'deny':
    case 'deny-once':
    case 'reject-once':
    case 'reject_once':
      return 'deny';
    default:
      return null;
  }
}

function approvalOptionIdsToDecisions(optionIds: string[]): ApprovalItem['allowedDecisions'] {
  return optionIds
    .map(nativeApprovalOptionIdToDecision)
    .filter((decision): decision is ApprovalItem['allowedDecisions'][number] => decision != null);
}

function projectionApprovals(
  state: ChatStoreState,
  recordKey: string,
  view: SessionProjectionState,
): Record<string, ApprovalItem[]> {
  const fact = factValue(view.approvals);
  if (!fact) {
    return state.pendingApprovalsBySession;
  }
  const identity = sessionIdentityForProjection(state, view);
  if (!identity) {
    return { ...state.pendingApprovalsBySession, [recordKey]: [] };
  }
  const endpointSessionId = view.endpointSessionId ?? state.loadedSessions[recordKey]?.meta.endpointSessionId;
  const approvals = fact
    .filter((approval) => approval.phase === 'requested')
    .map((approval) => ({
      id: approval.approvalId,
      sessionKey: recordKey,
      ...(endpointSessionId ? { endpointSessionId } : {}),
      sessionIdentity: identity,
      ...(approval.runId ? { runId: approval.runId } : {}),
      title: 'Approval required',
      allowedDecisions: approvalOptionIdsToDecisions(approval.optionIds),
      request: { optionIds: approval.optionIds },
      createdAtMs: Date.now(),
    }));
  return { ...state.pendingApprovalsBySession, [recordKey]: approvals };
}

function refreshSessionTasks(input: SessionProjectionApplyInput, view: SessionProjectionState, invalidate: boolean): void {
  const identity = sessionIdentityForProjection(input.get(), view);
  const recordKey = projectionRecordKey(input.get(), identity);
  if (!identity || !recordKey) return;
  void useTaskCenterStore.getState().refreshTasks({
    sessionKey: recordKey,
    sessionIdentity: identity,
    background: true,
    invalidate,
  }).catch(() => { /* The refresh owner logs failures and preserves the last snapshot. */ });
}

// Reads also restore the plugin's current plan after compaction; never parse their output.
const TASK_SNAPSHOT_TOOLS = new Set(['todowrite', 'todoget', 'taskcreate', 'taskupdate', 'tasklist', 'taskget']);

function isTaskToolTerminalTransition(tool: SessionWireTool, previous?: SessionWireTool): boolean {
  if (tool.phase !== 'completed' && tool.phase !== 'failed') return false;
  if (!TASK_SNAPSHOT_TOOLS.has((tool.name ?? previous?.name ?? '').trim().toLowerCase())) return false;
  return !previous || previous.runId !== tool.runId
    || (previous.phase !== 'completed' && previous.phase !== 'failed');
}

function applyDecodedSessionView(
  input: SessionProjectionApplyInput,
  view: SessionProjectionState,
  modelState?: SessionView['modelState'],
  display: SessionProjectionState = view,
  traceId?: string | null,
  timing?: { projectionElapsedMs: number; reconcileElapsedMs: number; traceEmitElapsedMs: number },
  terminalRunIds: readonly string[] = [],
  terminatedRunIds: readonly string[] = [],
  observedTerminalRunIds: readonly string[] = [],
): boolean {
  const state = input.get();
  const identity = sessionIdentityForProjection(state, view);
  const recordKey = identity ? displayRecordKey(state, identity) : null;
  if (!recordKey) return false;
  input.set((nextState) => {
    const current = getSessionRecord(nextState, recordKey);
    const nextIdentity = current.meta.sessionIdentity ?? identity;
    const nextMeta = nextIdentity ? {
      ...current.meta,
      runtimeScopeKey: buildRuntimeScopeKey(nextIdentity.endpoint),
      agentId: nextIdentity.agentId,
      protocolId: null,
      runtimeEndpointId: view.identity.endpoint.runtimeInstanceId,
      endpointSessionId: view.endpointSessionId,
      goal: view.goal,
      goalReadRevision: current.meta.goalReadRevision + (modelState !== undefined ? 1 : 0),
      modelState: current.meta.modelState?.overrideSource === 'user' ? current.meta.modelState : modelState ?? current.meta.modelState,
      ...(modelState !== undefined ? { ownership: view.ownership } : {}),
      sessionIdentity: nextIdentity,
    } : current.meta;
    const windows = windowStore(input.get);
    const displayKey = displayProjectionKey(nextState, view.identity);
    const messageRecord = { ...current, meta: nextMeta };
    const ownTerminatedRunIds = buildSessionIdentityKey(nextIdentity!) === buildSessionIdentityKey(view.identity)
      ? terminatedRunIds : [];
    const projectionStartedAt = timing ? performance.now() : 0;
    let projectedItems = prepareSessionProjectionItems(messageRecord,
      factValue(display.items) ? projectControlledSessionViewItems(display, renderProjectionStore(input.get), displayProjectionKey(input.get(), view.identity)) : current.items, ownTerminatedRunIds);
    if (buildSessionIdentityKey(nextIdentity!) !== buildSessionIdentityKey(view.identity)) {
      const incomingIds = new Set(projectedItems.map((item) => item.key));
      const retiredIds = display.retiredItemIds ?? new Set<string>();
      projectedItems = [...current.items.filter((item) => !incomingIds.has(item.key) && !retiredIds.has(item.key)), ...projectedItems];
    }
    const reconcileStartedAt = timing ? performance.now() : 0;
    if (timing) timing.projectionElapsedMs += reconcileStartedAt - projectionStartedAt;
    const wireRuntime = factValue(view.runtime);
    const terminals = sessionTerminalRunIds(messageRecord,
      wireRuntime && isTerminalRunPhase(wireRuntime.phase) && wireRuntime.activeRunId !== null
        ? [...terminalRunIds, wireRuntime.activeRunId] : terminalRunIds, observedTerminalRunIds);
    const send = currentSessionSend(current);
    const nextSend = send?.identityKey === buildSessionIdentityKey(view.identity) ? recordSendTerminals(send, terminals) : send;
    const reconciledItems = reconcileSessionItems(current.items, projectedItems, getSessionTextModel(view.identity).user);
    const messages = projectSessionMessages(messageRecord, reconciledItems, {
      identityKey: buildSessionIdentityKey(view.identity),
      runtime: wireRuntime ? projectionRuntime(current.runtime, view.runtime, reconciledItems, view.runtimeNotice ?? null) : null,
      terminalRunIds: terminals,
      terminatedRunIds: ownTerminatedRunIds,
      retiredItemIds: new Set([...(view.retiredItemIds ?? []), ...(display.retiredItemIds ?? [])]),
      send: nextSend,
    });
    const nextRuntime = messages.runtime;
    const nextItems = messages.items;
    const traceStartedAt = timing ? performance.now() : 0;
    if (timing) timing.reconcileElapsedMs += traceStartedAt - reconcileStartedAt;
    if (traceId) logSessionTrace('session.assembly.reconcile', traceId, () => ({
      identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
      recordKey: summarizeIdentifier(recordKey), displayEpoch: display.epoch, displaySeq: display.seq, displayCursor: display.cursor,
      display: summarizeWireAssistantTurns(factValue(display.items)),
      before: summarizeRenderAssistantTurns(current.items), projected: summarizeRenderAssistantTurns(projectedItems),
      reconciled: summarizeRenderAssistantTurns(nextItems),
    }));
    if (timing) timing.traceEmitElapsedMs += performance.now() - traceStartedAt;
    const pendingAssistant = nextItems.find((item) => item.kind === 'assistant-turn' && item.key.startsWith('renderer-assistant:'));
    const placeholderTraceStartedAt = timing ? performance.now() : 0;
    if (traceId) logSessionTrace('session.assembly.placeholder.after', traceId, () => ({
      identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
      pendingItemHash: summarizeIdentifier(pendingAssistant?.key).hash, pendingTurnHash: summarizeIdentifier(current.runtime.pendingTurnKey).hash,
      items: summarizeRenderAssistantTurns(nextItems),
    }));
    if (timing) timing.traceEmitElapsedMs += performance.now() - placeholderTraceStartedAt;
    const nextWindow = projectionWindow(current.window, display.window);
    windows.set(displayKey, { ...display, recordKey });
    const loadedSessions = patchSessionRecord(nextState, recordKey, {
      meta: nextMeta,
      items: nextItems,
      runtime: nextRuntime,
      send: nextSend,
      abort: messages.abort,
      window: nextWindow,
    });
    const nextApprovals = projectionApprovals(nextState, recordKey, view);
    return {
      loadedSessions,
      ...reconcileSessionDirectory(nextState, loadedSessions, [recordKey]),
      pendingApprovalsBySession: nextApprovals,
    };
  });
  return true;
}

function adoptProjectionView(view: SessionView): SessionView {
  const adoptFact = <T>(fact: SessionFact<T[]>): SessionFact<T[]> => {
    if (fact === 'unknown' || fact === 'unavailable') return fact;
    if ('complete' in fact) return { complete: fact.complete.map(adoptSessionProjectionFact) };
    return { incomplete: { facts: fact.incomplete.facts.map(adoptSessionProjectionFact), gaps: [...fact.incomplete.gaps] } };
  };
  return {
    ...view,
    identity: adoptSessionProjectionFact(view.identity),
    items: adoptFact(view.items), tools: adoptFact(view.tools), approvals: adoptFact(view.approvals),
    runtime: adoptSessionProjectionFact(view.runtime), window: adoptSessionProjectionFact(view.window),
    completeness: adoptSessionProjectionFact(view.completeness),
  };
}

export function applySessionView(
  input: SessionProjectionApplyInput,
  view: SessionView,
  options: { windowOnly?: boolean; direction?: 'older' | 'newer' | 'latest' } = {},
): SessionProjectionApplyResult {
  const traceId = createSessionTraceId('session.view.apply-boundary');
  const timing = traceId ? { projectionElapsedMs: 0, reconcileElapsedMs: 0, traceEmitElapsedMs: 0 } : undefined;
  const beforeTraceStartedAt = traceId ? performance.now() : 0;
  let applyStartedAt = 0;
  let beforeTraceEmitElapsedMs = 0;
  const finish = (result: SessionProjectionApplyResult): SessionProjectionApplyResult => {
    if (traceId && timing) {
      const applyElapsedMs = performance.now() - applyStartedAt - timing.traceEmitElapsedMs;
      const summaryStartedAt = performance.now();
      const payload = {
        identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
        windowOnly: !!options.windowOnly, direction: options.direction ?? null, status: result.status,
        reason: 'reason' in result ? summarizeIdentifier(result.reason) : result.status === 'stale' ? 'older-watermark' : result.status === 'duplicate' ? 'same-watermark' : null,
        items: summarizeRenderAssistantTurns(getSessionRecord(input.get(), displayRecordKey(input.get(), view.identity)).items),
      };
      logSessionTrace('session.view.apply.result', traceId, () => ({
        ...payload, applyElapsedMs, projectionElapsedMs: timing.projectionElapsedMs, reconcileElapsedMs: timing.reconcileElapsedMs,
        traceEmitElapsedMsBeforeResult: beforeTraceEmitElapsedMs + timing.traceEmitElapsedMs,
        resultSummaryElapsedMs: performance.now() - summaryStartedAt,
      }));
    }
    return result;
  };
  if (traceId) logSessionTrace('session.view.apply.before', traceId, () => ({
    identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
    windowOnly: !!options.windowOnly, direction: options.direction ?? null,
    incoming: summarizeWireAssistantTurns(factValue(view.items)),
    before: summarizeRenderAssistantTurns(getSessionRecord(input.get(), displayRecordKey(input.get(), view.identity)).items),
  }));
  if (traceId) {
    applyStartedAt = performance.now();
    beforeTraceEmitElapsedMs = applyStartedAt - beforeTraceStartedAt;
  }
  if (view.sessionKey !== view.identity.sessionKey) {
    return finish({ status: 'unavailable', sessionKey: view.sessionKey, reason: 'identity mismatch' });
  }
  const identity = sessionIdentityForProjection(input.get(), view);
  const recordKey = identity ? displayRecordKey(input.get(), identity) : null;
  if (!recordKey) {
    return finish({ status: 'unavailable', sessionKey: view.sessionKey, reason: 'session identity unavailable' });
  }
  const store = projectionStore(input.get);
  const projectionKey = buildSessionIdentityKey(view.identity);
  const previous = store.get(projectionKey);
  if (options.windowOnly) {
    view = adoptProjectionView(view);
    const items = factValue(view.items);
    const window = factValue(view.window);
    if (!items || !window) return finish({ status: 'unavailable', sessionKey: recordKey, reason: 'window unavailable' });
    if (previous && (view.epoch < previous.epoch || options.direction === 'latest' && view.epoch === previous.epoch
      && (view.seq < previous.seq || view.cursor < previous.cursor))) {
      return finish({ status: 'stale', sessionKey: recordKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
    }
    const currentItems = new Map((previous ? factValue(previous.items) : [])?.map((item) => [item.itemId, item]) ?? []);
    const preserveLive = previous && view.epoch === previous.epoch && (view.seq <= previous.seq || view.cursor <= previous.cursor);
    const display: SessionProjectionState = {
      ...view,
      items: { complete: items.filter((item) => !preserveLive || !previous.retiredItemIds?.has(item.itemId))
        .map((item) => preserveLive ? currentItems.get(item.itemId) ?? item : item) },
      tools: preserveLive ? { complete: [...new Map([...(factValue(view.tools) ?? []), ...(factValue(previous.tools) ?? [])]
        .map((tool) => [tool.toolCallId, tool])).values()] } : view.tools,
      recordKey,
    };
    windowStore(input.get).set(displayProjectionKey(input.get(), view.identity), display);
    input.set((state) => {
      const current = getSessionRecord(state, recordKey);
      const projectionStartedAt = timing ? performance.now() : 0;
      const projectedItems = projectControlledSessionViewItems(display, renderProjectionStore(input.get), displayProjectionKey(input.get(), view.identity));
      const reconcileStartedAt = timing ? performance.now() : 0;
      if (timing) timing.projectionElapsedMs += reconcileStartedAt - projectionStartedAt;
      const items = reconcileSessionItems(current.items, projectedItems, getSessionTextModel(display.identity).user);
      const traceStartedAt = timing ? performance.now() : 0;
      if (timing) timing.reconcileElapsedMs += traceStartedAt - reconcileStartedAt;
      if (traceId) logSessionTrace('session.view.window.assembly', traceId, () => ({
        identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
        direction: options.direction ?? null, preserveLive: !!preserveLive,
        display: summarizeWireAssistantTurns(factValue(display.items)), before: summarizeRenderAssistantTurns(current.items),
        projected: summarizeRenderAssistantTurns(projectedItems), reconciled: summarizeRenderAssistantTurns(items),
      }));
      if (timing) timing.traceEmitElapsedMs += performance.now() - traceStartedAt;
      const loadedSessions = patchSessionRecord(state, recordKey, {
        items,
        window: projectionWindow(current.window, view.window),
      });
      return { loadedSessions, ...reconcileSessionDirectory(state, loadedSessions, [recordKey]) };
    });
    return finish({ status: 'applied', sessionKey: recordKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
  }
  if (previous) {
    if (view.epoch < previous.epoch) {
      return finish({ status: 'stale', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
    }
    if (view.epoch === previous.epoch) {
      if (view.cursor < previous.cursor || view.seq < previous.seq) {
        return finish({ status: 'stale', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      }
      if (view.cursor === previous.cursor && view.seq === previous.seq) {
        input.set((state) => {
          const current = getSessionRecord(state, recordKey);
          const loadedSessions = patchSessionMeta(state, recordKey, {
            ownership: view.ownership,
            goal: view.goal,
            goalReadRevision: current.meta.goalReadRevision + 1,
            modelState: current.meta.modelState?.overrideSource === 'user' ? current.meta.modelState : view.modelState ?? current.meta.modelState,
          });
          return loadedSessions === state.loadedSessions ? state : {
            loadedSessions,
            ...reconcileSessionDirectory(state, loadedSessions, [recordKey]),
          };
        });
        refreshSessionTasks(input, view, false);
        return finish({ status: 'duplicate', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
      }
    }
  }
  view = adoptProjectionView(view);
  const { modelState, ...facts } = view;
  const retiredItemIds = new Set(view.epoch === previous?.epoch ? previous.retiredItemIds : undefined);
  factValue(view.items)?.forEach((item) => retiredItemIds.delete(item.itemId));
  const projection: SessionProjectionState = { ...facts, recordKey, retiredItemIds };
  const windows = windowStore(input.get);
  const loaded = windows.get(displayProjectionKey(input.get(), view.identity));
  const reading = loaded && loaded.epoch === projection.epoch
    && buildSessionIdentityKey(loaded.identity) === projectionKey
    && !input.get().loadedSessions[recordKey]?.window.isAtLatest;
  let display = reading ? reconcileReadingWindow(loaded, projection) : projection;
  if (loaded && projectionKey !== displayProjectionKey(input.get(), view.identity)) {
    const previousIds = new Set((previous ? factValue(previous.items) : [])?.map((item) => item.itemId) ?? []);
    const retained = (factValue(loaded.items) ?? []).filter((item) => !previousIds.has(item.itemId));
    display = {
      ...projection,
      items: factValue(view.items) ? { complete: mergeWireItems(retained, factValue(view.items)!) } : loaded.items,
      tools: { complete: [...new Map([...(factValue(loaded.tools) ?? []), ...(factValue(view.tools) ?? [])]
        .map((tool) => [tool.toolCallId, tool])).values()] },
      window: loaded.window,
    };
  }
  if (!reading && projectionKey === displayProjectionKey(input.get(), view.identity)) {
    for (const [key, run] of store) {
      if (key === projectionKey || getCronSessionBaseKey(run.identity.sessionKey) !== view.sessionKey
        || buildSessionIdentityKey({ ...run.identity, sessionKey: view.sessionKey }) !== projectionKey) continue;
      const retained = (factValue(display.items) ?? []).filter((item) => !run.retiredItemIds?.has(item.itemId));
      display = {
        ...display,
        items: { complete: mergeWireItems(retained, factValue(run.items) ?? []) },
        tools: { complete: [...new Map([...(factValue(display.tools) ?? []), ...(factValue(run.tools) ?? [])]
          .map((tool) => [tool.toolCallId, tool])).values()] },
      };
    }
  }
  const runtime = factValue(projection.runtime);
  const previousRuntime = previous?.epoch === projection.epoch ? factValue(previous.runtime) : null;
  const observedTerminalRunId = runtime && isTerminalRunPhase(runtime.phase) && runtime.activeRunId === null
    ? previousRuntime?.activeRunId : null;
  store.set(projectionKey, projection);
  if (!applyDecodedSessionView(input, projection, modelState, display, traceId, timing, [], [],
    observedTerminalRunId ? [observedTerminalRunId] : [])) {
    return finish({ status: 'unavailable', sessionKey: view.sessionKey, reason: 'session identity unavailable' });
  }
  refreshSessionTasks(input, view, true);
  return finish({ status: 'applied', sessionKey: view.sessionKey, epoch: view.epoch, seq: view.seq, cursor: view.cursor });
}

function reconcileReadingWindow(
  loaded: SessionProjectionState,
  projected: SessionProjectionState,
  previous?: SessionProjectionState,
  change?: SessionDelta['changes'][number],
): SessionProjectionState {
  const incoming = new Map((factValue(projected.items) ?? []).map((item) => [item.itemId, item]));
  const updated = change?.kind === 'messageDelta' && factValue(loaded.items)?.some((item) => item.itemId === change.itemId)
    ? applyProjectionChange(loaded, change).items : loaded.items;
  const items = updateProjectionFact<SessionWireItem[]>(updated, () => [], (items) => {
    if (change?.kind === 'messageDelta') return items;
    if (change?.kind !== 'itemsReplaced') return items.map((item) => incoming.get(item.itemId) ?? item);
    const oldIds = new Set(change.oldItemIds);
    const removedIds = new Set([...oldIds, ...change.items.map((item) => item.itemId)]);
    const canonical = factValue(previous?.items ?? 'unknown') ?? [];
    const anchor = change.anchor;
    const start = anchor.kind === 'start' ? 0 : canonical.findIndex((item) => item.itemId === anchor.itemId) + 1;
    let end = start;
    while (end < canonical.length && removedIds.has(canonical[end].itemId)) end += 1;
    const slot = canonical.slice(start, end);
    const index = slot.length ? items.findIndex((item) => item.itemId === slot[0].itemId) : -1;
    const slotIds = new Set(slot.map((item) => item.itemId));
    // Canonical anchors are not page anchors; only a complete existing slot can change identity.
    const replaceSlot = index >= 0 && slot.every((item, offset) => items[index + offset]?.itemId === item.itemId)
      && !items.some((item) => removedIds.has(item.itemId) && !oldIds.has(item.itemId) && !slotIds.has(item.itemId));
    if (replaceSlot) {
      const remainingCount = items.filter((item) => !removedIds.has(item.itemId)).length;
      if (remainingCount + change.items.length > 200) return items;
      const next = items.filter((item) => !removedIds.has(item.itemId));
      const position = items.slice(0, index).filter((item) => !removedIds.has(item.itemId)).length;
      next.splice(position, 0, ...change.items);
      return next;
    }
    return items.filter((item) => !oldIds.has(item.itemId) || incoming.has(item.itemId))
      .map((item) => incoming.get(item.itemId) ?? item);
  });
  const toolIds = new Set((factValue(items) ?? []).flatMap((item) => item.kind === 'assistantTurn'
    ? item.segments.flatMap((segment) => segment.kind === 'toolUse' || segment.kind === 'toolResult' ? [segment.toolCallId] : []) : []));
  const incomingTools = new Map((factValue(projected.tools) ?? []).map((tool) => [tool.toolCallId, tool]));
  const tools = updateProjectionFact<SessionWireTool[]>(loaded.tools, () => [], (tools) => {
    const next = tools.filter((tool) => toolIds.has(tool.toolCallId)).map((tool) => incomingTools.get(tool.toolCallId) ?? tool);
    const existing = new Set(next.map((tool) => tool.toolCallId));
    for (const tool of incomingTools.values()) {
      if (toolIds.has(tool.toolCallId) && !existing.has(tool.toolCallId)) next.push(tool);
    }
    return next;
  });
  if ((factValue(tools)?.length ?? 0) > 128) return { ...projected, items: loaded.items, tools: loaded.tools, window: loaded.window };
  return { ...projected, items, tools, window: loaded.window };
}

function updateProjectionFact<T>(
  fact: SessionFact<T>,
  seed: () => T,
  update: (facts: T) => T,
): SessionFact<T> {
  if (fact === 'unknown' || fact === 'unavailable') {
    return { incomplete: { facts: update(seed()), gaps: ['event_only'] } };
  }
  if ('complete' in fact) return { complete: update(fact.complete) };
  return { incomplete: { facts: update(fact.incomplete.facts), gaps: fact.incomplete.gaps } };
}

function isTerminalRunPhase(phase: SessionWireRuntime['phase']): boolean {
  return phase === 'completed'
    || phase === 'failed'
    || phase === 'cancelled'
    || phase === 'interrupted';
}

function runtimeNoticeAfterRuntimeChange(
  notice: ChatSessionRuntimeState['runtimeNotice'],
  runtime: SessionWireRuntime,
): ChatSessionRuntimeState['runtimeNotice'] {
  if (!notice || runtime.activeRunId !== notice.runId || isTerminalRunPhase(runtime.phase)) return null;
  return notice;
}

function runtimeNoticeAfterRunPhaseChange(
  notice: ChatSessionRuntimeState['runtimeNotice'],
  runId: string,
  phase: SessionWireRuntime['phase'],
): ChatSessionRuntimeState['runtimeNotice'] {
  if (!notice) return null;
  if (notice.runId === runId) return isTerminalRunPhase(phase) ? null : notice;
  return isTerminalRunPhase(phase) ? notice : null;
}

function applyProjectionChange(view: SessionProjectionState, change: SessionDelta['changes'][number]): SessionProjectionState {
  switch (change.kind) {
    case 'messageDelta':
      return { ...view, items: updateProjectionFact(view.items, () => [], (items) => {
        const next = [...items];
        const index = next.findIndex((item) => item.itemId === change.itemId);
        if (index >= 0) {
          const current = next[index];
          if (current.kind !== 'assistantTurn'
            || current.runId !== change.runId
            || current.messageId !== change.messageId) {
            return next;
          }
          const text = change.replace ? change.text : `${current.text}${change.text}`;
          next[index] = adoptSessionProjectionFact({ ...current, status: change.status, text, segments: [{ kind: 'text', text }] });
        } else {
          next.push(adoptSessionProjectionFact({
            kind: 'assistantTurn',
            itemId: change.itemId,
            runId: change.runId,
            messageId: change.messageId,
            status: change.status,
            segments: [{ kind: 'text', text: change.text }],
            text: change.text,
          }));
        }
        return next;
      }) };
    case 'messageUpdated':
      return { ...view, items: updateProjectionFact(view.items, () => [], (items) => {
        const next = [...items];
        const index = next.findIndex((item) => item.itemId === change.item.itemId);
        if (index >= 0) next[index] = change.item;
        else next.push(change.item);
        return next;
      }) };
    case 'messageReplaced':
      return { ...view, items: updateProjectionFact(view.items, () => [], (items) => {
        const next = [...items];
        const index = getSessionMessageReplacementIndex(view.identity, next, change.item);
        if (index < 0) next.push(change.item);
        else next[index] = change.item;
        return next;
      }) };
    case 'itemsReplaced': {
      const oldIds = new Set(change.oldItemIds);
      const incomingIds = new Set(change.items.map((item) => item.itemId));
      const anchor = change.anchor;
      if (oldIds.size !== change.oldItemIds.length || incomingIds.size !== change.items.length
        || change.oldItemIds.length > 200 || change.items.length > 200
        || anchor.kind === 'after' && (oldIds.has(anchor.itemId) || incomingIds.has(anchor.itemId))) {
        throw new Error('invalid replacement');
      }
      const items = updateProjectionFact(view.items, () => [], (items) => {
        const remaining = items.filter((item) => !oldIds.has(item.itemId) && !incomingIds.has(item.itemId));
        const index = anchor.kind === 'start' ? 0 : remaining.findIndex((item) => item.itemId === anchor.itemId) + 1;
        if (anchor.kind === 'after' && index === 0) throw new Error('replacement anchor missing');
        if (remaining.length + change.items.length > 200) throw new Error('invalid replacement');
        remaining.splice(index, 0, ...change.items);
        return remaining;
      });
      const retiredItemIds = new Set(view.retiredItemIds);
      oldIds.forEach((id) => retiredItemIds.add(id));
      incomingIds.forEach((id) => retiredItemIds.delete(id));
      return { ...view, items, retiredItemIds };
    }
    case 'toolUpdated':
      return { ...view, tools: updateProjectionFact(view.tools, () => [], (tools) => {
        const next = [...tools];
        const index = next.findIndex((tool) => tool.toolCallId === change.tool.toolCallId);
        if (index >= 0) next[index] = change.tool;
        else next.push(change.tool);
        return next;
      }) };
    case 'approvalUpdated':
      return { ...view, approvals: updateProjectionFact(view.approvals, () => [], (approvals) => {
        const next = [...approvals];
        const index = next.findIndex((approval) => approval.approvalId === change.approval.approvalId);
        if (index >= 0) next[index] = change.approval;
        else next.push(change.approval);
        return next;
      }) };
    case 'goalChanged':
      return { ...view, goal: change.goal };
    case 'runtimeChanged':
      return {
        ...view,
        runtime: updateProjectionFact(view.runtime, () => ({ phase: 'started', activeRunId: null, issue: null, runProgress: null, runtimeActivity: null, errorDetail: null }), () => change.runtime),
        runtimeNotice: runtimeNoticeAfterRuntimeChange(view.runtimeNotice ?? null, change.runtime),
      };
    case 'runtimeNoticeUpdated':
      return { ...view, runtimeNotice: change.notice };
    case 'windowChanged':
      return { ...view, window: { incomplete: { facts: change.window, gaps: ['bounded_history'] } } };
    case 'runPhaseChanged':
      return {
        ...view,
        runtime: updateProjectionFact(view.runtime, (): SessionWireRuntime => ({ phase: 'started', activeRunId: null, issue: null, runProgress: null, runtimeActivity: null, errorDetail: null }), (runtime) => (
          isTerminalRunPhase(change.phase) && runtime.activeRunId !== null && runtime.activeRunId !== change.runId
            ? runtime
            : {
                ...runtime,
                phase: change.phase,
                activeRunId: isTerminalRunPhase(change.phase) ? null : change.runId,
                runProgress: null,
                runtimeActivity: null,
                errorDetail: null,
              }
        )),
        runtimeNotice: runtimeNoticeAfterRunPhaseChange(view.runtimeNotice ?? null, change.runId, change.phase),
      };
    case 'recoveryRequired':
      return { ...view, completeness: change.reason === 'native_unavailable' ? 'unavailable' : change.reason === 'native_unknown' ? 'unknown' : { incomplete: { missing: ['replay_cursor'] } } };
  }
}

export function applySessionDelta(
  input: SessionProjectionApplyInput,
  delta: SessionDelta,
): SessionProjectionApplyResult {
  const traceId = createSessionTraceId('session.delta.apply-boundary');
  const finish = (result: SessionProjectionApplyResult): SessionProjectionApplyResult => {
    if (traceId) logSessionTrace('session.delta.apply.result', traceId, () => ({
      identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor,
      status: result.status, reason: 'reason' in result ? summarizeIdentifier(result.reason) : result.status === 'stale' ? 'older-watermark' : result.status === 'duplicate' ? 'same-watermark' : null,
    }));
    return result;
  };
  const store = projectionStore(input.get);
  const state = input.get();
  if (delta.identity.sessionKey !== delta.sessionKey) return finish({ status: 'unavailable', sessionKey: delta.sessionKey, reason: 'identity mismatch' });
  const projectionKey = buildSessionIdentityKey(delta.identity);
  const recordKey = displayRecordKey(state, delta.identity);
  let previous = store.get(projectionKey);
  if (!previous && delta.seq === 1 && delta.cursor === 1) {
    previous = { sessionKey: delta.sessionKey, identity: adoptSessionProjectionFact(delta.identity), endpointSessionId: state.loadedSessions[recordKey]?.meta.endpointSessionId ?? null, ownership: state.loadedSessions[recordKey]?.meta.ownership ?? null, goal: { kind: 'unknown' }, epoch: delta.epoch, seq: 0, cursor: 0, items: 'unknown', tools: 'unknown', approvals: 'unknown', runtime: 'unknown', window: 'unknown', completeness: { incomplete: { missing: ['event_only'] } } };
  }
  const traceTurnState = !!traceId && shouldTraceDeltaTurnState(delta);
  const traceRuntimeState = traceId && delta.changes.some((change) => (
    change.kind === 'runtimeChanged'
    || (change.kind === 'runPhaseChanged' && isTerminalRunPhase(change.phase))
  ));
  if (traceId) logSessionTrace('session.delta.apply.start', traceId, () => ({
    identity: summarizeSessionIdentity(delta.identity),
    recordKey: summarizeIdentifier(recordKey),
    sessionKey: summarizeIdentifier(delta.sessionKey),
    incomingEpoch: delta.epoch,
    incomingSeq: delta.seq,
    incomingCursor: delta.cursor,
    previousEpoch: previous?.epoch ?? null,
    previousSeq: previous?.seq ?? null,
    previousCursor: previous?.cursor ?? null,
    changeKinds: delta.changes.map((change) => change.kind),
    previousRuntimePhase: previous ? projectionRuntimePhase(factValue(previous.runtime)?.phase ?? 'started') : null,
    previousActiveRunId: summarizeIdentifier(factValue(previous?.runtime ?? 'unknown')?.activeRunId),
    ...(traceRuntimeState ? {
      incomingRuntimePhases: delta.changes
        .filter((change) => change.kind === 'runtimeChanged' || change.kind === 'runPhaseChanged')
        .map((change) => ({
          kind: change.kind,
          phase: change.kind === 'runtimeChanged' ? change.runtime.phase : change.phase,
          runId: summarizeIdentifier(change.kind === 'runtimeChanged' ? change.runtime.activeRunId : change.runId),
        })),
    } : {}),
  }));
  if (traceTurnState) {
    logSessionTrace('session.delta.apply.turns.before', traceId, () => ({
      sessionKey: summarizeIdentifier(delta.sessionKey),
      seq: delta.seq,
      cursor: delta.cursor,
      delta: summarizeDeltaTurnChanges(delta.changes),
      projectionTurns: summarizeWireAssistantTurns(previous ? factValue(previous.items) : null),
      identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch,
      displayTurns: summarizeWireAssistantTurns(factValue(windowStore(input.get).get(displayProjectionKey(state, delta.identity))?.items ?? 'unknown')),
      renderTurns: summarizeRenderAssistantTurns(getSessionRecord(state, recordKey).items),
    }));
  }
  if (!previous) {
    const historyReason = 'session_delta_without_view';
    if (traceId) logSessionTrace('session.delta.recovery-required', traceId, () => ({
      sessionKey: summarizeIdentifier(delta.sessionKey),
      reason: historyReason,
    }));
    return finish({ status: 'gap', sessionKey: delta.sessionKey, reason: 'missing SessionView' });
  }
  if (delta.epoch < previous.epoch) {
    return finish({ status: 'stale', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
  }
  const epochChanged = delta.epoch > previous.epoch;
  if (epochChanged && (delta.cursor !== 1 || delta.seq !== 1)) {
    const historyReason = 'session_delta_epoch_gap';
    if (traceId) logSessionTrace('session.delta.recovery-required', traceId, () => ({
      sessionKey: summarizeIdentifier(delta.sessionKey),
      reason: historyReason,
    }));
    return finish({ status: 'gap', sessionKey: delta.sessionKey, reason: 'new epoch delta did not start at seq 1, cursor 1' });
  }
  if (!epochChanged) {
    if (delta.cursor < previous.cursor || delta.seq < previous.seq) {
      return finish({ status: 'stale', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
    }
    if (delta.cursor === previous.cursor && delta.seq === previous.seq) {
      return finish({ status: 'duplicate', sessionKey: delta.sessionKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
    }
    if (delta.cursor !== previous.cursor + 1 || delta.seq !== previous.seq + 1) {
      const historyReason = 'session_delta_gap';
      if (traceId) logSessionTrace('session.delta.recovery-required', traceId, () => ({
        sessionKey: summarizeIdentifier(delta.sessionKey),
        reason: historyReason,
      }));
      return finish({ status: 'gap', sessionKey: delta.sessionKey, reason: `expected seq ${previous.seq + 1}, cursor ${previous.cursor + 1}` });
    }
  }
  let tasksChanged = epochChanged;
  const windows = windowStore(input.get);
  const displayKey = displayProjectionKey(state, delta.identity);
  const loaded = windows.get(displayKey);
  const reading = loaded && !epochChanged && loaded.epoch === delta.epoch
    && buildSessionIdentityKey(loaded.identity) === projectionKey
    && !state.loadedSessions[recordKey]?.window.isAtLatest;
  let readingDisplay = loaded;
  let nextView: SessionProjectionState;
  const terminalRunIds: string[] = [];
  const observedTerminalRunIds: string[] = [];
  const changes = delta.changes.map(adoptSessionProjectionFact);
  try {
    nextView = changes.reduce((view, change) => {
    if (change.kind === 'runPhaseChanged' && isTerminalRunPhase(change.phase)) terminalRunIds.push(change.runId);
    if (change.kind === 'runtimeChanged' && isTerminalRunPhase(change.runtime.phase)) {
      const runId = change.runtime.activeRunId ?? delta.runId;
      if (runId) terminalRunIds.push(runId);
      else {
        const observedRunId = epochChanged && view.runtime === previous.runtime ? null : factValue(view.runtime)?.activeRunId;
        if (observedRunId) observedTerminalRunIds.push(observedRunId);
      }
    }
    if (change.kind === 'toolUpdated'
      && (change.tool.phase === 'completed' || change.tool.phase === 'failed')
      && (change.tool.name === null || TASK_SNAPSHOT_TOOLS.has(change.tool.name.trim().toLowerCase()))
      && isTaskToolTerminalTransition(
        change.tool,
        factValue(view.tools)?.find((tool) => tool.toolCallId === change.tool.toolCallId),
      )) tasksChanged = true;
    if (change.kind === 'recoveryRequired') tasksChanged = true;
    const projected = applyProjectionChange(view, change);
    if (reading && readingDisplay) readingDisplay = reconcileReadingWindow(readingDisplay, projected, view, change);
    return projected;
    }, { ...previous, epoch: delta.epoch });
  } catch (error) {
    return finish({ status: 'gap', sessionKey: recordKey, reason: error instanceof Error ? error.message : 'invalid replacement' });
  }
  const projected: SessionProjectionState = {
    ...nextView,
    epoch: delta.epoch,
    seq: delta.seq,
    cursor: delta.cursor,
  };
  let display = projected;
  if (reading && readingDisplay) {
    display = { ...readingDisplay, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor };
  } else if (loaded && !epochChanged && buildSessionIdentityKey(loaded.identity) !== projectionKey) {
    try {
      display = changes.reduce((view, change) => applyProjectionChange(view, change), loaded);
      display = { ...display, runtime: projected.runtime, approvals: projected.approvals, runtimeNotice: projected.runtimeNotice };
      if (!state.loadedSessions[recordKey]?.window.isAtLatest) display = { ...display, window: loaded.window };
    } catch (error) {
      return finish({ status: 'gap', sessionKey: recordKey, reason: error instanceof Error ? error.message : 'invalid replacement' });
    }
  }
  store.set(projectionKey, { ...projected, recordKey });
  const terminatedRunIds = delta.changes.flatMap((change) => change.kind === 'runPhaseChanged' && isTerminalRunPhase(change.phase)
    ? [change.runId] : []);
  if (!applyDecodedSessionView(input, projected, undefined, display, traceId, undefined,
    terminalRunIds, terminatedRunIds, observedTerminalRunIds)) {
    return finish({ status: 'unavailable', sessionKey: delta.sessionKey, reason: 'session identity unavailable' });
  }
  if (traceRuntimeState) {
    const appliedState = input.get();
    const recordKey = projectionRecordKey(appliedState, sessionIdentityForProjection(appliedState, projected));
    const appliedRuntime = recordKey ? appliedState.loadedSessions[recordKey]?.runtime : null;
    logSessionTrace('session.delta.apply.runtime.after', traceId, () => ({
      sessionKey: summarizeIdentifier(delta.sessionKey),
      seq: delta.seq,
      cursor: delta.cursor,
      projectionPhase: factValue(projected.runtime)?.phase ?? null,
      projectionActiveRunId: summarizeIdentifier(factValue(projected.runtime)?.activeRunId),
      runtimePhase: appliedRuntime?.runPhase ?? null,
      activeRunId: summarizeIdentifier(appliedRuntime?.activeRunId),
    }));
  }
  if (traceTurnState) {
    logSessionTrace('session.delta.apply.turns.after', traceId, () => ({
      sessionKey: summarizeIdentifier(delta.sessionKey),
      seq: delta.seq,
      cursor: delta.cursor,
      projectionTurns: summarizeWireAssistantTurns(factValue(projected.items)),
      identity: summarizeSessionIdentity(delta.identity), epoch: delta.epoch,
      displayTurns: summarizeWireAssistantTurns(factValue(display.items)),
      renderTurns: summarizeRenderAssistantTurns(getSessionRecord(input.get(), recordKey).items),
    }));
  }
  if (tasksChanged) refreshSessionTasks(input, projected, true);
  return finish({ status: 'applied', sessionKey: recordKey, epoch: delta.epoch, seq: delta.seq, cursor: delta.cursor });
}

