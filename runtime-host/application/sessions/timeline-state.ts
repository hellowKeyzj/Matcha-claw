import type {
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

/**
 * Apply a tool-lifecycle update to the assistant-turn entry that owns the
 * matching `toolCallId`. If no turn currently references the toolCallId, the
 * latest streaming turn for the same run is patched with a placeholder tool
 * segment; the next chat-content frame will reorder it.
 */
export function applyToolStatusUpdate(
  entries: SessionTimelineEntry[],
  update: SessionToolStatusUpdateIngressEvent,
): SessionTimelineEntry[] {
  if (!update.toolCallId || !update.toolName) {
    return entries;
  }
  let index = findAssistantTurnIndexByToolCallId(entries, update.toolCallId);
  if (index < 0 && update.runId) {
    index = findLatestAssistantTurnIndexForRun(entries, update.runId);
  }
  if (index < 0) {
    return entries;
  }
  const target = entries[index]!;
  if (target.kind !== 'assistant-turn') {
    return entries;
  }
  const identity = buildIdentityFromTurnEntry(target);
  const nextSegments = applyToolStatusToSegments(target.segments, identity, {
    toolCallId: update.toolCallId,
    name: update.toolName,
    status: update.status,
    ...(update.input !== undefined ? { input: update.input } : {}),
    ...(update.output !== undefined ? { output: update.output } : {}),
    ...(update.timestamp != null ? { updatedAt: update.timestamp } : {}),
  });
  if (nextSegments === target.segments) {
    return entries;
  }
  const nextTurn = buildAssistantTurnEntry({
    identity,
    status: target.status ?? 'streaming',
    text: target.text,
    ...(target.createdAt != null ? { createdAt: target.createdAt } : {}),
    ...(target.sequenceId != null ? { sequenceId: target.sequenceId } : {}),
    segments: nextSegments,
    isStreaming: target.isStreaming,
  });
  const next = cloneTimelineEntries(entries);
  next[index] = nextTurn;
  return next;
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
