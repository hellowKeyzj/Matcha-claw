import type {
  SessionAssistantTurnItem,
  SessionExecutionGraphItem,
  SessionRenderItem,
  SessionRenderTaskCompletionItem,
  SessionRenderUserMessageItem,
  SessionRuntimeStateSnapshot,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
  SessionTimelineUserMessageEntry,
} from '../../shared/session-adapter-types';
import {
  assembleAuthoritativeAssistantTurns,
  hasAssistantTurnOutput,
} from './assistant-turn-assembler';
import {
  filterStateOnlyRenderItem,
} from './session-state-only-render-filter';
import type {
  PendingRunClosureSignal,
} from './session-runtime-types';
import {
  normalizeString,
} from './session-value-normalization';

export function cloneRenderItems(items: SessionRenderItem[]): SessionRenderItem[] {
  return structuredClone(items);
}

export function isAssistantTurnTimelineEntry(
  entry: SessionTimelineEntry,
): entry is SessionTimelineAssistantTurnEntry {
  return entry.kind === 'assistant-turn';
}

export function collectPendingRunClosureSignal(
  renderItems: ReadonlyArray<SessionRenderItem>,
  runtime: SessionRuntimeStateSnapshot,
): PendingRunClosureSignal {
  const activeRunId = normalizeString(runtime.activeRunId);
  const pendingTurnKey = normalizeString(runtime.pendingTurnKey);
  const pendingTurnLaneKey = normalizeString(runtime.pendingTurnLaneKey) || 'main';
  const signal: PendingRunClosureSignal = {
    hasActiveAssistantStream: false,
    hasBlockingToolActivity: false,
    hasFinalAssistantTurn: false,
    hasMatchingRunEvidence: false,
  };

  for (const item of renderItems) {
    if (item.kind !== 'assistant-turn') {
      continue;
    }
    if (!hasAssistantTurnOutput(item)) {
      continue;
    }
    const itemTurnKey = normalizeString(item.turnKey);
    const samePendingTurn = pendingTurnKey
      && (itemTurnKey === pendingTurnKey || itemTurnKey === `anchor:${pendingTurnKey}`)
      && (!pendingTurnLaneKey || item.laneKey === pendingTurnLaneKey);
    const sameRun = activeRunId && normalizeString(item.runId) === activeRunId;
    if (!samePendingTurn && !sameRun) {
      continue;
    }
    signal.hasMatchingRunEvidence = true;
    if (item.status === 'streaming') {
      signal.hasActiveAssistantStream = true;
      continue;
    }
    if (item.status === 'waiting_tool') {
      signal.hasBlockingToolActivity = true;
      continue;
    }
    if (item.status === 'final' || item.status === 'error' || item.status === 'aborted') {
      signal.hasFinalAssistantTurn = true;
    }
  }

  return signal;
}

function sortExecutionGraphItems(graphs: SessionExecutionGraphItem[]): SessionExecutionGraphItem[] {
  return [...graphs].sort((left, right) => {
    const leftCreatedAt = typeof left.createdAt === 'number' ? left.createdAt : 0;
    const rightCreatedAt = typeof right.createdAt === 'number' ? right.createdAt : 0;
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }
    return left.key.localeCompare(right.key);
  });
}

function buildUserMessageItem(entry: SessionTimelineUserMessageEntry): SessionRenderUserMessageItem {
  return {
    key: entry.key,
    kind: 'user-message',
    sessionKey: entry.sessionKey,
    role: 'user',
    text: entry.text,
    images: structuredClone(entry.images),
    attachedFiles: structuredClone(entry.attachedFiles),
    ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
    ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
    ...(entry.runId ? { runId: entry.runId } : {}),
    ...(entry.laneKey ? { laneKey: entry.laneKey } : {}),
    ...(entry.turnKey ? { turnKey: entry.turnKey } : {}),
    ...(entry.agentId ? { agentId: entry.agentId } : {}),
    ...(entry.messageId ? { messageId: entry.messageId } : {}),
  };
}

export function buildRenderItemsFromTimeline(input: {
  sessionKey: string;
  timelineEntries: SessionTimelineEntry[];
  executionGraphItems: SessionExecutionGraphItem[];
  runtime: SessionRuntimeStateSnapshot;
}): SessionRenderItem[] {
  const assembledTurns = assembleAuthoritativeAssistantTurns({
    sessionKey: input.sessionKey,
    timelineEntries: input.timelineEntries,
    runtime: input.runtime,
  });
  const graphByAnchorKey = new Map<string, SessionExecutionGraphItem[]>();
  const tailGraphs: SessionExecutionGraphItem[] = [];
  for (const graph of sortExecutionGraphItems(input.executionGraphItems)) {
    const anchorKey = normalizeString(graph.anchorItemKey);
    if (!anchorKey) {
      tailGraphs.push(structuredClone(graph));
      continue;
    }
    const current = graphByAnchorKey.get(anchorKey);
    if (current) {
      current.push(structuredClone(graph));
    } else {
      graphByAnchorKey.set(anchorKey, [structuredClone(graph)]);
    }
  }
  const renderItems: SessionRenderItem[] = [];

  const flushAnchoredGraphs = (anchorKey: string) => {
    const anchored = graphByAnchorKey.get(anchorKey);
    if (!anchored?.length) {
      return;
    }
    renderItems.push(...anchored.map((graph) => structuredClone(graph)));
    graphByAnchorKey.delete(anchorKey);
  };

  for (const entry of input.timelineEntries) {
    if (entry.kind === 'user-message') {
      const item = buildUserMessageItem(entry);
      renderItems.push(item);
      flushAnchoredGraphs(item.key);
      continue;
    }

    if (entry.kind === 'assistant-turn') {
      const item = assembledTurns.itemsByEntryKey.get(entry.key);
      if (!item) {
        continue;
      }
      const filteredItem = filterStateOnlyRenderItem(item);
      if (filteredItem) {
        renderItems.push(filteredItem);
        flushAnchoredGraphs(filteredItem.key);
      }
      continue;
    }

    if (entry.kind === 'task-completion') {
      const item: SessionRenderTaskCompletionItem = {
        key: entry.key,
        kind: 'task-completion',
        sessionKey: entry.sessionKey,
        role: 'system',
        text: entry.text,
        childSessionKey: entry.childSessionKey,
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.createdAt != null ? { updatedAt: entry.createdAt } : {}),
        ...(entry.runId ? { runId: entry.runId } : {}),
        ...(entry.childSessionId ? { childSessionId: entry.childSessionId } : {}),
        ...(entry.childAgentId ? { childAgentId: entry.childAgentId } : {}),
        ...(entry.taskLabel ? { taskLabel: entry.taskLabel } : {}),
        ...(entry.statusLabel ? { statusLabel: entry.statusLabel } : {}),
        ...(entry.result ? { result: entry.result } : {}),
        ...(entry.statsLine ? { statsLine: entry.statsLine } : {}),
        ...(entry.replyInstruction ? { replyInstruction: entry.replyInstruction } : {}),
        ...(entry.anchorItemKey ? { anchorItemKey: entry.anchorItemKey } : {}),
        ...(entry.triggerItemKey ? { triggerItemKey: entry.triggerItemKey } : {}),
        ...(entry.replyItemKey ? { replyItemKey: entry.replyItemKey } : {}),
      };
      renderItems.push(item);
      flushAnchoredGraphs(item.key);
      continue;
    }

    if (entry.kind === 'system') {
      renderItems.push(structuredClone(entry));
      flushAnchoredGraphs(entry.key);
    }
  }

  const pendingAssistantTurn: SessionAssistantTurnItem | null = assembledTurns.pendingTurn;
  if (
    pendingAssistantTurn
    && !renderItems.some((item) => item.kind === 'assistant-turn' && item.turnKey === pendingAssistantTurn.turnKey && item.laneKey === pendingAssistantTurn.laneKey)
  ) {
    const filteredPendingTurn = filterStateOnlyRenderItem(pendingAssistantTurn);
    if (filteredPendingTurn) {
      renderItems.push(filteredPendingTurn);
      flushAnchoredGraphs(filteredPendingTurn.key);
    }
  }

  renderItems.push(...tailGraphs);
  return renderItems;
}
