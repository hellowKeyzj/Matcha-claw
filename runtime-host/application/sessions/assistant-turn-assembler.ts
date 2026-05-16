import type {
  SessionAssistantTurnItem,
  SessionAssistantTurnSegment,
  SessionRenderAssistantBubbleToolResult,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
  SessionRuntimeStateSnapshot,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';
import {
  buildAssistantTurnEntryKey,
} from './assistant-turn-entry';
import {
  normalizeString,
} from './session-value-normalization';

function deriveText(segments: ReadonlyArray<SessionAssistantTurnSegment>): string {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message')
    .map((segment) => segment.text)
    .filter((text) => text.trim().length > 0)
    .join('\n');
}

function deriveThinking(segments: ReadonlyArray<SessionAssistantTurnSegment>): string | null {
  const parts = segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking')
    .map((segment) => segment.text.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

function deriveTools(segments: ReadonlyArray<SessionAssistantTurnSegment>): SessionRenderToolCard[] {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'tool' }> => segment.kind === 'tool')
    .map((segment) => structuredClone(segment.tool));
}

function deriveImages(segments: ReadonlyArray<SessionAssistantTurnSegment>): SessionRenderImage[] {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media')
    .flatMap((segment) => structuredClone(segment.images));
}

function deriveAttachedFiles(segments: ReadonlyArray<SessionAssistantTurnSegment>): SessionRenderAttachedFile[] {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media')
    .flatMap((segment) => structuredClone(segment.attachedFiles));
}

function buildEmbeddedToolResults(
  tools: ReadonlyArray<SessionRenderToolCard>,
): SessionRenderAssistantBubbleToolResult[] {
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

export function buildAssistantTurnItemKey(input: {
  sessionKey: string;
  turnKey: string;
  laneKey: string;
}): string {
  return buildAssistantTurnEntryKey(input.sessionKey, input.laneKey, input.turnKey);
}

export function resolveAssistantTurnItemKeyFromTimelineEntry(entry: SessionTimelineEntry): string | null {
  if (entry.kind !== 'assistant-turn') {
    return null;
  }
  const laneKey = normalizeString(entry.laneKey);
  const turnKey = normalizeString(entry.turnKey);
  if (!laneKey || !turnKey) {
    return null;
  }
  return entry.key;
}

function resolveStatus(
  entry: SessionTimelineAssistantTurnEntry,
  runtime: SessionRuntimeStateSnapshot,
): SessionAssistantTurnItem['status'] {
  if (entry.status === 'error') {
    return 'error';
  }
  if (entry.status === 'aborted') {
    return 'aborted';
  }
  if (entry.status === 'streaming' || entry.isStreaming) {
    return runtime.pendingFinal ? 'waiting_tool' : 'streaming';
  }
  return 'final';
}

function resolvePendingState(
  entry: SessionTimelineAssistantTurnEntry,
  runtime: SessionRuntimeStateSnapshot,
): SessionAssistantTurnItem['pendingState'] {
  if (!runtime.sending) {
    return null;
  }
  const pendingTurnKey = normalizeString(runtime.pendingTurnKey);
  if (pendingTurnKey && entry.turnKey !== pendingTurnKey) {
    return null;
  }
  if (runtime.pendingFinal || deriveTools(entry.segments).length > 0) {
    return 'activity';
  }
  if (entry.status === 'streaming' || entry.isStreaming) {
    return null;
  }
  return 'typing';
}

function buildItemFromEntry(
  entry: SessionTimelineAssistantTurnEntry,
  runtime: SessionRuntimeStateSnapshot,
): SessionAssistantTurnItem {
  const segments = structuredClone(entry.segments);
  const tools = deriveTools(segments);
  return {
    key: entry.key,
    kind: 'assistant-turn',
    sessionKey: entry.sessionKey,
    role: 'assistant',
    ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
    ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    laneKey: entry.laneKey ?? 'main',
    turnKey: entry.turnKey ?? '',
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    identitySource: entry.turnBindingSource ?? 'heuristic',
    identityMode: entry.turnIdentityMode ?? 'heuristic',
    identityConfidence: entry.turnIdentityConfidence ?? 'fallback',
    status: resolveStatus(entry, runtime),
    segments,
    thinking: deriveThinking(segments),
    tools,
    embeddedToolResults: buildEmbeddedToolResults(tools),
    text: deriveText(segments),
    images: deriveImages(segments),
    attachedFiles: deriveAttachedFiles(segments),
    pendingState: resolvePendingState(entry, runtime),
  };
}

function buildPendingTurnItem(input: {
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
    key: buildAssistantTurnEntryKey(input.sessionKey, pendingLaneKey, pendingTurnKey),
    kind: 'assistant-turn',
    sessionKey: input.sessionKey,
    role: 'assistant',
    laneKey: pendingLaneKey,
    turnKey: pendingTurnKey,
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

export interface AssistantTurnAssembly {
  itemsByEntryKey: Map<string, SessionAssistantTurnItem>;
  pendingTurn: SessionAssistantTurnItem | null;
}

export function assembleAuthoritativeAssistantTurns(input: {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  runtime: SessionRuntimeStateSnapshot;
}): AssistantTurnAssembly {
  const itemsByEntryKey = new Map<string, SessionAssistantTurnItem>();
  for (const entry of input.timelineEntries) {
    if (entry.kind !== 'assistant-turn') {
      continue;
    }
    itemsByEntryKey.set(entry.key, buildItemFromEntry(entry, input.runtime));
  }
  return {
    itemsByEntryKey,
    pendingTurn: buildPendingTurnItem({
      sessionKey: input.sessionKey,
      runtime: input.runtime,
    }),
  };
}

export function hasAssistantTurnOutput(item: Pick<
  SessionAssistantTurnItem,
  'segments' | 'text' | 'tools' | 'images' | 'attachedFiles' | 'thinking'
>): boolean {
  return (
    item.segments.length > 0
    || item.text.trim().length > 0
    || item.tools.length > 0
    || item.images.length > 0
    || item.attachedFiles.length > 0
    || Boolean(item.thinking)
  );
}
