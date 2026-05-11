import type {
  SessionAssistantTurnSegment,
  SessionMessageRole,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
} from '../../shared/session-adapter-types';
import {
  type ContentBlockLike,
  extractImagesAsAttachedFiles,
  extractImagesFromSingleBlock,
} from './assistant-segment-media';
import {
  buildMediaSegment,
  buildMessageSegment,
  buildThinkingSegment,
  buildToolSegment,
  buildTurnScopedAssistantSegmentKey,
  countSegmentsOfKind,
  normalizeOptionalSegmentString,
  normalizeToolSegmentCardKey,
  type StableAssistantSegmentKind,
} from './assistant-segment-primitives';
import {
  mergeAssistantSegmentStream,
} from './assistant-segment-stream';

export {
  buildTurnScopedAssistantSegmentKey,
} from './assistant-segment-primitives';
export {
  mergeAssistantSegmentStream,
} from './assistant-segment-stream';

function findAssistantToolCardIndexForBlock(input: {
  toolCards: ReadonlyArray<SessionRenderToolCard>;
  consumedIndices: Set<number>;
  toolCallId?: string;
  toolName?: string;
}): number {
  const normalizedToolCallId = normalizeOptionalSegmentString(input.toolCallId) ?? '';
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
  const normalizedToolName = normalizeOptionalSegmentString(input.toolName) ?? '';
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
