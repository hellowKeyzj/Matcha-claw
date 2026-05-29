import {
  isInternalAssistantControlMessage,
  isInternalRuntimeDisplayMessage,
  sanitizeCanonicalUserContent,
} from '../../../shared/chat-message-normalization';
import type { SessionRenderAttachedFile } from '../../../shared/session-adapter-types';
import { extractImagesAsAttachedFiles } from '../assistant-segment-media';
import type { CanonicalSessionEvent } from './canonical-events';
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

function eventId(parts: ReadonlyArray<string | number | undefined>): string {
  return parts.filter((part) => part !== undefined && String(part).trim()).join(':');
}

function replayBase(input: {
  eventId: string;
  providerEventType: string;
  sessionId: string;
  runId?: string;
  timestamp?: number;
  laneKey?: string;
  agentId?: string;
  toolCallId?: string;
  seq?: number;
}): Pick<CanonicalSessionEvent, 'eventId' | 'provider' | 'source' | 'sessionId' | 'runId' | 'timestamp' | 'laneKey' | 'agentId' | 'seq' | 'origin'> {
  return {
    eventId: input.eventId,
    provider: 'openclaw-v4',
    source: 'replay',
    sessionId: input.sessionId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.timestamp != null ? { timestamp: input.timestamp } : {}),
    ...(input.laneKey ? { laneKey: input.laneKey } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.seq != null ? { seq: input.seq } : {}),
    origin: {
      providerEventType: input.providerEventType,
      providerIds: {
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
      providerEventType: 'transcript.task_completion',
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

function cloneAttachedFiles(message: SessionTranscriptMessage): SessionRenderAttachedFile[] {
  return Array.isArray(message._attachedFiles)
    ? message._attachedFiles.flatMap((file) => (isRecord(file) ? [structuredClone(file) as SessionRenderAttachedFile] : []))
    : [];
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
          providerEventType: 'transcript.tool_call',
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
}): CanonicalSessionEvent {
  const agentId = normalizeString(input.message.agentId);
  const runId = messageRunId(input.message);
  return {
    ...replayBase({
      eventId: eventId(['replay', input.sessionId, 'tool-result', input.index, input.toolCallId]),
      providerEventType: 'transcript.message_tool_result',
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
  const hasToolEvents = readToolEventsFromMessage('', message, 0).length > 0;
  return role === 'system'
    || text.length > 0
    || cloneAttachedFiles(message).length > 0
    || hasContentMedia(message)
    || hasThinkingContent(message)
    || hasToolEvents
    || hasRenderableTaskCompletion(message);
}

export function canProjectTranscriptMessage(sessionId: string, message: SessionTranscriptMessage): boolean {
  if (message.role === 'toolresult' || message.role === 'tool_result') {
    return buildStandaloneToolResultEvent(sessionId, message, 0) !== null
      || extractTaskSnapshotFromTranscriptMessage(sessionId, message) !== null
      || hasRenderableTaskCompletion(message);
  }
  return canReplayMessageSnapshot(message)
    || extractTaskSnapshotFromTranscriptMessage(sessionId, message) !== null;
}

export function* iterateCanonicalReplayEventsFromTranscriptMessages(
  sessionId: string,
  messages: Iterable<SessionTranscriptMessage>,
): Generator<CanonicalSessionEvent> {
  yield {
    ...replayBase({
      eventId: eventId(['replay', sessionId, 'start']),
      providerEventType: 'transcript.replay_boundary',
      sessionId,
    }),
    type: 'replay_boundary',
    phase: 'start',
  };

  let index = 0;
  for (const message of messages) {
    try {
      if (!canProjectTranscriptMessage(sessionId, message)) {
        continue;
      }
      if (message.role === 'toolresult' || message.role === 'tool_result') {
        const toolResult = buildStandaloneToolResultEvent(sessionId, message, index);
        if (toolResult) {
          yield toolResult;
        }
        const taskSnapshot = extractTaskSnapshotFromTranscriptMessage(sessionId, message);
        if (taskSnapshot) {
          yield {
            ...replayBase({
              eventId: eventId(['replay', sessionId, 'plan', index]),
              providerEventType: 'transcript.plan',
              sessionId,
              ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
              seq: index,
            }),
            type: 'plan',
            taskSnapshot,
          };
        }
        for (const event of readTaskCompletionEvents(sessionId, message, index)) {
          yield event;
        }
        continue;
      }

      const role = message.role;
      const text = resolveTranscriptDisplayText(message);
      const toolEvents = readToolEventsFromMessage(sessionId, message, index);
      const runId = messageRunId(message);
      const agentId = normalizeString(message.agentId);
      const canonicalMessageId = messageId(message, sessionId, index);
      if (canReplayMessageSnapshot(message)) {
        yield {
          ...replayBase({
            eventId: eventId(['replay', sessionId, 'message', index, canonicalMessageId]),
            providerEventType: 'transcript.message',
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
            providerEventType: 'transcript.plan',
            sessionId,
            ...(runId ? { runId } : {}),
            ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
            seq: index,
          }),
          type: 'plan',
          taskSnapshot,
        };
      }
      for (const event of readTaskCompletionEvents(sessionId, message, index)) {
        yield event;
      }
    } finally {
      index += 1;
    }
  }

  yield {
    ...replayBase({
      eventId: eventId(['replay', sessionId, 'end']),
      providerEventType: 'transcript.replay_boundary',
      sessionId,
    }),
    type: 'replay_boundary',
    phase: 'end',
  };
}

export function buildCanonicalReplayEventsFromTranscriptMessages(
  sessionId: string,
  messages: Iterable<SessionTranscriptMessage>,
): CanonicalSessionEvent[] {
  return Array.from(iterateCanonicalReplayEventsFromTranscriptMessages(sessionId, messages));
}
