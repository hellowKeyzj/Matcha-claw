import type {
  SessionExecutionGraphRow,
  SessionExecutionGraphStep,
  SessionMessageRow,
  SessionRenderRow,
  SessionTaskCompletionRow,
  SessionToolActivityRow,
} from '../../shared/session-adapter-types';

const MAX_GRAPH_STEPS = 32;

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isAssistantActivityRow(
  row: SessionRenderRow,
): row is SessionMessageRow | SessionToolActivityRow {
  return row.role === 'assistant' && (row.kind === 'message' || row.kind === 'tool-activity');
}

export function isTaskCompletionRow(row: SessionRenderRow): row is SessionTaskCompletionRow {
  return row.kind === 'task-completion';
}

function makeToolId(prefix: string, toolName: string, index: number): string {
  return `${prefix}:${toolName}:${index}`;
}

export function deriveExecutionGraphSteps(rows: SessionRenderRow[]): SessionExecutionGraphStep[] {
  const steps: SessionExecutionGraphStep[] = [];
  const seenIds = new Set<string>();
  const activeToolNames = new Set<string>();

  const pushStep = (step: SessionExecutionGraphStep): void => {
    if (seenIds.has(step.id)) {
      return;
    }
    seenIds.add(step.id);
    steps.push(step);
  };

  const streamingRow = [...rows].reverse().find((row) => isAssistantActivityRow(row) && row.status === 'streaming') ?? null;
  const streamingStatuses = streamingRow?.toolStatuses ?? [];

  if (streamingRow?.kind === 'message') {
    const thinking = normalizeText(streamingRow.thinking);
    if (thinking) {
      pushStep({
        id: 'stream-thinking',
        label: 'Thinking',
        status: 'running',
        kind: 'thinking',
        detail: thinking,
        depth: 1,
      });
    }
  }

  for (const [index, tool] of streamingStatuses.entries()) {
    activeToolNames.add(tool.name);
    pushStep({
      id: tool.toolCallId || tool.id || makeToolId('stream-status', tool.name, index),
      label: tool.name,
      status: tool.status,
      kind: 'tool',
      detail: normalizeText(tool.summary),
      depth: 1,
    });
  }

  if (streamingRow) {
    for (const [index, tool] of streamingRow.toolUses.entries()) {
      if (activeToolNames.has(tool.name)) {
        continue;
      }
      pushStep({
        id: tool.id || makeToolId('stream-tool', tool.name, index),
        label: tool.name,
        status: 'running',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    }
  }

  const relevantAssistantRows = rows.filter((row) => (
    isAssistantActivityRow(row)
    && (
      row.toolUses.length > 0
      || (row.kind === 'message' && Boolean(normalizeText(row.thinking)))
    )
  ));

  for (const [rowIndex, assistantRow] of relevantAssistantRows.entries()) {
    if (assistantRow.kind === 'message') {
      const thinking = normalizeText(assistantRow.thinking);
      if (thinking) {
        pushStep({
          id: `history-thinking-${assistantRow.rowId || assistantRow.messageId || rowIndex}`,
          label: 'Thinking',
          status: assistantRow.status === 'error' ? 'error' : 'completed',
          kind: 'thinking',
          detail: thinking,
          depth: 1,
        });
      }
    }

    for (const [toolIndex, tool] of assistantRow.toolUses.entries()) {
      const status = assistantRow.toolStatuses.find((candidate) => (
        (candidate.toolCallId && candidate.toolCallId === tool.id)
        || (candidate.id && candidate.id === tool.id)
        || candidate.name === tool.name
      ))?.status ?? 'completed';
      pushStep({
        id: tool.id || makeToolId(`history-tool-${assistantRow.rowId || assistantRow.key || rowIndex}`, tool.name, toolIndex),
        label: tool.name,
        status,
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    }
  }

  return steps.slice(0, MAX_GRAPH_STEPS);
}

function resolveAnchorIdentity(
  replyRow: SessionMessageRow | SessionToolActivityRow | null,
): Pick<SessionExecutionGraphRow, 'laneKey' | 'turnKey' | 'agentId' | 'assistantTurnKey' | 'assistantLaneKey' | 'assistantLaneAgentId'> {
  if (!replyRow) {
    return {};
  }
  return {
    laneKey: replyRow.laneKey,
    turnKey: replyRow.turnKey,
    agentId: replyRow.agentId,
    assistantTurnKey: replyRow.assistantTurnKey ?? null,
    assistantLaneKey: replyRow.assistantLaneKey ?? null,
    assistantLaneAgentId: replyRow.assistantLaneAgentId ?? null,
  };
}

function buildExecutionGraphSteps(
  graph: SessionExecutionGraphRow,
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

export function createExecutionGraphRow(
  completionRow: SessionTaskCompletionRow,
  triggerRow: SessionRenderRow,
): SessionExecutionGraphRow {
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
    rowId: `graph:${graphId}`,
    graphId,
    completionRowKey: completionRow.key,
    anchorRowKey: triggerRow.key,
    childSessionKey: completionRow.childSessionKey,
    ...(completionRow.childSessionId ? { childSessionId: completionRow.childSessionId } : {}),
    ...(childAgentId ? { childAgentId } : {}),
    agentLabel: childAgentId || 'subagent',
    sessionLabel: completionRow.childSessionId || completionRow.childSessionKey,
    steps: [],
    active: true,
    triggerRowKey: triggerRow.key,
  };
}

export function attachExecutionGraphReply(
  graph: SessionExecutionGraphRow,
  replyRow: SessionMessageRow | SessionToolActivityRow | null,
): SessionExecutionGraphRow {
  if (!replyRow) {
    return {
      ...graph,
      replyRowKey: undefined,
      anchorRowKey: graph.triggerRowKey,
      active: true,
      ...resolveAnchorIdentity(null),
    };
  }
  return {
    ...graph,
    replyRowKey: replyRow.key,
    anchorRowKey: replyRow.key,
    createdAt: replyRow.createdAt ?? graph.createdAt,
    active: false,
    ...resolveAnchorIdentity(replyRow),
  };
}

export function updateExecutionGraphMainSteps(
  graph: SessionExecutionGraphRow,
  mainSteps: SessionExecutionGraphStep[],
): SessionExecutionGraphRow {
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
  graph: SessionExecutionGraphRow,
  childSteps: SessionExecutionGraphStep[],
): SessionExecutionGraphRow {
  const mainSteps = graph.steps.filter((step) => !step.id.startsWith('child-root:') && !step.id.startsWith(`child:${graph.childSessionKey}:`));
  return {
    ...graph,
    steps: buildExecutionGraphSteps({
      ...graph,
      steps: mainSteps,
    }, childSteps),
  };
}
