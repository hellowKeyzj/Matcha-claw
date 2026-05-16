import type {
  SessionAssistantTurnItem,
  SessionAssistantTurnSegment,
  SessionRenderItem,
  SessionStateSnapshot,
} from '../../shared/session-adapter-types';
import {
  isStateOnlyToolCard,
} from './state-only-tools';

function filterAssistantTurnSegments(
  segments: ReadonlyArray<SessionAssistantTurnSegment>,
): SessionAssistantTurnSegment[] {
  return segments
    .filter((segment) => segment.kind !== 'tool' || !isStateOnlyToolCard(segment.tool))
    .map((segment) => structuredClone(segment));
}

function filterAssistantTurnItem(item: SessionAssistantTurnItem): SessionAssistantTurnItem | null {
  const segments = filterAssistantTurnSegments(item.segments);
  if (segments.length === item.segments.length) {
    return structuredClone(item);
  }

  const tools = item.tools.filter((tool) => !isStateOnlyToolCard(tool)).map((tool) => structuredClone(tool));
  const embeddedToolResults = (item.embeddedToolResults ?? [])
    .filter((result) => !isStateOnlyToolCard({ name: result.toolName }))
    .map((result) => structuredClone(result));
  const textSegments = segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message');
  const thinkingSegments = segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking');
  const mediaSegments = segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media');
  const text = textSegments.map((segment) => segment.text).filter((value) => value.trim()).join('\n');
  const thinkingParts = thinkingSegments.map((segment) => segment.text.trim()).filter(Boolean);
  const images = mediaSegments.flatMap((segment) => structuredClone(segment.images));
  const attachedFiles = mediaSegments.flatMap((segment) => structuredClone(segment.attachedFiles));

  if (
    segments.length === 0
    && !text.trim()
    && tools.length === 0
    && images.length === 0
    && attachedFiles.length === 0
    && thinkingParts.length === 0
  ) {
    return null;
  }

  return {
    ...structuredClone(item),
    segments,
    tools,
    embeddedToolResults,
    text,
    thinking: thinkingParts.length > 0 ? thinkingParts.join('\n\n') : null,
    images,
    attachedFiles,
  };
}

export function filterStateOnlyRenderItem(item: SessionRenderItem | null): SessionRenderItem | null {
  if (!item) {
    return null;
  }
  if (item.kind !== 'assistant-turn') {
    return structuredClone(item);
  }
  return filterAssistantTurnItem(item);
}

export function filterStateOnlyRenderItems(items: ReadonlyArray<SessionRenderItem>): SessionRenderItem[] {
  return items.flatMap((item) => {
    const filtered = filterStateOnlyRenderItem(item);
    return filtered ? [filtered] : [];
  });
}

export function filterStateOnlySnapshot(snapshot: SessionStateSnapshot): SessionStateSnapshot {
  const items = filterStateOnlyRenderItems(snapshot.items);
  if (items.length === snapshot.items.length) {
    return structuredClone(snapshot);
  }
  return {
    ...structuredClone(snapshot),
    items,
    window: {
      ...snapshot.window,
      totalItemCount: Math.min(snapshot.window.totalItemCount, items.length),
      windowStartOffset: 0,
      windowEndOffset: items.length,
      hasMore: false,
      hasNewer: false,
      isAtLatest: true,
    },
  };
}
