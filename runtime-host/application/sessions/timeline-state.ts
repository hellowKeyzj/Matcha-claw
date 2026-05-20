import type {
  SessionAssistantToolSegment,
  SessionRuntimeStateSnapshot,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import {
  applyToolStatusToSegments,
  buildAssistantTurnEntry,
  type AssistantTurnEntryIdentity,
} from './assistant-turn-entry';
import {
  mergeTimelineEntry,
} from './timeline-entry-merge';
import {
  findTimelineEntryIndex,
  resolveTimelineInsertionIndex,
} from './timeline-insertion-policy';
import type { SessionToolStatusUpdateIngressEvent } from './gateway-ingress-types';
import {
  extractToolResultOutputText,
} from './tool/tool-card-content';

export {
  findTimelineEntryIndex,
} from './timeline-insertion-policy';

function cloneTimelineEntries(entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
  return structuredClone(entries);
}

export function upsertTimelineEntry(
  entries: SessionTimelineEntry[],
  incoming: SessionTimelineEntry,
): SessionTimelineEntry[] {
  const index = findTimelineEntryIndex(entries, incoming);

  if (index < 0) {
    const nextEntries = cloneTimelineEntries(entries);
    const insertionIndex = resolveTimelineInsertionIndex(nextEntries, incoming, nextEntries.length);
    nextEntries.splice(insertionIndex, 0, structuredClone(incoming));
    return nextEntries;
  }

  const mergedEntry = mergeTimelineEntry(entries[index]!, incoming);
  const nextEntries = cloneTimelineEntries(entries);
  nextEntries[index] = mergedEntry;
  return nextEntries;
}

export function mergeTimelineEntries(
  transcriptEntries: SessionTimelineEntry[],
  overlayEntries: SessionTimelineEntry[],
): SessionTimelineEntry[] {
  let mergedEntries = cloneTimelineEntries(transcriptEntries);
  for (const entry of overlayEntries) {
    mergedEntries = upsertTimelineEntry(mergedEntries, entry);
  }
  return mergedEntries;
}

function listToolSegments(entry: SessionTimelineAssistantTurnEntry): SessionAssistantToolSegment[] {
  return entry.segments.filter((segment): segment is SessionAssistantToolSegment => segment.kind === 'tool');
}

function buildTranscriptToolResultsById(
  transcriptEntries: SessionTimelineEntry[],
): Map<string, SessionAssistantToolSegment> {
  const results = new Map<string, SessionAssistantToolSegment>();
  for (const entry of transcriptEntries) {
    if (entry.kind !== 'assistant-turn') {
      continue;
    }
    for (const segment of listToolSegments(entry)) {
      if (
        segment.tool.result.kind === 'none'
        && segment.tool.output === undefined
      ) {
        continue;
      }
      const ids = [
        segment.tool.toolCallId,
        segment.tool.id,
      ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      for (const id of ids) {
        results.set(id, segment);
      }
    }
  }
  return results;
}

function toolNeedsTranscriptResult(segment: SessionAssistantToolSegment): boolean {
  return segment.tool.output === undefined && segment.tool.result.kind === 'none';
}

function findTranscriptResultForTool(
  segment: SessionAssistantToolSegment,
  transcriptResultsById: Map<string, SessionAssistantToolSegment>,
): SessionAssistantToolSegment | null {
  const ids = [
    segment.tool.toolCallId,
    segment.tool.id,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  for (const id of ids) {
    const result = transcriptResultsById.get(id);
    if (result) {
      return result;
    }
  }
  return null;
}

export function applyTranscriptToolResultUpdates(
  entries: SessionTimelineEntry[],
  transcriptEntries: SessionTimelineEntry[],
): {
  entries: SessionTimelineEntry[];
  updatedEntries: SessionTimelineAssistantTurnEntry[];
} {
  const transcriptResultsById = buildTranscriptToolResultsById(transcriptEntries);
  if (transcriptResultsById.size === 0) {
    return {
      entries,
      updatedEntries: [],
    };
  }

  let nextEntries: SessionTimelineEntry[] | null = null;
  const updatedEntries: SessionTimelineAssistantTurnEntry[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.kind !== 'assistant-turn') {
      continue;
    }
    let nextSegments = entry.segments;
    for (const segment of listToolSegments(entry)) {
      if (!toolNeedsTranscriptResult(segment)) {
        continue;
      }
      const transcriptSegment = findTranscriptResultForTool(segment, transcriptResultsById);
      if (!transcriptSegment) {
        continue;
      }
      nextSegments = applyToolStatusToSegments(nextSegments, buildIdentityFromTurnEntry(entry), {
        toolCallId: segment.tool.toolCallId ?? segment.tool.id,
        name: transcriptSegment.tool.name || segment.tool.name,
        input: transcriptSegment.tool.input !== undefined ? transcriptSegment.tool.input : segment.tool.input,
        output: transcriptSegment.tool.output,
        outputText: extractToolResultOutputText(transcriptSegment.tool.output),
        status: transcriptSegment.tool.status === 'error' ? 'error' : 'completed',
        ...(transcriptSegment.tool.durationMs != null ? { durationMs: transcriptSegment.tool.durationMs } : {}),
        ...(transcriptSegment.tool.updatedAt != null ? { updatedAt: transcriptSegment.tool.updatedAt } : {}),
      });
    }
    if (nextSegments === entry.segments) {
      continue;
    }
    const nextEntry: SessionTimelineAssistantTurnEntry = {
      ...structuredClone(entry),
      segments: nextSegments,
    };
    if (!nextEntries) {
      nextEntries = cloneTimelineEntries(entries);
    }
    nextEntries[index] = nextEntry;
    updatedEntries.push(structuredClone(nextEntry));
  }

  return {
    entries: nextEntries ?? entries,
    updatedEntries,
  };
}

function findAssistantTurnIndexByToolCallId(
  entries: SessionTimelineEntry[],
  toolCallId: string,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind !== 'assistant-turn') {
      continue;
    }
    for (const segment of entry.segments) {
      if (segment.kind === 'tool' && (segment.tool.toolCallId === toolCallId || segment.tool.id === toolCallId)) {
        return index;
      }
    }
  }
  return -1;
}

function findLatestAssistantToolByCallId(
  entries: SessionTimelineEntry[],
  toolCallId: string,
): SessionTimelineAssistantTurnEntry | null {
  const index = findAssistantTurnIndexByToolCallId(entries, toolCallId);
  const entry = index >= 0 ? entries[index] : null;
  return entry?.kind === 'assistant-turn' ? entry : null;
}

function findLatestAssistantTurnIndexForRun(
  entries: SessionTimelineEntry[],
  runId: string,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'assistant-turn' && entry.runId === runId) {
      return index;
    }
  }
  return -1;
}

function buildIdentityFromTurnEntry(entry: SessionTimelineAssistantTurnEntry): AssistantTurnEntryIdentity {
  return {
    sessionKey: entry.sessionKey,
    laneKey: entry.laneKey ?? 'main',
    turnKey: entry.turnKey ?? '',
    entryId: entry.entryId ?? '',
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    turnBindingSource: entry.turnBindingSource ?? 'heuristic',
    turnBindingConfidence: entry.turnBindingConfidence ?? 'fallback',
    turnIdentityMode: entry.turnIdentityMode ?? 'heuristic',
    turnIdentityConfidence: entry.turnIdentityConfidence ?? 'fallback',
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
    ...(entry.originMessageId ? { originMessageId: entry.originMessageId } : {}),
    ...(entry.clientId ? { clientId: entry.clientId } : {}),
  };
}

function buildIdentityForOrphanToolEvent(
  update: SessionToolStatusUpdateIngressEvent,
): AssistantTurnEntryIdentity | null {
  const sessionKey = update.sessionKey ?? '';
  const runId = update.runId ?? '';
  if (!sessionKey || !runId) {
    return null;
  }
  const laneKey = 'main';
  return {
    sessionKey,
    laneKey,
    turnKey: runId,
    entryId: `run:${runId}:assistant:0`,
    runId,
    turnBindingSource: 'run',
    turnBindingConfidence: 'strong',
    turnIdentityMode: 'run',
    turnIdentityConfidence: 'strong',
  };
}

/**
 * Apply a tool-lifecycle update to the assistant-turn entry that owns the
 * matching `toolCallId`. If no turn currently references the toolCallId, the
 * latest streaming turn for the same run is patched with a placeholder tool
 * segment; the next chat-content frame will reorder it.
 *
 * 当一个新的 chat 回合首条事件就是 tool start（assistant 还没有任何文本输出）时，
 * timeline 里此时没有对应 assistant-turn。此情况下凭借 runId 凭空创建一条空的
 * assistant-turn 占位条目，把 tool segment 挂上去。后续 chat delta 通过同一个 runId
 * 的 turn binding 会复用这条 entry，实现"先 tool 后文本"的正确顺序。
 */
export function applyToolStatusUpdate(
  entries: SessionTimelineEntry[],
  update: SessionToolStatusUpdateIngressEvent,
): SessionTimelineEntry[] {
  if (!update.toolCallId) {
    return entries;
  }
  let index = findAssistantTurnIndexByToolCallId(entries, update.toolCallId);
  if (index < 0 && update.runId) {
    index = findLatestAssistantTurnIndexForRun(entries, update.runId);
  }
  let target: SessionTimelineAssistantTurnEntry | null = null;
  if (index >= 0) {
    const candidate = entries[index]!;
    if (candidate.kind === 'assistant-turn') {
      target = candidate;
    }
  }
  const previousToolTurn = target ?? findLatestAssistantToolByCallId(entries, update.toolCallId);
  const previousTool = previousToolTurn?.segments.find((segment) => (
    segment.kind === 'tool'
    && (segment.tool.toolCallId === update.toolCallId || segment.tool.id === update.toolCallId)
  ));
  const toolName = update.toolName || (previousTool?.kind === 'tool' ? previousTool.tool.name : '');
  if (!toolName) {
    return entries;
  }
  const identity = target
    ? buildIdentityFromTurnEntry(target)
    : buildIdentityForOrphanToolEvent(update);
  if (!identity) {
    return entries;
  }
  const previousSegments = target?.segments ?? [];
  const nextSegments = applyToolStatusToSegments(previousSegments, identity, {
    toolCallId: update.toolCallId,
    name: toolName,
    status: update.status,
    ...(update.input !== undefined ? { input: update.input } : {}),
    ...(update.output !== undefined ? { output: update.output } : {}),
    ...(update.outputText !== undefined ? { outputText: update.outputText } : {}),
    ...(update.timestamp != null ? { updatedAt: update.timestamp } : {}),
  });
  if (nextSegments === previousSegments) {
    return entries;
  }
  const nextTurn = buildAssistantTurnEntry({
    identity,
    status: target?.status ?? 'streaming',
    text: target?.text ?? '',
    ...(target?.createdAt != null
      ? { createdAt: target.createdAt }
      : (update.timestamp != null ? { createdAt: update.timestamp } : {})),
    ...(target?.sequenceId != null
      ? { sequenceId: target.sequenceId }
      : (update.sequenceId != null ? { sequenceId: update.sequenceId } : {})),
    segments: nextSegments,
    isStreaming: target?.isStreaming ?? true,
  });
  if (target) {
    const next = cloneTimelineEntries(entries);
    next[index] = nextTurn;
    return next;
  }
  return upsertTimelineEntry(entries, nextTurn);
}

export function resolveTimelineLastActivityAt(
  entries: SessionTimelineEntry[],
  runtime: SessionRuntimeStateSnapshot,
): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const timestamp = entries[index]?.createdAt;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return typeof runtime.updatedAt === 'number' && Number.isFinite(runtime.updatedAt)
    ? runtime.updatedAt
    : undefined;
}
