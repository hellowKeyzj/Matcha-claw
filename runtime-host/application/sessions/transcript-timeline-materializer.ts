import {
  isInternalAssistantControlMessage,
  normalizeOptionalString,
} from '../../shared/chat-message-normalization';
import { buildToolCardsFromMessage } from './tool/tool-card-render';
import {
  buildAssistantSegmentsFromMessageContent,
  buildAssistantSegmentsFromToolCards,
} from './assistant-turn-segments';
import type {
  SessionTimelineEntryStatus,
  SessionTimelineEntry,
  SessionTimelineTaskCompletionEntry,
} from '../../shared/session-adapter-types';
import type { SessionTranscriptMessage } from './transcript-types';
import {
  extractImages,
  extractThinking,
  readMessageContent,
  resolveTranscriptDisplayText,
} from './transcript-content-extractors';
import {
  extractImagesAsAttachedFiles,
  mergeAttachedFiles,
  readAttachedFiles,
} from './transcript-media-extractors';
import {
  extractToolUses,
  readToolStatuses,
} from './transcript-tool-extractors';
import {
  resolveSessionLaneKey,
  resolveTranscriptEntryId,
  resolveTranscriptEntryStatus,
  resolveTranscriptTurnBinding,
} from './transcript-turn-identity';
import {
  materializeToolResultPatchRows,
  materializeToolResultRows,
} from './transcript-tool-result-materializer';
import {
  isToolCallContentType,
  isToolResultContentType,
  isStateOnlyToolName,
  resolveToolRecordName,
} from './state-only-tools';
import { isMalformedEmptyToolNameResult } from './tool-event-sanitizer';

function buildTaskCompletionText(row: SessionTimelineTaskCompletionEntry): string {
  return [
    row.taskLabel,
    row.statusLabel,
    row.result,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' · ');
}

function resolveCompletionTriggerRow(
  rows: SessionTimelineEntry[],
  fallbackEntryId: string,
): SessionTimelineEntry | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'user') {
      continue;
    }
    if (row.entryId === fallbackEntryId) {
      continue;
    }
    return row;
  }
  return null;
}

function isStateOnlyAssistantMessage(message: SessionTranscriptMessage): boolean {
  if (message.role !== 'assistant') {
    return false;
  }
  if (isStateOnlyToolName(message.toolName ?? message.name)) {
    return true;
  }
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return false;
  }
  let hasStateOnlyBlock = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      return false;
    }
    const row = block as { type?: unknown; name?: unknown };
    const type = typeof row.type === 'string' ? row.type : '';
    if (!isToolCallContentType(type) && !isToolResultContentType(type)) {
      return false;
    }
    if (!isStateOnlyToolName(resolveToolRecordName(row))) {
      return false;
    }
    hasStateOnlyBlock = true;
  }
  return hasStateOnlyBlock;
}

function isStateOnlyToolResultMessage(message: SessionTranscriptMessage): boolean {
  if (message.role !== 'toolresult' && message.role !== 'tool_result') {
    return false;
  }
  return isStateOnlyToolName(message.toolName ?? message.name);
}

function hasOnlyMalformedEmptyToolBlocks(message: SessionTranscriptMessage): boolean {
  const content = readMessageContent(message);
  if (!Array.isArray(content)) {
    return false;
  }
  let sawToolBlock = false;
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      return false;
    }
    const row = block as { type?: unknown };
    const type = typeof row.type === 'string' ? row.type : '';
    if (!isToolCallContentType(type) && !isToolResultContentType(type)) {
      return false;
    }
    if (resolveToolRecordName(row)) {
      return false;
    }
    sawToolBlock = true;
  }
  return sawToolBlock;
}

function isMalformedEmptyToolMessage(message: SessionTranscriptMessage): boolean {
  if (message.role === 'assistant') {
    return hasOnlyMalformedEmptyToolBlocks(message);
  }
  if (message.role !== 'toolresult' && message.role !== 'tool_result') {
    return false;
  }
  return isMalformedEmptyToolNameResult(message);
}

export function buildTimelineEntriesFromTranscriptMessage(
  sessionKey: string,
  message: SessionTranscriptMessage,
  options: {
    runId?: string;
    sequenceId?: number;
    status?: SessionTimelineEntryStatus;
    index: number;
    existingRows?: SessionTimelineEntry[];
  },
): SessionTimelineEntry[] {
  if (isInternalAssistantControlMessage(message)) {
    return [];
  }
  if (isMalformedEmptyToolMessage(message)) {
    return [];
  }
  if (isStateOnlyAssistantMessage(message)) {
    return [];
  }
  if (isStateOnlyToolResultMessage(message)) {
    return [];
  }
  const agentId = normalizeOptionalString(message.agentId) ?? '';
  const existingRows = options.existingRows ?? [];
  const defaultLaneKey = resolveSessionLaneKey(agentId);
  const turnBinding = resolveTranscriptTurnBinding(message, {
    runId: options.runId,
  });
  const laneKey = defaultLaneKey;
  const entryId = resolveTranscriptEntryId(message, options.index, {
    runId: options.runId,
    sequenceId: options.sequenceId,
  });
  const status = options.status ?? 'final';
  const createdAt = message.timestamp;
  const text = resolveTranscriptDisplayText(message);
  const turnKey = turnBinding
    ? `${laneKey}:${turnBinding.key}`
    : `${laneKey}:entry:${entryId}`;
  const resolvedRunId = options.runId;
  const resolvedAgentId = agentId;

  if (message.role === 'toolresult' || message.role === 'tool_result') {
    return materializeToolResultRows({
      sessionKey,
      message,
      status,
      runId: resolvedRunId,
      sequenceId: options.sequenceId,
      createdAt,
      entryId,
      laneKey,
      turnKey,
      agentId: resolvedAgentId,
      text,
      existingRows,
    });
  }

  const toolUses = extractToolUses(message);
  const toolStatuses = readToolStatuses(message);
  const toolCards = buildToolCardsFromMessage({
    content: message.content,
    role: message.role,
    status,
    toolName: message.toolName ?? message.name,
    toolCallId: message.toolCallId,
    toolStatuses,
    toolCalls: message.tool_calls ?? message.toolCalls,
  });
  const thinking = extractThinking(message);
  const images = extractImages(message);
  const attachedFiles = mergeAttachedFiles(
    readAttachedFiles(message),
    extractImagesAsAttachedFiles(message.content).filter((file) => Boolean(file.gatewayUrl)),
  );
  const role = message.role === 'user' || message.role === 'system' ? message.role : 'assistant';
  const assistantSegments = role === 'assistant'
    ? buildAssistantSegmentsFromMessageContent({
        role: message.role,
        turnKey,
        laneKey,
        content: readMessageContent(message),
        text,
        images,
        attachedFiles,
        toolCards,
      })
    : [];
  const base = {
    key: `session:${sessionKey}|entry:${entryId}`,
    sessionKey,
    role,
    text,
    createdAt,
    status,
    ...(resolvedRunId ? { runId: resolvedRunId } : {}),
    ...(options.sequenceId != null ? { sequenceId: options.sequenceId } : {}),
    entryId,
    laneKey,
    turnKey,
    ...(turnBinding ? {
      turnBindingSource: turnBinding.source,
      turnBindingConfidence: turnBinding.confidence,
      turnIdentityMode: turnBinding.mode,
      turnIdentityConfidence: turnBinding.confidence,
    } : {
      turnBindingSource: 'heuristic' as const,
      turnBindingConfidence: 'fallback' as const,
      turnIdentityMode: 'heuristic' as const,
      turnIdentityConfidence: 'fallback' as const,
    }),
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
      ...(role === 'assistant' ? {
        sourceRole: message.role,
        assistantTurnKey: turnKey,
        assistantLaneKey: laneKey,
        assistantLaneAgentId: resolvedAgentId || null,
    } : {}),
  } as const;

  const isToolActivity = (
    role === 'assistant'
    && toolUses.length > 0
    && text.trim().length === 0
    && !thinking
    && images.length === 0
    && attachedFiles.length === 0
  );

  const rows: SessionTimelineEntry[] = [];
  if (isToolActivity) {
    rows.push({
      ...base,
      kind: 'tool-activity',
      role: 'assistant',
      assistantSegments: buildAssistantSegmentsFromToolCards({
        toolCards,
      }),
      toolUses,
      toolStatuses,
      toolCards,
      attachedFiles: [],
      isStreaming: status === 'streaming' || Boolean(message.streaming),
    });
  } else {
    rows.push({
      ...base,
      kind: 'message',
      thinking,
      assistantSegments,
      images,
      toolUses,
      attachedFiles,
      toolStatuses,
      toolCards,
      isStreaming: status === 'streaming' || Boolean(message.streaming),
      ...(message.messageId ? { messageId: message.messageId } : {}),
      ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
      ...(message.clientId ? { clientId: message.clientId } : {}),
    });
  }

  const completionEvents = Array.isArray(message.taskCompletionEvents) ? message.taskCompletionEvents : [];
  for (const [completionIndex, event] of completionEvents.entries()) {
    const triggerRow = resolveCompletionTriggerRow(existingRows, entryId);
    const completionRow: SessionTimelineTaskCompletionEntry = {
      key: `session:${sessionKey}|completion:${entryId}:${completionIndex}`,
      kind: 'task-completion',
      sessionKey,
      role: 'system',
      text: [
        event.taskLabel,
        event.statusLabel,
        event.result,
      ].filter((value) => typeof value === 'string' && value.trim()).join(' · '),
      createdAt,
      status: 'final',
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.sequenceId != null ? { sequenceId: options.sequenceId } : {}),
      entryId,
      childSessionKey: event.childSessionKey,
      ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
      ...(event.childAgentId ? { childAgentId: event.childAgentId } : {}),
      ...(event.taskLabel ? { taskLabel: event.taskLabel } : {}),
      ...(event.statusLabel ? { statusLabel: event.statusLabel } : {}),
      ...(event.result ? { result: event.result } : {}),
      ...(event.statsLine ? { statsLine: event.statsLine } : {}),
      ...(event.replyInstruction ? { replyInstruction: event.replyInstruction } : {}),
      ...(triggerRow?.key ? { triggerItemKey: triggerRow.key } : {}),
    };
    if (!completionRow.text) {
      completionRow.text = buildTaskCompletionText(completionRow);
    }
    rows.push(completionRow);
  }

  return rows;
}

export function materializeTranscriptTimelineEntries(
  sessionKey: string,
  messages: SessionTranscriptMessage[],
  options: {
    existingRows?: SessionTimelineEntry[];
  } = {},
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  const baselineRows = options.existingRows ?? [];
  for (const [index, message] of messages.entries()) {
    entries.push(...buildTimelineEntriesFromTranscriptMessage(sessionKey, message, {
      index,
      status: resolveTranscriptEntryStatus(message),
      existingRows: [
        ...baselineRows,
        ...entries,
      ],
    }));
  }
  return entries;
}

export function materializeTranscriptToolResultPatchEntries(
  sessionKey: string,
  messages: SessionTranscriptMessage[],
  existingRows: SessionTimelineEntry[],
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'toolresult' && message.role !== 'tool_result') {
      continue;
    }
    if (isStateOnlyToolResultMessage(message)) {
      continue;
    }
    entries.push(...materializeToolResultPatchRows({
      sessionKey,
      message,
      sequenceId: undefined,
      index,
      existingRows: [
        ...existingRows,
        ...entries,
      ],
    }));
  }
  return entries;
}
