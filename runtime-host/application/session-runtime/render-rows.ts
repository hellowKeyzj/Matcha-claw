import type {
  SessionExecutionGraph,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderRow,
  SessionRenderToolStatus,
  SessionRenderToolUse,
  SessionRuntimeStateSnapshot,
  SessionTaskCompletionEvent,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';

interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  data?: unknown;
  mimeType?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
  content?: unknown;
}

interface AssistantTurnLaneState {
  laneKey: string;
  turnKey: string;
  agentId: string | null;
  entry: SessionTimelineEntry;
  toolStatuses: SessionRenderToolStatus[];
}

interface AssistantTurnSnapshot {
  turnKey: string;
  lanes: AssistantTurnLaneState[];
  latestEntry: SessionTimelineEntry;
  latestStreamingEntry: SessionTimelineEntry | null;
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readMessageContent(entry: SessionTimelineEntry): unknown {
  return entry.message.content;
}

function extractThinking(entry: SessionTimelineEntry): string | null {
  const content = readMessageContent(entry);
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type !== 'thinking' || typeof block.thinking !== 'string') {
      continue;
    }
    const cleaned = block.thinking.trim();
    if (cleaned) {
      parts.push(cleaned);
    }
  }
  const combined = parts.join('\n\n').trim();
  return combined || null;
}

function extractImages(entry: SessionTimelineEntry): SessionRenderImage[] {
  const content = readMessageContent(entry);
  if (!Array.isArray(content)) {
    return [];
  }
  const images: SessionRenderImage[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type !== 'image') {
      continue;
    }
    if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
      images.push({
        mimeType: block.source.media_type,
        data: block.source.data,
      });
      continue;
    }
    if (block.source?.type === 'url' && typeof block.source.url === 'string') {
      images.push({
        mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
        url: block.source.url,
      });
      continue;
    }
    if (typeof block.data === 'string') {
      images.push({
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
        data: block.data,
      });
    }
  }
  return images;
}

function extractToolUses(entry: SessionTimelineEntry): SessionRenderToolUse[] {
  const content = readMessageContent(entry);
  const tools: SessionRenderToolUse[] = [];
  if (Array.isArray(content)) {
    for (const block of content as ContentBlockLike[]) {
      const type = typeof block.type === 'string' ? block.type : '';
      const name = typeof block.name === 'string' ? block.name.trim() : '';
      if (!name || (type !== 'tool_use' && type !== 'toolCall')) {
        continue;
      }
      tools.push({
        id: typeof block.id === 'string' && block.id.trim() ? block.id : name,
        name,
        input: block.input ?? block.arguments,
      });
    }
  }

  if (tools.length > 0) {
    return tools;
  }

  const toolCalls = entry.message.tool_calls ?? entry.message.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return [];
  }
  return toolCalls.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : '';
    const fn = (row.function ?? row) as Record<string, unknown>;
    const name = typeof fn.name === 'string' ? fn.name.trim() : '';
    if (!name) {
      return [];
    }
    let input: unknown = fn.input ?? fn.arguments;
    if (typeof input === 'string') {
      try {
        input = JSON.parse(input);
      } catch {
        // keep raw string
      }
    }
    return [{
      id: id || name,
      name,
      input,
    }];
  });
}

function readAttachedFiles(entry: SessionTimelineEntry): SessionRenderAttachedFile[] {
  const attachedFiles = entry.message._attachedFiles;
  if (!Array.isArray(attachedFiles)) {
    return [];
  }
  return attachedFiles.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const fileName = typeof row.fileName === 'string' ? row.fileName : 'file';
    const mimeType = typeof row.mimeType === 'string' ? row.mimeType : 'application/octet-stream';
    const fileSize = typeof row.fileSize === 'number' && Number.isFinite(row.fileSize) ? row.fileSize : 0;
    const preview = typeof row.preview === 'string' ? row.preview : null;
    const filePath = typeof row.filePath === 'string' && row.filePath.trim() ? row.filePath : undefined;
    return [{
      fileName,
      mimeType,
      fileSize,
      preview,
      ...(filePath ? { filePath } : {}),
    }];
  });
}

function readToolStatuses(entry: SessionTimelineEntry): SessionRenderToolStatus[] {
  const toolStatuses = entry.message.toolStatuses;
  if (!Array.isArray(toolStatuses)) {
    return [];
  }
  return toolStatuses.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as Record<string, unknown>;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const status = row.status === 'running' || row.status === 'completed' || row.status === 'error'
      ? row.status
      : null;
    if (!name || !status) {
      return [];
    }
    const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : undefined;
    const toolCallId = typeof row.toolCallId === 'string' && row.toolCallId.trim() ? row.toolCallId.trim() : undefined;
    const summary = typeof row.summary === 'string' && row.summary.trim() ? row.summary.trim() : undefined;
    const durationMs = typeof row.durationMs === 'number' && Number.isFinite(row.durationMs) ? row.durationMs : undefined;
    const updatedAt = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : undefined;
    return [{
      ...(id ? { id } : {}),
      ...(toolCallId ? { toolCallId } : {}),
      name,
      status,
      ...(summary ? { summary } : {}),
      ...(durationMs != null ? { durationMs } : {}),
      ...(updatedAt != null ? { updatedAt } : {}),
    }];
  });
}

function readMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const regex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    refs.push({ filePath: match[1], mimeType: match[2] });
  }
  return refs;
}

function extractImagesAsAttachedFiles(content: unknown): SessionRenderAttachedFile[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const files: SessionRenderAttachedFile[] = [];
  for (const block of content as ContentBlockLike[]) {
    if (block.type === 'image') {
      if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
        files.push({
          fileName: 'image',
          mimeType: block.source.media_type,
          fileSize: 0,
          preview: `data:${block.source.media_type};base64,${block.source.data}`,
        });
      } else if (block.source?.type === 'url' && typeof block.source.url === 'string') {
        files.push({
          fileName: 'image',
          mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
          fileSize: 0,
          preview: block.source.url,
        });
      } else if (typeof block.data === 'string') {
        const mimeType = typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
        });
      }
    }
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content !== undefined) {
      files.push(...extractImagesAsAttachedFiles(block.content));
    }
  }
  return files;
}

function collectToolCallPaths(entry: SessionTimelineEntry, paths: Map<string, string>): void {
  const content = readMessageContent(entry);
  if (Array.isArray(content)) {
    for (const block of content as ContentBlockLike[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && typeof block.id === 'string' && block.id.trim()) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        const filePath = typeof args?.file_path === 'string'
          ? args.file_path
          : typeof args?.filePath === 'string'
            ? args.filePath
            : typeof args?.path === 'string'
              ? args.path
              : typeof args?.file === 'string'
                ? args.file
                : null;
        if (filePath) {
          paths.set(block.id.trim(), filePath);
        }
      }
    }
  }

  const toolCalls = entry.message.tool_calls ?? entry.message.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return;
  }
  for (const item of toolCalls as Array<Record<string, unknown>>) {
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
      continue;
    }
    const fn = (item.function ?? item) as Record<string, unknown>;
    let args: Record<string, unknown> | undefined;
    try {
      args = typeof fn.arguments === 'string'
        ? JSON.parse(fn.arguments)
        : (fn.arguments ?? fn.input) as Record<string, unknown>;
    } catch {
      args = undefined;
    }
    const filePath = typeof args?.file_path === 'string'
      ? args.file_path
      : typeof args?.filePath === 'string'
        ? args.filePath
        : typeof args?.path === 'string'
          ? args.path
          : typeof args?.file === 'string'
            ? args.file
            : null;
    if (filePath) {
      paths.set(id, filePath);
    }
  }
}

function readEntryText(entry: SessionTimelineEntry): string {
  return typeof entry.text === 'string' ? entry.text : '';
}

function cloneAttachedFiles(files: SessionRenderAttachedFile[]): Array<Record<string, unknown>> {
  return files.map((file) => ({ ...file }));
}

function enrichEntriesWithAttachedFiles(entries: SessionTimelineEntry[]): SessionTimelineEntry[] {
  const pending: SessionRenderAttachedFile[] = [];
  const toolCallPaths = new Map<string, string>();
  let changed = false;
  const nextEntries = entries.map((entry) => {
    if (entry.role === 'assistant') {
      collectToolCallPaths(entry, toolCallPaths);
    }

    if (entry.role === 'tool_result' || entry.role === 'toolresult') {
      const matchedPath = entry.message.toolCallId ? toolCallPaths.get(entry.message.toolCallId) : undefined;
      const imageFiles = extractImagesAsAttachedFiles(entry.message.content);
      if (matchedPath) {
        for (const file of imageFiles) {
          if (!file.filePath) {
            file.filePath = matchedPath;
            file.fileName = matchedPath.split(/[\\/]/).pop() || 'image';
          }
        }
      }
      pending.push(...imageFiles);
      const text = readEntryText(entry);
      if (text) {
        for (const ref of readMediaRefs(text)) {
          pending.push({
            fileName: ref.filePath.split(/[\\/]/).pop() || 'file',
            mimeType: ref.mimeType,
            fileSize: 0,
            preview: null,
            filePath: ref.filePath,
          });
        }
      }
      return entry;
    }

    if (entry.role === 'assistant' && pending.length > 0) {
      const toAttach = pending.splice(0);
      const existingFiles = readAttachedFiles(entry);
      const existingPaths = new Set(existingFiles.map((file) => file.filePath).filter(Boolean));
      const newFiles = toAttach.filter((file) => !file.filePath || !existingPaths.has(file.filePath));
      if (newFiles.length === 0) {
        return entry;
      }
      changed = true;
      return {
        ...entry,
        message: {
          ...entry.message,
          _attachedFiles: cloneAttachedFiles([...existingFiles, ...newFiles]),
        },
      };
    }

    return entry;
  });
  return changed ? nextEntries : entries;
}

function resolveRenderableRole(entry: SessionTimelineEntry): 'user' | 'assistant' | 'system' {
  return entry.role === 'user' || entry.role === 'system' ? entry.role : 'assistant';
}

function buildMessageRow(sessionKey: string, entry: SessionTimelineEntry): SessionRenderRow {
  const role = resolveRenderableRole(entry);
  const text = readEntryText(entry);
  const thinking = extractThinking(entry);
  const images = extractImages(entry);
  const toolUses = extractToolUses(entry);
  const attachedFiles = readAttachedFiles(entry);
  const toolStatuses = readToolStatuses(entry);
  const isStreaming = entry.status === 'streaming' || Boolean(entry.message.streaming);
  const resolvedAgentId = entry.agentId ?? (normalizeIdentifier(entry.message.agentId) || undefined);
  const base = {
    key: `session:${sessionKey}|entry:${entry.entryId}`,
    sessionKey,
    role,
    text,
    createdAt: entry.timestamp,
    status: entry.status,
    runId: entry.runId,
    entryId: entry.entryId,
    laneKey: entry.laneKey,
    turnKey: entry.turnKey,
    agentId: resolvedAgentId,
    assistantTurnKey: role === 'assistant' ? entry.turnKey : null,
    assistantLaneKey: role === 'assistant' ? entry.laneKey : null,
    assistantLaneAgentId: role === 'assistant' ? (resolvedAgentId ?? null) : null,
  } as const;

  const isToolActivity = (
    role === 'assistant'
    && toolUses.length > 0
    && text.trim().length === 0
    && !thinking
    && images.length === 0
    && attachedFiles.length === 0
  );

  if (isToolActivity) {
    return {
      ...base,
      kind: 'tool-activity',
      role: 'assistant',
      toolUses,
      toolStatuses,
      isStreaming,
    };
  }

  return {
    ...base,
    kind: 'message',
    thinking,
    images,
    toolUses,
    attachedFiles,
    toolStatuses,
    isStreaming,
    messageId: normalizeIdentifier(entry.message.id) || entry.entryId,
  };
}

function buildTaskCompletionText(event: SessionTaskCompletionEvent): string {
  return [
    event.taskLabel,
    event.statusLabel,
    event.result,
  ].filter((value) => typeof value === 'string' && value.trim()).join(' · ');
}

function buildTaskCompletionRows(sessionKey: string, entry: SessionTimelineEntry): SessionRenderRow[] {
  const events = Array.isArray(entry.message.taskCompletionEvents)
    ? entry.message.taskCompletionEvents
    : [];
  return events.map((event, index) => ({
    key: `session:${sessionKey}|completion:${entry.entryId}:${index}`,
    kind: 'task-completion',
    sessionKey,
    role: 'system',
    text: buildTaskCompletionText(event),
    createdAt: entry.timestamp,
    status: 'final',
    runId: entry.runId,
    entryId: entry.entryId,
    childSessionKey: event.childSessionKey,
    ...(event.childSessionId ? { childSessionId: event.childSessionId } : {}),
    ...(event.childAgentId ? { childAgentId: event.childAgentId } : {}),
    ...(event.taskLabel ? { taskLabel: event.taskLabel } : {}),
    ...(event.statusLabel ? { statusLabel: event.statusLabel } : {}),
    ...(event.result ? { result: event.result } : {}),
    ...(event.statsLine ? { statsLine: event.statsLine } : {}),
    ...(event.replyInstruction ? { replyInstruction: event.replyInstruction } : {}),
  }));
}

function findCurrentStreamingTurn(entries: SessionTimelineEntry[], streamingMessageId: string | null | undefined): SessionTimelineEntry | null {
  const normalizedStreamingMessageId = normalizeIdentifier(streamingMessageId);
  if (normalizedStreamingMessageId) {
    const matched = entries.find((entry) => entry.entryId === normalizedStreamingMessageId);
    if (matched) {
      return matched;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role === 'assistant' && entry.status === 'streaming') {
      return entry;
    }
  }
  return null;
}

function collectAssistantTurns(entries: SessionTimelineEntry[]): AssistantTurnSnapshot[] {
  interface MutableTurn {
    turnKey: string;
    latestEntry: SessionTimelineEntry;
    latestStreamingEntry: SessionTimelineEntry | null;
    lanesByKey: Map<string, AssistantTurnLaneState>;
  }

  const turns: MutableTurn[] = [];
  const turnIndexByKey = new Map<string, number>();
  for (const entry of entries) {
    if (entry.role !== 'assistant') {
      continue;
    }
    const turnKey = normalizeIdentifier(entry.turnKey);
    const laneKey = normalizeIdentifier(entry.laneKey);
    if (!turnKey || !laneKey) {
      continue;
    }

    let turn = (() => {
      const existingIndex = turnIndexByKey.get(turnKey);
      return existingIndex != null ? turns[existingIndex] : undefined;
    })();
    if (!turn) {
      turn = {
        turnKey,
        latestEntry: entry,
        latestStreamingEntry: entry.status === 'streaming' ? entry : null,
        lanesByKey: new Map<string, AssistantTurnLaneState>(),
      };
      turnIndexByKey.set(turnKey, turns.length);
      turns.push(turn);
    }

    turn.latestEntry = entry;
    if (entry.status === 'streaming') {
      turn.latestStreamingEntry = entry;
    }
    turn.lanesByKey.set(laneKey, {
      laneKey,
      turnKey,
      agentId: normalizeIdentifier(entry.agentId ?? entry.message.agentId) || null,
      entry,
      toolStatuses: readToolStatuses(entry),
    });
  }

  return turns.map((turn) => ({
    turnKey: turn.turnKey,
    lanes: Array.from(turn.lanesByKey.values()),
    latestEntry: turn.latestEntry,
    latestStreamingEntry: turn.latestStreamingEntry,
  }));
}

function buildPendingAssistantRows(input: {
  sessionKey: string;
  entries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
}): SessionRenderRow[] {
  if (!input.runtime.sending) {
    return [];
  }
  const turns = collectAssistantTurns(input.entries);
  const currentStreamingTurn = findCurrentStreamingTurn(input.entries, input.runtime.streamingMessageId);
  const activeTurnKey = currentStreamingTurn ? normalizeIdentifier(currentStreamingTurn.turnKey) : (turns[turns.length - 1]?.turnKey ?? '');
  const activeTurn = activeTurnKey ? turns.find((turn) => turn.turnKey === activeTurnKey) ?? null : null;
  const activeLanes = activeTurn?.lanes ?? [];
  const activityRows = activeLanes
    .filter((lane) => lane.entry.status !== 'streaming')
    .filter((lane) => input.runtime.pendingFinal || lane.toolStatuses.length > 0)
    .map((lane) => ({
      key: `session:${input.sessionKey}|pending:${lane.turnKey}:${lane.laneKey}`,
      kind: 'pending-assistant' as const,
      sessionKey: input.sessionKey,
      role: 'assistant' as const,
      text: '',
      createdAt: lane.entry.timestamp,
      status: 'pending' as const,
      runId: lane.entry.runId,
      laneKey: lane.laneKey,
      turnKey: lane.turnKey,
      agentId: lane.agentId ?? undefined,
      assistantTurnKey: lane.turnKey,
      assistantLaneKey: lane.laneKey,
      assistantLaneAgentId: lane.agentId,
      pendingState: 'activity' as const,
    }));
  if (activityRows.length > 0) {
    return activityRows;
  }
  if (activeTurn?.lanes.some((lane) => lane.entry.status === 'streaming')) {
    return [];
  }
  const fallbackEntry = activeTurn?.latestEntry ?? input.entries.filter((entry) => entry.role === 'assistant').at(-1) ?? null;
  return [{
    key: `session:${input.sessionKey}|pending:default`,
    kind: 'pending-assistant',
    sessionKey: input.sessionKey,
    role: 'assistant',
    text: '',
    createdAt: fallbackEntry?.timestamp,
    status: 'pending',
    runId: fallbackEntry?.runId,
    laneKey: fallbackEntry?.laneKey,
    turnKey: fallbackEntry?.turnKey,
    agentId: fallbackEntry?.agentId,
    assistantTurnKey: fallbackEntry?.turnKey ?? null,
    assistantLaneKey: fallbackEntry?.laneKey ?? null,
    assistantLaneAgentId: fallbackEntry?.agentId ?? null,
    pendingState: input.runtime.pendingFinal ? 'activity' : 'typing',
  }];
}

export function buildSessionRenderRows(input: {
  sessionKey: string;
  entries: SessionTimelineEntry[];
  executionGraphs: SessionExecutionGraph[];
  runtime: SessionRuntimeStateSnapshot;
}): SessionRenderRow[] {
  const enrichedEntries = enrichEntriesWithAttachedFiles(input.entries);
  const baseRows: SessionRenderRow[] = [];
  const rowKeyByEntryId = new Map<string, string>();

  for (const entry of enrichedEntries) {
    if (entry.role === 'toolresult' || entry.role === 'tool_result') {
      continue;
    }
    const row = buildMessageRow(input.sessionKey, entry);
    baseRows.push(row);
    if (entry.entryId) {
      rowKeyByEntryId.set(entry.entryId, row.key);
    }
    const completionRows = buildTaskCompletionRows(input.sessionKey, entry);
    if (completionRows.length > 0) {
      baseRows.push(...completionRows);
    }
  }

  if (input.executionGraphs.length === 0) {
    return [...baseRows, ...buildPendingAssistantRows({
      sessionKey: input.sessionKey,
      entries: enrichedEntries,
      runtime: input.runtime,
    })];
  }

  const graphsByAnchorEntryId = new Map<string, SessionExecutionGraph[]>();
  const fallbackGraphs: SessionExecutionGraph[] = [];
  for (const graph of input.executionGraphs) {
    if (rowKeyByEntryId.has(graph.anchorEntryId)) {
      const current = graphsByAnchorEntryId.get(graph.anchorEntryId);
      if (current) {
        current.push(graph);
      } else {
        graphsByAnchorEntryId.set(graph.anchorEntryId, [graph]);
      }
      continue;
    }
    fallbackGraphs.push(graph);
  }

  const rows: SessionRenderRow[] = [];
  for (const row of baseRows) {
    rows.push(row);
    if (!row.entryId) {
      continue;
    }
    const graphs = graphsByAnchorEntryId.get(row.entryId);
    if (!graphs || graphs.length === 0) {
      continue;
    }
    for (const graph of graphs) {
      rows.push({
        key: `session:${input.sessionKey}|graph:${graph.id}`,
        kind: 'execution-graph',
        sessionKey: input.sessionKey,
        role: 'assistant',
        text: '',
        createdAt: row.createdAt,
        status: 'final',
        agentId: graph.childAgentId,
        assistantTurnKey: row.assistantTurnKey ?? null,
        assistantLaneKey: row.assistantLaneKey ?? null,
        assistantLaneAgentId: row.assistantLaneAgentId ?? null,
        graphId: graph.id,
        childSessionKey: graph.childSessionKey,
        ...(graph.childSessionId ? { childSessionId: graph.childSessionId } : {}),
        ...(graph.childAgentId ? { childAgentId: graph.childAgentId } : {}),
        agentLabel: graph.agentLabel,
        sessionLabel: graph.sessionLabel,
        steps: graph.steps,
        active: graph.active,
        ...(rowKeyByEntryId.get(graph.triggerEntryId) ? { triggerRowKey: rowKeyByEntryId.get(graph.triggerEntryId) } : {}),
        ...(graph.replyEntryId && rowKeyByEntryId.get(graph.replyEntryId) ? { replyRowKey: rowKeyByEntryId.get(graph.replyEntryId) } : {}),
      });
    }
  }

  for (const graph of fallbackGraphs) {
    rows.push({
      key: `session:${input.sessionKey}|graph:${graph.id}`,
      kind: 'execution-graph',
      sessionKey: input.sessionKey,
      role: 'assistant',
      text: '',
      status: 'final',
      agentId: graph.childAgentId,
      assistantTurnKey: null,
      assistantLaneKey: null,
      assistantLaneAgentId: null,
      graphId: graph.id,
      childSessionKey: graph.childSessionKey,
      ...(graph.childSessionId ? { childSessionId: graph.childSessionId } : {}),
      ...(graph.childAgentId ? { childAgentId: graph.childAgentId } : {}),
      agentLabel: graph.agentLabel,
      sessionLabel: graph.sessionLabel,
      steps: graph.steps,
      active: graph.active,
      ...(rowKeyByEntryId.get(graph.triggerEntryId) ? { triggerRowKey: rowKeyByEntryId.get(graph.triggerEntryId) } : {}),
      ...(graph.replyEntryId && rowKeyByEntryId.get(graph.replyEntryId) ? { replyRowKey: rowKeyByEntryId.get(graph.replyEntryId) } : {}),
    });
  }

  return [
    ...rows,
    ...buildPendingAssistantRows({
      sessionKey: input.sessionKey,
      entries: enrichedEntries,
      runtime: input.runtime,
    }),
  ];
}
