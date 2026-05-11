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
} from '../../shared/session-adapter-types';

export type StableAssistantSegmentKind = 'thinking' | 'message' | 'media';

export function normalizeOptionalSegmentString(value: unknown): string | undefined {
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

export function cloneSegmentWithKey<T extends SessionAssistantTurnSegment>(segment: T, key: string): T {
  return {
    ...structuredClone(segment),
    key,
  };
}

export function buildThinkingSegment(key: string, text: string): SessionAssistantThinkingSegment | null {
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

export function buildMessageSegment(key: string, text: string): SessionAssistantMessageSegment | null {
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

export function buildMediaSegment(input: {
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

export function normalizeToolSegmentCardKey(tool: SessionRenderToolCard): string {
  return normalizeOptionalSegmentString(tool.toolCallId ?? tool.id ?? tool.name) ?? tool.name;
}

export function buildToolSegment(tool: SessionRenderToolCard): SessionAssistantToolSegment {
  return {
    kind: 'tool',
    key: normalizeToolSegmentCardKey(tool),
    tool: structuredClone(tool),
  };
}

export function countSegmentsOfKind(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
  kind: StableAssistantSegmentKind,
): number {
  return segments.filter((segment) => segment.kind === kind).length;
}
