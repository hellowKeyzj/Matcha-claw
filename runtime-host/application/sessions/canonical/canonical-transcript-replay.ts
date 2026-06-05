import {
  isInternalAssistantControlMessage,
  isInternalRuntimeDisplayMessage,
  sanitizeCanonicalUserContent,
} from '../../../shared/chat-message-normalization';
import type { SessionRenderAttachedFile } from '../../../shared/session-adapter-types';
import { extractImagesAsAttachedFiles } from '../assistant-segment-media';
import { extractToolResultMediaAttachments } from '../tool-result-media';
import type { CanonicalSessionEvent, RuntimeEndpointId, RuntimeProtocolId } from './canonical-events';
import type { SessionTranscriptMessage } from '../transcript-types';
import { extractTaskSnapshotFromTranscriptMessage } from '../transcript-task-snapshot-replay';
import { readMessageContent, resolveTranscriptDisplayText } from '../transcript-content-extractors';
import { isRecord, normalizeString } from '../session-value-normalization';
import {
  isStateOnlyToolContentBlock,
  isStateOnlyToolName,
  isToolCallContentType,
  resolveToolRecordCallId,
  resolveToolRecordCallPayload,
  resolveToolRecordName,
  resolveToolRecordResultPayload,
} from '../state-only-tools';
import { extractToolResultOutputText } from '../tool/tool-card-content';

export interface CanonicalReplayRuntimeIdentity {
  protocolId: RuntimeProtocolId;
  runtimeEndpointId: RuntimeEndpointId;
}

function eventId(parts: ReadonlyArray<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && String(part).trim()).join(':');
}

function replayBase(input: {
  eventId: string;
  identity: CanonicalReplayRuntimeIdentity;
  runtimeEventType: string;
  sessionId: string;
  runId?: string;
  timestamp?: number;
  laneKey?: string;
  agentId?: string;
  toolCallId?: string;
  seq?: number;
}): Pick<CanonicalSessionEvent, 'eventId' | 'protocolId' | 'runtimeEndpointId' | 'source' | 'sessionId' | 'runId' | 'timestamp' | 'laneKey' | 'agentId' | 'seq' | 'origin'> {
  return {
    eventId: input.eventId,
    protocolId: input.identity.protocolId,
    runtimeEndpointId: input.identity.runtimeEndpointId,
    source: 'replay',
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.timestamp != null ? { timestamp: input.timestamp } : {}),
    ...(input.laneKey ? { laneKey: input.laneKey } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.seq != null ? { seq: input.seq } : {}),
    origin: {
      runtimeEventType: input.runtimeEventType,
      runtimeIds: {
        sessionKey: input.sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.laneKey ? { laneKey: input.laneKey } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.toolCallId ? { toolUseId: input.toolCallId } : {}),
        ...(input.seq != null ? { seq: String(input.seq) } : {}),
      },
    },
  };
}

function stripStateOnlyToolContent(content: unknown): unknown {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.filter((block) => !isStateOnlyToolContentBlock(block));
}

function messageContent(message: SessionTranscriptMessage): unknown {
  const content = readMessageContent(message);
  if (message.role === 'user') {
    return sanitizeCanonicalUserContent(content);
  }
  return stripStateOnlyToolContent(content);
}

function messageLaneKey(message: SessionTranscriptMessage): string {
  const agentId = normalizeString(message.agentId);
  return agentId ? `member:${agentId}` : 'main';
}

function messageRunId(message: SessionTranscriptMessage): string {
  return normalizeString(message.metadata?.runId);
}

function messageId(message: SessionTranscriptMessage, sessionId: string, index: number): string {
  return normalizeString(message.messageId) || normalizeString(message.id) || `transcript:${sessionId}:${message.role}:${index}`;
}

function messageStatus(message: SessionTranscriptMessage): 'streaming' | 'final' | 'error' {
  if (message.status === 'error' || message.isError) {
    return 'error';
  }
  return message.streaming ? 'streaming' : 'final';
}

function readTaskCompletionEvents(
  sessionId: string,
  message: SessionTranscriptMessage,
  index: number,
  identity: CanonicalReplayRuntimeIdentity,
): CanonicalSessionEvent[] {
  if (!message.taskCompletionEvents?.length) {
    return [];
  }
  const runId = messageRunId(message);
  const laneKey = messageLaneKey(message);
  const agentId = normalizeString(message.agentId);
  return message.taskCompletionEvents.map((event, eventIndex): CanonicalSessionEvent => ({
    ...replayBase({
      eventId: eventId(['replay', sessionId, 'team', index, eventIndex, event.childSessionKey]),
      identity,
      runtimeEventType: 'transcript.task_completion',
      sessionId,
      ...(runId ? { runId } : {}),
      ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
      laneKey,
      ...(agentId ? { agentId } : {}),
      seq: index,
    }),
    type: 'team',
    event: structuredClone(event),
  }));
}

function attachmentKey(file: SessionRenderAttachedFile): string {
  return [file.filePath ?? '', file.gatewayUrl ?? '', file.fileName, file.mimeType].join('\n');
}

function cloneAttachedFiles(message: SessionTranscriptMessage): SessionRenderAttachedFile[] {
  const files = Array.isArray(message._attachedFiles)
    ? message._attachedFiles.flatMap((file) => (isRecord(file) ? [structuredClone(file) as SessionRenderAttachedFile] : []))
    : [];
  const mediaFiles = extractToolResultMediaAttachments({
    outputText: typeof message.content === 'string' ? message.content : typeof message.text === 'string' ? message.text : undefined,
  });
  if (mediaFiles.length === 0) {
    return files;
  }
  const seen = new Set(files.map(attachmentKey));
  for (const file of mediaFiles) {
    const key = attachmentKey(file);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    files.push(file);
  }
  return files;
}

function hasContentMedia(message: SessionTranscriptMessage): boolean {
  return extractImagesAsAttachedFiles(readMessageContent(message)).length > 0;
}

function hasThinkingContent(message: SessionTranscriptMessage): boolean {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    const row = isRecord(block) ? block : null;
    if (!row) {
      return false;
    }
    const type = normalizeString(row.type);
    const text = normalizeString(row.thinking) || normalizeString(row.text);
    return (type === 'thinking' || type === 'thought') && text.length > 0;
  });
}

function hasRenderableTaskCompletion(message: SessionTranscriptMessage): boolean {
  return Array.isArray(message.taskCompletionEvents) && message.taskCompletionEvents.length > 0;
}

function readToolEventsFromMessage(
  sessionId: string,
  message: SessionTranscriptMessage,
  index: number,
  identity: CanonicalReplayRuntimeIdentity,
): CanonicalSessionEvent[] {
  const content = readMessageContent(message);
  if (message.role !== 'assistant' || !Array.isArray(content)) {
    return [];
  }
  const runId = messageRunId(message);
  const laneKey = messageLaneKey(message);
  const agentId = normalizeString(message.agentId);
  return content.flatMap((block, blockIndex): CanonicalSessionEvent[] => {
    if (!isRecord(block)) {
      return [];
    }
    const toolCallId = resolveToolRecordCallId(block);
    const name = resolveToolRecordName(block);
    if (!toolCallId || !name || isStateOnlyToolName(name)) {
      return [];
    }
    if (isToolCallContentType(block.type)) {
      return [{
        ...replayBase({
          eventId: eventId(['replay', sessionId, 'tool-call', index, blockIndex, toolCallId]),
          identity,
          runtimeEventType: 'transcript.tool_call',
          sessionId,
          ...(runId ? { runId } : {}),
          ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
          laneKey,
          ...(agentId ? { agentId } : {}),
          toolCallId,
          seq: index,
        }),
        type: 'tool_call',
        toolCallId,
        name,
        input: resolveToolRecordCallPayload(block),
      }];
    }
    const type = normalizeString(block.type);
    if (type !== 'tool_result' && type !== 'toolResult' && type !== 'function_call_output' && type !== 'functionCallOutput') {
      return [];
    }
    const output = resolveToolRecordResultPayload(block);
    const outputText = extractToolResultOutputText(output);
    return [buildToolResultEvent({
      sessionId,
      message,
      index,
      toolCallId,
      name,
      output,
      ...(outputText ? { outputText } : {}),
      isError: block.isError === true || block.is_error === true,
      identity,
    })];
  });
}

function buildToolResultEvent(input: {
  sessionId: string;
  message: SessionTranscriptMessage;
  index: number;
  toolCallId: string;
  name?: string;
  output: unknown;
  outputText?: string;
  isError: boolean;
  identity: CanonicalReplayRuntimeIdentity;
}): CanonicalSessionEvent {
  const agentId = normalizeString(input.message.agentId);
  const runId = messageRunId(input.message);
  return {
    ...replayBase({
      eventId: eventId(['replay', input.sessionId, 'tool-result', input.index, input.toolCallId]),
      identity: input.identity,
      runtimeEventType: 'transcript.message_tool_result',
      sessionId: input.sessionId,
      ...(runId ? { runId } : {}),
      ...(input.message.timestamp != null ? { timestamp: input.message.timestamp } : {}),
      laneKey: agentId ? `member:${agentId}` : 'main',
      ...(agentId ? { agentId } : {}),
      toolCallId: input.toolCallId,
      seq: input.index,
    }),
    type: 'tool_result',
    toolCallId: input.toolCallId,
    ...(input.name ? { name: input.name } : {}),
    output: input.output,
    ...(input.outputText ? { outputText: input.outputText } : {}),
    isError: input.isError,
  };
}

function buildStandaloneToolResultEvent(
  sessionId: string,
  message: SessionTranscriptMessage,
  index: number,
  identity: CanonicalReplayRuntimeIdentity,
): CanonicalSessionEvent | null {
  const toolCallId = normalizeString(message.toolCallId);
  if (!toolCallId) {
    return null;
  }
  const output = readMessageContent(message);
  const outputText = extractToolResultOutputText(output);
  return buildToolResultEvent({
    sessionId,
    message,
    index,
    toolCallId,
    name: normalizeString(message.name) || normalizeString(message.toolName),
    output,
    ...(outputText ? { outputText } : {}),
    isError: message.isError === true,
    identity,
  });
}

function hasToolEventContent(message: SessionTranscriptMessage): boolean {
  const content = readMessageContent(message);
  if (message.role !== 'assistant' || !Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!isRecord(block)) {
      return false;
    }
    const toolCallId = resolveToolRecordCallId(block);
    const name = resolveToolRecordName(block);
    if (!toolCallId || !name || isStateOnlyToolName(name)) {
      return false;
    }
    const type = normalizeString(block.type);
    return isToolCallContentType(block.type)
      || type === 'tool_result'
      || type === 'toolResult'
      || type === 'function_call_output'
      || type === 'functionCallOutput';
  });
}

function canReplayMessageSnapshot(message: SessionTranscriptMessage): boolean {
  const role = message.role;
  if (role !== 'user' && role !== 'assistant' && role !== 'system') {
    return false;
  }
  if (isInternalRuntimeDisplayMessage(message) || isInternalAssistantControlMessage(message)) {
    return false;
  }
  const text = resolveTranscriptDisplayText(message);
  return role === 'system'
    || text.length > 0
    || cloneAttachedFiles(message).length > 0
    || hasContentMedia(message)
    || hasThinkingContent(message)
    || hasToolEventContent(message)
    || hasRenderableTaskCompletion(message);
}

export function canProjectTranscriptMessage(sessionId: string, message: SessionTranscriptMessage): boolean {
  if (message.role !== 'toolresult' && message.role !== 'tool_result') {
    return canReplayMessageSnapshot(message)
      || extractTaskSnapshotFromTranscriptMessage(sessionId, message) !== null;
  }
  const toolCallId = normalizeString(message.toolCallId);
  return toolCallId.length > 0
    || extractTaskSnapshotFromTranscriptMessage(sessionId, message) !== null
    || hasRenderableTaskCompletion(message);
}

function buildReplayBoundaryEvent(
  sessionId: string,
  phase: 'start' | 'end',
  identity: CanonicalReplayRuntimeIdentity,
): CanonicalSessionEvent {
  return {
    ...replayBase({
      eventId: eventId(['replay', sessionId, phase]),
      identity,
      runtimeEventType: 'transcript.replay_boundary',
      sessionId,
    }),
    type: 'replay_boundary',
    phase,
  };
}

function* iterateCanonicalReplayEventsFromTranscriptMessage(
  sessionId: string,
  message: SessionTranscriptMessage,
  index: number,
  identity: CanonicalReplayRuntimeIdentity,
): Generator<CanonicalSessionEvent> {
  if (!canProjectTranscriptMessage(sessionId, message)) {
    return;
  }
  if (message.role === 'toolresult' || message.role === 'tool_result') {
    const toolResult = buildStandaloneToolResultEvent(sessionId, message, index, identity);
    if (toolResult) {
      yield toolResult;
    }
    const taskSnapshot = extractTaskSnapshotFromTranscriptMessage(sessionId, message);
    if (taskSnapshot) {
      yield {
        ...replayBase({
          eventId: eventId(['replay', sessionId, 'plan', index]),
          identity,
          runtimeEventType: 'transcript.plan',
          sessionId,
          ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
          seq: index,
        }),
        type: 'plan',
        taskSnapshot,
      };
    }
    for (const event of readTaskCompletionEvents(sessionId, message, index, identity)) {
      yield event;
    }
    return;
  }

  const role = message.role;
  const text = resolveTranscriptDisplayText(message);
  const toolEvents = readToolEventsFromMessage(sessionId, message, index, identity);
  const runId = messageRunId(message);
  const agentId = normalizeString(message.agentId);
  const canonicalMessageId = messageId(message, sessionId, index);
  if (canReplayMessageSnapshot(message)) {
    yield {
      ...replayBase({
        eventId: eventId(['replay', sessionId, 'message', index, canonicalMessageId]),
        identity,
        runtimeEventType: 'transcript.message',
        sessionId,
        ...(runId ? { runId } : {}),
        ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
        laneKey: messageLaneKey(message),
        ...(agentId ? { agentId } : {}),
        seq: index,
      }),
      type: 'message_snapshot',
      role,
      messageId: canonicalMessageId,
      ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
      ...(message.clientId ? { clientId: message.clientId } : {}),
      content: structuredClone(messageContent(message)),
      text,
      status: messageStatus(message),
      attachedFiles: cloneAttachedFiles(message),
    };
    for (const event of toolEvents) {
      yield event;
    }
  }
  const taskSnapshot = extractTaskSnapshotFromTranscriptMessage(sessionId, message);
  if (taskSnapshot) {
    yield {
      ...replayBase({
        eventId: eventId(['replay', sessionId, 'plan', index]),
        identity,
        runtimeEventType: 'transcript.plan',
        sessionId,
        ...(runId ? { runId } : {}),
        ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
        seq: index,
      }),
      type: 'plan',
      taskSnapshot,
    };
  }
  for (const event of readTaskCompletionEvents(sessionId, message, index, identity)) {
    yield event;
  }
}

export function* iterateCanonicalReplayEventsFromTranscriptMessages(
  sessionId: string,
  messages: Iterable<SessionTranscriptMessage>,
  identity: CanonicalReplayRuntimeIdentity,
): Generator<CanonicalSessionEvent> {
  yield buildReplayBoundaryEvent(sessionId, 'start', identity);
  let index = 0;
  for (const message of messages) {
    try {
      yield* iterateCanonicalReplayEventsFromTranscriptMessage(sessionId, message, index, identity);
    } finally {
      index += 1;
    }
  }
  yield buildReplayBoundaryEvent(sessionId, 'end', identity);
}

export async function* iterateCanonicalReplayEventsFromTranscriptMessagesAsync(
  sessionId: string,
  messages: AsyncIterable<SessionTranscriptMessage>,
  identity: CanonicalReplayRuntimeIdentity,
): AsyncGenerator<CanonicalSessionEvent> {
  yield buildReplayBoundaryEvent(sessionId, 'start', identity);
  let index = 0;
  for await (const message of messages) {
    try {
      yield* iterateCanonicalReplayEventsFromTranscriptMessage(sessionId, message, index, identity);
    } finally {
      index += 1;
    }
  }
  yield buildReplayBoundaryEvent(sessionId, 'end', identity);
}

export function buildCanonicalReplayEventsFromTranscriptMessages(
  sessionId: string,
  messages: Iterable<SessionTranscriptMessage>,
  identity: CanonicalReplayRuntimeIdentity,
): CanonicalSessionEvent[] {
  return Array.from(iterateCanonicalReplayEventsFromTranscriptMessages(sessionId, messages, identity));
}
