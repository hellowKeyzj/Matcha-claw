import type {
  SessionMessageRow,
  SessionRenderRow,
  SessionRuntimeStateSnapshot,
  SessionToolActivityRow,
} from '../../shared/session-adapter-types';

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneRows(rows: SessionRenderRow[]): SessionRenderRow[] {
  return structuredClone(rows);
}

function isMessageRow(row: SessionRenderRow): row is SessionMessageRow {
  return row.kind === 'message';
}

function isToolActivityRow(row: SessionRenderRow): row is SessionToolActivityRow {
  return row.kind === 'tool-activity';
}

function mergeAttachedFiles(
  existingFiles: ReadonlyArray<SessionMessageRow['attachedFiles'][number]>,
  incomingFiles: ReadonlyArray<SessionMessageRow['attachedFiles'][number]>,
): SessionMessageRow['attachedFiles'] {
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
  existingStatuses: ReadonlyArray<SessionMessageRow['toolStatuses'][number]>,
  incomingStatuses: ReadonlyArray<SessionMessageRow['toolStatuses'][number]>,
): SessionMessageRow['toolStatuses'] {
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
  existingUses: ReadonlyArray<SessionMessageRow['toolUses'][number]>,
  incomingUses: ReadonlyArray<SessionMessageRow['toolUses'][number]>,
): SessionMessageRow['toolUses'] {
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

function resolveMergedRowText(
  existing: SessionRenderRow | null,
  incoming: SessionRenderRow,
): string {
  if (!existing) {
    return incoming.text;
  }
  if (incoming.status === 'streaming') {
    return appendMonotonicText(existing.text, incoming.text);
  }
  return incoming.text || existing.text;
}

function mergeRow(
  existing: SessionRenderRow | null,
  incoming: SessionRenderRow,
): SessionRenderRow {
  if (!existing) {
    return structuredClone(incoming);
  }

  const mergedBase = {
    ...structuredClone(existing),
    ...structuredClone(incoming),
    text: resolveMergedRowText(existing, incoming),
    rowId: existing.rowId ?? incoming.rowId,
    laneKey: incoming.laneKey || existing.laneKey,
    turnKey: incoming.turnKey || existing.turnKey,
  };

  if (isMessageRow(existing) || isMessageRow(incoming)) {
    const existingMessage = isMessageRow(existing) ? existing : null;
    const incomingMessage = isMessageRow(incoming) ? incoming : null;
    const mergedMessageRow: SessionMessageRow = {
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
      mergedMessageRow.role === 'assistant'
      && mergedMessageRow.toolUses.length > 0
      && mergedMessageRow.text.trim().length === 0
      && !mergedMessageRow.thinking
      && mergedMessageRow.images.length === 0
      && mergedMessageRow.attachedFiles.length === 0
    );
    if (shouldRemainToolActivity) {
      return {
        ...mergedBase,
        kind: 'tool-activity',
        role: 'assistant',
        toolUses: mergedMessageRow.toolUses,
        toolStatuses: mergedMessageRow.toolStatuses,
        attachedFiles: [],
        isStreaming: mergedMessageRow.isStreaming,
      };
    }
    return mergedMessageRow;
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
      isToolActivityRow(existing) ? existing.attachedFiles : [],
      isToolActivityRow(incoming) ? incoming.attachedFiles : [],
    ),
    isStreaming: incoming.status === 'streaming' || (isToolActivityRow(incoming) ? incoming.isStreaming : false),
  };
}

export function findRowIndex(
  rows: SessionRenderRow[],
  incoming: SessionRenderRow,
): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]!.key === incoming.key) {
      return index;
    }
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = rows[index]!;
    const shouldAllowFallbackMerge = (
      candidate.rowId === incoming.rowId
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

export function upsertRow(
  rows: SessionRenderRow[],
  incoming: SessionRenderRow,
): SessionRenderRow[] {
  const index = findRowIndex(rows, incoming);
  const resolveInsertionIndex = (
    candidates: SessionRenderRow[],
    row: SessionRenderRow,
    fallbackIndex: number,
  ): number => {
    const runId = normalizeString(row.runId);
    const sequenceId = row.sequenceId;
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
    const nextRows = cloneRows(rows);
    const insertionIndex = resolveInsertionIndex(nextRows, incoming, nextRows.length);
    nextRows.splice(insertionIndex, 0, structuredClone(incoming));
    return nextRows;
  }

  const mergedRow = mergeRow(rows[index]!, incoming);
  const nextRows = cloneRows(rows);
  nextRows.splice(index, 1);
  const insertionIndex = resolveInsertionIndex(nextRows, mergedRow, Math.min(index, nextRows.length));
  nextRows.splice(insertionIndex, 0, mergedRow);
  return nextRows;
}

export function mergeRows(
  transcriptRows: SessionRenderRow[],
  overlayRows: SessionRenderRow[],
): SessionRenderRow[] {
  let mergedRows = cloneRows(transcriptRows);
  for (const row of overlayRows) {
    mergedRows = upsertRow(mergedRows, row);
  }
  return mergedRows;
}

export function resolveLastActivityAt(
  rows: SessionRenderRow[],
  runtime: SessionRuntimeStateSnapshot,
): number | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const timestamp = rows[index]?.createdAt;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return typeof runtime.updatedAt === 'number' && Number.isFinite(runtime.updatedAt)
    ? runtime.updatedAt
    : undefined;
}
