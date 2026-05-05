import {
  extractMessageText,
  sanitizeAssistantDisplayText,
} from '../../shared/chat-message-normalization';
import type {
  SessionAssistantMediaSegment,
  SessionAssistantMessageSegment,
  SessionAssistantThinkingSegment,
  SessionAssistantToolSegment,
  SessionAssistantTurnSegment,
  SessionMessageRole,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
} from '../../shared/session-adapter-types';

interface ContentBlockLike {
  type?: unknown;
  text?: unknown;
  thinking?: unknown;
  source?: { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
  data?: unknown;
  mimeType?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  name?: unknown;
  content?: unknown;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function buildThinkingSegment(key: string, text: string): SessionAssistantThinkingSegment | null {
  const cleaned = text.trim();
  if (!cleaned) {
    return null;
  }
  return {
    kind: 'thinking',
    key,
    text: cleaned,
  };
}

function buildMessageSegment(key: string, text: string): SessionAssistantMessageSegment | null {
  const cleaned = sanitizeAssistantDisplayText([{ type: 'text', text }]);
  if (!cleaned) {
    return null;
  }
  return {
    kind: 'message',
    key,
    text: cleaned,
  };
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

function normalizeToolSegmentCardKey(tool: SessionRenderToolCard): string {
  return normalizeOptionalString(tool.toolCallId ?? tool.id ?? tool.name) ?? tool.name;
}

function buildToolSegment(tool: SessionRenderToolCard): SessionAssistantToolSegment {
  return {
    kind: 'tool',
    key: normalizeToolSegmentCardKey(tool),
    tool: structuredClone(tool),
  };
}

function extractImagesFromSingleBlock(block: ContentBlockLike): SessionRenderImage[] {
  if (block.type !== 'image') {
    return [];
  }
  if (block.source?.type === 'base64' && typeof block.source.media_type === 'string' && typeof block.source.data === 'string') {
    return [{
      mimeType: block.source.media_type,
      data: block.source.data,
    }];
  }
  if (block.source?.type === 'url' && typeof block.source.url === 'string') {
    return [{
      mimeType: typeof block.source.media_type === 'string' ? block.source.media_type : 'image/jpeg',
      url: block.source.url,
    }];
  }
  if (typeof block.data === 'string') {
    return [{
      mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/jpeg',
      data: block.data,
    }];
  }
  return [];
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

function findAssistantToolCardIndexForBlock(input: {
  toolCards: ReadonlyArray<SessionRenderToolCard>;
  consumedIndices: Set<number>;
  toolCallId?: string;
  toolName?: string;
}): number {
  const normalizedToolCallId = normalizeOptionalString(input.toolCallId) ?? '';
  if (normalizedToolCallId) {
    for (let index = 0; index < input.toolCards.length; index += 1) {
      if (input.consumedIndices.has(index)) {
        continue;
      }
      const tool = input.toolCards[index];
      if ((tool?.toolCallId ?? tool?.id) === normalizedToolCallId) {
        return index;
      }
    }
  }
  const normalizedToolName = normalizeOptionalString(input.toolName) ?? '';
  if (normalizedToolName) {
    for (let index = 0; index < input.toolCards.length; index += 1) {
      if (input.consumedIndices.has(index)) {
        continue;
      }
      const tool = input.toolCards[index];
      if (tool?.name === normalizedToolName) {
        return index;
      }
    }
  }
  return -1;
}

export function buildAssistantSegmentsFromToolCards(input: {
  toolCards: ReadonlyArray<SessionRenderToolCard>;
  updatedToolKeys?: ReadonlyArray<string>;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  const normalizedUpdatedKeys = new Set(
    (input.updatedToolKeys ?? [])
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );
  return input.toolCards.flatMap((tool) => {
    const toolKey = normalizeToolSegmentCardKey(tool);
    if (normalizedUpdatedKeys.size > 0 && !normalizedUpdatedKeys.has(toolKey)) {
      return [];
    }
    return [buildToolSegment(tool)];
  });
}

export function buildAssistantSegmentsFromMessageContent(input: {
  role: SessionMessageRole;
  entryKey: string;
  content: unknown;
  text: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  toolCards: ReadonlyArray<SessionRenderToolCard>;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  if (input.role !== 'assistant') {
    return [];
  }

  const segments: SessionAssistantTurnSegment[] = [];
  const consumedToolIndices = new Set<number>();
  let emittedInlineMedia = false;

  if (Array.isArray(input.content)) {
    for (const [index, block] of input.content.entries()) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const row = block as ContentBlockLike;
      const type = typeof row.type === 'string' ? row.type : '';
      if (type === 'thinking' && typeof row.thinking === 'string') {
        const segment = buildThinkingSegment(`${input.entryKey}:thinking:${index}`, row.thinking);
        if (segment) {
          segments.push(segment);
        }
        continue;
      }
      if (type === 'text' && typeof row.text === 'string') {
        const segment = buildMessageSegment(`${input.entryKey}:message:${index}`, row.text);
        if (segment) {
          segments.push(segment);
        }
        continue;
      }
      if (type === 'image') {
        const segment = buildMediaSegment({
          key: `${input.entryKey}:media:${index}`,
          images: extractImagesFromSingleBlock(row),
          attachedFiles: extractImagesAsAttachedFiles([row]),
        });
        if (segment) {
          emittedInlineMedia = true;
          segments.push(segment);
        }
        continue;
      }
      if (type === 'tool_use' || type === 'toolCall' || type === 'toolResult' || type === 'tool_result') {
        const toolIndex = findAssistantToolCardIndexForBlock({
          toolCards: input.toolCards,
          consumedIndices: consumedToolIndices,
          toolCallId: typeof row.toolCallId === 'string'
            ? row.toolCallId
            : (typeof row.id === 'string' ? row.id : undefined),
          toolName: typeof row.name === 'string' ? row.name : undefined,
        });
        if (toolIndex >= 0) {
          consumedToolIndices.add(toolIndex);
          const tool = input.toolCards[toolIndex];
          if (tool) {
            segments.push(buildToolSegment(tool));
          }
        }
      }
    }
  }

  if (segments.length === 0 && input.text.trim()) {
    const segment = buildMessageSegment(`${input.entryKey}:message:full`, input.text);
    if (segment) {
      segments.push(segment);
    }
  }

  for (let index = 0; index < input.toolCards.length; index += 1) {
    if (consumedToolIndices.has(index)) {
      continue;
    }
    const tool = input.toolCards[index];
    if (tool) {
      segments.push(buildToolSegment(tool));
    }
  }

  if (!emittedInlineMedia) {
    const segment = buildMediaSegment({
      key: `${input.entryKey}:media:tail`,
      images: input.images,
      attachedFiles: input.attachedFiles,
    });
    if (segment) {
      segments.push(segment);
    }
  }

  return segments;
}

function buildSegmentIdentity(segment: SessionAssistantTurnSegment): string {
  if (segment.kind === 'tool') {
    return `tool:${normalizeToolSegmentCardKey(segment.tool)}`;
  }
  return `${segment.kind}:${segment.key}`;
}

function hashSegmentText(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function isMonotonicMessageTextUpdate(existingText: string, incomingText: string): boolean {
  if (!existingText || !incomingText) {
    return true;
  }
  return incomingText === existingText
    || incomingText.startsWith(existingText)
    || existingText.startsWith(incomingText);
}

function cloneMessageSegmentWithVariantKey(
  segment: SessionAssistantMessageSegment,
): SessionAssistantMessageSegment {
  const textKey = hashSegmentText(segment.text.trim());
  return {
    ...structuredClone(segment),
    key: `${segment.key}:variant:${textKey}`,
  };
}

function buildNormalizedMessageSegmentTextSet(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
): Set<string> {
  return new Set(
    segments
      .filter((segment): segment is SessionAssistantMessageSegment => segment.kind === 'message')
      .map((segment) => segment.text.trim())
      .filter((text) => text.length > 0),
  );
}

function mergeAssistantSegmentSkeleton(
  existingSegments: ReadonlyArray<SessionAssistantTurnSegment>,
  incomingSegments: ReadonlyArray<SessionAssistantTurnSegment>,
): SessionAssistantTurnSegment[] {
  const merged = structuredClone(existingSegments);
  for (const incoming of incomingSegments) {
    const identity = buildSegmentIdentity(incoming);
    const existingIndex = merged.findIndex((segment) => buildSegmentIdentity(segment) === identity);
    if (existingIndex >= 0) {
      const existing = merged[existingIndex];
      if (
        existing?.kind === 'message'
        && incoming.kind === 'message'
        && !isMonotonicMessageTextUpdate(existing.text.trim(), incoming.text.trim())
      ) {
        const distinctIncoming = cloneMessageSegmentWithVariantKey(incoming);
        const distinctIdentity = buildSegmentIdentity(distinctIncoming);
        const distinctIndex = merged.findIndex((segment) => buildSegmentIdentity(segment) === distinctIdentity);
        if (distinctIndex >= 0) {
          merged[distinctIndex] = distinctIncoming;
        } else {
          merged.push(distinctIncoming);
        }
        continue;
      }
      merged[existingIndex] = structuredClone(incoming);
      continue;
    }
    merged.push(structuredClone(incoming));
  }
  return merged;
}

export function rebuildAssistantSegmentsFromMergedEntry(input: {
  role: SessionMessageRole | 'assistant';
  existingSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  incomingSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  thinking: string | null;
  text: string;
  images: ReadonlyArray<SessionRenderImage>;
  attachedFiles: ReadonlyArray<SessionRenderAttachedFile>;
  toolCards: ReadonlyArray<SessionRenderToolCard>;
}): ReadonlyArray<SessionAssistantTurnSegment> {
  if (input.role !== 'assistant') {
    return [];
  }

  const orderedSegments = mergeAssistantSegmentSkeleton(input.existingSegments, input.incomingSegments);
  const mergedToolByKey = new Map<string, SessionRenderToolCard>();
  for (const tool of input.toolCards) {
    mergedToolByKey.set(normalizeToolSegmentCardKey(tool), tool);
  }

  const incomingMessageTexts = buildNormalizedMessageSegmentTextSet(input.incomingSegments);
  const hasDistinctIncomingMessageSegments = incomingMessageTexts.size > 0;
  const thinkingSegmentCount = orderedSegments.filter((segment) => segment.kind === 'thinking').length;
  const mediaSegmentCount = orderedSegments.filter((segment) => segment.kind === 'media').length;
  const emittedToolKeys = new Set<string>();
  const rebuilt: SessionAssistantTurnSegment[] = [];

  for (const segment of orderedSegments) {
    if (segment.kind === 'tool') {
      const toolKey = normalizeToolSegmentCardKey(segment.tool);
      const mergedTool = mergedToolByKey.get(toolKey);
      if (!mergedTool || emittedToolKeys.has(toolKey)) {
        continue;
      }
      emittedToolKeys.add(toolKey);
      rebuilt.push(buildToolSegment(mergedTool));
      continue;
    }

    if (segment.kind === 'thinking') {
      const nextText = thinkingSegmentCount === 1 && input.thinking
        ? input.thinking
        : segment.text;
      const rebuiltSegment = buildThinkingSegment(segment.key, nextText);
      if (rebuiltSegment) {
        rebuilt.push(rebuiltSegment);
      }
      continue;
    }

    if (segment.kind === 'message') {
      const nextText = (
        hasDistinctIncomingMessageSegments
        && incomingMessageTexts.has(segment.text.trim())
      )
        ? segment.text
        : segment.text;
      const rebuiltSegment = buildMessageSegment(segment.key, nextText);
      if (rebuiltSegment) {
        rebuilt.push(rebuiltSegment);
      }
      continue;
    }

    const rebuiltSegment = mediaSegmentCount === 1
      ? buildMediaSegment({
          key: segment.key,
          images: input.images,
          attachedFiles: input.attachedFiles,
        })
      : buildMediaSegment({
          key: segment.key,
          images: segment.images,
          attachedFiles: segment.attachedFiles,
        });
    if (rebuiltSegment) {
      rebuilt.push(rebuiltSegment);
    }
  }

  const hasThinkingSegment = rebuilt.some((segment) => segment.kind === 'thinking');
  if (!hasThinkingSegment && input.thinking?.trim()) {
    const segment = buildThinkingSegment('merged:thinking', input.thinking);
    if (segment) {
      rebuilt.push(segment);
    }
  }

  const hasMessageSegment = rebuilt.some((segment) => segment.kind === 'message');
  const hasIncomingFullTextSegment = input.text.trim().length > 0
    && rebuilt.some((segment) => segment.kind === 'message' && segment.text.trim() === input.text.trim());
  if (!hasMessageSegment && input.text.trim()) {
    const segment = buildMessageSegment('merged:message:full', input.text);
    if (segment) {
      rebuilt.push(segment);
    }
  }
  if (!hasIncomingFullTextSegment && input.text.trim() && !incomingMessageTexts.has(input.text.trim())) {
    const segment = buildMessageSegment('merged:message:tail', input.text);
    if (segment) {
      rebuilt.push(segment);
    }
  }

  for (const tool of input.toolCards) {
    const toolKey = normalizeToolSegmentCardKey(tool);
    if (emittedToolKeys.has(toolKey)) {
      continue;
    }
    emittedToolKeys.add(toolKey);
    rebuilt.push(buildToolSegment(tool));
  }

  const hasMediaSegment = rebuilt.some((segment) => segment.kind === 'media');
  if (!hasMediaSegment) {
    const segment = buildMediaSegment({
      key: 'merged:media:tail',
      images: input.images,
      attachedFiles: input.attachedFiles,
    });
    if (segment) {
      rebuilt.push(segment);
    }
  }

  return rebuilt;
}
