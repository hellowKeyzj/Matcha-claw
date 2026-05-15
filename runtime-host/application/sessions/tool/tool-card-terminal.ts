import type {
  SessionAssistantTurnSegment,
  SessionRenderToolCard,
  SessionRenderToolStatus,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineToolActivityEntry,
} from '../../../shared/session-adapter-types';

function isToolBearingEntry(entry: SessionTimelineEntry): entry is SessionTimelineMessageEntry | SessionTimelineToolActivityEntry {
  return entry.kind === 'message' || entry.kind === 'tool-activity';
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

function closeMissingToolStatusResult(status: SessionRenderToolStatus): SessionRenderToolStatus {
  return status.status === 'running'
    ? { ...status, status: 'missing_result' }
    : status;
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
    if (entry.runId !== runId || !isToolBearingEntry(entry)) {
      return structuredClone(entry);
    }
    return {
      ...structuredClone(entry),
      toolStatuses: entry.toolStatuses.map(closeMissingToolStatusResult),
      toolCards: entry.toolCards.map(closeMissingToolCardResult),
      assistantSegments: entry.assistantSegments.map(closeMissingToolSegmentResult),
      isStreaming: false,
    };
  });
}
