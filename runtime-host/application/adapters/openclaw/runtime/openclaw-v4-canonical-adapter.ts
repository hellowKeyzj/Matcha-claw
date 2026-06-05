import type { CanonicalLifecyclePhase, CanonicalMessageStatus, CanonicalSessionEvent } from '../../../sessions/canonical/canonical-events';
import type { GatewayTransportIssue } from '../../../../shared/gateway-error';
import type { RuntimeSessionContext } from '../../../agent-runtime/contracts/runtime-endpoint-types';
import { OPENCLAW_RUNTIME_PROTOCOL_ID, OPENCLAW_RUNTIME_ENDPOINT_ID } from './openclaw-runtime-identity';
import { extractToolResultOutputText } from '../../../sessions/tool/tool-card-content';
import {
  normalizeTaskArtifactSnapshot,
  normalizeTaskToolSnapshot,
} from '../../../sessions/task-snapshot-normalizer';
import {
  canonicalizeToolName,
  isStateOnlyToolCallSnapshotName,
  isStateOnlyToolContentBlock,
  isStateOnlyToolName,
  isToolCallContentType,
  resolveToolRecordCallId,
  resolveToolRecordCallPayload,
  resolveToolRecordName,
} from '../../../sessions/state-only-tools';

export type OpenClawV4ConversationEvent =
  | { type: 'chat.message'; event: Record<string, unknown> }
  | { type: 'thinking.delta'; event: Record<string, unknown> }
  | { type: 'tool.lifecycle'; event: Record<string, unknown> }
  | { type: 'session.message'; event: Record<string, unknown> }
  | { type: 'session.tool'; event: Record<string, unknown> }
  | { type: 'usage'; event: Record<string, unknown> }
  | { type: 'artifact'; event: Record<string, unknown> }
  | { type: 'run.activity'; activity: 'compacting'; phase: 'started' | 'completed'; runId?: string; sessionKey?: string }
  | { type: 'run.phase'; phase: 'started' | 'completed' | 'error' | 'aborted'; runId?: string; sessionKey?: string; error?: string; errorMessage?: string; errorCode?: string; errorDetails?: unknown };

interface ChatSnapshotBuffer {
  messageId: string;
  text: string;
  content: unknown;
  updatedAt: number;
}

interface CanonicalLane {
  laneKey: string;
  agentId?: string;
}

const MAX_CHAT_SNAPSHOT_BUFFERS = 128;
const CHAT_SNAPSHOT_BUFFER_TTL_MS = 10 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readMessageText(content: unknown): string {
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

function stripStateOnlyToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.filter((block) => !isStateOnlyToolContentBlock(block));
}

function normalizeVisibleMessageContent(content: unknown, visibleText: string): unknown {
  if (typeof content === 'string') {
    return visibleText;
  }
  const visibleContent = stripStateOnlyToolContent(content);
  if (!Array.isArray(visibleContent) || readMessageText(visibleContent) === visibleText) {
    return visibleContent;
  }
  const next = structuredClone(visibleContent);
  const textBlock = next.find((block) => {
    const row = asRecord(block);
    return row && (row.type === 'text' || row.type === 'message') && typeof row.text === 'string';
  });
  if (textBlock && typeof textBlock === 'object' && !Array.isArray(textBlock)) {
    (textBlock as Record<string, unknown>).text = visibleText;
    return next;
  }
  const contentBlock = next.find((block) => {
    const row = asRecord(block);
    return row && row.type === 'text' && typeof row.content === 'string';
  });
  if (contentBlock && typeof contentBlock === 'object' && !Array.isArray(contentBlock)) {
    (contentBlock as Record<string, unknown>).content = visibleText;
    return next;
  }
  return content;
}

function eventId(parts: ReadonlyArray<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && String(part).trim()).join(':');
}

function hashString(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function stableEventFingerprint(value: unknown): string {
  try {
    return hashString(JSON.stringify(value));
  } catch {
    return hashString(String(value));
  }
}

function liveCanonicalLane(context: Pick<RuntimeSessionContext, 'agentId'>): CanonicalLane {
  const selectedAgentId = readString(context.agentId);
  return selectedAgentId
    ? { laneKey: `member:${selectedAgentId}`, agentId: selectedAgentId }
    : { laneKey: 'main' };
}

function openClawBase(input: {
  eventId: string;
  runtimeEventType: string;
  sessionKey: string;
  runId?: string;
  seq?: number;
  timestamp?: number;
  laneKey?: string;
  agentId?: string;
  toolCallId?: string;
  source?: 'live' | 'replay';
  raw?: unknown;
}): Pick<CanonicalSessionEvent, 'eventId' | 'protocolId' | 'runtimeEndpointId' | 'source' | 'sessionId' | 'runId' | 'seq' | 'timestamp' | 'laneKey' | 'agentId' | 'origin'> {
  return {
    eventId: input.eventId,
    protocolId: OPENCLAW_RUNTIME_PROTOCOL_ID,
    runtimeEndpointId: OPENCLAW_RUNTIME_ENDPOINT_ID,
    source: input.source ?? 'live',
    sessionId: input.sessionKey,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.seq != null ? { seq: input.seq } : {}),
    ...(input.timestamp != null ? { timestamp: input.timestamp } : {}),
    ...(input.laneKey ? { laneKey: input.laneKey } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    origin: {
      runtimeEventType: input.runtimeEventType,
      runtimeIds: {
        sessionKey: input.sessionKey,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.seq != null ? { seq: String(input.seq) } : {}),
        ...(input.laneKey ? { laneKey: input.laneKey } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.toolCallId ? { toolUseId: input.toolCallId } : {}),
      },
      ...(input.raw !== undefined ? { raw: structuredClone(input.raw) } : {}),
    },
  };
}

function messageStatus(state: string): CanonicalMessageStatus | null {
  switch (state) {
    case 'delta':
      return 'streaming';
    case 'final':
      return 'final';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return null;
  }
}

function lifecyclePhase(phase: string): { phase: CanonicalLifecyclePhase; runPhase: 'done' | 'error' | 'aborted' | 'submitted' } | null {
  switch (phase) {
    case 'started':
      return { phase: 'started', runPhase: 'submitted' };
    case 'completed':
      return { phase: 'final', runPhase: 'done' };
    case 'error':
      return { phase: 'error', runPhase: 'error' };
    case 'aborted':
      return { phase: 'aborted', runPhase: 'aborted' };
    default:
      return null;
  }
}

export class OpenClawV4Adapter {
  private readonly chatSnapshots = new Map<string, ChatSnapshotBuffer>();

  translate(input: OpenClawV4ConversationEvent, context: Pick<RuntimeSessionContext, 'agentId'>): CanonicalSessionEvent[] {
    switch (input.type) {
      case 'chat.message':
        return this.translateChat(input.event, context);
      case 'thinking.delta':
        return this.translateThinking(input.event, context);
      case 'tool.lifecycle':
        return this.translateSourceToolLifecycle(input.event, 'tool.lifecycle', 'live', liveCanonicalLane(context));
      case 'session.message':
        return this.translateSessionMessage(input.event);
      case 'session.tool':
        return this.translateSourceToolLifecycle(input.event, 'session.tool', 'replay', { laneKey: 'main' });
      case 'usage':
        return this.deriveUsageFacts(input.event, liveCanonicalLane(context));
      case 'artifact':
        return this.deriveArtifactFacts(input.event, liveCanonicalLane(context));
      case 'run.activity':
        return this.translateRuntimeActivity(input, liveCanonicalLane(context));
      case 'run.phase':
        return this.translateRunPhase(input, liveCanonicalLane(context));
      default:
        return [];
    }
  }

  private bufferKey(sessionKey: string, runId: string): string {
    return `${sessionKey}\n${runId}`;
  }

  private pruneChatSnapshots(now: number): void {
    for (const [key, snapshot] of this.chatSnapshots) {
      if (now - snapshot.updatedAt > CHAT_SNAPSHOT_BUFFER_TTL_MS) {
        this.chatSnapshots.delete(key);
      }
    }
    while (this.chatSnapshots.size > MAX_CHAT_SNAPSHOT_BUFFERS) {
      const oldestKey = this.chatSnapshots.keys().next().value as string | undefined;
      if (!oldestKey) {
        return;
      }
      this.chatSnapshots.delete(oldestKey);
    }
  }

  private rememberChatSnapshot(key: string, snapshot: ChatSnapshotBuffer): void {
    this.chatSnapshots.delete(key);
    this.chatSnapshots.set(key, snapshot);
    this.pruneChatSnapshots(snapshot.updatedAt);
  }

  private derivePlanEventsFromMessageContent(input: {
    content: unknown;
    sessionKey: string;
    runId: string;
    seq: number;
    timestamp?: number;
    lane: CanonicalLane;
  }): CanonicalSessionEvent[] {
    if (!Array.isArray(input.content)) {
      return [];
    }
    return input.content.flatMap((block, index) => {
      const row = asRecord(block);
      if (!row || !isToolCallContentType(row.type)) {
        return [];
      }
      const name = resolveToolRecordName(row);
      if (!isStateOnlyToolName(name)) {
        return [];
      }
      const taskSnapshot = isStateOnlyToolCallSnapshotName(name)
        ? normalizeTaskToolSnapshot(name, resolveToolRecordCallPayload(row), input.sessionKey)
        : null;
      if (!taskSnapshot) {
        return [];
      }
      const toolCallId = resolveToolRecordCallId(row) || String(index);
      return [this.buildDerivedPlanEvent({
        idParts: ['openclaw-v4', 'plan', input.sessionKey, input.runId, input.seq, toolCallId],
        sessionKey: input.sessionKey,
        runId: input.runId,
        seq: input.seq,
        timestamp: input.timestamp,
        lane: input.lane,
        taskSnapshot,
      })];
    });
  }

  private translateThinking(payload: Record<string, unknown>, context: Pick<RuntimeSessionContext, 'agentId'>): CanonicalSessionEvent[] {
    const sessionKey = readString(payload.sessionKey);
    const runId = readString(payload.runId);
    const seq = readNumber(payload.seq);
    const timestamp = readNumber(payload.timestamp);
    const text = readString(payload.text);
    if (!sessionKey || !runId || seq == null || timestamp == null || !text) {
      return [];
    }
    const lane = liveCanonicalLane(context);
    return [{
      ...openClawBase({
        eventId: eventId(['openclaw-v4', 'thinking', sessionKey, runId, seq]),
        runtimeEventType: 'thinking.delta',
        sessionKey,
        runId,
        seq,
        timestamp,
        laneKey: lane.laneKey,
        ...(lane.agentId ? { agentId: lane.agentId } : {}),
        raw: payload,
      }),
      type: 'thought_snapshot',
      text,
      status: 'streaming',
    }];
  }

  private translateChat(payload: Record<string, unknown>, context: Pick<RuntimeSessionContext, 'agentId'>): CanonicalSessionEvent[] {
    const state = readString(payload.state);
    const status = messageStatus(state);
    if (!status) {
      return [];
    }
    const sessionKey = readString(payload.sessionKey);
    const runId = readString(payload.runId);
    const seq = readNumber(payload.seq);
    const message = asRecord(payload.message);
    const timestamp = readNumber(message?.timestamp) ?? Date.now();
    this.pruneChatSnapshots(timestamp);
    if (!sessionKey || !runId || seq == null || !message) {
      return [];
    }
    if (message.role !== 'assistant') {
      return [];
    }
    const key = this.bufferKey(sessionKey, runId);
    const previous = this.chatSnapshots.get(key);
    const content = Object.prototype.hasOwnProperty.call(message, 'content') ? message.content : previous?.content ?? [];
    const snapshotText = readMessageText(content);
    const deltaText = typeof payload.deltaText === 'string' ? payload.deltaText : '';
    const bufferedText = payload.replace === true
      ? deltaText
      : `${previous?.text ?? ''}${deltaText}`;
    const useBufferedSnapshot = bufferedText.length > snapshotText.length;
    const visibleText = useBufferedSnapshot ? bufferedText : snapshotText;
    const visibleContent = normalizeVisibleMessageContent(useBufferedSnapshot ? previous?.content ?? content : content, visibleText);
    const providerMessageId = readString(message.messageId ?? message.id ?? payload.messageId ?? payload.id);
    const messageId = previous?.messageId || providerMessageId || `openclaw-v4:chat:${sessionKey}:${runId}:${seq}`;
    const lane = liveCanonicalLane(context);
    if (status === 'streaming') {
      this.rememberChatSnapshot(key, { messageId, text: visibleText, content: visibleContent, updatedAt: timestamp });
    } else {
      this.chatSnapshots.delete(key);
    }
    const planEvents = this.derivePlanEventsFromMessageContent({
      content,
      sessionKey: sessionKey,
      runId,
      seq,
      timestamp,
      lane,
    });
    if (planEvents.length > 0 && !visibleText.trim()) {
      return planEvents;
    }
    return [
      {
        ...openClawBase({
          eventId: eventId(['openclaw-v4', 'chat', sessionKey, runId, seq, state, stableEventFingerprint(visibleContent)]),
          runtimeEventType: 'chat.message',
          sessionKey,
          runId,
          seq,
          timestamp,
          laneKey: lane.laneKey,
          ...(lane.agentId ? { agentId: lane.agentId } : {}),
          raw: payload,
        }),
        type: 'message_snapshot',
        role: 'assistant',
        messageId,
        ...(readString(message.originMessageId) ? { originMessageId: readString(message.originMessageId) } : {}),
        ...(readString(message.clientId) ? { clientId: readString(message.clientId) } : {}),
        content: structuredClone(visibleContent),
        text: visibleText,
        status,
      },
      ...planEvents,
    ];
  }

  private buildDerivedPlanEvent(input: {
    idParts: ReadonlyArray<string | number | undefined>;
    runtimeEventType?: string;
    sessionKey: string;
    runId: string;
    seq: number;
    timestamp?: number;
    source?: 'live' | 'replay';
    lane: CanonicalLane;
    taskSnapshot: NonNullable<ReturnType<typeof normalizeTaskToolSnapshot>>;
  }): CanonicalSessionEvent {
    return {
      ...openClawBase({
        eventId: eventId(input.idParts),
        runtimeEventType: input.runtimeEventType ?? 'plan.snapshot',
        sessionKey: input.sessionKey,
        runId: input.runId,
        seq: input.seq,
        timestamp: input.timestamp,
        laneKey: input.lane.laneKey,
        ...(input.lane.agentId ? { agentId: input.lane.agentId } : {}),
        source: input.source,
      }),
      type: 'plan',
      taskSnapshot: input.taskSnapshot,
    };
  }

  private translateSessionMessage(payload: Record<string, unknown>): CanonicalSessionEvent[] {
    const sessionKey = readString(payload.sessionKey);
    if (!sessionKey) {
      return [];
    }
    const message = asRecord(payload.message) ?? payload;
    const role = readString(message.role);
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      return [];
    }
    const content = Object.prototype.hasOwnProperty.call(message, 'content') ? message.content : '';
    const text = readMessageText(content) || readString(message.text);
    const metadata = asRecord(message.metadata);
    const runId = readString(message.runId ?? metadata?.runId ?? payload.runId);
    const agentId = readString(message.agentId ?? payload.agentId);
    const seq = readNumber(payload.seq ?? message.seq);
    const timestamp = readNumber(message.timestamp ?? payload.timestamp ?? payload.ts);
    const messageId = readString(message.messageId ?? message.id) || `openclaw-v4:session-message:${sessionKey}:${role}:${seq ?? 'unsequenced'}`;
    return [{
      ...openClawBase({
        eventId: eventId(['openclaw-v4', 'session-message', sessionKey, runId, seq, messageId]),
        runtimeEventType: 'session.message',
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(seq != null ? { seq } : {}),
        ...(timestamp != null ? { timestamp } : {}),
        laneKey: agentId ? `member:${agentId}` : 'main',
        ...(agentId ? { agentId } : {}),
        source: 'replay',
        raw: payload,
      }),
      type: 'message_snapshot',
      role,
      messageId,
      ...(readString(message.originMessageId) ? { originMessageId: readString(message.originMessageId) } : {}),
      ...(readString(message.clientId) ? { clientId: readString(message.clientId) } : {}),
      content: structuredClone(content),
      text,
      status: 'final',
    }];
  }

  private translateSourceToolLifecycle(payload: Record<string, unknown>, runtimeEventType: string, source: 'live' | 'replay', lane: CanonicalLane): CanonicalSessionEvent[] {
    const phase = readString(payload.phase);
    const sessionKey = readString(payload.sessionKey);
    const runId = readString(payload.runId);
    const seq = readNumber(payload.seq);
    const timestamp = readNumber(payload.timestamp);
    const toolCallId = readString(payload.toolCallId);
    if (!sessionKey || !runId || seq == null || !toolCallId) {
      return [];
    }
    const name = canonicalizeToolName(payload.name);
    const base = openClawBase({
      eventId: eventId(['openclaw-v4', 'tool', sessionKey, runId, seq, toolCallId, phase]),
      runtimeEventType,
      sessionKey,
      runId,
      seq,
      timestamp,
      laneKey: lane.laneKey,
      ...(lane.agentId ? { agentId: lane.agentId } : {}),
      toolCallId,
      source,
      raw: payload,
    });
    if (phase === 'start') {
      if (!name) {
        return [];
      }
      if (isStateOnlyToolName(name)) {
        const taskSnapshot = isStateOnlyToolCallSnapshotName(name)
          ? normalizeTaskToolSnapshot(name, payload.args, sessionKey)
          : null;
        return taskSnapshot
          ? [this.buildDerivedPlanEvent({
              idParts: ['openclaw-v4', 'plan', sessionKey, runId, seq, toolCallId],
              sessionKey,
              runId,
              seq,
              timestamp,
              runtimeEventType,
              source,
              lane,
              taskSnapshot,
            })]
          : [];
      }
      return [{
        ...base,
        eventId: eventId(['openclaw-v4', 'tool-call', sessionKey, runId, seq, toolCallId]),
        type: 'tool_call',
        toolCallId,
        name,
        ...(Object.prototype.hasOwnProperty.call(payload, 'args') ? { input: structuredClone(payload.args) } : {}),
      }];
    }
    if (phase === 'update') {
      const taskSnapshot = name && isStateOnlyToolName(name)
        ? normalizeTaskToolSnapshot(name, payload.partialResult, sessionKey)
        : null;
      if (taskSnapshot) {
        return [this.buildDerivedPlanEvent({
          idParts: ['openclaw-v4', 'plan', sessionKey, runId, seq, toolCallId],
          sessionKey,
          runId,
          seq,
          timestamp,
          runtimeEventType,
          source,
          lane,
          taskSnapshot,
        })];
      }
      return [{
        ...base,
        eventId: eventId(['openclaw-v4', 'tool-progress', sessionKey, runId, seq, toolCallId]),
        type: 'tool_progress',
        toolCallId,
        ...(Object.prototype.hasOwnProperty.call(payload, 'partialResult') ? { partialResult: structuredClone(payload.partialResult) } : {}),
        outputText: extractToolResultOutputText(payload.partialResult),
      }];
    }
    if (phase === 'result') {
      const taskSnapshot = name
        ? normalizeTaskToolSnapshot(name, payload.result, sessionKey)
        : null;
      const artifactSnapshot = normalizeTaskArtifactSnapshot(payload.result, sessionKey);
      const planEvent = taskSnapshot || artifactSnapshot
        ? this.buildDerivedPlanEvent({
            idParts: ['openclaw-v4', taskSnapshot ? 'plan' : 'artifact-plan', sessionKey, runId, seq, toolCallId],
            sessionKey,
            runId,
            seq,
            timestamp,
            runtimeEventType,
            source,
            lane,
            taskSnapshot: taskSnapshot ?? artifactSnapshot!,
          })
        : null;
      if (planEvent && name && isStateOnlyToolName(name)) {
        return [planEvent];
      }
      const toolResult: CanonicalSessionEvent = {
        ...base,
        eventId: eventId(['openclaw-v4', 'tool-result', sessionKey, runId, seq, toolCallId]),
        type: 'tool_result',
        toolCallId,
        ...(name ? { name } : {}),
        ...(Object.prototype.hasOwnProperty.call(payload, 'result') ? { output: structuredClone(payload.result) } : {}),
        outputText: extractToolResultOutputText(payload.result),
        isError: payload.isError === true,
      };
      return planEvent ? [toolResult, planEvent] : [toolResult];
    }
    return [];
  }

  private deriveUsageFacts(payload: Record<string, unknown>, lane: CanonicalLane): CanonicalSessionEvent[] {
    const sessionKey = readString(payload.sessionKey);
    if (!sessionKey) {
      return [];
    }
    const runId = readString(payload.runId);
    const seq = readNumber(payload.seq);
    const timestamp = readNumber(payload.timestamp ?? payload.ts);
    const source = payload.source === 'replay' ? 'replay' : 'live';
    const usagePayload = Object.prototype.hasOwnProperty.call(payload, 'usage') ? payload.usage : payload;
    return [{
      ...openClawBase({
        eventId: eventId(['openclaw-v4', 'usage', sessionKey, runId, seq, timestamp]),
        runtimeEventType: 'usage',
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(seq != null ? { seq } : {}),
        ...(timestamp != null ? { timestamp } : {}),
        laneKey: lane.laneKey,
        ...(lane.agentId ? { agentId: lane.agentId } : {}),
        source,
        raw: payload,
      }),
      type: 'usage',
      payload: structuredClone(usagePayload),
    }];
  }

  private deriveArtifactFacts(payload: Record<string, unknown>, lane: CanonicalLane): CanonicalSessionEvent[] {
    const sessionKey = readString(payload.sessionKey);
    if (!sessionKey) {
      return [];
    }
    const runId = readString(payload.runId);
    const seq = readNumber(payload.seq);
    const timestamp = readNumber(payload.timestamp ?? payload.ts);
    const source = payload.source === 'replay' ? 'replay' : 'live';
    const artifactPayload = Object.prototype.hasOwnProperty.call(payload, 'artifact') ? payload.artifact : payload;
    return [{
      ...openClawBase({
        eventId: eventId(['openclaw-v4', 'artifact', sessionKey, runId, seq, timestamp]),
        runtimeEventType: 'artifact',
        sessionKey,
        ...(runId ? { runId } : {}),
        ...(seq != null ? { seq } : {}),
        ...(timestamp != null ? { timestamp } : {}),
        laneKey: lane.laneKey,
        ...(lane.agentId ? { agentId: lane.agentId } : {}),
        source,
        raw: payload,
      }),
      type: 'artifact',
      payload: structuredClone(artifactPayload),
    }];
  }

  private translateRuntimeActivity(payload: Extract<OpenClawV4ConversationEvent, { type: 'run.activity' }>, lane: CanonicalLane): CanonicalSessionEvent[] {
    const sessionKey = readString(payload.sessionKey);
    if (!sessionKey) {
      return [];
    }
    return [{
      ...openClawBase({
        eventId: eventId(['openclaw-v4', 'runtime-activity', sessionKey, payload.runId, payload.activity, payload.phase]),
        runtimeEventType: 'run.activity',
        sessionKey,
        ...(readString(payload.runId) ? { runId: readString(payload.runId) } : {}),
        laneKey: lane.laneKey,
        ...(lane.agentId ? { agentId: lane.agentId } : {}),
        raw: payload,
      }),
      type: 'runtime_activity',
      activity: payload.activity,
      phase: payload.phase,
    }];
  }

  private translateRunPhase(payload: Extract<OpenClawV4ConversationEvent, { type: 'run.phase' }>, lane: CanonicalLane): CanonicalSessionEvent[] {
    const sessionKey = readString(payload.sessionKey);
    const runId = readString(payload.runId);
    const mapped = lifecyclePhase(payload.phase);
    if (!sessionKey || !mapped) {
      return [];
    }
    const error = readString(payload.errorMessage) || readString(payload.error) || null;
    const transportIssue: GatewayTransportIssue | null = payload.errorCode || payload.errorDetails
      ? {
          source: 'runtime',
          code: readString(payload.errorCode) || 'gateway_error',
          message: error ?? 'Gateway run failed',
          at: Date.now(),
          ...(payload.errorDetails !== undefined ? { details: payload.errorDetails } : {}),
        }
      : null;
    return [{
      ...openClawBase({
        eventId: eventId(['openclaw-v4', 'lifecycle', sessionKey, runId, mapped.phase]),
        runtimeEventType: 'run.phase',
        sessionKey,
        ...(runId ? { runId } : {}),
        laneKey: lane.laneKey,
        ...(lane.agentId ? { agentId: lane.agentId } : {}),
        raw: payload,
      }),
      type: 'lifecycle',
      phase: mapped.phase,
      runPhase: mapped.runPhase,
      error,
      ...(transportIssue ? { transportIssue } : {}),
    }];
  }
}
