import type {
  SessionAssistantTurnItem,
  SessionExecutionGraphItem,
  SessionExecutionGraphStep,
  SessionTimelineEntry,
  SessionTimelineMessageEntry,
  SessionTimelineTaskCompletionEntry,
  SessionTimelineToolActivityEntry,
} from '../../shared/session-adapter-types';

const MAX_GRAPH_STEPS = 32;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isAssistantActivityEntry(
  entry: SessionTimelineEntry,
): entry is SessionTimelineMessageEntry | SessionTimelineToolActivityEntry {
  return entry.role === 'assistant' && (entry.kind === 'message' || entry.kind === 'tool-activity');
}

export function isTaskCompletionEntry(entry: SessionTimelineEntry): entry is SessionTimelineTaskCompletionEntry {
  return entry.kind === 'task-completion';
}

function makeToolId(prefix: string, toolName: string, index: number): string {
  return `${prefix}:${toolName}:${index}`;
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

  const relevantAssistantEntries = entries.filter((entry) => (
    isAssistantActivityEntry(entry)
    && (
      entry.toolUses.length > 0
      || (entry.kind === 'message' && Boolean(normalizeText(entry.thinking)))
    )
  ));

  for (const [entryIndex, assistantEntry] of relevantAssistantEntries.entries()) {
    if (assistantEntry.kind === 'message') {
      const thinking = normalizeText(assistantEntry.thinking);
      if (thinking) {
        upsertStep({
          id: `history-thinking-${assistantEntry.entryId || assistantEntry.messageId || entryIndex}`,
          label: 'Thinking',
          status: assistantEntry.status === 'error' ? 'error' : 'completed',
          kind: 'thinking',
          detail: thinking,
          depth: 1,
        });
      }
    }

    for (const [toolIndex, tool] of assistantEntry.toolCards.entries()) {
      upsertStep({
        id: tool.toolCallId || tool.id || makeToolId(`history-tool-${assistantEntry.entryId || assistantEntry.key || entryIndex}`, tool.name, toolIndex),
        label: tool.name,
        status: tool.status,
        kind: 'tool',
        detail: normalizeText(tool.summary ?? tool.inputText ?? JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    }
  }

  const streamingEntry = [...entries].reverse().find((entry) => isAssistantActivityEntry(entry) && entry.status === 'streaming') ?? null;
  const streamingStatuses = streamingEntry?.toolStatuses ?? [];
  const streamingToolCards = streamingEntry?.toolCards ?? [];

  if (streamingEntry?.kind === 'message') {
    const thinking = normalizeText(streamingEntry.thinking);
    if (thinking) {
      upsertStep({
        id: 'stream-thinking',
        label: 'Thinking',
        status: 'running',
        kind: 'thinking',
        detail: thinking,
        depth: 1,
      });
    }
  }

  const activeToolIds = new Set<string>();
  const activeToolNamesWithoutIds = new Set<string>();

  for (const [index, tool] of streamingStatuses.entries()) {
    const id = tool.toolCallId || tool.id || makeToolId('stream-status', tool.name, index);
    activeToolIds.add(id);
    if (!tool.toolCallId && !tool.id) {
      activeToolNamesWithoutIds.add(tool.name);
    }
    upsertStep({
      id,
      label: tool.name,
      status: tool.status,
      kind: 'tool',
      detail: normalizeText(tool.summary),
      depth: 1,
    });
  }

  if (streamingEntry) {
    for (const [index, tool] of streamingToolCards.entries()) {
      const id = tool.toolCallId || tool.id || makeToolId('stream-tool', tool.name, index);
      if (activeToolIds.has(id) || activeToolNamesWithoutIds.has(tool.name)) {
        continue;
      }
      upsertStep({
        id,
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
  replyRow: SessionTimelineMessageEntry | SessionTimelineToolActivityEntry | SessionAssistantTurnItem | null,
): Pick<SessionExecutionGraphItem, 'laneKey' | 'turnKey' | 'agentId' | 'assistantTurnKey' | 'assistantLaneKey' | 'assistantLaneAgentId'> {
  if (!replyRow) {
    return {};
  }
  const isAssistantTurnItem = replyRow.kind === 'assistant-turn';
  return {
    laneKey: replyRow.laneKey,
    turnKey: replyRow.turnKey,
    agentId: replyRow.agentId,
    assistantTurnKey: isAssistantTurnItem ? (replyRow.turnKey ?? null) : (replyRow.assistantTurnKey ?? null),
    assistantLaneKey: isAssistantTurnItem ? (replyRow.laneKey ?? null) : (replyRow.assistantLaneKey ?? null),
    assistantLaneAgentId: isAssistantTurnItem ? (replyRow.agentId ?? null) : (replyRow.assistantLaneAgentId ?? null),
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
  replyRow: SessionTimelineMessageEntry | SessionTimelineToolActivityEntry | SessionAssistantTurnItem | null,
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
