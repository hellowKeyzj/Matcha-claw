import {
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

type StableAssistantSegmentKind = 'thinking' | 'message' | 'media';

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildTurnScopedAssistantSegmentKey(input: {
  kind: StableAssistantSegmentKind;
  turnKey: string;
  laneKey: string;
  slot: number;
}): string {
  return `${input.kind}:${input.turnKey}:${input.laneKey}:${input.slot}`;
}

function cloneSegmentWithKey<T extends SessionAssistantTurnSegment>(segment: T, key: string): T {
  return {
    ...structuredClone(segment),
    key,
  };
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

function countSegmentsOfKind(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  kind: StableAssistantSegmentKind,
): number {
  return segments.filter((segment) => segment.kind === kind).length;
}

function findLastSegmentIndexByKind(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  kind: StableAssistantSegmentKind,
): number {
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index]?.kind === kind) {
      return index;
    }
  }
  return -1;
}

function hasLaterDifferentKindSegment(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  index: number,
  kind: StableAssistantSegmentKind,
): boolean {
  for (let cursor = index + 1; cursor < segments.length; cursor += 1) {
    if (segments[cursor]?.kind !== kind) {
      return true;
    }
  }
  return false;
}

function findToolSegmentIndex(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  toolKey: string,
): number {
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment?.kind !== 'tool') {
      continue;
    }
    if (normalizeToolSegmentCardKey(segment.tool) === toolKey) {
      return index;
    }
  }
  return -1;
}

export function mergeAssistantSegmentStream(input: {
  turnKey: string;
  laneKey: string;
  existingSegments: ReadonlyArray<SessionAssistantTurnSegment>;
  incomingSegments: ReadonlyArray<SessionAssistantTurnSegment>;
}): SessionAssistantTurnSegment[] {
  const merged = structuredClone(input.existingSegments);
  for (const incoming of input.incomingSegments) {
    if (incoming.kind === 'tool') {
      const toolKey = normalizeToolSegmentCardKey(incoming.tool);
      const existingIndex = findToolSegmentIndex(merged, toolKey);
      if (existingIndex >= 0) {
        merged[existingIndex] = structuredClone(incoming);
      } else {
        merged.push(structuredClone(incoming));
      }
      continue;
    }

    const latestIndex = findLastSegmentIndexByKind(merged, incoming.kind);
    if (latestIndex >= 0 && !hasLaterDifferentKindSegment(merged, latestIndex, incoming.kind)) {
      merged[latestIndex] = cloneSegmentWithKey(incoming, merged[latestIndex]!.key);
      continue;
    }

    const slot = countSegmentsOfKind(merged, incoming.kind);
    merged.push(cloneSegmentWithKey(incoming, buildTurnScopedAssistantSegmentKey({
      kind: incoming.kind,
      turnKey: input.turnKey,
      laneKey: input.laneKey,
      slot,
    })));
  }
  return merged;
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
  turnKey: string;
  laneKey: string;
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
  const slots: Record<StableAssistantSegmentKind, number> = {
    thinking: 0,
    message: 0,
    media: 0,
  };
  let emittedInlineMedia = false;

  const nextSegmentKey = (kind: StableAssistantSegmentKind): string => {
    const slot = slots[kind];
    slots[kind] += 1;
    return buildTurnScopedAssistantSegmentKey({
      kind,
      turnKey: input.turnKey,
      laneKey: input.laneKey,
      slot,
    });
  };

  if (Array.isArray(input.content)) {
    for (const block of input.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      const row = block as ContentBlockLike;
      const type = typeof row.type === 'string' ? row.type : '';
      if (type === 'thinking' && typeof row.thinking === 'string') {
        const segment = buildThinkingSegment(nextSegmentKey('thinking'), row.thinking);
        if (segment) {
          segments.push(segment);
        }
        continue;
      }
      if (type === 'text' && typeof row.text === 'string') {
        const segment = buildMessageSegment(nextSegmentKey('message'), row.text);
        if (segment) {
          segments.push(segment);
        }
        continue;
      }
      if (type === 'image') {
        const segment = buildMediaSegment({
          key: nextSegmentKey('media'),
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
    const segment = buildMessageSegment(nextSegmentKey('message'), input.text);
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
      key: nextSegmentKey('media'),
      images: input.images,
      attachedFiles: input.attachedFiles,
    });
    if (segment) {
      segments.push(segment);
    }
  }

  return segments;
}

export function rebuildAssistantSegmentsFromMergedEntry(input: {
  role: SessionMessageRole | 'assistant';
  turnKey: string;
  laneKey: string;
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

  const orderedSegments = mergeAssistantSegmentStream({
    turnKey: input.turnKey,
    laneKey: input.laneKey,
    existingSegments: input.existingSegments,
    incomingSegments: input.incomingSegments,
  });
  const mergedToolByKey = new Map<string, SessionRenderToolCard>();
  for (const tool of input.toolCards) {
    mergedToolByKey.set(normalizeToolSegmentCardKey(tool), tool);
  }

  const messageSegmentCount = countSegmentsOfKind(orderedSegments, 'message');
  const thinkingSegmentCount = countSegmentsOfKind(orderedSegments, 'thinking');
  const mediaSegmentCount = countSegmentsOfKind(orderedSegments, 'media');
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
      const rebuiltSegment = buildThinkingSegment(
        segment.key,
        thinkingSegmentCount === 1 ? (input.thinking ?? segment.text) : segment.text,
      );
      if (rebuiltSegment) {
        rebuilt.push(rebuiltSegment);
      }
      continue;
    }

    if (segment.kind === 'message') {
      const rebuiltSegment = buildMessageSegment(
        segment.key,
        messageSegmentCount === 1 ? input.text : segment.text,
      );
      if (rebuiltSegment) {
        rebuilt.push(rebuiltSegment);
      }
      continue;
    }

    const rebuiltSegment = buildMediaSegment(
      mediaSegmentCount === 1
        ? {
            key: segment.key,
            images: input.images,
            attachedFiles: input.attachedFiles,
          }
        : {
            key: segment.key,
            images: segment.images,
            attachedFiles: segment.attachedFiles,
          },
    );
    if (rebuiltSegment) {
      rebuilt.push(rebuiltSegment);
    }
  }

  if (!rebuilt.some((segment) => segment.kind === 'thinking') && input.thinking?.trim()) {
    const segment = buildThinkingSegment(
      buildTurnScopedAssistantSegmentKey({
        kind: 'thinking',
        turnKey: input.turnKey,
        laneKey: input.laneKey,
        slot: 0,
      }),
      input.thinking,
    );
    if (segment) {
      rebuilt.push(segment);
    }
  }

  if (!rebuilt.some((segment) => segment.kind === 'message') && input.text.trim()) {
    const segment = buildMessageSegment(
      buildTurnScopedAssistantSegmentKey({
        kind: 'message',
        turnKey: input.turnKey,
        laneKey: input.laneKey,
        slot: 0,
      }),
      input.text,
    );
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

  if (!rebuilt.some((segment) => segment.kind === 'media')) {
    const segment = buildMediaSegment({
      key: buildTurnScopedAssistantSegmentKey({
        kind: 'media',
        turnKey: input.turnKey,
        laneKey: input.laneKey,
        slot: 0,
      }),
      images: input.images,
      attachedFiles: input.attachedFiles,
    });
    if (segment) {
      rebuilt.push(segment);
    }
  }

  return rebuilt;
}
