import type {
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
} from '../../shared/session-adapter-types';
import { mergeToolCards } from './tool/tool-card-render';
import { rebuildAssistantSegmentsFromMergedEntry } from './assistant-turn-segments';

function isMessageEntry(entry: SessionTimelineEntry): entry is SessionTimelineMessageEntry {
  return entry.kind === 'message';
}

function isToolActivityEntry(entry: SessionTimelineEntry): entry is SessionTimelineToolActivityEntry {
  return entry.kind === 'tool-activity';
}

function isToolBearingEntry(entry: SessionTimelineEntry): entry is SessionTimelineMessageEntry | SessionTimelineToolActivityEntry {
  return isMessageEntry(entry) || isToolActivityEntry(entry);
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
  if (
    existing.status === 'streaming'
    && incoming.text
    && existing.text
    && existing.text.startsWith(incoming.text)
  ) {
    return existing.text;
  }
  return incoming.text || existing.text;
}

function shouldRemainToolActivity(entry: SessionTimelineMessageEntry): boolean {
  return (
    entry.role === 'assistant'
    && entry.toolUses.length > 0
    && entry.text.trim().length === 0
    && !entry.thinking
    && entry.images.length === 0
    && entry.attachedFiles.length === 0
  );
}

function mergeMessageEntry(
  existing: SessionTimelineEntry,
  incoming: SessionTimelineEntry,
  mergedBase: SessionTimelineEntry,
): SessionTimelineEntry {
  const existingMessage = isMessageEntry(existing) ? existing : null;
  const incomingMessage = isMessageEntry(incoming) ? incoming : null;
  const existingToolEntry = isToolBearingEntry(existing) ? existing : null;
  const incomingToolEntry = isToolBearingEntry(incoming) ? incoming : null;
  const mergedToolUses = mergeToolUses(existingToolEntry?.toolUses ?? [], incomingToolEntry?.toolUses ?? []);
  const mergedToolStatuses = mergeToolStatuses(existingToolEntry?.toolStatuses ?? [], incomingToolEntry?.toolStatuses ?? []);
  const mergedAttachedFiles = mergeAttachedFiles(
    existingMessage?.attachedFiles ?? [],
    incomingMessage?.attachedFiles ?? [],
  );
  const mergedToolCards = mergeToolCards({
    existingTools: existingToolEntry?.toolCards ?? [],
    toolUses: mergedToolUses,
    toolStatuses: mergedToolStatuses,
  });
  const mergedThinking = incomingMessage?.thinking ?? existingMessage?.thinking ?? null;
  const mergedImages = incomingMessage?.images?.length ? incomingMessage.images : (existingMessage?.images ?? []);
  const mergedMessageEntry: SessionTimelineMessageEntry = {
    ...mergedBase,
    kind: 'message',
    thinking: mergedThinking,
    assistantSegments: [],
    images: mergedImages,
    toolUses: mergedToolUses,
    attachedFiles: mergedAttachedFiles,
    toolStatuses: mergedToolStatuses,
    toolCards: mergedToolCards,
    isStreaming: incoming.status === 'streaming' || (incomingMessage?.isStreaming ?? false),
    messageId: incomingMessage?.messageId ?? existingMessage?.messageId,
    originMessageId: incomingMessage?.originMessageId ?? existingMessage?.originMessageId,
    clientId: incomingMessage?.clientId ?? existingMessage?.clientId,
  };
  mergedMessageEntry.assistantSegments = mergedMessageEntry.role === 'assistant'
    ? rebuildAssistantSegmentsFromMergedEntry({
        role: 'assistant',
        turnKey: mergedMessageEntry.turnKey ?? '',
        laneKey: mergedMessageEntry.laneKey ?? '',
        existingSegments: existingMessage?.assistantSegments ?? [],
        incomingSegments: incomingMessage?.assistantSegments ?? [],
        thinking: mergedMessageEntry.thinking,
        text: mergedMessageEntry.text,
        images: mergedMessageEntry.images,
        attachedFiles: mergedMessageEntry.attachedFiles,
        toolCards: mergedMessageEntry.toolCards,
      })
    : [];
  if (shouldRemainToolActivity(mergedMessageEntry)) {
    return {
      ...mergedBase,
      kind: 'tool-activity',
      role: 'assistant',
      assistantSegments: mergedMessageEntry.assistantSegments,
      toolUses: mergedMessageEntry.toolUses,
      toolStatuses: mergedMessageEntry.toolStatuses,
      toolCards: mergedMessageEntry.toolCards,
      attachedFiles: [],
      isStreaming: mergedMessageEntry.isStreaming,
    };
  }
  return mergedMessageEntry;
}

function mergeToolActivityEntry(
  existing: SessionTimelineEntry,
  incoming: SessionTimelineEntry,
  mergedBase: SessionTimelineEntry,
): SessionTimelineToolActivityEntry {
  const existingToolEntry = isToolBearingEntry(existing) ? existing : null;
  const incomingToolEntry = isToolBearingEntry(incoming) ? incoming : null;
  const mergedToolUses = mergeToolUses(existingToolEntry?.toolUses ?? [], incomingToolEntry?.toolUses ?? []);
  const mergedToolStatuses = mergeToolStatuses(existingToolEntry?.toolStatuses ?? [], incomingToolEntry?.toolStatuses ?? []);
  const mergedToolCards = mergeToolCards({
    existingTools: existingToolEntry?.toolCards ?? [],
    toolUses: mergedToolUses,
    toolStatuses: mergedToolStatuses,
  });
  const mergedAttachedFiles = mergeAttachedFiles(
    isToolActivityEntry(existing) ? existing.attachedFiles : [],
    isToolActivityEntry(incoming) ? incoming.attachedFiles : [],
  );
  return {
    ...mergedBase,
    kind: 'tool-activity',
    role: 'assistant',
    assistantSegments: rebuildAssistantSegmentsFromMergedEntry({
      role: 'assistant',
      turnKey: mergedBase.turnKey ?? '',
      laneKey: mergedBase.laneKey ?? '',
      existingSegments: isToolActivityEntry(existing) ? existing.assistantSegments : [],
      incomingSegments: isToolActivityEntry(incoming) ? incoming.assistantSegments : [],
      thinking: null,
      text: mergedBase.text,
      images: [],
      attachedFiles: mergedAttachedFiles,
      toolCards: mergedToolCards,
    }),
    toolUses: mergedToolUses,
    toolStatuses: mergedToolStatuses,
    toolCards: mergedToolCards,
    attachedFiles: mergedAttachedFiles,
    isStreaming: incoming.status === 'streaming' || (isToolActivityEntry(incoming) ? incoming.isStreaming : false),
  };
}

export function mergeTimelineEntry(
  existing: SessionTimelineEntry | null,
  incoming: SessionTimelineEntry,
): SessionTimelineEntry {
  if (!existing) {
    return structuredClone(incoming);
  }

  const mergedBase: SessionTimelineEntry = {
    ...structuredClone(existing),
    ...structuredClone(incoming),
    text: resolveMergedEntryText(existing, incoming),
    entryId: existing.entryId ?? incoming.entryId,
    laneKey: incoming.laneKey || existing.laneKey,
    turnKey: incoming.turnKey || existing.turnKey,
  };

  if (isMessageEntry(existing) || isMessageEntry(incoming)) {
    return mergeMessageEntry(existing, incoming, mergedBase);
  }

  if (existing.kind === 'task-completion' || incoming.kind === 'task-completion') {
    return structuredClone(incoming);
  }

  return mergeToolActivityEntry(existing, incoming, mergedBase);
}
