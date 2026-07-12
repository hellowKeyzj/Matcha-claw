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

function readMessageRole(payload: AcpRecord): 'user' | 'assistant' | 'system' {
  const role = asString(payload.role) ?? asString(asRecord(payload.message)?.role);
  return role === 'user' || role === 'system' ? role : 'assistant';
}

type AcpToolMethodKind = 'call' | 'result';

const ACP_TOOL_CALL_METHODS = new Set([
  'session/toolCall',
  'session/tool_call',
  'session/toolUse',
  'session/tool_use',
  'tool/call',
  'tool/use',
  'tool/start',
  'toolCall',
  'toolUse',
  'tool_call',
  'tool_use',
  'tool.started',
  'tool_call.start',
  'toolCallStart',
  'tool_started',
]);

const ACP_TOOL_RESULT_METHODS = new Set([
  'session/toolResult',
  'session/tool_result',
  'tool/result',
  'tool/completed',
  'tool/error',
  'toolResult',
  'tool_result',
  'tool.completed',
  'tool.failed',
  'tool_call.completed',
  'toolCallCompleted',
  'toolCompleted',
  'toolFailed',
  'tool_error',
]);

function classifyAcpToolMethod(method: string): AcpToolMethodKind | null {
  if (ACP_TOOL_RESULT_METHODS.has(method)) {
    return 'result';
  }
  if (ACP_TOOL_CALL_METHODS.has(method)) {
    return 'call';
  }
  return null;
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function stableFingerprint(value: unknown): string {
  const text = stableStringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function fallbackMessagePartKey(input: {
  method: string;
  payload: AcpRecord;
  runId?: string;
  laneKey: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
}): string {
  return `fingerprint:${stableFingerprint({
    method: input.method,
    runId: input.runId,
    laneKey: input.laneKey,
    role: input.role,
    text: input.text,
    content: input.payload.content ?? asRecord(input.payload.message)?.content,
    status: input.payload.status,
    done: input.payload.done,
    timestamp: input.payload.timestamp ?? input.payload.createdAtMs,
  })}`;
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
    source: asRecord(input.raw)?.source === 'replay' ? 'replay' : 'live',
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

    const toolMethodKind = classifyAcpToolMethod(method);
    if (toolMethodKind && toolCallId) {
      if (toolMethodKind === 'result') {
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
          type: 'tool',
          phase: payload.isError === true ? 'failed' : 'completed',
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
        type: 'tool',
        phase: 'started',
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
    const role = readMessageRole(payload);
    const messagePartKey = messageId ?? (seq != null ? String(seq) : fallbackMessagePartKey({
      method,
      payload,
      ...(runId ? { runId } : {}),
      laneKey,
      role,
      text,
    }));
    const status = payload.status === 'final' || payload.done === true
      ? 'final'
      : payload.status === 'error'
        ? 'error'
        : 'streaming';
    const messageEvent: CanonicalSessionEvent = {
      ...base({
        eventId: `acp:${eventScope(context)}:message:${context.sessionKey}:${runId ?? 'run'}:${messagePartKey}`,
        runtimeEventType: method,
        context,
        ...(runId ? { runId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(timestamp != null ? { timestamp } : {}),
        laneKey,
        ...(seq != null ? { seq } : {}),
        raw: input,
      }),
      type: 'message_part',
      partId: messageId ?? `${runId ?? 'run'}:${messagePartKey}`,
      role,
      kind: 'text',
      mode: status === 'final' ? 'final' : 'snapshot',
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
      status,
    };
    if (status !== 'final' || role !== 'assistant' || !runId) {
      return [messageEvent];
    }
    return [messageEvent, {
      ...base({
        eventId: `acp:${eventScope(context)}:lifecycle:${context.sessionKey}:${runId}:completed`,
        runtimeEventType: `${method}.completed`,
        context,
        runId,
        ...(turnId ? { turnId } : {}),
        ...(timestamp != null ? { timestamp } : {}),
        laneKey,
        ...(seq != null ? { seq } : {}),
        raw: input,
      }),
      type: 'lifecycle',
      phase: 'final',
      runPhase: 'done',
      error: null,
    }];
  }
}
