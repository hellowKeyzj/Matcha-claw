import type {
  SessionAssistantTurnSegment,
  SessionRenderToolCard,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
} from '../../../shared/session-adapter-types';

function isAssistantTurnEntry(entry: SessionTimelineEntry): entry is SessionTimelineAssistantTurnEntry {
  return entry.kind === 'assistant-turn';
}

function hasToolResult(tool: SessionRenderToolCard): boolean {
  return tool.result.kind !== 'none' || tool.output !== undefined;
}

function closeMissingToolCardResult(tool: SessionRenderToolCard): SessionRenderToolCard {
  if (tool.status !== 'running' || hasToolResult(tool)) {
    return tool;
  }
  return {
    ...tool,
    status: 'missing_result',
  };
}

function closeMissingToolSegmentResult(segment: SessionAssistantTurnSegment): SessionAssistantTurnSegment {
  return segment.kind === 'tool'
    ? { ...segment, tool: closeMissingToolCardResult(segment.tool) }
    : segment;
}

export function closeMissingToolResultsForRun(
  entries: ReadonlyArray<SessionTimelineEntry>,
  runId: string | null,
): SessionTimelineEntry[] {
  if (!runId) {
    return entries.map((entry) => structuredClone(entry));
  }

  return entries.map((entry) => {
    if (entry.runId !== runId || !isAssistantTurnEntry(entry)) {
      return structuredClone(entry);
    }
    return {
      ...structuredClone(entry),
      segments: entry.segments.map(closeMissingToolSegmentResult),
      isStreaming: false,
    };
  });
}
