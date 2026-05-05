import type { GatewayNotification } from './protocol';

type GatewayRunPhase = 'started' | 'completed' | 'error' | 'aborted';

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
    type: 'run.phase';
    phase: GatewayRunPhase;
    runId?: string;
    sessionKey?: string;
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

function normalizeGatewayChatState(
  payload: Record<string, unknown>,
  message: Record<string, unknown>,
): string {
  const fromPayload = getTrimmedString(payload.state || payload.phase).toLowerCase();
  const fromMessage = getTrimmedString(message.state || message.phase).toLowerCase();
  const state = fromPayload || fromMessage;
  if (state) {
    if (state === 'completed' || state === 'done' || state === 'finished' || state === 'end') {
      return 'final';
    }
    return state;
  }

  const stopReason = payload.stopReason ?? payload.stop_reason ?? message.stopReason ?? message.stop_reason;
  if (stopReason != null) {
    return 'final';
  }
  if (message.role != null || message.content != null || message.text != null) {
    // Legacy chat payloads often omit explicit state while still being part of
    // a streaming sequence. Default to delta and let explicit state/stopReason
    // close the turn as final.
    return 'delta';
  }
  return '';
}

function normalizeGatewayChatEvent(payload: unknown): Record<string, unknown> | null {
  const input = asRecord(payload);
  if (!input) {
    return null;
  }
  const nestedMessage = asRecord(input.message);
  const message = nestedMessage ?? input;
  const state = normalizeGatewayChatState(input, message);
  if (!state) {
    return null;
  }

  const runId = getTrimmedString(input.runId ?? message.runId);
  const sessionKey = getTrimmedString(input.sessionKey ?? message.sessionKey);
  const sequenceId = getFiniteNumber(input.sequenceId ?? input.sequence_id ?? message.sequenceId ?? message.sequence_id);
  const agentId = getTrimmedString(input.agentId ?? input.agent_id ?? message.agentId ?? message.agent_id);
  return {
    state,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(sequenceId != null ? { sequenceId } : {}),
    ...(agentId ? { agentId } : {}),
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
  const sequenceId = getFiniteNumber(input.seq);
  const timestamp = getFiniteNumber(input.ts);
  if (!phase || !toolCallId || !runId || !sessionKey || sequenceId == null || timestamp == null) {
    return null;
  }

  const toolName = getTrimmedString(data.name);
  if (phase === 'start' && !toolName) {
    return null;
  }
  return {
    runId,
    sessionKey,
    sequenceId,
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

function normalizeGatewayRunPhase(payload: unknown): {
  phase: GatewayRunPhase;
  runId?: string;
  sessionKey?: string;
} | null {
  const input = asRecord(payload) ?? {};
  const stream = getTrimmedString(input.stream);
  if (stream && stream !== 'lifecycle') {
    return null;
  }
  const data = asRecord(input.data) ?? {};
  const phaseRaw = getTrimmedString(data.phase ?? input.phase ?? data.state ?? input.state).toLowerCase();
  if (!phaseRaw) {
    return null;
  }

  const phase = (() => {
    if (phaseRaw === 'start' || phaseRaw === 'started') {
      return 'started' as const;
    }
    if (phaseRaw === 'completed' || phaseRaw === 'done' || phaseRaw === 'finished' || phaseRaw === 'end') {
      return 'completed' as const;
    }
    if (phaseRaw === 'error' || phaseRaw === 'failed') {
      return 'error' as const;
    }
    if (phaseRaw === 'aborted' || phaseRaw === 'abort' || phaseRaw === 'cancelled' || phaseRaw === 'canceled') {
      return 'aborted' as const;
    }
    return null;
  })();
  if (!phase) {
    return null;
  }

  const runId = getTrimmedString(input.runId ?? data.runId);
  const sessionKey = getTrimmedString(input.sessionKey ?? data.sessionKey);
  return {
    phase,
    ...(runId ? { runId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
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
    case 'agent': {
      const toolLifecycleEvent = normalizeGatewayToolLifecycleEvent(payload);
      if (toolLifecycleEvent) {
        dispatcher.emitConversationEvent({
          type: 'tool.lifecycle',
          event: toolLifecycleEvent,
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
          type: 'tool.lifecycle',
          event: toolLifecycleEvent,
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
