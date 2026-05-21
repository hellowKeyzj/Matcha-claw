import {
  isInternalAssistantControlMessage,
  isInternalRuntimeDisplayMessage,
  normalizeOptionalString,
} from '../../shared/chat-message-normalization';
import type {
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
  SessionTimelineEntryStatus,
  SessionTimelineTaskCompletionEntry,
  SessionTimelineUserMessageEntry,
} from '../../shared/session-adapter-types';
import {
  applyToolStatusToSegments,
  buildAssistantTurnEntry,
  buildAssistantTurnEntryKey,
  buildSegmentsFromChatContent,
  type AssistantTurnEntryIdentity,
} from './assistant-turn-entry';
import {
  isStateOnlyToolName,
  isToolCallContentType,
  isToolResultContentType,
  resolveToolRecordCallId,
  resolveToolRecordName,
  resolveToolRecordResultPayload,
} from './state-only-tools';
import { isMalformedEmptyToolNameResult } from './tool-event-sanitizer';
import {
  extractToolResultOutputText,
} from './tool/tool-card-content';
import {
  extractImagesAsAttachedFiles,
  mergeAttachedFiles,
  readAttachedFiles,
  readMediaRefs,
} from './transcript-media-extractors';
import {
  resolveTranscriptDisplayText,
} from './transcript-content-extractors';
import {
  resolveSessionLaneKey,
  resolveTranscriptEntryId,
  resolveTranscriptEntryStatus,
  resolveTranscriptTurnBinding,
} from './transcript-turn-identity';
import type { SessionTranscriptMessage } from './transcript-types';
import { readMessageContent } from './transcript-content-extractors';

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

function buildIdentityFromMessage(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  runId?: string;
  sequenceId?: number;
  index: number;
  turnAnchorId?: string;
}): AssistantTurnEntryIdentity {
  const agentId = normalizeOptionalString(input.message.agentId) ?? '';
  const laneKey = resolveSessionLaneKey(agentId);
  const turnBinding = resolveTranscriptTurnBinding(input.message, {
    runId: input.runId,
    ...(input.turnAnchorId ? { turnAnchorId: input.turnAnchorId } : {}),
  });
  const entryId = resolveTranscriptEntryId(input.message, input.index, {
    runId: input.runId,
    sequenceId: input.sequenceId,
  });
  const turnKey = turnBinding ? turnBinding.key : `entry:${entryId}`;
  return {
    sessionKey: input.sessionKey,
    laneKey,
    turnKey,
    entryId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(agentId ? { agentId } : {}),
    turnBindingSource: turnBinding?.source ?? 'heuristic',
    turnBindingConfidence: turnBinding?.confidence ?? 'fallback',
    turnIdentityMode: turnBinding?.mode ?? 'heuristic',
    turnIdentityConfidence: turnBinding?.confidence ?? 'fallback',
    ...(input.message.messageId ? { messageId: input.message.messageId } : {}),
    ...(input.message.originMessageId ? { originMessageId: input.message.originMessageId } : {}),
    ...(input.message.clientId ? { clientId: input.message.clientId } : {}),
  };
}

function findExistingAssistantTurnEntry(
  rows: ReadonlyArray<SessionTimelineEntry>,
  identity: AssistantTurnEntryIdentity,
): SessionTimelineAssistantTurnEntry | null {
  const target = buildAssistantTurnEntryKey(identity.sessionKey, identity.laneKey, identity.turnKey);
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind === 'assistant-turn' && row.key === target) {
      return row;
    }
  }
  return null;
}

function findAssistantTurnByToolCallId(
  rows: ReadonlyArray<SessionTimelineEntry>,
  toolCallId: string,
): SessionTimelineAssistantTurnEntry | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row?.kind !== 'assistant-turn') {
      continue;
    }
    for (const segment of row.segments) {
      if (segment.kind === 'tool' && (segment.tool.toolCallId === toolCallId || segment.tool.id === toolCallId)) {
        return row;
      }
    }
  }
  return null;
}

function buildUserMessageEntry(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  runId?: string;
  sequenceId?: number;
  index: number;
  status: SessionTimelineEntryStatus;
}): SessionTimelineUserMessageEntry {
  const message = input.message;
  const agentId = normalizeOptionalString(message.agentId) ?? '';
  const laneKey = resolveSessionLaneKey(agentId);
  const turnBinding = resolveTranscriptTurnBinding(message, { runId: input.runId });
  const entryId = resolveTranscriptEntryId(message, input.index, {
    runId: input.runId,
    sequenceId: input.sequenceId,
  });
  const turnKey = turnBinding ? turnBinding.key : `entry:${entryId}`;
  const text = resolveTranscriptDisplayText(message);
  const attachedFiles = mergeAttachedFiles(
    readAttachedFiles(message),
    extractImagesAsAttachedFiles(message.content).filter((file) => Boolean(file.gatewayUrl)),
  );
  return {
    key: `session:${input.sessionKey}|entry:${entryId}`,
    kind: 'user-message',
    sessionKey: input.sessionKey,
    role: 'user',
    text,
    status: input.status,
    ...(message.timestamp != null ? { createdAt: message.timestamp } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
    entryId,
    laneKey,
    turnKey,
    turnBindingSource: turnBinding?.source ?? 'heuristic',
    turnBindingConfidence: turnBinding?.confidence ?? 'fallback',
    turnIdentityMode: turnBinding?.mode ?? 'heuristic',
    turnIdentityConfidence: turnBinding?.confidence ?? 'fallback',
    ...(agentId ? { agentId } : {}),
    sourceRole: message.role,
    images: [],
    attachedFiles,
    ...(message.messageId ? { messageId: message.messageId } : {}),
    ...(message.originMessageId ? { originMessageId: message.originMessageId } : {}),
    ...(message.clientId ? { clientId: message.clientId } : {}),
  };
}

function buildAssistantTurnFromAssistantMessage(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  runId?: string;
  sequenceId?: number;
  index: number;
  status: SessionTimelineEntryStatus;
  existingRows: ReadonlyArray<SessionTimelineEntry>;
  turnAnchorId?: string;
}): SessionTimelineAssistantTurnEntry {
  const identity = buildIdentityFromMessage({
    sessionKey: input.sessionKey,
    message: input.message,
    runId: input.runId,
    sequenceId: input.sequenceId,
    index: input.index,
    ...(input.turnAnchorId ? { turnAnchorId: input.turnAnchorId } : {}),
  });
  const existing = findExistingAssistantTurnEntry(input.existingRows, identity);
  const previousSegments = existing?.segments ?? [];
  const text = resolveTranscriptDisplayText(input.message);
  const attachedFiles = mergeAttachedFiles(
    readAttachedFiles(input.message),
    extractImagesAsAttachedFiles(input.message.content).filter((file) => Boolean(file.gatewayUrl)),
  );
  const segments = buildSegmentsFromChatContent({
    identity,
    content: input.message.content,
    fallbackText: text,
    attachedFiles,
    toolStatuses: input.message.toolStatuses,
    previousSegments,
    isStreaming: input.status === 'streaming' || Boolean(input.message.streaming),
  });
  return buildAssistantTurnEntry({
    identity,
    status: input.status,
    text,
    ...(input.message.timestamp != null ? { createdAt: input.message.timestamp } : {}),
    ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
    segments,
    isStreaming: input.status === 'streaming' || Boolean(input.message.streaming),
  });
}

function buildAssistantTurnFromToolResult(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  runId?: string;
  sequenceId?: number;
  index: number;
  status: SessionTimelineEntryStatus;
  existingRows: ReadonlyArray<SessionTimelineEntry>;
}): SessionTimelineAssistantTurnEntry | null {
  const message = input.message;
  if (isMalformedEmptyToolNameResult(message)) {
    return null;
  }
  const toolCallId = normalizeOptionalString(message.toolCallId) ?? '';
  const toolName = normalizeOptionalString(message.toolName ?? message.name) ?? '';
  if (!toolName || isStateOnlyToolName(toolName)) {
    return null;
  }

  const existingTurn = toolCallId
    ? findAssistantTurnByToolCallId(input.existingRows, toolCallId)
    : null;
  if (!existingTurn) {
    return null;
  }

  const identity: AssistantTurnEntryIdentity = {
    sessionKey: existingTurn.sessionKey,
    laneKey: existingTurn.laneKey ?? 'main',
    turnKey: existingTurn.turnKey ?? '',
    entryId: existingTurn.entryId ?? '',
    ...(existingTurn.runId ? { runId: existingTurn.runId } : {}),
    ...(existingTurn.agentId ? { agentId: existingTurn.agentId } : {}),
    turnBindingSource: existingTurn.turnBindingSource ?? 'heuristic',
    turnBindingConfidence: existingTurn.turnBindingConfidence ?? 'fallback',
    turnIdentityMode: existingTurn.turnIdentityMode ?? 'heuristic',
    turnIdentityConfidence: existingTurn.turnIdentityConfidence ?? 'fallback',
    ...(existingTurn.messageId ? { messageId: existingTurn.messageId } : {}),
    ...(existingTurn.originMessageId ? { originMessageId: existingTurn.originMessageId } : {}),
    ...(existingTurn.clientId ? { clientId: existingTurn.clientId } : {}),
  };

  const output = message.details !== undefined
    ? message.details
    : resolveToolRecordResultPayload(message) ?? message.content;
  const segments = applyToolStatusToSegments(existingTurn.segments, identity, {
    toolCallId,
    name: toolName,
    output,
    outputText: extractToolResultOutputText(output),
    content: message.content,
    status: message.isError ? 'error' : 'completed',
  });

  return buildAssistantTurnEntry({
    identity,
    status: existingTurn.status ?? 'final',
    text: existingTurn.text,
    ...(existingTurn.createdAt != null ? { createdAt: existingTurn.createdAt } : {}),
    ...(existingTurn.sequenceId != null ? { sequenceId: existingTurn.sequenceId } : {}),
    segments,
    isStreaming: existingTurn.isStreaming,
  });
}

function buildTaskCompletionRows(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  sourceEntryId: string;
  existingRows: ReadonlyArray<SessionTimelineEntry>;
  runId?: string;
  sequenceId?: number;
}): SessionTimelineTaskCompletionEntry[] {
  const completionEvents = Array.isArray(input.message.taskCompletionEvents) ? input.message.taskCompletionEvents : [];
  return completionEvents.map((event, completionIndex) => {
    const triggerRow = resolveCompletionTriggerRow([...input.existingRows], input.sourceEntryId);
    const completionRow: SessionTimelineTaskCompletionEntry = {
      key: `session:${input.sessionKey}|completion:${input.sourceEntryId}:${completionIndex}`,
      kind: 'task-completion',
      sessionKey: input.sessionKey,
      role: 'system',
      text: [event.taskLabel, event.statusLabel, event.result]
        .filter((value) => typeof value === 'string' && value.trim())
        .join(' · '),
      ...(input.message.timestamp != null ? { createdAt: input.message.timestamp } : {}),
      status: 'final',
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
      entryId: input.sourceEntryId,
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
    return completionRow;
  });
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
    turnAnchorId?: string;
  },
): SessionTimelineEntry[] {
  if (isInternalAssistantControlMessage(message)) {
    return [];
  }
  if (isInternalRuntimeDisplayMessage(message)) {
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

  const status = options.status ?? 'final';
  const existingRows = options.existingRows ?? [];

  if (message.role === 'toolresult' || message.role === 'tool_result') {
    const updated = buildAssistantTurnFromToolResult({
      sessionKey,
      message,
      runId: options.runId,
      sequenceId: options.sequenceId,
      index: options.index,
      status,
      existingRows,
    });
    return updated ? [updated] : [];
  }

  if (message.role === 'user' || message.role === 'system') {
    if (message.role === 'system') {
      const entryId = resolveTranscriptEntryId(message, options.index, {
        runId: options.runId,
        sequenceId: options.sequenceId,
      });
      return [{
        key: `session:${sessionKey}|entry:${entryId}`,
        kind: 'system',
        sessionKey,
        role: 'system',
        level: 'info',
        text: resolveTranscriptDisplayText(message),
        status,
        ...(message.timestamp != null ? { createdAt: message.timestamp } : {}),
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.sequenceId != null ? { sequenceId: options.sequenceId } : {}),
        entryId,
      }];
    }
    const userEntry = buildUserMessageEntry({
      sessionKey,
      message,
      runId: options.runId,
      sequenceId: options.sequenceId,
      index: options.index,
      status,
    });
    return [
      userEntry,
      ...buildTaskCompletionRows({
        sessionKey,
        message,
        sourceEntryId: userEntry.entryId ?? `entry-${options.index}`,
        existingRows,
        runId: options.runId,
        sequenceId: options.sequenceId,
      }),
    ];
  }

  const turnEntry = buildAssistantTurnFromAssistantMessage({
    sessionKey,
    message,
    runId: options.runId,
    sequenceId: options.sequenceId,
    index: options.index,
    status,
    existingRows,
    ...(options.turnAnchorId ? { turnAnchorId: options.turnAnchorId } : {}),
  });
  const rows: SessionTimelineEntry[] = [turnEntry];

  rows.push(...buildTaskCompletionRows({
    sessionKey,
    message,
    sourceEntryId: turnEntry.entryId ?? `entry-${options.index}`,
    existingRows,
    runId: options.runId,
    sequenceId: options.sequenceId,
  }));

  return rows;
}

export function materializeTranscriptTimelineEntries(
  sessionKey: string,
  messages: SessionTranscriptMessage[],
  options: {
    existingRows?: SessionTimelineEntry[];
  } = {},
): SessionTimelineEntry[] {
  const entries: SessionTimelineEntry[] = [...(options.existingRows ?? [])];
  const baselineLength = entries.length;
  let turnAnchorId: string | undefined;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'user') {
      turnAnchorId = normalizeOptionalString(message.messageId)
        ?? normalizeOptionalString(message.id)
        ?? `index:${index}`;
    }
    const produced = buildTimelineEntriesFromTranscriptMessage(sessionKey, message, {
      index,
      status: resolveTranscriptEntryStatus(message),
      existingRows: entries,
      ...(turnAnchorId ? { turnAnchorId } : {}),
    });
    for (const entry of produced) {
      const existingIndex = entries.findIndex((candidate) => candidate.key === entry.key);
      if (existingIndex >= 0) {
        entries[existingIndex] = entry;
      } else {
        entries.push(entry);
      }
    }
  }
  return entries.slice(baselineLength);
}
