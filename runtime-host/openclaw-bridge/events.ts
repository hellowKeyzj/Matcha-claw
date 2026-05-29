import type { GatewayNotification } from './protocol';

type GatewayRunPhase = 'started' | 'completed' | 'error' | 'aborted';
type GatewayRuntimeActivityPhase = 'started' | 'completed';

export type GatewayConversationEvent =
  | {
    type: 'chat.message';
    event: Record<string, unknown>;
  }
  | {
    type: 'tool.lifecycle';
    event: Record<string, unknown>;
  }
  | {
    type: 'session.message';
    event: Record<string, unknown>;
  }
  | {
    type: 'session.tool';
    event: Record<string, unknown>;
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

function normalizeGatewayChatState(payload: Record<string, unknown>): string {
  const state = getTrimmedString(payload.state).toLowerCase();
  return state === 'delta' || state === 'final' || state === 'error' || state === 'aborted'
    ? state
    : '';
}

function normalizeGatewayChatEvent(payload: unknown): Record<string, unknown> | null {
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
  return {
    state,
    runId,
    sessionKey,
    seq,
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

function normalizeGatewayToolLifecycleEvent(payload: unknown): Record<string, unknown> | null {
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
  if (!toolName) {
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
