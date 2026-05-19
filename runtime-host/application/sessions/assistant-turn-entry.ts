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
import {
  extractToolResultOutputText,
} from './tool/tool-card-content';
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

function normalizeIncomingMessageText(
  incomingText: string,
  previousText: string,
  isStreaming: boolean,
): string {
  const incoming = sanitizeAssistantDisplayText([{ type: 'text', text: incomingText }]);
  if (!incoming) {
    return previousText;
  }
  if (!previousText) {
    return incoming;
  }
  if (incoming === previousText || incoming.startsWith(previousText)) {
    return incoming;
  }
  if (previousText.startsWith(incoming)) {
    return previousText;
  }
  if (isStreaming) {
    return `${previousText}${incoming}`;
  }
  return incoming.length >= previousText.length ? incoming : previousText;
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

function countSegmentsOfKind(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  kind: SessionAssistantTurnSegment['kind'],
): number {
  return segments.filter((segment) => segment.kind === kind).length;
}

/**
 * Incremental segment update from a chat-stream content frame.
 *
 * OpenClaw's chat stream only carries text (and optionally thinking). It
 * never carries toolCall/toolResult blocks in realtime — those arrive via
 * the separate tool-lifecycle stream.
 *
 * Incremental rule:
 * - If the tail of `previousSegments` is a message segment, update its text.
 * - If the tail is NOT a message (e.g. a tool just arrived), append a new
 *   message segment — this creates the interleaved text→tool→text pattern.
 *
 * For transcript replay (history), content arrays DO contain toolCall/
 * toolResult blocks. The presence of tool blocks distinguishes the two
 * flows; transcript content is forwarded to `buildSegmentsFromTranscriptContent`,
 * which merges tool segments onto previousSegments (so multiple transcript
 * messages within the same turn aggregate without duplicating tool cards).
 */
export function buildSegmentsFromChatContent(input: {
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>;
  content: unknown;
  fallbackText: string;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  toolStatuses?: ReadonlyArray<Record<string, unknown>>;
  previousSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  isStreaming: boolean;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  const incomingText = extractTextFromContent(input.content) || input.fallbackText;
  const incomingThinking = extractThinkingFromContent(input.content);
  const hasToolCallBlocks = contentHasToolBlocks(input.content);

  // Transcript-style content (any frame containing toolCall/toolResult blocks):
  // the realtime chat stream never includes tool blocks, so this signal reliably
  // identifies transcript replay or chat.append injection paths. Merge against
  // previousSegments so multiple transcript messages within the same turn
  // aggregate (no duplicate text, no duplicate tool cards).
  if (hasToolCallBlocks) {
    return buildSegmentsFromTranscriptContent(input);
  }

  // Realtime chat stream: only text/thinking, incremental append
  const segments: SessionAssistantTurnSegment[] = input.previousSegments.map((s) => structuredClone(s));

  // Update or append thinking
  if (incomingThinking) {
    const thinkingIndex = segments.findIndex((s) => s.kind === 'thinking');
    if (thinkingIndex >= 0) {
      (segments[thinkingIndex] as SessionAssistantThinkingSegment).text = incomingThinking;
    } else {
      const slot = countSegmentsOfKind(segments, 'thinking');
      const segment = buildThinkingSegment(
        buildSegmentKey(input.identity, 'thinking', slot),
        incomingThinking,
      );
      if (segment) segments.push(segment);
    }
  }

  // Update or append message text
  if (incomingText.trim()) {
    const lastSegment = segments[segments.length - 1];
    if (lastSegment?.kind === 'message') {
      // Tail is already a message → update in place (same text position)
      const previousText = (lastSegment as SessionAssistantMessageSegment).text;
      (lastSegment as SessionAssistantMessageSegment).text = normalizeIncomingMessageText(
        incomingText,
        previousText,
        input.isStreaming,
      );
    } else {
      // Tail is a tool or thinking or empty → append new message segment
      const slot = countSegmentsOfKind(segments, 'message');
      const segment = buildMessageSegment(
        buildSegmentKey(input.identity, 'message', slot),
        incomingText,
      );
      if (segment) segments.push(segment);
    }
  }

  if (
    input.attachedFiles.length > 0
    && !segments.some((segment) => segment.kind === 'media')
  ) {
    const slot = countSegmentsOfKind(segments, 'media');
    const segment = buildMediaSegment({
      key: buildSegmentKey(input.identity, 'media', slot),
      images: [],
      attachedFiles: input.attachedFiles,
    });
    if (segment) segments.push(segment);
  }

  return segments;
}

/**
 * Build segments from a transcript content array (history replay or chat.append injection).
 *
 * 合并语义（关键）：
 * - 起步基于 previousSegments，确保同一 turn 内多条 transcript message 累积叠加。
 * - text/thinking/image 块：append 新 segment，slot 序号从 previousSegments 已有数量起算。
 * - toolCall/toolResult 块：按 toolCallId upsert。已有就在原位置更新；没有就追加。
 *
 * 如此一来，重启后水合时同一 turn 的 N 条 assistant message 会被合并到同一个 entry 的
 * segments 数组里，不会重复 tool 卡或文本。
 */
function buildSegmentsFromTranscriptContent(input: {
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>;
  content: unknown;
  fallbackText: string;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  toolStatuses?: ReadonlyArray<Record<string, unknown>>;
  previousSegments: ReadonlyArray<SessionAssistantTurnSegment>;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  const segments: SessionAssistantTurnSegment[] = input.previousSegments.map((s) => structuredClone(s));
  const slots = {
    thinking: countSegmentsOfKind(segments, 'thinking'),
    message: countSegmentsOfKind(segments, 'message'),
    media: countSegmentsOfKind(segments, 'media'),
  };
  const hadInlineMedia = segments.some((segment) => segment.kind === 'media');
  let emittedInlineMedia = hadInlineMedia;

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
        const toolCallId = resolveToolRecordCallId(row);
        let existingIndex = toolCallId
          ? segments.findIndex((segment) => (
              segment.kind === 'tool'
              && (segment.tool.toolCallId === toolCallId || segment.tool.id === toolCallId)
            ))
          : -1;
        const isCall = isToolCallContentType(type);
        const isResult = isToolResultContentType(type);
        const rawName = resolveToolRecordName(row);
        let existingTool = existingIndex >= 0 && segments[existingIndex]!.kind === 'tool'
          ? (segments[existingIndex] as SessionAssistantToolSegment).tool
          : (toolCallId || !rawName ? null : findToolSegmentByName(segments, rawName)?.tool ?? null);
        const name = rawName || existingTool?.name || '';
        if (!name || isStateOnlyToolName(name)) {
          continue;
        }
        if (existingIndex < 0 && isResult) {
          existingIndex = findLatestUnresolvedToolSegmentIndexByName(segments, name);
          existingTool = existingIndex >= 0 && segments[existingIndex]!.kind === 'tool'
            ? (segments[existingIndex] as SessionAssistantToolSegment).tool
            : existingTool;
        }
        const callPayload = isCall ? resolveToolRecordCallPayload(row) : existingTool?.input ?? null;
        const resultPayload = isResult ? resolveToolRecordResultPayload(row) : existingTool?.output;
        const isError = isResult && (row as { isError?: unknown; is_error?: unknown }).isError === true;
        const status: SessionRenderToolStatusKind = isResult
          ? (isError ? 'error' : 'completed')
          : existingTool?.status ?? 'running';
        const renderState = resolveToolCardRenderState({
          name,
          input: callPayload,
          output: resultPayload,
          outputText: isResult ? extractToolResultOutputText(resultPayload) : undefined,
        });
        const toolSegmentKey = existingIndex >= 0
          ? segments[existingIndex]!.key
          : buildSegmentKey(input.identity, 'tool', 0, toolCallId || `${name}:${segments.length}`);
        const nextToolSegment: SessionAssistantToolSegment = {
          kind: 'tool',
          key: toolSegmentKey,
          tool: {
            id: toolCallId || existingTool?.id || name,
            ...(toolCallId ? { toolCallId } : (existingTool?.toolCallId ? { toolCallId: existingTool.toolCallId } : {})),
            name,
            input: callPayload,
            status,
            ...renderState,
            ...(existingTool?.summary ? { summary: existingTool.summary } : {}),
            ...(existingTool?.durationMs != null ? { durationMs: existingTool.durationMs } : {}),
            ...(existingTool?.updatedAt != null ? { updatedAt: existingTool.updatedAt } : {}),
            ...(resultPayload !== undefined ? { output: structuredClone(resultPayload) } : {}),
          },
        };
        if (existingIndex >= 0) {
          segments[existingIndex] = nextToolSegment;
        } else {
          segments.push(nextToolSegment);
        }
      }
    }
  }

  if (segments.length === 0 && input.fallbackText.trim()) {
    const segment = buildMessageSegment(
      buildSegmentKey(input.identity, 'message', slots.message),
      input.fallbackText,
    );
    if (segment) segments.push(segment);
  }

  if (!emittedInlineMedia && input.attachedFiles.length > 0) {
    const segment = buildMediaSegment({
      key: buildSegmentKey(input.identity, 'media', slots.media),
      images: [],
      attachedFiles: input.attachedFiles,
    });
    if (segment) segments.push(segment);
  }

  if (input.toolStatuses?.length) {
    for (const status of input.toolStatuses) {
      const toolCallId = resolveToolRecordCallId(status);
      const name = resolveToolRecordName(status);
      const index = toolCallId
        ? segments.findIndex((segment) => (
            segment.kind === 'tool'
            && (segment.tool.toolCallId === toolCallId || segment.tool.id === toolCallId)
          ))
        : (name ? segments.findIndex((segment) => segment.kind === 'tool' && segment.tool.name === name) : -1);
      if (index < 0 || segments[index]?.kind !== 'tool') {
        continue;
      }
      const target = segments[index] as SessionAssistantToolSegment;
      const output = resolveToolRecordResultPayload(status);
      const renderState = resolveToolCardRenderState({
        name: target.tool.name,
        input: target.tool.input,
        output: output ?? target.tool.output,
        outputText: extractToolResultOutputText(output),
      });
      const statusValue = typeof status.status === 'string' && ['running', 'completed', 'error', 'missing_result'].includes(status.status)
        ? status.status as SessionRenderToolStatusKind
        : target.tool.status;
      segments[index] = {
        ...target,
        tool: {
          ...target.tool,
          status: statusValue,
          ...renderState,
          ...(output !== undefined ? { output: structuredClone(output) } : (target.tool.output !== undefined ? { output: target.tool.output } : {})),
        },
      };
    }
  }

  return segments;
}

/**
 * Apply a tool-lifecycle event to a turn's segments (incremental).
 *
 * - If a tool segment with matching toolCallId exists → update its state.
 * - If not → append a new tool segment at the tail. This is the normal
 *   realtime path: tool events arrive independently of chat text.
 */
export function applyToolStatusToSegments(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  identity: Pick<AssistantTurnEntryIdentity, 'turnKey' | 'laneKey'>,
  update: {
    toolCallId: string;
    name: string;
    input?: unknown;
    output?: unknown;
    outputText?: string;
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
  const index = next.findIndex((segment) => (
    segment.kind === 'tool'
    && (segment.tool.toolCallId === update.toolCallId || segment.tool.id === update.toolCallId)
  ));

  const renderState = resolveToolCardRenderState({
    name: update.name,
    input: update.input ?? (index >= 0 && next[index]!.kind === 'tool'
      ? (next[index] as SessionAssistantToolSegment).tool.input
      : null),
    output: update.output,
    outputText: update.outputText,
  });

  if (index < 0) {
    // New tool → append at tail (incremental arrival)
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

  // Existing tool → update in place (preserves position)
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

// --- helpers ---

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

function contentHasToolBlocks(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((block) => {
    if (!block || typeof block !== 'object') {
      return false;
    }
    const type = typeof (block as { type?: unknown }).type === 'string'
      ? (block as { type: string }).type
      : '';
    return isToolCallContentType(type) || isToolResultContentType(type);
  });
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

function findLatestUnresolvedToolSegmentIndexByName(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  name: string,
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (
      segment?.kind === 'tool'
      && segment.tool.name === name
      && segment.tool.status === 'running'
      && segment.tool.result.kind === 'none'
    ) {
      return index;
    }
  }
  return -1;
}
