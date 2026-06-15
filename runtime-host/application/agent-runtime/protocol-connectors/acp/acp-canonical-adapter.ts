import type { CanonicalSessionEvent } from '../../../sessions/canonical/canonical-events';
import type { RuntimeEventAdapter, RuntimeSessionContext } from '../../contracts/runtime-endpoint-types';
import { ACP_PROTOCOL_ID } from './acp-identity';

type AcpRecord = Record<string, unknown>;

function asRecord(value: unknown): AcpRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as AcpRecord : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readPayload(input: unknown): AcpRecord | null {
  const record = asRecord(input);
  return asRecord(record?.params) ?? asRecord(record?.event) ?? record;
}

function eventScope(context: RuntimeSessionContext): string {
  return context.endpoint.scopeKey;
}

function readText(payload: AcpRecord): string {
  return asString(payload.text)
    ?? asString(payload.content)
    ?? asString(asRecord(payload.message)?.text)
    ?? asString(asRecord(payload.message)?.content)
    ?? '';
}

function base(input: {
  eventId: string;
  runtimeEventType: string;
  context: RuntimeSessionContext;
  runId?: string;
  turnId?: string;
  timestamp?: number;
  laneKey?: string;
  seq?: number;
  raw: unknown;
}): Pick<CanonicalSessionEvent, 'eventId' | 'protocolId' | 'runtimeEndpointId' | 'source' | 'sessionId' | 'runId' | 'turnId' | 'timestamp' | 'laneKey' | 'seq' | 'origin'> {
  return {
    eventId: input.eventId,
    protocolId: input.context.protocolId,
    runtimeEndpointId: input.context.runtimeEndpointId,
    source: 'live',
    sessionId: input.context.sessionKey,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.timestamp != null ? { timestamp: input.timestamp } : {}),
    laneKey: input.laneKey ?? 'main',
    ...(input.seq != null ? { seq: input.seq } : {}),
    origin: {
      runtimeEventType: input.runtimeEventType,
      runtimeIds: {
        sessionKey: input.context.sessionKey,
        ...(input.runId ? { runId: input.runId } : {}),
      },
      raw: structuredClone(input.raw),
    },
  };
}

export class AcpCanonicalAdapter implements RuntimeEventAdapter {
  canTranslate(input: unknown, context: RuntimeSessionContext): boolean {
    return context.protocolId === ACP_PROTOCOL_ID && asRecord(input) !== null;
  }

  translate(input: unknown, context: RuntimeSessionContext): CanonicalSessionEvent[] {
    const record = asRecord(input);
    const payload = readPayload(input);
    if (!record || !payload) {
      return [];
    }
    const method = asString(record.method) ?? asString(record.type) ?? 'acp.event';
    const turnId = asString(payload.turnId);
    const runId = asString(payload.runId) ?? turnId ?? asString(payload.sessionId);
    const timestamp = asNumber(payload.timestamp) ?? asNumber(payload.createdAtMs);
    const laneKey = asString(payload.laneKey) ?? asString(payload.agentId) ?? 'main';
    const seq = asNumber(payload.seq);
    const messageId = asString(payload.messageId) ?? asString(payload.id);
    const toolCallId = asString(payload.toolCallId) ?? asString(payload.toolUseId);
    const ownerTurnKey = turnId ? `turn:${laneKey}:${turnId}` : runId ? `run:${laneKey}:${runId}` : undefined;
    const ownerMessageKey = messageId ? `message:${laneKey}:${messageId}` : ownerTurnKey;

    if (method.includes('tool') && toolCallId) {
      if (method.includes('result') || method.includes('completed')) {
        return [{
          ...base({
            eventId: `acp:${eventScope(context)}:tool-result:${context.sessionKey}:${runId ?? 'run'}:${toolCallId}`,
            runtimeEventType: method,
            context,
            ...(runId ? { runId } : {}),
            ...(turnId ? { turnId } : {}),
            ...(timestamp != null ? { timestamp } : {}),
            laneKey,
            ...(seq != null ? { seq } : {}),
            raw: input,
          }),
          type: 'tool_result',
          ...(ownerTurnKey ? {
            ownerTurnKey,
            turnBindingSource: turnId ? 'runtime' : 'synthetic',
            turnBindingConfidence: turnId ? 'high' : 'low',
          } : {}),
          ...(ownerMessageKey ? {
            ownerMessageKey,
            messageBindingSource: messageId ? 'runtime' : 'synthetic',
            messageBindingConfidence: messageId ? 'high' : 'low',
          } : {}),
          toolCallId,
          name: asString(payload.name) ?? asString(payload.toolName),
          output: payload.output ?? payload.result,
          outputText: asString(payload.outputText) ?? asString(payload.text),
          isError: payload.isError === true,
        }];
      }
      return [{
        ...base({
          eventId: `acp:${eventScope(context)}:tool-call:${context.sessionKey}:${runId ?? 'run'}:${toolCallId}`,
          runtimeEventType: method,
          context,
          ...(runId ? { runId } : {}),
          ...(turnId ? { turnId } : {}),
          ...(timestamp != null ? { timestamp } : {}),
          laneKey,
          ...(seq != null ? { seq } : {}),
          raw: input,
        }),
        type: 'tool_call',
        ...(ownerTurnKey ? {
          ownerTurnKey,
          turnBindingSource: turnId ? 'runtime' : 'synthetic',
          turnBindingConfidence: turnId ? 'high' : 'low',
        } : {}),
        ...(ownerMessageKey ? {
          ownerMessageKey,
          messageBindingSource: messageId ? 'runtime' : 'synthetic',
          messageBindingConfidence: messageId ? 'high' : 'low',
        } : {}),
        toolCallId,
        name: asString(payload.name) ?? asString(payload.toolName) ?? 'tool',
        input: payload.input ?? payload.arguments,
      }];
    }

    const text = readText(payload);
    if (!text && !messageId) {
      return [];
    }
    const role = asString(payload.role) === 'user' || asString(payload.role) === 'system' ? asString(payload.role)! : 'assistant';
    return [{
      ...base({
        eventId: `acp:${eventScope(context)}:message:${context.sessionKey}:${runId ?? 'run'}:${messageId ?? seq ?? 'message'}`,
        runtimeEventType: method,
        context,
        ...(runId ? { runId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(timestamp != null ? { timestamp } : {}),
        laneKey,
        ...(seq != null ? { seq } : {}),
        raw: input,
      }),
      type: 'message_snapshot',
      role,
      ...(ownerTurnKey ? {
        ownerTurnKey,
        turnBindingSource: turnId ? 'runtime' : 'synthetic',
        turnBindingConfidence: turnId ? 'high' : 'low',
      } : {}),
      ...(ownerMessageKey ? {
        ownerMessageKey,
        messageBindingSource: messageId ? 'runtime' : 'synthetic',
        messageBindingConfidence: messageId ? 'high' : 'low',
      } : {}),
      ...(messageId ? { messageId } : {}),
      content: payload.content ?? text,
      text,
      status: payload.status === 'final' || payload.done === true ? 'final' : payload.status === 'error' ? 'error' : 'streaming',
    }];
  }
}
