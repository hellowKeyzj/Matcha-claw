import type {
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
} from '../../shared/session-adapter-types';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneTimelineEntries(entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
  return structuredClone(entries);
}

function isMessageEntry(entry: SessionTimelineEntry): entry is SessionTimelineMessageEntry {
  return entry.kind === 'message';
}

function isToolActivityEntry(entry: SessionTimelineEntry): entry is SessionTimelineToolActivityEntry {
  return entry.kind === 'tool-activity';
}

function mergeAttachedFiles(
  existingFiles: ReadonlyArray<SessionTimelineMessageEntry['attachedFiles'][number]>,
  incomingFiles: ReadonlyArray<SessionTimelineMessageEntry['attachedFiles'][number]>,
): SessionTimelineMessageEntry['attachedFiles'] {
  const merged = existingFiles.map((file) => ({ ...file }));
  for (const file of incomingFiles) {
    const exists = merged.some((candidate) => (
      candidate.fileName === file.fileName
      && candidate.mimeType === file.mimeType
      && candidate.fileSize === file.fileSize
      && (candidate.preview ?? null) === (file.preview ?? null)
      && (candidate.filePath ?? null) === (file.filePath ?? null)
    ));
    if (!exists) {
      merged.push({ ...file });
    }
  }
  return merged;
}

function mergeToolStatuses(
  existingStatuses: ReadonlyArray<SessionTimelineMessageEntry['toolStatuses'][number]>,
  incomingStatuses: ReadonlyArray<SessionTimelineMessageEntry['toolStatuses'][number]>,
): SessionTimelineMessageEntry['toolStatuses'] {
  const merged = existingStatuses.map((status) => ({ ...status }));
  const indexByKey = new Map<string, number>();
  for (const [index, status] of merged.entries()) {
    indexByKey.set(status.toolCallId || status.id || `${status.name}:${index}`, index);
  }
  for (const status of incomingStatuses) {
    const key = status.toolCallId || status.id || status.name;
    if (!key || !indexByKey.has(key)) {
      indexByKey.set(key || `incoming:${merged.length}`, merged.length);
      merged.push({ ...status });
      continue;
    }
    const index = indexByKey.get(key)!;
    const existing = merged[index]!;
    const shouldPreserveExistingName = (
      Boolean(existing.name)
      && (
        status.name === status.toolCallId
        || status.name === status.id
      )
    );
    merged[index] = {
      ...existing,
      ...status,
      ...(shouldPreserveExistingName ? { name: existing.name } : {}),
    };
  }
  return merged;
}

function mergeToolUses(
  existingUses: ReadonlyArray<SessionTimelineMessageEntry['toolUses'][number]>,
  incomingUses: ReadonlyArray<SessionTimelineMessageEntry['toolUses'][number]>,
): SessionTimelineMessageEntry['toolUses'] {
  if (incomingUses.length === 0) {
    return existingUses.map((tool) => ({ ...tool }));
  }
  const merged = existingUses.map((tool) => ({ ...tool }));
  const indexByKey = new Map<string, number>();
  for (const [index, tool] of merged.entries()) {
    indexByKey.set(tool.id || `${tool.name}:${index}`, index);
  }
  for (const tool of incomingUses) {
    const key = tool.id || tool.name;
    if (!key || !indexByKey.has(key)) {
      indexByKey.set(key || `incoming:${merged.length}`, merged.length);
      merged.push({ ...tool });
      continue;
    }
    const index = indexByKey.get(key)!;
    merged[index] = {
      ...merged[index],
      ...tool,
    };
  }
  return merged;
}

function appendMonotonicText(currentText: string, incomingText: string): string {
  if (!incomingText) {
    return currentText;
  }
  if (!currentText) {
    return incomingText;
  }
  if (incomingText.startsWith(currentText)) {
    return incomingText;
  }
  if (currentText.startsWith(incomingText)) {
    return currentText;
  }

  const maxOverlap = Math.min(currentText.length, incomingText.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (currentText.endsWith(incomingText.slice(0, size))) {
      return `${currentText}${incomingText.slice(size)}`;
    }
  }

  return `${currentText}${incomingText}`;
}

function resolveMergedEntryText(
  existing: SessionTimelineEntry | null,
  incoming: SessionTimelineEntry,
): string {
  if (!existing) {
    return incoming.text;
  }
  if (incoming.status === 'streaming') {
    return appendMonotonicText(existing.text, incoming.text);
  }
  return incoming.text || existing.text;
}

function mergeTimelineEntry(
  existing: SessionTimelineEntry | null,
  incoming: SessionTimelineEntry,
): SessionTimelineEntry {
  if (!existing) {
    return structuredClone(incoming);
  }

  const mergedBase = {
    ...structuredClone(existing),
    ...structuredClone(incoming),
    text: resolveMergedEntryText(existing, incoming),
    entryId: existing.entryId ?? incoming.entryId,
    laneKey: incoming.laneKey || existing.laneKey,
    turnKey: incoming.turnKey || existing.turnKey,
  };

  if (isMessageEntry(existing) || isMessageEntry(incoming)) {
    const existingMessage = isMessageEntry(existing) ? existing : null;
    const incomingMessage = isMessageEntry(incoming) ? incoming : null;
    const mergedMessageEntry: SessionTimelineMessageEntry = {
      ...mergedBase,
      kind: 'message',
      thinking: incomingMessage?.thinking ?? existingMessage?.thinking ?? null,
      images: incomingMessage?.images?.length ? incomingMessage.images : (existingMessage?.images ?? []),
      toolUses: mergeToolUses(existing.toolUses ?? [], incoming.toolUses ?? []),
      attachedFiles: mergeAttachedFiles(
        existingMessage?.attachedFiles ?? [],
        incomingMessage?.attachedFiles ?? [],
      ),
      toolStatuses: mergeToolStatuses(existing.toolStatuses ?? [], incoming.toolStatuses ?? []),
      isStreaming: incoming.status === 'streaming' || (incomingMessage?.isStreaming ?? false),
      messageId: incomingMessage?.messageId ?? existingMessage?.messageId,
      originMessageId: incomingMessage?.originMessageId ?? existingMessage?.originMessageId,
      clientId: incomingMessage?.clientId ?? existingMessage?.clientId,
      uniqueId: incomingMessage?.uniqueId ?? existingMessage?.uniqueId,
      requestId: incomingMessage?.requestId ?? existingMessage?.requestId,
    };
    const shouldRemainToolActivity = (
      mergedMessageEntry.role === 'assistant'
      && mergedMessageEntry.toolUses.length > 0
      && mergedMessageEntry.text.trim().length === 0
      && !mergedMessageEntry.thinking
      && mergedMessageEntry.images.length === 0
      && mergedMessageEntry.attachedFiles.length === 0
    );
    if (shouldRemainToolActivity) {
      return {
        ...mergedBase,
        kind: 'tool-activity',
        role: 'assistant',
        toolUses: mergedMessageEntry.toolUses,
        toolStatuses: mergedMessageEntry.toolStatuses,
        attachedFiles: [],
        isStreaming: mergedMessageEntry.isStreaming,
      };
    }
    return mergedMessageEntry;
  }

  if (existing.kind === 'task-completion' || incoming.kind === 'task-completion') {
    return structuredClone(incoming);
  }

  return {
      ...mergedBase,
      kind: 'tool-activity',
      role: 'assistant',
    toolUses: mergeToolUses(existing.toolUses ?? [], incoming.toolUses ?? []),
    toolStatuses: mergeToolStatuses(existing.toolStatuses ?? [], incoming.toolStatuses ?? []),
    attachedFiles: mergeAttachedFiles(
      isToolActivityEntry(existing) ? existing.attachedFiles : [],
      isToolActivityEntry(incoming) ? incoming.attachedFiles : [],
    ),
    isStreaming: incoming.status === 'streaming' || (isToolActivityEntry(incoming) ? incoming.isStreaming : false),
  };
}

export function findTimelineEntryIndex(
  entries: SessionTimelineEntry[],
  incoming: SessionTimelineEntry,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.key === incoming.key) {
      return index;
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const candidate = entries[index]!;
    const shouldAllowFallbackMerge = (
      candidate.entryId === incoming.entryId
      || candidate.status === 'streaming'
      || incoming.status === 'streaming'
    );
    if (!shouldAllowFallbackMerge || candidate.kind !== incoming.kind) {
      continue;
    }
    if (
      candidate.role === incoming.role
      && (candidate.runId ?? null) === (incoming.runId ?? null)
      && (candidate.sequenceId ?? null) === (incoming.sequenceId ?? null)
      && candidate.laneKey === incoming.laneKey
      && candidate.turnKey === incoming.turnKey
    ) {
      return index;
    }
  }

  return -1;
}

export function upsertTimelineEntry(
  entries: SessionTimelineEntry[],
  incoming: SessionTimelineEntry,
): SessionTimelineEntry[] {
  const index = findTimelineEntryIndex(entries, incoming);
  const resolveInsertionIndex = (
    candidates: SessionTimelineEntry[],
    entry: SessionTimelineEntry,
    fallbackIndex: number,
  ): number => {
    const runId = normalizeString(entry.runId);
    const sequenceId = entry.sequenceId;
    if (!runId || sequenceId == null) {
      return fallbackIndex;
    }

    let lastSameRunIndex = -1;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex]!;
      if (normalizeString(candidate.runId) !== runId) {
        continue;
      }
      const candidateSequenceId = candidate.sequenceId;
      if (candidateSequenceId == null) {
        continue;
      }
      if (candidateSequenceId > sequenceId) {
        return candidateIndex;
      }
      lastSameRunIndex = candidateIndex;
    }

    if (lastSameRunIndex >= 0) {
      return lastSameRunIndex + 1;
    }
    return fallbackIndex;
  };

  if (index < 0) {
    const nextEntries = cloneTimelineEntries(entries);
    const insertionIndex = resolveInsertionIndex(nextEntries, incoming, nextEntries.length);
    nextEntries.splice(insertionIndex, 0, structuredClone(incoming));
    return nextEntries;
  }

  const mergedEntry = mergeTimelineEntry(entries[index]!, incoming);
  const nextEntries = cloneTimelineEntries(entries);
  nextEntries.splice(index, 1);
  const insertionIndex = resolveInsertionIndex(nextEntries, mergedEntry, Math.min(index, nextEntries.length));
  nextEntries.splice(insertionIndex, 0, mergedEntry);
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
