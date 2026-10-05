import type { RuntimeEndpointRef } from '../types/desktop/runtime-address';
import type { SessionDelta, SessionWireItem } from '../types/session/snapshot';
import type { SessionRenderItem } from '../types/session/render-item';

const SESSION_TRACE_PREFIX = 'session-trace';
const SESSION_TRACE_STORAGE_KEY = 'matchaclaw:session-trace';

type TracePayload = Record<string, unknown>;

type SessionIdentityLike = {
  endpoint: RuntimeEndpointRef;
  agentId?: string;
  sessionKey: string;
};

export function isSessionTraceEnabled(): boolean {
  if (import.meta.env.VITE_MATCHACLAW_SESSION_TRACE === '1') {
    return true;
  }
  try {
    return window.localStorage.getItem(SESSION_TRACE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function createSessionTraceId(label: string): string | null {
  if (!isSessionTraceEnabled()) {
    return null;
  }
  return `${SESSION_TRACE_PREFIX}:${label}:${crypto.randomUUID()}`;
}

export function logSessionTrace(stage: string, traceId: string | null | undefined, payload: TracePayload = {}): void {
  if (!traceId || !isSessionTraceEnabled()) {
    return;
  }
  console.info(JSON.stringify({
    prefix: SESSION_TRACE_PREFIX,
    source: 'renderer',
    traceId,
    stage,
    at: Date.now(),
    ...payload,
  }));
}

export function summarizeText(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return {
    hash: (hash >>> 0).toString(16).padStart(8, '0'),
    utf8Bytes: new TextEncoder().encode(value).length,
    utf16Length: value.length,
  };
}

export function summarizeIdentifier(value: string | null | undefined) {
  return value ? { present: true, length: value.length, ...summarizeText(value) }
    : { present: false, length: 0, hash: null, utf8Bytes: 0, utf16Length: 0 };
}

export function summarizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    message: summarizeIdentifier(message),
  };
}

export function summarizeEndpoint(endpoint: RuntimeEndpointRef | null | undefined) {
  if (!endpoint) {
    return null;
  }
  switch (endpoint.kind) {
    case 'native-runtime':
      return {
        kind: endpoint.kind,
        runtimeAdapterId: endpoint.runtimeAdapterId,
        runtimeInstanceId: summarizeIdentifier(endpoint.runtimeInstanceId),
      };
    case 'protocol-connector':
      return {
        kind: endpoint.kind,
        protocolId: summarizeIdentifier(endpoint.protocolId),
        connectorId: summarizeIdentifier(endpoint.connectorId),
        endpointId: summarizeIdentifier(endpoint.endpointId),
      };
  }
}

export function summarizeWireItem(item: SessionWireItem) {
  const segments = item.kind === 'assistantTurn' ? item.segments : item.kind === 'userMessage' ? item.content : [];
  return {
    kind: item.kind,
    itemHash: summarizeIdentifier(item.itemId).hash,
    runHash: summarizeIdentifier(item.kind === 'assistantTurn' ? item.runId : null).hash,
    messageHash: summarizeIdentifier(item.kind !== 'system' ? item.messageId : null).hash,
    status: item.status,
    text: summarizeText(item.text),
    segmentCount: segments.length, summarizedSegmentCount: Math.min(segments.length, 64), truncated: segments.length > 64,
    segments: segments.slice(0, 64).map((segment, segmentIndex) => ({
      segmentIndex, kind: segment.kind,
      ...('text' in segment ? { text: summarizeText(segment.text) } : {}),
      ...('toolCallId' in segment ? { toolHash: summarizeIdentifier(segment.toolCallId).hash } : {}),
      ...(segment.kind === 'largeText' ? { loadedBytes: segment.loadedBytes, totalBytes: segment.totalBytes } : {}),
    })),
  };
}

export function summarizeRenderItems(items: readonly SessionRenderItem[]) {
  return { itemCount: items.length, summarizedItemCount: Math.min(items.length, 200), truncated: items.length > 200,
    items: items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, ...summarizeRenderItem(item) })) };
}

export function summarizeRenderItem(item: SessionRenderItem) {
  return {
    kind: item.kind,
    renderKeyHash: summarizeIdentifier(item.key).hash,
    runHash: summarizeIdentifier(item.runId).hash,
    messageHash: summarizeIdentifier('messageId' in item && typeof item.messageId === 'string' ? item.messageId : null).hash,
    text: summarizeText(item.text),
    ...(item.kind === 'assistant-turn' ? {
      status: item.status,
      segmentCount: item.segments.length, summarizedSegmentCount: Math.min(item.segments.length, 64), truncated: item.segments.length > 64,
      segments: item.segments.slice(0, 64).map((segment, segmentIndex) => ({
        segmentIndex, kind: segment.kind, segmentHash: summarizeIdentifier(segment.key).hash,
        ...('text' in segment ? { text: summarizeText(segment.text) } : {}),
        ...(segment.kind === 'tool' ? { toolHash: summarizeIdentifier(segment.tool.toolCallId ?? segment.tool.id).hash } : {}),
        ...(segment.kind === 'message' && segment.largeText ? { loadedBytes: segment.largeText.loadedBytes, totalBytes: segment.largeText.totalBytes } : {}),
      })),
    } : {}),
  };
}

export function summarizeSessionChanges(changes: SessionDelta['changes']) {
  return { changeCount: changes.length, summarizedChangeCount: Math.min(changes.length, 16), truncated: changes.length > 16,
    changes: changes.slice(0, 16).map((change, changeIndex) => {
    switch (change.kind) {
      case 'itemsReplaced': return { changeIndex, kind: change.kind,
        oldItemCount: change.oldItemIds.length, oldItemHashes: change.oldItemIds.slice(0, 200).map((id) => summarizeIdentifier(id).hash),
        anchor: { kind: change.anchor.kind, itemHash: change.anchor.kind === 'after' ? summarizeIdentifier(change.anchor.itemId).hash : null },
        itemCount: change.items.length, summarizedItemCount: Math.min(change.items.length, 200), truncated: change.items.length > 200 || change.oldItemIds.length > 200,
        items: change.items.slice(0, 200).map((item, itemIndex) => ({ itemIndex, ...summarizeWireItem(item) })) };
      case 'messageUpdated':
      case 'messageReplaced': return { changeIndex, kind: change.kind, item: summarizeWireItem(change.item) };
      case 'messageDelta': return { changeIndex, kind: change.kind, itemHash: summarizeIdentifier(change.itemId).hash,
        runHash: summarizeIdentifier(change.runId).hash, messageHash: summarizeIdentifier(change.messageId).hash,
        text: summarizeText(change.text), replace: change.replace, status: change.status };
      case 'toolUpdated': return { changeIndex, kind: change.kind, toolHash: summarizeIdentifier(change.tool.toolCallId).hash,
        runHash: summarizeIdentifier(change.tool.runId).hash, phase: change.tool.phase };
      default: return { changeIndex, kind: change.kind };
    }
  }) };
}

export function summarizeSessionIdentity(identity: SessionIdentityLike | null | undefined) {
  if (!identity) {
    return null;
  }
  return {
    ...(identity.endpoint.kind === 'native-runtime' ? { provider: identity.endpoint.runtimeAdapterId,
      instanceHash: summarizeIdentifier(identity.endpoint.runtimeInstanceId).hash } : {}),
    agentHash: summarizeIdentifier(identity.agentId).hash, sessionHash: summarizeIdentifier(identity.sessionKey).hash,
    endpoint: summarizeEndpoint(identity.endpoint),
    agentId: summarizeIdentifier(identity.agentId),
    sessionKey: summarizeIdentifier(identity.sessionKey),
  };
}
