import { createHash } from 'node:crypto';
import { logger } from '../../../../utils/logger';
import type { SessionChange, SessionIdentity, SessionItem, SessionView } from './session-contract';

const SESSION_TRACE_PREFIX = 'session-trace';
export const SESSION_TRACE_HEADER = 'X-MatchaClaw-Session-Trace';

type TracePayload = Record<string, unknown>;

export function isSessionTraceEnabled(): boolean {
  return process.env.MATCHACLAW_SESSION_TRACE === '1';
}

export function logSessionTrace(stage: string, traceId: string | null | undefined, payload: TracePayload = {}): void {
  if (!traceId || !isSessionTraceEnabled()) {
    return;
  }
  logger.info(JSON.stringify({
    prefix: SESSION_TRACE_PREFIX,
    source: 'electron-main',
    traceIdHash: createHash('sha256').update(traceId).digest('hex').slice(0, 16),
    stage,
    at: Date.now(),
    ...payload,
  }));
}

export function traceHeader(traceId: string | null | undefined): Record<string, string> {
  return traceId ? { [SESSION_TRACE_HEADER]: traceId } : {};
}

export function readTraceHeader(headers: Record<string, string | string[] | undefined>): string | null {
  const value = headers[SESSION_TRACE_HEADER.toLowerCase()] ?? headers[SESSION_TRACE_HEADER];
  const traceId = Array.isArray(value) ? value[0] : value;
  return typeof traceId === 'string' && traceId.length > 0 && traceId.length <= 256
    ? traceId
    : null;
}

export function summarizeText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return { hash: (hash >>> 0).toString(16).padStart(8, '0'), utf8Bytes: Buffer.byteLength(value, 'utf8'), utf16Length: value.length };
}

export function summarizeIdentifier(value: string | null | undefined) {
  return value ? { present: true, length: value.length, ...summarizeText(value) }
    : { present: false, length: 0, hash: null, utf8Bytes: 0, utf16Length: 0 };
}

export function summarizeSessionIdentity(identity: SessionIdentity) {
  return { provider: identity.endpoint.runtimeAdapterId, instanceHash: summarizeIdentifier(identity.endpoint.runtimeInstanceId).hash,
    agentHash: summarizeIdentifier(identity.agentId).hash, sessionHash: summarizeIdentifier(identity.sessionKey).hash };
}

export function summarizeSessionItem(item: SessionItem): unknown {
  const value = item as SessionItem & Record<string, unknown>;
  const segments = value.kind === 'assistantTurn' ? value.segments : value.kind === 'userMessage' ? value.content : [];
  return { kind: value.kind, itemHash: summarizeIdentifier(typeof value.itemId === 'string' ? value.itemId : null).hash,
    runHash: summarizeIdentifier(typeof value.runId === 'string' ? value.runId : null).hash,
    messageHash: summarizeIdentifier(typeof value.messageId === 'string' ? value.messageId : null).hash,
    status: value.status, text: typeof value.text === 'string' ? summarizeText(value.text) : null,
    segmentCount: Array.isArray(segments) ? segments.length : 0, summarizedSegmentCount: Array.isArray(segments) ? Math.min(segments.length, 64) : 0,
    truncated: Array.isArray(segments) && segments.length > 64,
    segments: Array.isArray(segments) ? segments.slice(0, 64).map((segment, segmentIndex) => {
      if (!isRecord(segment)) return { segmentIndex };
      return { segmentIndex, kind: segment.kind,
        ...(typeof segment.text === 'string' ? { text: summarizeText(segment.text) } : {}),
        ...(typeof segment.toolCallId === 'string' ? { toolHash: summarizeIdentifier(segment.toolCallId).hash } : {}),
        ...(segment.kind === 'largeText' ? { loadedBytes: segment.loadedBytes, totalBytes: segment.totalBytes } : {}) };
    }) : [] };
}

export function summarizeSessionChanges(changes: readonly SessionChange[]) {
  return { changeCount: changes.length, summarizedChangeCount: Math.min(changes.length, 16), truncated: changes.length > 16,
    changes: changes.slice(0, 16).map((change, changeIndex) => {
    switch (change.kind) {
      case 'itemsReplaced': return { changeIndex, kind: change.kind,
        oldItemCount: change.oldItemIds.length, oldItemHashes: change.oldItemIds.slice(0, 200).map((id) => summarizeIdentifier(id).hash),
        anchor: { kind: change.anchor.kind, itemHash: change.anchor.kind === 'after' ? summarizeIdentifier(change.anchor.itemId).hash : null },
        itemCount: change.items.length, summarizedItemCount: Math.min(change.items.length, 200), truncated: change.items.length > 200 || change.oldItemIds.length > 200,
        items: change.items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, summary: summarizeSessionItem(item) })) };
      case 'messageUpdated':
      case 'messageReplaced': return { changeIndex, kind: change.kind, item: summarizeSessionItem(change.item) };
      case 'messageDelta': return { changeIndex, kind: change.kind, itemHash: summarizeIdentifier(change.itemId).hash,
        runHash: summarizeIdentifier(change.runId).hash, messageHash: summarizeIdentifier(change.messageId).hash,
        text: summarizeText(change.text), replace: change.replace, status: change.status };
      case 'toolUpdated': return { changeIndex, kind: change.kind, toolHash: summarizeIdentifier(change.tool.toolCallId).hash,
        runHash: summarizeIdentifier(change.tool.runId).hash, phase: change.tool.phase };
      default: return { changeIndex, kind: change.kind };
    }
  }) };
}

export function summarizeSessionView(view: SessionView) {
  const items = isRecord(view.items) ? ('complete' in view.items ? view.items.complete
    : isRecord(view.items.incomplete) ? view.items.incomplete.facts : null) : null;
  return { identity: summarizeSessionIdentity(view.identity), epoch: view.epoch, seq: view.seq, cursor: view.cursor,
    itemCount: Array.isArray(items) ? items.length : 0, summarizedItemCount: Array.isArray(items) ? Math.min(items.length, 200) : 0,
    truncated: Array.isArray(items) && items.length > 200,
    items: Array.isArray(items) ? items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, summary: summarizeSessionItem(item as SessionItem) })) : null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
