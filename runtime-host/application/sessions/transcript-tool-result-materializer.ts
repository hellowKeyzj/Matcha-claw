import { normalizeOptionalString } from '../../shared/chat-message-normalization';
import { mergeToolCards } from './tool/tool-card-render';
import type {
  SessionTimelineEntryStatus,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
} from '../../shared/session-adapter-types';
import {
  buildAssistantSegmentsFromToolCards,
} from './assistant-turn-segments';
import type { SessionTranscriptMessage } from './transcript-types';
import {
  extractImagesAsAttachedFiles,
  mergeAttachedFiles,
  readAttachedFiles,
  readMediaRefs,
} from './transcript-media-extractors';
import {
  mergeToolStatusRecords,
  readToolStatuses,
} from './transcript-tool-extractors';
import {
  resolveTranscriptDisplayText,
} from './transcript-content-extractors';
import {
  resolveSessionLaneKey,
  resolveTranscriptEntryId,
  resolveTranscriptEntryStatus,
} from './transcript-turn-identity';

function findLatestAssistantContentRow(
  rows: SessionTimelineEntry[],
  laneKey: string,
  turnKey: string,
): SessionTimelineMessageEntry | SessionTimelineToolActivityEntry | null {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'assistant') {
      continue;
    }
    if ((row.kind !== 'message' && row.kind !== 'tool-activity') || row.laneKey !== laneKey || row.turnKey !== turnKey) {
      continue;
    }
    return row;
  }
  return null;
}

function findLatestAssistantContentRowByToolCallId(
  rows: SessionTimelineEntry[],
  toolCallId: string,
  preferredLaneKey?: string,
): SessionTimelineMessageEntry | SessionTimelineToolActivityEntry | null {
  const matchesToolCallId = (row: SessionTimelineMessageEntry | SessionTimelineToolActivityEntry) => (
    row.toolUses.some((toolUse) => toolUse.toolCallId === toolCallId || toolUse.id === toolCallId)
    || row.toolStatuses.some((toolStatus) => toolStatus.toolCallId === toolCallId || toolStatus.id === toolCallId)
    || row.toolCards.some((toolCard) => toolCard.toolCallId === toolCallId || toolCard.id === toolCallId)
  );

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'assistant' || (row.kind !== 'message' && row.kind !== 'tool-activity')) {
      continue;
    }
    if (preferredLaneKey && row.laneKey !== preferredLaneKey) {
      continue;
    }
    if (matchesToolCallId(row)) {
      return row;
    }
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || row.role !== 'assistant' || (row.kind !== 'message' && row.kind !== 'tool-activity')) {
      continue;
    }
    if (matchesToolCallId(row)) {
      return row;
    }
  }

  return null;
}

export function materializeToolResultPatchRows(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  sequenceId?: number;
  index: number;
  existingRows: SessionTimelineEntry[];
}): SessionTimelineEntry[] {
  const agentId = normalizeOptionalString(input.message.agentId) ?? '';
  const laneKey = resolveSessionLaneKey(agentId);
  const entryId = resolveTranscriptEntryId(input.message, input.index, {
    sequenceId: input.sequenceId,
  });
  return materializeToolResultRows({
    sessionKey: input.sessionKey,
    message: input.message,
    status: resolveTranscriptEntryStatus(input.message),
    sequenceId: input.sequenceId,
    createdAt: input.message.timestamp,
    entryId,
    laneKey,
    turnKey: `${laneKey}:entry:${entryId}`,
    agentId,
    text: resolveTranscriptDisplayText(input.message),
    existingRows: input.existingRows,
  });
}

export function materializeToolResultRows(input: {
  sessionKey: string;
  message: SessionTranscriptMessage;
  status: SessionTimelineEntryStatus;
  runId?: string;
  sequenceId?: number;
  createdAt?: number;
  entryId: string;
  laneKey: string;
  turnKey: string;
  agentId: string;
  text: string;
  existingRows: SessionTimelineEntry[];
}): SessionTimelineEntry[] {
  const attachedFiles = mergeAttachedFiles(
    readAttachedFiles(input.message),
    [
      ...extractImagesAsAttachedFiles(input.message.content, 'tool-result'),
      ...readMediaRefs(input.text).map((ref) => ({
        fileName: ref.filePath.split(/[\\/]/).pop() || 'file',
        mimeType: ref.mimeType,
        fileSize: 0,
        preview: null,
        filePath: ref.filePath,
        source: 'tool-result' as const,
      })),
    ],
  );
  const toolStatuses = readToolStatuses(input.message);
  const toolCallId = normalizeOptionalString(
    input.message.toolCallId
    ?? toolStatuses[0]?.toolCallId
    ?? toolStatuses[0]?.id,
  );
  const existingAssistantRow = toolCallId
    ? (
        findLatestAssistantContentRowByToolCallId(input.existingRows, toolCallId, input.laneKey)
        ?? findLatestAssistantContentRow(input.existingRows, input.laneKey, input.turnKey)
      )
    : findLatestAssistantContentRow(input.existingRows, input.laneKey, input.turnKey);
  const resolvedLaneKey = existingAssistantRow?.laneKey ?? input.laneKey;
  const resolvedTurnKey = existingAssistantRow?.turnKey ?? input.turnKey;
  const resolvedTurnBindingSource = existingAssistantRow?.turnBindingSource
    ?? (toolCallId ? 'tool_call' : 'heuristic');
  const resolvedTurnBindingConfidence = existingAssistantRow?.turnBindingConfidence
    ?? (toolCallId ? 'strong' : 'fallback');
  const resolvedTurnIdentityMode = existingAssistantRow?.turnIdentityMode
    ?? (toolCallId ? 'tool_call' : 'heuristic');
  const resolvedTurnIdentityConfidence = existingAssistantRow?.turnIdentityConfidence
    ?? (toolCallId ? 'strong' : 'fallback');
  const resolvedAgentId = existingAssistantRow?.agentId ?? input.agentId;
  const existingToolUses = existingAssistantRow?.toolUses ?? [];
  const existingToolStatuses = existingAssistantRow?.toolStatuses ?? [];
  const existingToolCards = existingAssistantRow?.toolCards ?? [];
  const nextToolStatuses = mergeToolStatusRecords(existingToolStatuses, toolStatuses);
  const nextToolCards = mergeToolCards({
    existingTools: existingToolCards,
    toolUses: existingToolUses,
    toolStatuses: nextToolStatuses,
  });
  const updatedToolKeys = toolStatuses.map((status) => normalizeOptionalString(status.toolCallId ?? status.id ?? status.name) ?? '').filter(Boolean);
  if (existingAssistantRow?.kind === 'message') {
    return [{
      ...existingAssistantRow,
      key: existingAssistantRow.key,
      status: input.status,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
      createdAt: input.createdAt ?? existingAssistantRow.createdAt,
      turnBindingSource: resolvedTurnBindingSource,
      turnBindingConfidence: resolvedTurnBindingConfidence,
      turnIdentityMode: resolvedTurnIdentityMode,
      turnIdentityConfidence: resolvedTurnIdentityConfidence,
      sourceRole: input.message.role,
      attachedFiles: mergeAttachedFiles(existingAssistantRow.attachedFiles, attachedFiles),
      toolStatuses: nextToolStatuses,
      toolCards: nextToolCards,
      assistantSegments: buildAssistantSegmentsFromToolCards({
        toolCards: nextToolCards,
        updatedToolKeys,
      }),
      isStreaming: input.status === 'streaming' || existingAssistantRow.isStreaming,
    }];
  }
  return [{
    key: existingAssistantRow?.key ?? `session:${input.sessionKey}|tool-activity:${input.entryId}`,
    kind: 'tool-activity',
    sessionKey: input.sessionKey,
    role: 'assistant',
    text: existingAssistantRow?.text ?? '',
    createdAt: input.createdAt,
    status: input.status,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
    entryId: existingAssistantRow?.entryId ?? input.entryId,
    laneKey: resolvedLaneKey,
    turnKey: resolvedTurnKey,
    turnBindingSource: resolvedTurnBindingSource,
    turnBindingConfidence: resolvedTurnBindingConfidence,
    turnIdentityMode: resolvedTurnIdentityMode,
    turnIdentityConfidence: resolvedTurnIdentityConfidence,
    ...(resolvedAgentId ? { agentId: resolvedAgentId } : {}),
    sourceRole: input.message.role,
    assistantTurnKey: resolvedTurnKey,
    assistantLaneKey: resolvedLaneKey,
    assistantLaneAgentId: resolvedAgentId || null,
    toolUses: existingToolUses,
    toolStatuses: nextToolStatuses,
    toolCards: nextToolCards,
    assistantSegments: buildAssistantSegmentsFromToolCards({
      toolCards: nextToolCards,
      updatedToolKeys,
    }),
    attachedFiles,
    isStreaming: input.status === 'streaming' || Boolean(input.message.streaming),
  }];
}
