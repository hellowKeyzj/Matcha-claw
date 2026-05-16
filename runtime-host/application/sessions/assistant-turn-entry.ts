import {
  sanitizeAssistantDisplayText,
} from '../../shared/chat-message-normalization';
import type {
  SessionAssistantMediaSegment,
  SessionAssistantMessageSegment,
  SessionAssistantThinkingSegment,
  SessionAssistantToolSegment,
  SessionAssistantTurnSegment,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
  SessionRenderToolStatusKind,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntryStatus,
  SessionTurnBindingConfidence,
  SessionTurnBindingSource,
  SessionTurnIdentityConfidence,
  SessionTurnIdentityMode,
} from '../../shared/session-adapter-types';
import {
  extractImagesAsAttachedFiles,
  extractImagesFromSingleBlock,
} from './assistant-segment-media';
import {
  isStateOnlyToolName,
  isToolCallContentType,
  isToolResultContentType,
  resolveToolRecordCallId,
  resolveToolRecordCallPayload,
  resolveToolRecordName,
  resolveToolRecordResultPayload,
} from './state-only-tools';
import {
  resolveToolCardRenderState,
} from './tool/tool-card-render-state';
import type { ContentBlockLike } from './transcript-types';

export interface AssistantTurnEntryIdentity {
  sessionKey: string;
  runId?: string;
  agentId?: string;
  laneKey: string;
  turnKey: string;
  turnBindingSource: SessionTurnBindingSource;
  turnBindingConfidence: SessionTurnBindingConfidence;
  turnIdentityMode: SessionTurnIdentityMode;
  turnIdentityConfidence: SessionTurnIdentityConfidence;
  entryId: string;
  messageId?: string;
  originMessageId?: string;
  clientId?: string;
}

function buildSegmentKey(
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>,
  kind: SessionAssistantTurnSegment['kind'],
  slot: number,
  toolCallId?: string,
): string {
  if (kind === 'tool' && toolCallId) {
    return `tool:${identity.turnKey}:${identity.laneKey}:${toolCallId}`;
  }
  return `${kind}:${identity.turnKey}:${identity.laneKey}:${slot}`;
}

export function buildAssistantTurnEntryKey(
  sessionKey: string,
  laneKey: string,
  turnKey: string,
): string {
  return `session:${sessionKey}|assistant-turn:${laneKey}:${turnKey}`;
}

function buildThinkingSegment(key: string, text: string): SessionAssistantThinkingSegment | null {
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }
  return { kind: 'thinking', key, text: cleaned };
}

function buildMessageSegment(key: string, text: string): SessionAssistantMessageSegment | null {
  const cleaned = sanitizeAssistantDisplayText([{ type: 'text', text }]);
  if (!cleaned) {
    return null;
  }
  return { kind: 'message', key, text: cleaned };
}

function buildMediaSegment(input: {
  key: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
}): SessionAssistantMediaSegment | null {
  if (input.images.length === 0 && input.attachedFiles.length === 0) {
    return null;
  }
  return {
    kind: 'media',
    key: input.key,
    images: structuredClone(input.images),
    attachedFiles: structuredClone(input.attachedFiles),
  };
}

function buildToolSegmentFromBlock(input: {
  key: string;
  toolCallId: string;
  name: string;
  block: ContentBlockLike;
  existingTool: SessionRenderToolCard | null;
  defaultStatus: SessionRenderToolStatusKind;
}): SessionAssistantToolSegment {
  const isCall = isToolCallContentType(input.block.type);
  const isResult = isToolResultContentType(input.block.type);
  const callPayload = isCall ? resolveToolRecordCallPayload(input.block) : input.existingTool?.input ?? null;
  const resultPayload = isResult ? resolveToolRecordResultPayload(input.block) : input.existingTool?.output;
  const isError = isResult && (input.block as { isError?: unknown; is_error?: unknown }).isError === true;
  const status: SessionRenderToolStatusKind = isResult
    ? (isError ? 'error' : 'completed')
    : input.existingTool?.status ?? input.defaultStatus;
  const renderState = resolveToolCardRenderState({
    name: input.name,
    input: callPayload,
    output: resultPayload,
  });
  return {
    kind: 'tool',
    key: input.key,
    tool: {
      id: input.toolCallId || input.name,
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      name: input.name,
      input: callPayload,
      status,
      ...renderState,
      ...(input.existingTool?.summary ? { summary: input.existingTool.summary } : {}),
      ...(input.existingTool?.durationMs != null ? { durationMs: input.existingTool.durationMs } : {}),
      ...(input.existingTool?.updatedAt != null ? { updatedAt: input.existingTool.updatedAt } : {}),
      ...(resultPayload !== undefined ? { output: structuredClone(resultPayload) } : {}),
    },
  };
}

function findToolSegment(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  toolCallId: string,
): SessionAssistantToolSegment | null {
  for (const segment of segments) {
    if (segment.kind === 'tool' && (segment.tool.toolCallId === toolCallId || segment.tool.id === toolCallId)) {
      return segment;
    }
  }
  return null;
}

function findToolSegmentByName(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  name: string,
): SessionAssistantToolSegment | null {
  for (const segment of segments) {
    if (segment.kind === 'tool' && segment.tool.name === name && !segment.tool.toolCallId) {
      return segment;
    }
  }
  return null;
}

/**
 * Build the segment list for an assistant turn from one chat-stream content
 * array. The content array order is the authoritative ordering for the turn.
 *
 * - For `final` status: content array is complete and authoritative. Segments
 *   are rebuilt from scratch following content order.
 * - For `streaming` status: content array only contains the currently
 *   generating fragment (no previously completed toolCall blocks). New text
 *   is appended after existing tool segments to preserve correct visual order.
 *   Tool segments from previousSegments are kept in place.
 */
export function buildSegmentsFromChatContent(input: {
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>;
  content: unknown;
  fallbackText: string;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  defaultToolStatus: SessionRenderToolStatusKind;
  previousSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  isStreaming: boolean;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  if (input.isStreaming && input.previousSegments.length > 0) {
    return buildStreamingSegments(input);
  }
  return buildFinalSegments(input);
}

function buildStreamingSegments(input: {
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>;
  content: unknown;
  fallbackText: string;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  defaultToolStatus: SessionRenderToolStatusKind;
  previousSegments: ReadonlyArray<SessionAssistantTurnSegment>;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  const incomingText = extractTextFromContent(input.content) || input.fallbackText;
  const incomingThinking = extractThinkingFromContent(input.content);

  const segments: SessionAssistantTurnSegment[] = [];
  let hasMessageSegment = false;
  let hasThinkingSegment = false;

  for (const previous of input.previousSegments) {
    if (previous.kind === 'message') {
      hasMessageSegment = true;
      segments.push({
        ...structuredClone(previous),
        text: incomingText || previous.text,
      });
    } else if (previous.kind === 'thinking') {
      hasThinkingSegment = true;
      segments.push({
        ...structuredClone(previous),
        text: incomingThinking || previous.text,
      });
    } else {
      segments.push(structuredClone(previous));
    }
  }

  if (!hasThinkingSegment && incomingThinking) {
    const segment = buildThinkingSegment(
      buildSegmentKey(input.identity, 'thinking', 0),
      incomingThinking,
    );
    if (segment) segments.push(segment);
  }

  if (!hasMessageSegment && incomingText.trim()) {
    const segment = buildMessageSegment(
      buildSegmentKey(input.identity, 'message', 0),
      incomingText,
    );
    if (segment) segments.push(segment);
  }

  return segments;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is { type: string; text: string } => (
      Boolean(block) && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string'
    ))
    .map((block) => block.text)
    .join('\n');
}

function extractThinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is { type: string; thinking: string } => (
      Boolean(block) && typeof block === 'object' && block.type === 'thinking' && typeof block.thinking === 'string'
    ))
    .map((block) => block.thinking)
    .join('\n\n');
}

function buildFinalSegments(input: {
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>;
  content: unknown;
  fallbackText: string;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  defaultToolStatus: SessionRenderToolStatusKind;
  previousSegments: ReadonlyArray<SessionAssistantTurnSegment>;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  const slots = { thinking: 0, message: 0, media: 0 };
  const segments: SessionAssistantTurnSegment[] = [];
  const consumedToolCallIds = new Set<string>();
  let emittedInlineMedia = false;

  if (Array.isArray(input.content)) {
    for (const block of input.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const row = block as ContentBlockLike;
      const type = typeof row.type === 'string' ? row.type : '';

      if (type === 'thinking' && typeof row.thinking === 'string') {
        const segment = buildThinkingSegment(
          buildSegmentKey(input.identity, 'thinking', slots.thinking),
          row.thinking,
        );
        slots.thinking += 1;
        if (segment) segments.push(segment);
        continue;
      }

      if (type === 'text' && typeof row.text === 'string') {
        const segment = buildMessageSegment(
          buildSegmentKey(input.identity, 'message', slots.message),
          row.text,
        );
        slots.message += 1;
        if (segment) segments.push(segment);
        continue;
      }

      if (type === 'image') {
        const segment = buildMediaSegment({
          key: buildSegmentKey(input.identity, 'media', slots.media),
          images: extractImagesFromSingleBlock(row),
          attachedFiles: extractImagesAsAttachedFiles([row]),
        });
        slots.media += 1;
        if (segment) {
          emittedInlineMedia = true;
          segments.push(segment);
        }
        continue;
      }

      if (isToolCallContentType(type) || isToolResultContentType(type)) {
        const name = resolveToolRecordName(row);
        if (!name || isStateOnlyToolName(name)) {
          continue;
        }
        const toolCallId = resolveToolRecordCallId(row);
        const previousTool = toolCallId
          ? findToolSegment(input.previousSegments, toolCallId)?.tool ?? null
          : findToolSegmentByName(input.previousSegments, name)?.tool ?? null;
        const toolSegment = buildToolSegmentFromBlock({
          key: buildSegmentKey(input.identity, 'tool', 0, toolCallId || `${name}:${segments.length}`),
          toolCallId,
          name,
          block: row,
          existingTool: previousTool,
          defaultStatus: input.defaultToolStatus,
        });
        segments.push(toolSegment);
        if (toolCallId) {
          consumedToolCallIds.add(toolCallId);
        }
      }
    }
  }

  if (segments.length === 0 && input.fallbackText.trim()) {
    const segment = buildMessageSegment(
      buildSegmentKey(input.identity, 'message', slots.message),
      input.fallbackText,
    );
    slots.message += 1;
    if (segment) segments.push(segment);
  }

  for (const previous of input.previousSegments) {
    if (previous.kind !== 'tool') {
      continue;
    }
    const id = previous.tool.toolCallId ?? previous.tool.id;
    if (id && consumedToolCallIds.has(id)) {
      continue;
    }
    if (isStateOnlyToolName(previous.tool.name)) {
      continue;
    }
    segments.push(structuredClone(previous));
    if (id) {
      consumedToolCallIds.add(id);
    }
  }

  if (!emittedInlineMedia) {
    const segment = buildMediaSegment({
      key: buildSegmentKey(input.identity, 'media', slots.media),
      images: [],
      attachedFiles: input.attachedFiles,
    });
    if (segment) segments.push(segment);
  }

  return segments;
}

/**
 * Apply a tool-lifecycle update to a turn's segments.
 *
 * Only the tool segment with the matching toolCallId is mutated. If no
 * matching segment exists yet, a new tool segment is appended at the tail;
 * a subsequent chat-content frame will reorder it via
 * `buildSegmentsFromChatContent`.
 */
export function applyToolStatusToSegments(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>,
  update: {
    toolCallId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    status: SessionRenderToolStatusKind;
    summary?: string;
    durationMs?: number;
    updatedAt?: number;
  },
): ReadonlyArray<SessionAssistantTurnSegment> {
  if (!update.toolCallId || !update.name || isStateOnlyToolName(update.name)) {
    return segments;
  }

  const next = segments.map((segment) => structuredClone(segment));
  let index = next.findIndex((segment) => (
    segment.kind === 'tool'
    && (segment.tool.toolCallId === update.toolCallId || segment.tool.id === update.toolCallId)
  ));

  if (index < 0) {
    index = next.findIndex((segment) => (
      segment.kind === 'tool' && segment.tool.name === update.name && !segment.tool.toolCallId
    ));
  }

  const renderState = resolveToolCardRenderState({
    name: update.name,
    input: update.input ?? (index >= 0 && next[index]!.kind === 'tool'
      ? (next[index] as SessionAssistantToolSegment).tool.input
      : null),
    output: update.output,
  });

  if (index < 0) {
    next.push({
      kind: 'tool',
      key: buildSegmentKey(identity, 'tool', 0, update.toolCallId),
      tool: {
        id: update.toolCallId || update.name,
        toolCallId: update.toolCallId,
        name: update.name,
        input: update.input ?? null,
        status: update.status,
        ...renderState,
        ...(update.summary ? { summary: update.summary } : {}),
        ...(update.durationMs != null ? { durationMs: update.durationMs } : {}),
        ...(update.updatedAt != null ? { updatedAt: update.updatedAt } : {}),
        ...(update.output !== undefined ? { output: structuredClone(update.output) } : {}),
      },
    });
    return next;
  }

  const target = next[index] as SessionAssistantToolSegment;
  next[index] = {
    ...target,
    tool: {
      ...target.tool,
      id: update.toolCallId || target.tool.id,
      toolCallId: update.toolCallId || target.tool.toolCallId,
      name: update.name,
      input: update.input !== undefined ? update.input : target.tool.input,
      status: update.status,
      ...renderState,
      ...(update.summary ? { summary: update.summary } : { summary: target.tool.summary }),
      ...(update.durationMs != null ? { durationMs: update.durationMs } : {}),
      ...(update.updatedAt != null ? { updatedAt: update.updatedAt } : {}),
      ...(update.output !== undefined
        ? { output: structuredClone(update.output) }
        : (target.tool.output !== undefined ? { output: target.tool.output } : {})),
    },
  };
  return next;
}

export function buildAssistantTurnEntry(input: {
  identity: AssistantTurnEntryIdentity;
  status: SessionTimelineEntryStatus;
  text: string;
  createdAt?: number;
  sequenceId?: number;
  segments: ReadonlyArray<SessionAssistantTurnSegment>;
  isStreaming: boolean;
}): SessionTimelineAssistantTurnEntry {
  const id = input.identity;
  return {
    key: buildAssistantTurnEntryKey(id.sessionKey, id.laneKey, id.turnKey),
    kind: 'assistant-turn',
    sessionKey: id.sessionKey,
    role: 'assistant',
    text: input.text,
    status: input.status,
    ...(input.createdAt != null ? { createdAt: input.createdAt } : {}),
    ...(input.sequenceId != null ? { sequenceId: input.sequenceId } : {}),
    ...(id.runId ? { runId: id.runId } : {}),
    entryId: id.entryId,
    laneKey: id.laneKey,
    turnKey: id.turnKey,
    turnBindingSource: id.turnBindingSource,
    turnBindingConfidence: id.turnBindingConfidence,
    turnIdentityMode: id.turnIdentityMode,
    turnIdentityConfidence: id.turnIdentityConfidence,
    ...(id.agentId ? { agentId: id.agentId } : {}),
    ...(id.messageId ? { messageId: id.messageId } : {}),
    ...(id.originMessageId ? { originMessageId: id.originMessageId } : {}),
    ...(id.clientId ? { clientId: id.clientId } : {}),
    segments: input.segments,
    isStreaming: input.isStreaming,
  };
}
