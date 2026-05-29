import type {
  SessionAssistantTurnItem,
  SessionExecutionGraphItem,
  SessionRenderItem,
  SessionRenderUserMessageItem,
  SessionTimelineAssistantTurnEntry,
  SessionTimelineEntry,
  SessionTimelineUserMessageEntry,
} from '../../shared/session-adapter-types';
import {
  assembleAuthoritativeAssistantTurns,
  hasAssistantTurnOutput,
} from './assistant-turn-assembler';

export function cloneRenderItems(items: SessionRenderItem[]): SessionRenderItem[] {
  return structuredClone(items);
}

export function isAssistantTurnTimelineEntry(
  entry: SessionTimelineEntry,
): entry is SessionTimelineAssistantTurnEntry {
  return entry.kind === 'assistant-turn';
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

  const renderedItemKeys = new Set<string>();
  const appendRenderItem = (item: SessionRenderItem) => {
    if (renderedItemKeys.has(item.key)) {
      return;
    }
    renderedItemKeys.add(item.key);
    renderItems.push(item);
    flushAnchoredGraphs(item.key);
  };

  for (const entry of input.timelineEntries) {
    if (entry.kind === 'user-message') {
      appendRenderItem(buildUserMessageItem(entry));
      continue;
    }

    if (entry.kind === 'assistant-turn') {
      const item = assembledTurns.itemsByEntryKey.get(entry.key);
      if (!item) {
        continue;
      }
      appendRenderItem(item);
      continue;
    }

    if (entry.kind === 'system') {
      appendRenderItem(structuredClone(entry));
    }
  }

  const pendingAssistantTurn: SessionAssistantTurnItem | null = assembledTurns.pendingTurn;
  if (
    pendingAssistantTurn
    && !renderItems.some((item) => item.kind === 'assistant-turn' && item.turnKey === pendingAssistantTurn.turnKey && item.laneKey === pendingAssistantTurn.laneKey)
    && !renderItems.some((item) => item.kind === 'assistant-turn' && item.runId === pendingAssistantTurn.turnKey && item.laneKey === pendingAssistantTurn.laneKey)
  ) {
    renderItems.push(pendingAssistantTurn);
    flushAnchoredGraphs(pendingAssistantTurn.key);
  }

  renderItems.push(...tailGraphs);
  return renderItems;
}
