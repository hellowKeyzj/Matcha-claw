import type {
  SessionAssistantTurnItem,
  SessionExecutionGraphItem,
  SessionExecutionGraphStep,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
  SessionTimelineTaskCompletionEntry,
} from '../../shared/session-adapter-types';

const MAX_GRAPH_STEPS = 32;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isAssistantTurnTimelineEntry(
  entry: SessionTimelineEntry,
): entry is SessionTimelineAssistantTurnEntry {
  return entry.kind === 'assistant-turn';
}

export function isTaskCompletionEntry(entry: SessionTimelineEntry): entry is SessionTimelineTaskCompletionEntry {
  return entry.kind === 'task-completion';
}

function makeToolId(prefix: string, toolName: string, index: number): string {
  return `${prefix}:${toolName}:${index}`;
}

function readTurnSummary(entry: SessionTimelineAssistantTurnEntry): {
  thinking: string | undefined;
  tools: ReadonlyArray<{ id: string; toolCallId?: string; name: string; status: 'running' | 'completed' | 'error' | 'missing_result'; summary?: string; inputText?: string; input: unknown }>;
} {
  let thinking: string | undefined;
  const tools: Array<{ id: string; toolCallId?: string; name: string; status: 'running' | 'completed' | 'error' | 'missing_result'; summary?: string; inputText?: string; input: unknown }> = [];
  for (const segment of entry.segments) {
    if (segment.kind === 'thinking') {
      thinking = thinking ? `${thinking}\n\n${segment.text}` : segment.text;
      continue;
    }
    if (segment.kind === 'tool') {
      tools.push({
        id: segment.tool.id,
        ...(segment.tool.toolCallId ? { toolCallId: segment.tool.toolCallId } : {}),
        name: segment.tool.name,
        status: segment.tool.status,
        ...(segment.tool.summary ? { summary: segment.tool.summary } : {}),
        ...(segment.tool.inputText ? { inputText: segment.tool.inputText } : {}),
        input: segment.tool.input,
      });
    }
  }
  return { thinking: normalizeText(thinking), tools };
}

export function deriveExecutionGraphSteps(entries: SessionTimelineEntry[]): SessionExecutionGraphStep[] {
  const steps: SessionExecutionGraphStep[] = [];
  const stepIndexById = new Map<string, number>();

  const upsertStep = (step: SessionExecutionGraphStep): void => {
    const existingIndex = stepIndexById.get(step.id);
    if (existingIndex == null) {
      stepIndexById.set(step.id, steps.length);
      steps.push(step);
      return;
    }
    const existing = steps[existingIndex]!;
    steps[existingIndex] = {
      ...existing,
      ...step,
      detail: step.detail ?? existing.detail,
    };
  };

  const turnEntries = entries.filter(isAssistantTurnTimelineEntry);
  for (const [entryIndex, entry] of turnEntries.entries()) {
    const summary = readTurnSummary(entry);
    if (summary.thinking) {
      upsertStep({
        id: `history-thinking-${entry.entryId || entry.messageId || entryIndex}`,
        label: 'Thinking',
        status: entry.status === 'error' ? 'error' : 'completed',
        kind: 'thinking',
        detail: summary.thinking,
        depth: 1,
      });
    }
    for (const [toolIndex, tool] of summary.tools.entries()) {
      upsertStep({
        id: tool.toolCallId || tool.id || makeToolId(`history-tool-${entry.entryId || entry.key || entryIndex}`, tool.name, toolIndex),
        label: tool.name,
        status: tool.status,
        kind: 'tool',
        detail: normalizeText(tool.summary ?? tool.inputText ?? JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    }
  }

  const streamingEntry = [...turnEntries].reverse().find((entry) => entry.status === 'streaming' || entry.isStreaming) ?? null;
  if (streamingEntry) {
    const summary = readTurnSummary(streamingEntry);
    if (summary.thinking) {
      upsertStep({
        id: 'stream-thinking',
        label: 'Thinking',
        status: 'running',
        kind: 'thinking',
        detail: summary.thinking,
        depth: 1,
      });
    }
    for (const [toolIndex, tool] of summary.tools.entries()) {
      upsertStep({
        id: tool.toolCallId || tool.id || makeToolId('stream-tool', tool.name, toolIndex),
        label: tool.name,
        status: tool.status,
        kind: 'tool',
        detail: normalizeText(tool.summary ?? tool.inputText ?? JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    }
  }

  return steps.length > MAX_GRAPH_STEPS
    ? steps.slice(-MAX_GRAPH_STEPS)
    : steps;
}

function resolveAnchorIdentity(
  replyRow: SessionTimelineAssistantTurnEntry | SessionAssistantTurnItem | null,
): Pick<SessionExecutionGraphItem, 'laneKey' | 'turnKey' | 'agentId'> {
  if (!replyRow) {
    return {};
  }
  return {
    ...(replyRow.laneKey ? { laneKey: replyRow.laneKey } : {}),
    ...(replyRow.turnKey ? { turnKey: replyRow.turnKey } : {}),
    ...(replyRow.agentId ? { agentId: replyRow.agentId } : {}),
  };
}

function buildExecutionGraphSteps(
  graph: SessionExecutionGraphItem,
  childSteps: SessionExecutionGraphStep[],
): SessionExecutionGraphStep[] {
  const steps: SessionExecutionGraphStep[] = [...graph.steps.filter((step) => !step.id.startsWith('child-root:') && !step.id.startsWith(`child:${graph.childSessionKey}:`))];
  if (childSteps.length > 0) {
    const childRootId = `child-root:${graph.childSessionKey}`;
    steps.push({
      id: childRootId,
      label: `${graph.agentLabel} subagent`,
      status: 'completed',
      kind: 'system',
      detail: graph.childSessionKey,
      depth: 1,
      parentId: 'agent-run',
    });
    for (const [stepIndex, step] of childSteps.entries()) {
      steps.push({
        ...step,
        id: `child:${graph.childSessionKey}:${step.id || stepIndex}`,
        depth: Math.max(step.depth + 1, 2),
        parentId: childRootId,
      });
    }
  }
  return steps.slice(0, MAX_GRAPH_STEPS);
}

export function createExecutionGraphItem(
  completionRow: SessionTimelineTaskCompletionEntry,
  triggerRow: SessionTimelineEntry,
): SessionExecutionGraphItem {
  const childAgentId = completionRow.childAgentId ?? undefined;
  const graphId = `${completionRow.sessionKey}:${completionRow.childSessionKey}:${completionRow.key}`;
  return {
    key: `session:${completionRow.sessionKey}|graph:${graphId}`,
    kind: 'execution-graph',
    sessionKey: completionRow.sessionKey,
    role: 'assistant',
    text: '',
    createdAt: triggerRow.createdAt ?? completionRow.createdAt,
    status: 'final',
    entryId: `graph:${graphId}`,
    graphId,
    completionItemKey: completionRow.key,
    anchorItemKey: triggerRow.key,
    childSessionKey: completionRow.childSessionKey,
    ...(completionRow.childSessionId ? { childSessionId: completionRow.childSessionId } : {}),
    ...(childAgentId ? { childAgentId } : {}),
    agentLabel: childAgentId || 'subagent',
    sessionLabel: completionRow.childSessionId || completionRow.childSessionKey,
    steps: [],
    active: true,
    triggerItemKey: triggerRow.key,
  };
}

export function attachExecutionGraphReply(
  graph: SessionExecutionGraphItem,
  replyRow: SessionTimelineAssistantTurnEntry | SessionAssistantTurnItem | null,
): SessionExecutionGraphItem {
  if (!replyRow) {
    return {
      ...graph,
      replyItemKey: undefined,
      anchorItemKey: graph.triggerItemKey,
      active: true,
      ...resolveAnchorIdentity(null),
    };
  }
  return {
    ...graph,
    replyItemKey: replyRow.key,
    anchorItemKey: replyRow.key,
    createdAt: replyRow.createdAt ?? graph.createdAt,
    active: false,
    ...resolveAnchorIdentity(replyRow),
  };
}

export function updateExecutionGraphMainSteps(
  graph: SessionExecutionGraphItem,
  mainSteps: SessionExecutionGraphStep[],
): SessionExecutionGraphItem {
  const childSteps = graph.steps
    .filter((step) => step.id.startsWith(`child:${graph.childSessionKey}:`))
    .map((step) => ({
      ...step,
      depth: Math.max(step.depth - 1, 1),
      parentId: undefined,
      id: step.id.slice(`child:${graph.childSessionKey}:`.length),
    }));
  return {
    ...graph,
    steps: buildExecutionGraphSteps({
      ...graph,
      steps: mainSteps,
    }, childSteps),
  };
}

export function updateExecutionGraphChildSteps(
  graph: SessionExecutionGraphItem,
  childSteps: SessionExecutionGraphStep[],
): SessionExecutionGraphItem {
  const mainSteps = graph.steps.filter((step) => !step.id.startsWith('child-root:') && !step.id.startsWith(`child:${graph.childSessionKey}:`));
  return {
    ...graph,
    steps: buildExecutionGraphSteps({
      ...graph,
      steps: mainSteps,
    }, childSteps),
  };
}
