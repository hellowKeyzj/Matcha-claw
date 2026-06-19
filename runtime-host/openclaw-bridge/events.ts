import type { GatewayNotification } from './protocol';

type GatewayRunPhase = 'started' | 'completed' | 'error' | 'aborted';
type GatewayRuntimeActivityPhase = 'started' | 'completed';
type GatewayChatTextMode = 'delta' | 'snapshot' | 'replace';

export interface GatewayChatMessageEvent {
  state: 'delta' | 'final' | 'error' | 'aborted';
  runId: string;
  sessionKey: string;
  seq: number;
  textMode: GatewayChatTextMode;
  text: string;
  message: Record<string, unknown>;
  messageId?: unknown;
  id?: unknown;
  originMessageId?: unknown;
  clientId?: unknown;
  timestamp?: unknown;
  ts?: unknown;
  deltaText?: unknown;
  replace?: true;
}

export interface GatewayThinkingEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  timestamp: number;
  text: string;
  delta?: string;
}

export interface GatewayToolLifecycleEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  timestamp: number;
  phase: 'start' | 'update' | 'result';
  toolCallId: string;
  name?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
}

export interface GatewayPlanEvent {
  runId: string;
  sessionKey: string;
  seq: number;
  timestamp?: number;
  data: Record<string, unknown>;
}

export type GatewayConversationEvent =
  | {
    type: 'chat.message';
    event: GatewayChatMessageEvent;
  }
  | {
    type: 'thinking.delta';
    event: GatewayThinkingEvent;
  }
  | {
    type: 'tool.lifecycle';
    event: GatewayToolLifecycleEvent;
  }
  | {
    type: 'plan.snapshot';
    event: GatewayPlanEvent;
  }
  | {
    type: 'session.message';
    event: Record<string, unknown>;
  }
  | {
    type: 'session.tool';
    event: GatewayToolLifecycleEvent;
  }
  | {
    type: 'usage';
    event: Record<string, unknown>;
  }
  | {
    type: 'artifact';
    event: Record<string, unknown>;
  }
  | {
    type: 'run.activity';
    activity: 'compacting';
    phase: GatewayRuntimeActivityPhase;
    runId?: string;
    sessionKey?: string;
  }
  | {
    type: 'run.phase';
    phase: GatewayRunPhase;
    runId?: string;
    sessionKey?: string;
    error?: string;
    errorMessage?: string;
    errorCode?: string;
    errorDetails?: unknown;
  };

export type GatewayProtocolEventDispatcher = {
  emitNotification: (notification: GatewayNotification) => void;
  emitConversationEvent: (payload: GatewayConversationEvent) => void;
  emitChannelStatus: (payload: { channelId: string; status: string }) => void;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function getTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function getFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = Number(value.trim());
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

function normalizeGatewayChatState(payload: Record<string, unknown>): GatewayChatMessageEvent['state'] | null {
  const state = getTrimmedString(payload.state).toLowerCase();
  return state === 'delta' || state === 'final' || state === 'error' || state === 'aborted'
    ? state
    : null;
}

function readGatewayMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.flatMap((block) => {
    const row = asRecord(block);
    if (!row) {
      return [];
    }
    if ((row.type === 'text' || row.type === 'message') && typeof row.text === 'string') {
      return [row.text];
    }
    if (row.type === 'text' && typeof row.content === 'string') {
      return [row.content];
    }
    return [];
  }).join('\n');
}

function normalizeGatewayChatEvent(payload: unknown): GatewayChatMessageEvent | null {
  const input = asRecord(payload);
  if (!input) {
    return null;
  }
  const nestedMessage = asRecord(input.message);
  const message = nestedMessage ?? {};
  const state = normalizeGatewayChatState(input);
  if (!state) {
    return null;
  }

  const runId = getTrimmedString(input.runId);
  const sessionKey = getTrimmedString(input.sessionKey);
  const seq = getFiniteNumber(input.seq);
  if (!runId || !sessionKey || seq == null) {
    return null;
  }
  const hasDeltaText = Object.prototype.hasOwnProperty.call(input, 'deltaText') && typeof input.deltaText === 'string';
  const textMode: GatewayChatTextMode = input.replace === true
    ? 'replace'
    : hasDeltaText
      ? 'delta'
      : 'snapshot';
  const text = hasDeltaText ? String(input.deltaText) : readGatewayMessageText(message.content);
  return {
    state,
    runId,
    sessionKey,
    seq,
    textMode,
    text,
    ...(Object.prototype.hasOwnProperty.call(input, 'messageId') ? { messageId: input.messageId } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'id') ? { id: input.id } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'originMessageId') ? { originMessageId: input.originMessageId } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'clientId') ? { clientId: input.clientId } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'timestamp') ? { timestamp: input.timestamp } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'ts') ? { ts: input.ts } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, 'deltaText') ? { deltaText: input.deltaText } : {}),
    ...(input.replace === true ? { replace: true } : {}),
    message,
  };
}

type GatewayToolPhase = 'start' | 'update' | 'result';

function parseGatewayToolPhase(value: unknown): GatewayToolPhase | null {
  const phase = getTrimmedString(value);
  return phase === 'start' || phase === 'update' || phase === 'result'
    ? phase
    : null;
}

function normalizeGatewayToolLifecycleEvent(payload: unknown): GatewayToolLifecycleEvent | null {
  const input = asRecord(payload);
  const data = asRecord(input?.data);
  if (!input || !data || input.stream !== 'tool') {
    return null;
  }
  const phase = parseGatewayToolPhase(data.phase);
  const toolCallId = getTrimmedString(data.toolCallId);
  const runId = getTrimmedString(input.runId);
  const sessionKey = getTrimmedString(input.sessionKey);
  const seq = getFiniteNumber(input.seq);
  const timestamp = getFiniteNumber(input.ts);
  if (!phase || !toolCallId || !runId || !sessionKey || seq == null || timestamp == null) {
    return null;
  }

  const toolName = getTrimmedString(data.name);
  if (phase === 'start' && !toolName) {
    return null;
  }
  return {
    runId,
    sessionKey,
    seq,
    timestamp,
    phase,
    toolCallId,
    ...(toolName ? { name: toolName } : {}),
    ...(Object.prototype.hasOwnProperty.call(data, 'args') ? { args: data.args } : {}),
    ...(Object.prototype.hasOwnProperty.call(data, 'partialResult') ? { partialResult: data.partialResult } : {}),
    ...(Object.prototype.hasOwnProperty.call(data, 'result') ? { result: data.result } : {}),
    ...(typeof data.isError === 'boolean' ? { isError: data.isError } : {}),
  };
}

function normalizeGatewayThinkingEvent(payload: unknown): GatewayThinkingEvent | null {
  const input = asRecord(payload);
  const data = asRecord(input?.data);
  if (!input || !data || input.stream !== 'thinking') {
    return null;
  }
  const runId = getTrimmedString(input.runId);
  const sessionKey = getTrimmedString(input.sessionKey);
  const seq = getFiniteNumber(input.seq);
  const timestamp = getFiniteNumber(input.ts);
  const text = getTrimmedString(data.text);
  const delta = getTrimmedString(data.delta);
  if (!runId || !sessionKey || seq == null || timestamp == null || !text) {
    return null;
  }
  return {
    runId,
    sessionKey,
    seq,
    timestamp,
    text,
    ...(delta ? { delta } : {}),
  };
}

function normalizeGatewayRunActivity(payload: unknown): {
  activity: 'compacting';
  phase: GatewayRuntimeActivityPhase;
  runId?: string;
  sessionKey?: string;
} | null {
  const input = asRecord(payload);
  if (!input || input.stream !== 'compaction') {
    return null;
  }
  const data = asRecord(input.data) ?? {};
  const phaseRaw = getTrimmedString(data.phase).toLowerCase();
  const phase = (() => {
    if (phaseRaw === 'start') {
      return 'started' as const;
    }
    if (phaseRaw === 'end') {
      return 'completed' as const;
    }
    return null;
  })();
  if (!phase) {
    return null;
  }
  const runId = getTrimmedString(input.runId);
  const sessionKey = getTrimmedString(input.sessionKey);
  return {
    activity: 'compacting',
    phase,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function normalizeGatewayPlanEvent(payload: unknown): GatewayPlanEvent | null {
  const input = asRecord(payload);
  const data = asRecord(input?.data);
  if (!input || !data || input.stream !== 'plan') {
    return null;
  }
  const runId = getTrimmedString(input.runId);
  const sessionKey = getTrimmedString(input.sessionKey);
  const seq = getFiniteNumber(input.seq);
  if (!runId || !sessionKey || seq == null) {
    return null;
  }
  const timestamp = getFiniteNumber(input.ts);
  return {
    runId,
    sessionKey,
    seq,
    ...(timestamp != null ? { timestamp } : {}),
    data,
  };
}

function normalizeGatewayRunPhase(payload: unknown): {
  phase: 'started' | 'completed' | 'error' | 'aborted';
  runId?: string;
  sessionKey?: string;
  error?: string;
  errorMessage?: string;
  errorCode?: string;
  errorDetails?: unknown;
} | null {
  const input = asRecord(payload);
  const data = asRecord(input?.data);
  if (!input || !data || input.stream !== 'lifecycle') {
    return null;
  }
  const rawPhase = getTrimmedString(data.phase).toLowerCase();
  const phase = rawPhase === 'start'
    ? 'started'
    : rawPhase === 'end'
      ? 'completed'
      : rawPhase === 'error' || rawPhase === 'aborted'
        ? rawPhase
        : null;
  if (!phase) {
    return null;
  }

  const runId = getTrimmedString(input.runId);
  const sessionKey = getTrimmedString(input.sessionKey);
  const errorMessage = getTrimmedString(data.errorMessage);
  const error = getTrimmedString(data.error);
  const rawError = asRecord(data.error);
  const errorCode = getTrimmedString(data.errorCode ?? rawError?.code);
  const errorDetails = data.errorDetails ?? rawError?.details;
  return {
    phase,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(error ? { error } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorDetails !== undefined ? { errorDetails } : {}),
  };
}

export function __resetGatewayChatEventDedupStateForTest(): void {
  // Kept as a test hook for gateway protocol state; event ingress is stateless.
}

export function dispatchGatewayProtocolEvent(
  dispatcher: GatewayProtocolEventDispatcher,
  event: string,
  payload: unknown,
): void {
  switch (event) {
    case 'tick':
      break;
    case 'chat':
      {
        const normalized = normalizeGatewayChatEvent(payload);
        if (!normalized) {
          break;
        }
        dispatcher.emitConversationEvent({
          type: 'chat.message',
          event: normalized,
        });
      }
      break;
    case 'session.message': {
      const normalized = asRecord(payload);
      if (normalized) {
        dispatcher.emitConversationEvent({
          type: 'session.message',
          event: normalized,
        });
      }
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
      break;
    }
    case 'agent': {
      const thinkingEvent = normalizeGatewayThinkingEvent(payload);
      if (thinkingEvent) {
        dispatcher.emitConversationEvent({
          type: 'thinking.delta',
          event: thinkingEvent,
        });
      }
      const planEvent = normalizeGatewayPlanEvent(payload);
      if (planEvent) {
        dispatcher.emitConversationEvent({
          type: 'plan.snapshot',
          event: planEvent,
        });
        dispatcher.emitNotification({
          method: event,
          params: payload,
        } satisfies GatewayNotification);
        break;
      }
      const toolLifecycleEvent = normalizeGatewayToolLifecycleEvent(payload);
      if (toolLifecycleEvent) {
        dispatcher.emitConversationEvent({
          type: 'tool.lifecycle',
          event: toolLifecycleEvent,
        });
      }
      const runActivity = normalizeGatewayRunActivity(payload);
      if (runActivity) {
        dispatcher.emitConversationEvent({
          type: 'run.activity',
          ...runActivity,
        });
      }
      const runPhase = normalizeGatewayRunPhase(payload);
      if (runPhase) {
        dispatcher.emitConversationEvent({
          type: 'run.phase',
          ...runPhase,
        });
      }
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
      break;
    }
    case 'session.tool': {
      const toolLifecycleEvent = normalizeGatewayToolLifecycleEvent(payload);
      if (toolLifecycleEvent) {
        dispatcher.emitConversationEvent({
          type: 'session.tool',
          event: toolLifecycleEvent,
        });
      }
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
      break;
    }
    case 'usage':
    case 'artifact': {
      const normalized = asRecord(payload);
      if (normalized) {
        dispatcher.emitConversationEvent({
          type: event,
          event: normalized,
        });
      }
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
      break;
    }
    case 'channel.status':
      dispatcher.emitChannelStatus(payload as { channelId: string; status: string });
      break;
    default:
      dispatcher.emitNotification({
        method: event,
        params: payload,
      } satisfies GatewayNotification);
  }
}
