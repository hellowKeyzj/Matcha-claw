import type { SessionIdentity } from '../../../electron/desktop-contract/runtime-address';
import type {
  SessionChange,
  SessionCompleteness,
  SessionFact,
  SessionView,
  SessionWireApproval,
  SessionWireContent,
  SessionWireIdentity,
  SessionWireItem,
  SessionWireRuntime,
  SessionWireTool,
  SessionWireWindow,
} from '../../../src/types/session/snapshot';

export type SessionFixtureItem = SessionWireItem;

export const sessionFixtureIdentity = (
  sessionKey: string,
  agentId = sessionKey.split(':')[1] ?? 'main',
  runtimeInstanceId = 'local',
): SessionIdentity => ({
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId,
  },
  agentId,
  sessionKey,
});

function wireIdentity(identity: SessionIdentity | SessionWireIdentity): SessionWireIdentity {
  return {
    sessionKey: identity.sessionKey,
    endpoint: {
      kind: identity.endpoint.kind,
      runtimeAdapterId: identity.endpoint.runtimeAdapterId,
      runtimeInstanceId: identity.endpoint.runtimeInstanceId,
    },
    ...(identity.agentId ? { agentId: identity.agentId } : {}),
  };
}

export function completeFact<T>(value: T): SessionFact<T> {
  return { complete: value };
}

export function incompleteFact<T>(value: T, gaps: SessionWireMissingFact[] = ['event_only']): SessionFact<T> {
  return { incomplete: { facts: value, gaps } };
}

type SessionWireMissingFact =
  | 'session_identity'
  | 'catalog'
  | 'usage'
  | 'artifacts'
  | 'context_tokens'
  | 'tasks'
  | 'replay_cursor'
  | 'bounded_history'
  | 'partial_runtime'
  | 'event_only';

export function textContent(text: string): SessionWireContent {
  return { kind: 'text', text };
}

export function largeTextContent(
  text: string,
  contentRef = 'content-ref-1',
  totalBytes = 12,
  loadedBytes = 7,
): SessionWireContent {
  return { kind: 'largeText', text, contentRef, totalBytes, loadedBytes };
}

export function thinkingContent(text: string): SessionWireContent {
  return { kind: 'thinking', text };
}

export function toolUseContent(name: string, toolCallId: string): SessionWireContent {
  return { kind: 'toolUse', name, toolCallId };
}

export function toolResultContent(
  toolCallId: string,
  summary: string | null,
  isError: boolean,
): SessionWireContent {
  return { kind: 'toolResult', toolCallId, summary, isError };
}

export function mediaContent(mediaType: string | null, reference: string): SessionWireContent {
  return { kind: 'media', mediaType, reference };
}

export function omittedContent(reason: 'thinking' | 'unsafe_media' | 'unknown'): SessionWireContent {
  return { kind: 'omitted', reason };
}

export function userItem(
  itemId: string,
  text: string,
  options: Partial<Extract<SessionWireItem, { kind: 'userMessage' }>> = {},
): Extract<SessionWireItem, { kind: 'userMessage' }> {
  return {
    kind: 'userMessage',
    itemId,
    messageId: itemId,
    text,
    content: [textContent(text)],
    status: 'final',
    ...options,
  };
}

export function assistantItem(
  itemId: string,
  text: string,
  options: Partial<Extract<SessionWireItem, { kind: 'assistantTurn' }>> = {},
): Extract<SessionWireItem, { kind: 'assistantTurn' }> {
  return {
    kind: 'assistantTurn',
    itemId,
    runId: null,
    messageId: itemId,
    status: 'final',
    segments: text ? [textContent(text)] : [],
    text,
    ...options,
  };
}

export function systemItem(
  itemId: string,
  text: string,
  status: Extract<SessionWireItem, { kind: 'system' }>['status'] = 'final',
): Extract<SessionWireItem, { kind: 'system' }> {
  return { kind: 'system', itemId, text, status };
}

export function toolView(
  toolCallId: string,
  options: Partial<SessionWireTool> = {},
): SessionWireTool {
  return {
    toolCallId,
    runId: null,
    name: 'tool',
    phase: 'started',
    input: null,
    inputText: null,
    summary: null,
    output: null,
    details: null,
    isError: null,
    ...options,
  };
}

export function approvalView(
  approvalId: string,
  options: Partial<SessionWireApproval> = {},
): SessionWireApproval {
  return {
    approvalId,
    runId: null,
    phase: 'requested',
    optionIds: ['allow-once', 'deny'],
    ...options,
  };
}

export function runtimeView(options: Partial<SessionWireRuntime> = {}): SessionWireRuntime {
  return {
    phase: 'completed',
    activeRunId: null,
    issue: null,
    runProgress: null,
    runtimeActivity: null,
    errorDetail: null,
    ...options,
  };
}

export function windowView(
  totalItemCount: number,
  options: Partial<SessionWireWindow> = {},
): SessionWireWindow {
  return {
    totalItemCount,
    windowStartOffset: 0,
    windowEndOffset: totalItemCount,
    hasMore: false,
    hasNewer: false,
    isAtLatest: true,
    ...options,
  };
}

export function sessionView(
  sessionKey: string,
  options: {
    identity?: SessionIdentity | SessionWireIdentity;
    endpointSessionId?: string | null;
    epoch?: number;
    seq?: number;
    cursor?: number;
    items?: SessionFact<SessionWireItem[]>;
    tools?: SessionFact<SessionWireTool[]>;
    approvals?: SessionFact<SessionWireApproval[]>;
    runtime?: SessionFact<SessionWireRuntime>;
    window?: SessionFact<SessionWireWindow>;
    completeness?: SessionCompleteness;
  } = {},
): SessionView {
  const items = options.items ?? completeFact<SessionWireItem[]>([]);
  const itemFacts = typeof items === 'object' && items !== null && 'complete' in items
    ? items.complete
    : typeof items === 'object' && items !== null && 'incomplete' in items
      ? items.incomplete.facts
      : [];
  const window = options.window ?? completeFact(windowView(itemFacts.length));
  return {
    sessionKey,
    endpointSessionId: options.endpointSessionId ?? null,
    model: null,
    identity: wireIdentity(options.identity ?? sessionFixtureIdentity(sessionKey)),
    epoch: options.epoch ?? 1,
    seq: options.seq ?? 0,
    cursor: options.cursor ?? 0,
    items,
    tools: options.tools ?? completeFact<SessionWireTool[]>([]),
    approvals: options.approvals ?? completeFact<SessionWireApproval[]>([]),
    runtime: options.runtime ?? completeFact(runtimeView()),
    window,
    completeness: options.completeness ?? 'complete',
  };
}

export function sessionDelta(
  sessionKey: string,
  options: {
    epoch?: number;
    seq: number;
    cursor: number;
    routeKey?: string;
    runId?: string;
    changes: SessionChange[];
  },
): SessionDeltaFixture {
  return {
    sessionKey,
    epoch: options.epoch ?? 1,
    seq: options.seq,
    cursor: options.cursor,
    ...(options.routeKey ? { routeKey: options.routeKey } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    changes: options.changes,
  };
}

export type SessionDeltaFixture = {
  sessionKey: string;
  routeKey?: string;
  epoch: number;
  seq: number;
  cursor: number;
  runId?: string;
  changes: SessionChange[];
};
