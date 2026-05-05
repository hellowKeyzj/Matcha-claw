import type {
  SessionAssistantTurnItem,
  SessionAssistantTurnSegment,
  SessionRenderAssistantBubbleToolResult,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
  SessionRuntimeStateSnapshot,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
} from '../../shared/session-adapter-types';

interface AssistantTurnAccumulator {
  key: string;
  turnKey: string;
  laneKey: string;
  sessionKey: string;
  agentId?: string;
  createdAt?: number;
  updatedAt?: number;
  runId?: string;
  latestTimelineKey: string;
  latestTimelineEntryId?: string;
  latestTimelineMessageId?: string;
  identitySource: SessionTurnBindingSource;
  identityMode: SessionTurnIdentityMode;
  identityConfidence: SessionTurnIdentityConfidence;
  lastStatus?: SessionTimelineEntry['status'];
  segments: SessionAssistantTurnSegment[];
}

export interface AssistantTurnAssembly {
  turnsByLatestTimelineKey: Map<string, SessionAssistantTurnItem>;
  pendingTurn: SessionAssistantTurnItem | null;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isAssistantTimelineEntry(
  entry: SessionTimelineEntry,
): entry is SessionTimelineMessageEntry | SessionTimelineToolActivityEntry {
  return entry.role === 'assistant' && (entry.kind === 'message' || entry.kind === 'tool-activity');
}

function cloneSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): SessionAssistantTurnSegment[] {
  return structuredClone(segments);
}

function normalizeToolSegmentKey(segment: SessionAssistantTurnSegment): string {
  if (segment.kind !== 'tool') {
    return '';
  }
  return normalizeString(segment.tool.toolCallId ?? segment.tool.id ?? segment.tool.name);
}

function isDeferredMessageSegment(segment: SessionAssistantTurnSegment): boolean {
  return segment.kind === 'message' && segment.key.includes(':variant:');
}

function findDeferredMessageInsertIndex(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
): number {
  return segments.findIndex((segment) => isDeferredMessageSegment(segment));
}

function mergeOrderedSegments(
  existingSegments: ReadonlyArray<SessionAssistantTurnSegment>,
  incomingSegments: ReadonlyArray<SessionAssistantTurnSegment>,
): SessionAssistantTurnSegment[] {
  if (existingSegments.length === 0) {
    return cloneSegments(incomingSegments);
  }
  if (incomingSegments.length === 0) {
    return cloneSegments(existingSegments);
  }

  const merged = cloneSegments(existingSegments);
  let deferredInsertIndex = findDeferredMessageInsertIndex(merged);
  for (const incoming of incomingSegments) {
    if (incoming.kind === 'tool') {
      const incomingToolKey = normalizeToolSegmentKey(incoming);
      if (incomingToolKey) {
        const existingIndex = merged.findIndex((segment) => (
          segment.kind === 'tool'
          && normalizeToolSegmentKey(segment) === incomingToolKey
        ));
        if (existingIndex >= 0) {
          merged[existingIndex] = structuredClone(incoming);
          continue;
        }
      }
      if (deferredInsertIndex >= 0) {
        merged.splice(deferredInsertIndex, 0, structuredClone(incoming));
        deferredInsertIndex += 1;
        continue;
      }
    }
    merged.push(structuredClone(incoming));
  }
  return merged;
}

function buildEmbeddedToolResults(
  tools: ReadonlyArray<SessionRenderToolCard>,
): ReadonlyArray<SessionRenderAssistantBubbleToolResult> {
  const embedded: SessionRenderAssistantBubbleToolResult[] = [];
  for (const tool of tools) {
    if (tool.result.kind !== 'canvas' || tool.result.surface !== 'assistant-bubble' || tool.result.preview.surface !== 'assistant_message') {
      continue;
    }
    embedded.push({
      key: tool.toolCallId || tool.id || `${tool.name}:${embedded.length}`,
      ...(tool.toolCallId ? { toolCallId: tool.toolCallId } : {}),
      toolName: tool.name,
      preview: structuredClone(tool.result.preview),
      ...(tool.result.rawText ? { rawText: tool.result.rawText } : {}),
    });
  }
  return embedded;
}

function deriveThinkingFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): string | null {
  const parts = segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking')
    .map((segment) => segment.text.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function deriveToolsFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): ReadonlyArray<SessionRenderToolCard> {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'tool' }> => segment.kind === 'tool')
    .map((segment) => structuredClone(segment.tool));
}

function deriveTextFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): string {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message')
    .map((segment) => segment.text)
    .filter((text) => text.trim().length > 0)
    .join('\n');
}

function deriveImagesFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): ReadonlyArray<SessionRenderImage> {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media')
    .flatMap((segment) => structuredClone(segment.images));
}

function deriveAttachedFilesFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): ReadonlyArray<SessionRenderAttachedFile> {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media')
    .flatMap((segment) => structuredClone(segment.attachedFiles));
}

function resolveAssistantTurnPendingState(input: {
  runtime: SessionRuntimeStateSnapshot;
  activeTurnKey: string | null;
  accumulator: AssistantTurnAccumulator;
}): SessionAssistantTurnItem['pendingState'] {
  if (!input.runtime.sending) {
    return null;
  }
  if (input.activeTurnKey !== input.accumulator.turnKey) {
    return null;
  }
  if (input.runtime.pendingFinal || deriveToolsFromSegments(input.accumulator.segments).length > 0) {
    return 'activity';
  }
  if (input.accumulator.lastStatus === 'streaming') {
    return null;
  }
  return 'typing';
}

function resolveAssistantTurnStatus(input: {
  runtime: SessionRuntimeStateSnapshot;
  activeTurnKey: string | null;
  accumulator: AssistantTurnAccumulator;
}): SessionAssistantTurnItem['status'] {
  if (input.accumulator.lastStatus === 'error') {
    return 'error';
  }
  if (input.accumulator.lastStatus === 'aborted') {
    return 'aborted';
  }
  if (input.accumulator.lastStatus === 'streaming') {
    return 'streaming';
  }
  if (input.runtime.sending && input.activeTurnKey === input.accumulator.turnKey) {
    return input.runtime.pendingFinal || deriveToolsFromSegments(input.accumulator.segments).length > 0
      ? 'waiting_tool'
      : 'streaming';
  }
  return 'final';
}

export function buildAssistantTurnItemKey(input: {
  sessionKey: string;
  turnKey: string;
  laneKey: string;
}): string {
  return `session:${input.sessionKey}|assistant-turn:${input.turnKey}:${input.laneKey}`;
}

function buildPendingAssistantTurnItem(input: {
  sessionKey: string;
  runtime: SessionRuntimeStateSnapshot;
}): SessionAssistantTurnItem | null {
  const pendingTurnKey = normalizeString(input.runtime.pendingTurnKey);
  const pendingLaneKey = normalizeString(input.runtime.pendingTurnLaneKey) || 'main';
  if (!input.runtime.sending || !pendingTurnKey) {
    return null;
  }
  const hasAuthoritativeRunBinding = !pendingTurnKey.startsWith('main:prompt:');
  return {
    key: buildAssistantTurnItemKey({
      sessionKey: input.sessionKey,
      turnKey: pendingTurnKey,
      laneKey: pendingLaneKey,
    }),
    kind: 'assistant-turn',
    sessionKey: input.sessionKey,
    role: 'assistant',
    turnKey: pendingTurnKey,
    laneKey: pendingLaneKey,
    identitySource: hasAuthoritativeRunBinding ? 'run' : 'heuristic',
    identityMode: hasAuthoritativeRunBinding ? 'run' : 'heuristic',
    identityConfidence: hasAuthoritativeRunBinding ? 'strong' : 'fallback',
    status: input.runtime.pendingFinal ? 'waiting_tool' : 'streaming',
    segments: [],
    thinking: null,
    tools: [],
    embeddedToolResults: [],
    text: '',
    images: [],
    attachedFiles: [],
    pendingState: input.runtime.pendingFinal ? 'activity' : 'typing',
    ...(typeof input.runtime.updatedAt === 'number' ? { updatedAt: input.runtime.updatedAt } : {}),
  };
}

function resolveAssistantTurnBinding(
  row: SessionTimelineMessageEntry | SessionTimelineToolActivityEntry,
): {
  source: SessionTurnBindingSource;
  mode: SessionTurnIdentityMode;
  confidence: SessionTurnIdentityConfidence;
} {
  if (row.turnBindingSource && row.turnBindingConfidence && row.turnIdentityMode && row.turnIdentityConfidence) {
    return {
      source: row.turnBindingSource,
      mode: row.turnIdentityMode,
      confidence: row.turnIdentityConfidence,
    };
  }
  if (normalizeString(row.runId)) {
    return {
      source: 'run',
      mode: 'run',
      confidence: 'strong',
    };
  }
  if (row.kind === 'message' && normalizeString(row.messageId)) {
    return {
      source: 'message',
      mode: 'message',
      confidence: 'strong',
    };
  }
  if (row.kind === 'message' && normalizeString(row.originMessageId)) {
    return {
      source: 'origin',
      mode: 'origin',
      confidence: 'fallback',
    };
  }
  if (row.kind === 'message' && normalizeString(row.clientId)) {
    return {
      source: 'client',
      mode: 'client',
      confidence: 'fallback',
    };
  }
  return {
    source: 'heuristic',
    mode: 'heuristic',
    confidence: 'fallback',
  };
}

function createAssistantTurnAccumulator(
  row: SessionTimelineMessageEntry | SessionTimelineToolActivityEntry,
): AssistantTurnAccumulator | null {
  const laneKey = normalizeString(row.laneKey);
  const turnKey = normalizeString(row.turnKey);
  if (!laneKey || !turnKey) {
    return null;
  }
  const binding = resolveAssistantTurnBinding(row);
  return {
    key: buildAssistantTurnItemKey({
      sessionKey: row.sessionKey,
      turnKey,
      laneKey,
    }),
    turnKey,
    laneKey,
    sessionKey: row.sessionKey,
    ...(row.agentId ? { agentId: row.agentId } : {}),
    createdAt: row.createdAt,
    updatedAt: row.createdAt,
    ...(row.runId ? { runId: row.runId } : {}),
    latestTimelineKey: row.key,
    ...(row.entryId ? { latestTimelineEntryId: row.entryId } : {}),
    ...(row.kind === 'message' && row.messageId ? { latestTimelineMessageId: row.messageId } : {}),
    identitySource: binding.source,
    identityMode: binding.mode,
    identityConfidence: binding.confidence,
    lastStatus: row.status,
    segments: cloneSegments(row.assistantSegments),
  };
}

function mergeAssistantTurnAccumulator(
  accumulator: AssistantTurnAccumulator,
  row: SessionTimelineMessageEntry | SessionTimelineToolActivityEntry,
): AssistantTurnAccumulator {
  return {
    ...accumulator,
    createdAt: accumulator.createdAt ?? row.createdAt,
    updatedAt: typeof row.createdAt === 'number' ? row.createdAt : accumulator.updatedAt,
    runId: row.runId ?? accumulator.runId,
    latestTimelineKey: row.key,
    latestTimelineEntryId: row.entryId ?? accumulator.latestTimelineEntryId,
    latestTimelineMessageId: row.kind === 'message'
      ? (row.messageId ?? accumulator.latestTimelineMessageId)
      : accumulator.latestTimelineMessageId,
    identitySource: row.turnBindingSource ?? accumulator.identitySource,
    identityMode: row.turnIdentityMode ?? accumulator.identityMode,
    identityConfidence: row.turnIdentityConfidence ?? accumulator.identityConfidence,
    lastStatus: row.status ?? accumulator.lastStatus,
    segments: mergeOrderedSegments(accumulator.segments, row.assistantSegments),
  };
}

function buildAssistantTurnMatchKey(accumulator: AssistantTurnAccumulator): string {
  if (accumulator.identityConfidence === 'strong') {
    return `strong:${accumulator.laneKey}:${accumulator.identityMode}:${accumulator.turnKey}`;
  }
  return `fallback:${accumulator.laneKey}:${accumulator.key}`;
}

export function resolveAssistantTurnItemKeyFromTimelineEntry(entry: SessionTimelineEntry): string | null {
  if (!isAssistantTimelineEntry(entry)) {
    return null;
  }
  const laneKey = normalizeString(entry.laneKey);
  const turnKey = normalizeString(entry.turnKey);
  if (!laneKey || !turnKey) {
    return null;
  }
  return buildAssistantTurnItemKey({
    sessionKey: entry.sessionKey,
    turnKey,
    laneKey,
  });
}

export function assembleAuthoritativeAssistantTurns(input: {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
}): AssistantTurnAssembly {
  const assistantAccumulatorsByMatchKey = new Map<string, AssistantTurnAccumulator>();
  const assistantTurnOrder: string[] = [];
  const assistantTurnMatchKeyByItemKey = new Map<string, string>();
  let previousFallbackAssistantMatchKey: string | null = null;
  let previousFallbackAssistantLaneKey: string | null = null;

  for (const entry of input.timelineEntries) {
    if (!isAssistantTimelineEntry(entry)) {
      previousFallbackAssistantMatchKey = null;
      previousFallbackAssistantLaneKey = null;
      continue;
    }
    const accumulatorSeed = createAssistantTurnAccumulator(entry);
    if (!accumulatorSeed) {
      previousFallbackAssistantMatchKey = null;
      previousFallbackAssistantLaneKey = null;
      continue;
    }
    const matchKey = (
      accumulatorSeed.identityConfidence === 'fallback'
      && previousFallbackAssistantMatchKey
      && previousFallbackAssistantLaneKey === accumulatorSeed.laneKey
    )
      ? previousFallbackAssistantMatchKey
      : buildAssistantTurnMatchKey(accumulatorSeed);
    const existing = assistantAccumulatorsByMatchKey.get(matchKey);
    const next = existing
      ? mergeAssistantTurnAccumulator(existing, entry)
      : accumulatorSeed;
    assistantAccumulatorsByMatchKey.set(matchKey, next);
    if (!existing) {
      assistantTurnOrder.push(matchKey);
    }
    assistantTurnMatchKeyByItemKey.set(next.key, matchKey);
    if (next.identityConfidence === 'strong') {
      previousFallbackAssistantMatchKey = null;
      previousFallbackAssistantLaneKey = null;
    } else {
      previousFallbackAssistantMatchKey = matchKey;
      previousFallbackAssistantLaneKey = accumulatorSeed.laneKey;
    }
  }

  const activeAssistantTurnMatchKey = (() => {
    const pendingTurnKey = normalizeString(input.runtime.pendingTurnKey);
    const pendingTurnLaneKey = normalizeString(input.runtime.pendingTurnLaneKey);
    if (pendingTurnKey) {
      for (const matchKey of assistantTurnOrder) {
        const candidate = assistantAccumulatorsByMatchKey.get(matchKey);
        if (!candidate) {
          continue;
        }
        if (
          candidate.turnKey === pendingTurnKey
          && (!pendingTurnLaneKey || candidate.laneKey === pendingTurnLaneKey)
        ) {
          return matchKey;
        }
      }
    }
    const activeTurnItemKey = normalizeString(input.runtime.activeTurnItemKey);
    if (activeTurnItemKey) {
      const byItemKey = assistantTurnMatchKeyByItemKey.get(activeTurnItemKey);
      if (byItemKey) {
        return byItemKey;
      }
    }
    if (assistantTurnOrder.length === 0) {
      return null;
    }
    return assistantTurnOrder[assistantTurnOrder.length - 1] ?? null;
  })();

  const turnsByLatestTimelineKey = new Map<string, SessionAssistantTurnItem>();
  for (const matchKey of assistantTurnOrder) {
    const accumulator = assistantAccumulatorsByMatchKey.get(matchKey);
    if (!accumulator) {
      continue;
    }
    const activeTurnKey = activeAssistantTurnMatchKey
      ? assistantAccumulatorsByMatchKey.get(activeAssistantTurnMatchKey)?.turnKey ?? null
      : null;
    const segments = cloneSegments(accumulator.segments);
    const tools = deriveToolsFromSegments(segments);
    turnsByLatestTimelineKey.set(accumulator.latestTimelineKey, {
      key: accumulator.key,
      kind: 'assistant-turn',
      sessionKey: accumulator.sessionKey,
      role: 'assistant',
      ...(accumulator.createdAt != null ? { createdAt: accumulator.createdAt } : {}),
      ...(accumulator.updatedAt != null ? { updatedAt: accumulator.updatedAt } : {}),
      ...(accumulator.runId ? { runId: accumulator.runId } : {}),
      laneKey: accumulator.laneKey,
      turnKey: accumulator.turnKey,
      ...(accumulator.agentId ? { agentId: accumulator.agentId } : {}),
      identitySource: accumulator.identitySource,
      identityMode: accumulator.identityMode,
      identityConfidence: accumulator.identityConfidence,
      status: resolveAssistantTurnStatus({
        runtime: input.runtime,
        activeTurnKey,
        accumulator,
      }),
      segments,
      thinking: deriveThinkingFromSegments(segments),
      tools,
      embeddedToolResults: buildEmbeddedToolResults(tools),
      text: deriveTextFromSegments(segments),
      images: deriveImagesFromSegments(segments),
      attachedFiles: deriveAttachedFilesFromSegments(segments),
      pendingState: resolveAssistantTurnPendingState({
        runtime: input.runtime,
        activeTurnKey,
        accumulator,
      }),
    });
  }

  return {
    turnsByLatestTimelineKey,
    pendingTurn: buildPendingAssistantTurnItem({
      sessionKey: input.sessionKey,
      runtime: input.runtime,
    }),
  };
}
