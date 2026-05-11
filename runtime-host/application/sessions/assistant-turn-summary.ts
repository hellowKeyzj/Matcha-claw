import type {
  SessionAssistantTurnItem,
  SessionAssistantTurnSegment,
  SessionRenderAssistantBubbleToolResult,
  SessionRenderAttachedFile,
  SessionRenderImage,
  SessionRenderToolCard,
} from '../../shared/session-adapter-types';

export function buildEmbeddedToolResults(
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

export function deriveThinkingFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): string | null {
  const parts = segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'thinking' }> => segment.kind === 'thinking')
    .map((segment) => segment.text.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

export function deriveToolsFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): ReadonlyArray<SessionRenderToolCard> {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'tool' }> => segment.kind === 'tool')
    .map((segment) => structuredClone(segment.tool));
}

export function deriveTextFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): string {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'message' }> => segment.kind === 'message')
    .map((segment) => segment.text)
    .filter((text) => text.trim().length > 0)
    .join('\n');
}

export function deriveImagesFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): ReadonlyArray<SessionRenderImage> {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media')
    .flatMap((segment) => structuredClone(segment.images));
}

export function deriveAttachedFilesFromSegments(segments: ReadonlyArray<SessionAssistantTurnSegment>): ReadonlyArray<SessionRenderAttachedFile> {
  return segments
    .filter((segment): segment is Extract<SessionAssistantTurnSegment, { kind: 'media' }> => segment.kind === 'media')
    .flatMap((segment) => structuredClone(segment.attachedFiles));
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
