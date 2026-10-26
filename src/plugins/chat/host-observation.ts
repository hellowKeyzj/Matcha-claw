import { subscribeHostEvent } from '@/lib/host-events';
import { isGatewayOperational } from '@/lib/gateway-status';
import { useGatewayStore } from '@/plugins/runtime/store';
import { useChatStore } from './store';
import { useTaskSnapshotStore } from './store/task-snapshot-store';
import type { TaskSnapshotEvent } from '@/types/session/task-snapshot';
import { decodeSessionDelta, type SessionDelta, type SessionChange, type SessionWireContent, type SessionWireItem } from '@/types/session/snapshot';
import { createSessionTraceId, logSessionTrace, isSessionTraceEnabled, summarizeError, summarizeSessionChanges, summarizeSessionIdentity, summarizeIdentifier } from '@/lib/session-trace';

function sessionDeltaTextLength(changes: readonly SessionChange[]): number {
  return changes.reduce((total, change) => {
    if (change.kind === 'messageDelta') return total + change.text.length;
    if (change.kind === 'itemsReplaced') return total + change.items.reduce((length, item) => length + sessionItemTextLength(item), 0);
    if (change.kind !== 'messageUpdated' && change.kind !== 'messageReplaced') return total;
    return total + sessionItemTextLength(change.item);
  }, 0);
}

function sessionItemTextLength(item: SessionWireItem): number {
  if (item.kind === 'userMessage') return itemTextOrSegmentsLength(item.text, item.content);
  if (item.kind === 'assistantTurn') return itemTextOrSegmentsLength(item.text, item.segments);
  return item.text.length;
}

function itemTextOrSegmentsLength(
  text: string,
  segments: readonly SessionWireContent[],
): number {
  const segmentsLength = segments.reduce((total, segment) => (
    segment.kind === 'text' || segment.kind === 'thinking' || segment.kind === 'largeText'
      ? total + segment.text.length
      : total
  ), 0);
  return segmentsLength > 0 ? segmentsLength : text.length;
}

function sessionDeltaRunId(delta: SessionDelta): string | undefined {
  if (delta.runId) return delta.runId;
  for (const change of delta.changes) {
    if ('runId' in change && typeof change.runId === 'string') return change.runId;
  }
  return undefined;
}

function traceSessionDeltaBoundary(
  stage: string,
  traceId: string | null | undefined,
  delta: SessionDelta,
  extra: Record<string, unknown> = {},
): void {
  if (!traceId || !isSessionTraceEnabled()) return;
  logSessionTrace(stage, traceId, () => ({
    identity: summarizeSessionIdentity(delta.identity),
    mappedChanges: summarizeSessionChanges(delta.changes),
    sessionKey: summarizeIdentifier(delta.sessionKey),
    runId: summarizeIdentifier(sessionDeltaRunId(delta)),
    epoch: delta.epoch,
    seq: delta.seq,
    cursor: delta.cursor,
    changeKinds: delta.changes.map((change) => change.kind),
    changeCount: delta.changes.length,
    textLength: sessionDeltaTextLength(delta.changes),
    ...extra,
  }));
}

function syncPendingApprovals(): void {
  void useChatStore.getState().syncPendingApprovals().catch((error) => {
    console.warn('[session.approvals]', summarizeError(error));
  });
}

export function subscribeChatHostEvents(): () => void {
  const unsubscribers: Array<() => void> = [];
  unsubscribers.push(subscribeHostEvent<unknown>('session.resync', (payload) => {
    void useChatStore.getState().resyncSession(payload).catch((error) => {
      console.warn('[session.resync]', summarizeError(error));
      logSessionTrace('session.resync.failed', 'session-resync-boundary', () => summarizeError(error));
    });
  }));
  unsubscribers.push(subscribeHostEvent<unknown>('session.delta', (payload) => {
    const traceId = createSessionTraceId('session.delta-boundary');
    logSessionTrace('session.delta.received', traceId, () => ({
      payloadType: payload && typeof payload === 'object' ? 'object' : typeof payload,
    }));
    let delta;
    try {
      delta = decodeSessionDelta(payload);
    } catch (error) {
      logSessionTrace('session.delta.decode', traceId, () => ({
        decoded: false,
        ...summarizeError(error),
      }));
      return;
    }
    traceSessionDeltaBoundary('session.delta.decode', traceId, delta);
    const applyResult = useChatStore.getState().applySessionDelta(delta);
    if (isSessionTraceEnabled()) traceSessionDeltaBoundary('session.delta.apply', traceId, delta, {
      status: applyResult.status,
      reason: 'reason' in applyResult ? summarizeIdentifier(applyResult.reason) : null,
    });
  }));
  unsubscribers.push(subscribeHostEvent<TaskSnapshotEvent>(
    'task:snapshot',
    (payload) => {
      useTaskSnapshotStore.getState().reportTaskCenterSnapshot(payload);
    },
  ));
  unsubscribers.push(useGatewayStore.subscribe((state, previous) => {
    if (isGatewayOperational(state.status) && !isGatewayOperational(previous.status)) syncPendingApprovals();
  }));
  if (isGatewayOperational(useGatewayStore.getState().status)) syncPendingApprovals();
  return () => { for (const unsubscribe of unsubscribers.reverse()) unsubscribe(); };
}
