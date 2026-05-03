import type {
  SessionExecutionGraph,
  SessionExecutionGraphStep,
  SessionTaskCompletionEvent,
  SessionTimelineEntry,
} from '../../shared/session-adapter-types';

const MAX_GRAPH_STEPS = 32;

interface CompletionAnchor {
  eventEntry: SessionTimelineEntry;
  completionIndex: number;
  completionEvent: SessionTaskCompletionEvent;
  triggerEntry: SessionTimelineEntry;
  replyEntry: SessionTimelineEntry | null;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readEntryTaskCompletionEvents(entry: SessionTimelineEntry): SessionTaskCompletionEvent[] {
  return Array.isArray(entry.message.taskCompletionEvents)
    ? entry.message.taskCompletionEvents
    : [];
}

function extractEntryThinking(entry: SessionTimelineEntry): string | null {
  const content = entry.message.content;
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const row = block as { type?: unknown; thinking?: unknown };
    if (row.type !== 'thinking' || typeof row.thinking !== 'string') {
      continue;
    }
    const thinking = row.thinking.trim();
    if (thinking) {
      parts.push(thinking);
    }
  }

  const combined = parts.join('\n\n').trim();
  return combined || null;
}

function extractEntryToolUse(entry: SessionTimelineEntry): Array<{ id: string; name: string; input: unknown }> {
  const content = entry.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const tools: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') {
      continue;
    }
    const row = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown; arguments?: unknown };
    const type = typeof row.type === 'string' ? row.type : '';
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name || (type !== 'tool_use' && type !== 'toolCall')) {
      continue;
    }
    tools.push({
      id: typeof row.id === 'string' ? row.id : '',
      name,
      input: row.input ?? row.arguments,
    });
  }
  return tools;
}

function readEntryToolStatuses(entry: SessionTimelineEntry): Array<{
  id?: string;
  toolCallId?: string;
  name: string;
  status: 'running' | 'completed' | 'error';
  summary?: string;
}> {
  if (!Array.isArray(entry.message.toolStatuses)) {
    return [];
  }
  return entry.message.toolStatuses.flatMap((item) => {
    if (!item || typeof item !== 'object') {
      return [];
    }
    const row = item as {
      id?: unknown;
      toolCallId?: unknown;
      name?: unknown;
      status?: unknown;
      summary?: unknown;
    };
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    const status = row.status === 'running' || row.status === 'completed' || row.status === 'error'
      ? row.status
      : null;
    if (!name || !status) {
      return [];
    }
    return [{
      ...(typeof row.id === 'string' ? { id: row.id } : {}),
      ...(typeof row.toolCallId === 'string' ? { toolCallId: row.toolCallId } : {}),
      name,
      status,
      ...(typeof row.summary === 'string' && row.summary.trim() ? { summary: row.summary.trim() } : {}),
    }];
  });
}

function makeToolId(prefix: string, toolName: string, index: number): string {
  return `${prefix}:${toolName}:${index}`;
}

function parseSpawnAgentName(step: SessionExecutionGraphStep): string | null {
  const raw = step.detail || '';
  const match = raw.match(/"agentId"\s*:\s*"([^"]+)"/i) ?? raw.match(/agentId\s*:\s*([^\s,]+)/i);
  return match?.[1]?.trim() || null;
}

function isSpawnLikeStep(label: string): boolean {
  const normalized = label.trim().toLowerCase();
  return normalized === 'sessions_spawn' || /\bsessions[_-]?spawn\b/.test(normalized);
}

function attachTopology(steps: SessionExecutionGraphStep[]): SessionExecutionGraphStep[] {
  const withTopology: SessionExecutionGraphStep[] = [];
  let activeBranchNodeId: string | null = null;

  for (const step of steps) {
    if (isSpawnLikeStep(step.label)) {
      withTopology.push({
        ...step,
        depth: 1,
        parentId: 'agent-run',
      });
      const branchAgent = parseSpawnAgentName(step) ?? 'subagent';
      const branchNodeId = `${step.id}:branch`;
      withTopology.push({
        id: branchNodeId,
        label: `${branchAgent} subagent`,
        status: step.status,
        kind: 'system',
        detail: `Spawned branch for ${branchAgent}`,
        depth: 2,
        parentId: step.id,
      });
      activeBranchNodeId = branchNodeId;
      continue;
    }

    if (/sessions_yield/i.test(step.label)) {
      withTopology.push({
        ...step,
        depth: activeBranchNodeId ? 3 : 1,
        parentId: activeBranchNodeId ?? 'agent-run',
      });
      activeBranchNodeId = null;
      continue;
    }

    withTopology.push({
      ...step,
      depth: activeBranchNodeId ? 3 : 1,
      parentId: activeBranchNodeId ?? 'agent-run',
    });
  }

  return withTopology.slice(0, MAX_GRAPH_STEPS);
}

function deriveTaskSteps(entries: SessionTimelineEntry[]): SessionExecutionGraphStep[] {
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

  const streamingEntry = [...entries].reverse().find((entry) => entry.role === 'assistant' && entry.status === 'streaming') ?? null;
  const streamingTools = streamingEntry ? readEntryToolStatuses(streamingEntry) : [];

  if (streamingEntry) {
    const thinking = extractEntryThinking(streamingEntry);
    if (thinking) {
      pushStep({
        id: 'stream-thinking',
        label: 'Thinking',
        status: 'running',
        kind: 'thinking',
        detail: normalizeText(thinking),
        depth: 1,
      });
    }
  }

  for (const [index, tool] of streamingTools.entries()) {
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

  if (streamingEntry) {
    const toolUse = extractEntryToolUse(streamingEntry);
    for (const [index, tool] of toolUse.entries()) {
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

  const relevantAssistantEntries = entries.filter((entry) => {
    if (entry.role !== 'assistant') {
      return false;
    }
    return extractEntryToolUse(entry).length > 0 || Boolean(extractEntryThinking(entry));
  });

  for (const [entryIndex, assistantEntry] of relevantAssistantEntries.entries()) {
    const thinking = extractEntryThinking(assistantEntry);
    if (thinking) {
      pushStep({
        id: `history-thinking-${assistantEntry.entryId || assistantEntry.message.id || entryIndex}`,
        label: 'Thinking',
        status: 'completed',
        kind: 'thinking',
        detail: normalizeText(thinking),
        depth: 1,
      });
    }

    for (const [toolIndex, tool] of extractEntryToolUse(assistantEntry).entries()) {
      pushStep({
        id: tool.id || makeToolId(`history-tool-${assistantEntry.entryId || assistantEntry.message.id || entryIndex}`, tool.name, toolIndex),
        label: tool.name,
        status: 'completed',
        kind: 'tool',
        detail: normalizeText(JSON.stringify(tool.input, null, 2)),
        depth: 1,
      });
    }
  }

  return attachTopology(steps);
}

function findCompletionAnchors(entries: SessionTimelineEntry[]): CompletionAnchor[] {
  const anchors: CompletionAnchor[] = [];
  for (const [eventIndex, entry] of entries.entries()) {
    const completionEvents = readEntryTaskCompletionEvents(entry);
    if (completionEvents.length === 0) {
      continue;
    }

    let triggerEntry = entry;
    for (let index = eventIndex - 1; index >= 0; index -= 1) {
      const previousEntry = entries[index];
      if (previousEntry.role !== 'user') {
        continue;
      }
      if (readEntryTaskCompletionEvents(previousEntry).length > 0) {
        continue;
      }
      triggerEntry = previousEntry;
      break;
    }

    let replyEntry: SessionTimelineEntry | null = null;
    for (let index = eventIndex + 1; index < entries.length; index += 1) {
      if (entries[index]?.role === 'assistant') {
        replyEntry = entries[index];
        break;
      }
    }

    for (const [completionIndex, completionEvent] of completionEvents.entries()) {
      anchors.push({
        eventEntry: entry,
        completionIndex,
        completionEvent,
        triggerEntry,
        replyEntry,
      });
    }
  }
  return anchors;
}

function resolveAnchorLaneIdentity(
  entries: SessionTimelineEntry[],
  triggerEntryId: string,
  preferredReplyEntryId: string | null,
): {
  anchorEntryId: string;
  turnKey?: string;
  laneKey?: string;
} {
  if (preferredReplyEntryId) {
    const replyEntry = entries.find((entry) => entry.entryId === preferredReplyEntryId);
    if (replyEntry?.role === 'assistant') {
      return {
        anchorEntryId: replyEntry.entryId,
        ...(replyEntry.turnKey ? { turnKey: replyEntry.turnKey } : {}),
        ...(replyEntry.laneKey ? { laneKey: replyEntry.laneKey } : {}),
      };
    }
  }

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.role !== 'assistant') {
      continue;
    }
    return {
      anchorEntryId: entry.entryId,
      ...(entry.turnKey ? { turnKey: entry.turnKey } : {}),
      ...(entry.laneKey ? { laneKey: entry.laneKey } : {}),
    };
  }

  return {
    anchorEntryId: triggerEntryId,
  };
}

export function buildSessionExecutionGraphs(input: {
  sessionKey: string;
  entries: SessionTimelineEntry[];
  resolveChildEntries: (sessionKey: string) => SessionTimelineEntry[];
}): SessionExecutionGraph[] {
  const anchors = findCompletionAnchors(input.entries);
  const executionGraphs: SessionExecutionGraph[] = [];

  for (const anchor of anchors) {
    const childEntries = input.resolveChildEntries(anchor.completionEvent.childSessionKey);
    const mainStartIndex = Math.max(0, input.entries.findIndex((entry) => entry.entryId === anchor.triggerEntry.entryId));
    const mainEndIndexExclusive = anchor.replyEntry
      ? input.entries.findIndex((entry) => entry.entryId === anchor.replyEntry!.entryId) + 1
      : input.entries.length;
    const mainEntries = input.entries.slice(mainStartIndex, Math.max(mainStartIndex, mainEndIndexExclusive));
    const mainSteps = deriveTaskSteps(mainEntries);
    const childSteps = deriveTaskSteps(childEntries);
    const steps = [...mainSteps];
    const childAgentId = anchor.completionEvent.childAgentId ?? undefined;
    const agentLabel = childAgentId || 'subagent';
    if (childSteps.length > 0) {
      const childRootId = `child-root:${anchor.completionEvent.childSessionKey}`;
      steps.push({
        id: childRootId,
        label: `${agentLabel} subagent`,
        status: 'completed',
        kind: 'system',
        detail: anchor.completionEvent.childSessionKey,
        depth: 1,
        parentId: 'agent-run',
      });
      for (const [stepIndex, step] of childSteps.entries()) {
        steps.push({
          ...step,
          id: `child:${anchor.completionEvent.childSessionKey}:${step.id || stepIndex}`,
          depth: Math.max(step.depth + 1, 2),
          parentId: childRootId,
        });
      }
    }

    const anchorIdentity = resolveAnchorLaneIdentity(
      mainEntries.length > 0 ? mainEntries : input.entries,
      anchor.triggerEntry.entryId,
      anchor.replyEntry?.entryId ?? null,
    );
    executionGraphs.push({
      id: `${input.sessionKey}:${anchor.completionEvent.childSessionKey}:${anchor.eventEntry.entryId}:${anchor.completionIndex}`,
      anchorEntryId: anchorIdentity.anchorEntryId,
      ...(anchorIdentity.turnKey ? { anchorTurnKey: anchorIdentity.turnKey } : {}),
      ...(anchorIdentity.laneKey ? { anchorLaneKey: anchorIdentity.laneKey } : {}),
      triggerEntryId: anchor.triggerEntry.entryId,
      ...(anchor.replyEntry ? { replyEntryId: anchor.replyEntry.entryId } : {}),
      childSessionKey: anchor.completionEvent.childSessionKey,
      ...(anchor.completionEvent.childSessionId ? { childSessionId: anchor.completionEvent.childSessionId } : {}),
      ...(childAgentId ? { childAgentId } : {}),
      agentLabel,
      sessionLabel: anchor.completionEvent.childSessionId || anchor.completionEvent.childSessionKey,
      steps: steps.slice(0, MAX_GRAPH_STEPS),
      active: anchor.replyEntry == null,
    });
  }

  return executionGraphs;
}
