import {
  buildAssistantLaneTurnMatchKey,
} from './chat-row-model';
import type { ExecutionGraphData } from './execution-graph-model';
import { deriveTaskSteps, type TaskStep } from './task-viz';
import {
  EMPTY_TIMELINE_ENTRIES,
  EMPTY_TASK_STEPS,
  EXECUTION_GRAPH_CHILD_STEPS_CACHE_MAX,
  EXECUTION_GRAPH_MAIN_STEPS_CACHE_MAX,
  type CompletionEventAnchor,
  type MessageKeyIndexSnapshot,
} from './exec-graph-types';
import { buildHistoryFingerprint } from './exec-graph-signature';
import { resolveAssistantEntryLaneIdentity } from '@/stores/chat/session-turn-state';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

export interface MaterializeExecutionGraphAtIndexInput {
  anchorIndex: number;
  anchors: CompletionEventAnchor[];
  graphSignature: string;
  graphByAnchor: Array<ExecutionGraphData | null>;
  keyIndex: MessageKeyIndexSnapshot;
  timelineEntries: SessionTimelineEntry[];
  currentSessionKey: string;
  showThinking: boolean;
  subagentHistoryBySession: Map<string, SessionTimelineEntry[]>;
  agentNameById: Map<string, string>;
  previousGraphCache: Map<string, ExecutionGraphData>;
  nextGraphCache: Map<string, ExecutionGraphData>;
  mainStepsCacheBySignature: Map<string, TaskStep[]>;
  childStepsCacheBySignature: Map<string, TaskStep[]>;
  executionGraphs: ExecutionGraphData[];
}

function buildMessageRangeFingerprint(
  timelineEntries: SessionTimelineEntry[],
  start: number,
  endExclusive: number,
): string {
  const length = Math.max(0, endExclusive - start);
  if (length <= 0) {
    return '0';
  }
  const first = timelineEntries[start];
  const last = timelineEntries[endExclusive - 1];
  return [
    length,
    first?.entryId ?? '',
    first?.timestamp ?? '',
    first?.role ?? '',
    last?.entryId ?? '',
    last?.timestamp ?? '',
    last?.role ?? '',
  ].join('|');
}

function buildMainStepsSignature(input: {
  currentSessionKey: string;
  start: number;
  endExclusive: number;
  showThinking: boolean;
  rangeFingerprint: string;
}): string {
  return [
    input.currentSessionKey,
    input.start,
    input.endExclusive,
    input.rangeFingerprint,
    input.showThinking ? '1' : '0',
  ].join('|');
}

function buildChildStepsSignature(input: {
  sessionKey: string;
  showThinking: boolean;
  subagentHistoryFingerprint: string;
}): string {
  return [
    input.sessionKey,
    input.showThinking ? '1' : '0',
    input.subagentHistoryFingerprint,
  ].join('|');
}

function readTaskStepsCache(
  cache: Map<string, TaskStep[]>,
  signature: string,
): TaskStep[] | undefined {
  const cached = cache.get(signature);
  if (!cached) {
    return undefined;
  }
  cache.delete(signature);
  cache.set(signature, cached);
  return cached;
}

function writeTaskStepsCache(
  cache: Map<string, TaskStep[]>,
  signature: string,
  steps: TaskStep[],
  maxSize: number,
): void {
  if (cache.has(signature)) {
    cache.delete(signature);
  }
  cache.set(signature, steps);
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    cache.delete(oldestKey);
  }
}

function resolveExecutionGraphAnchorLaneIdentity(
  timelineEntries: SessionTimelineEntry[],
  start: number,
  endExclusive: number,
  preferredReplyIndex: number | null,
): {
  turnKey: string | null;
  laneKey: string | null;
} {
  if (preferredReplyIndex != null) {
    const replyEntry = timelineEntries[preferredReplyIndex];
    if (replyEntry?.role === 'assistant') {
      const laneIdentity = resolveAssistantEntryLaneIdentity(replyEntry);
      if (laneIdentity.turnKey && laneIdentity.laneKey) {
        return {
          turnKey: laneIdentity.turnKey,
          laneKey: laneIdentity.laneKey,
        };
      }
    }
  }

  for (let index = endExclusive - 1; index >= start; index -= 1) {
    const entry = timelineEntries[index];
    if (entry?.role !== 'assistant') {
      continue;
    }
    const laneIdentity = resolveAssistantEntryLaneIdentity(entry);
    if (laneIdentity.turnKey && laneIdentity.laneKey) {
      return {
        turnKey: laneIdentity.turnKey,
        laneKey: laneIdentity.laneKey,
      };
    }
  }

  return {
    turnKey: null,
    laneKey: null,
  };
}

function collectExecutionGraphSuppressLaneTurnKeys(input: {
  timelineEntries: SessionTimelineEntry[];
  mainStart: number;
  mainEnd: number;
  anchorTurnKey: string | null;
}): string[] {
  const suppressToolCardLaneTurnKeys = new Set<string>();
  const collectFromRange = (start: number, endExclusive: number, turnKeyFilter?: string | null) => {
    for (let index = start; index < endExclusive; index += 1) {
      const entry = input.timelineEntries[index];
      if (entry?.role !== 'assistant') {
        continue;
      }
      const laneIdentity = resolveAssistantEntryLaneIdentity(entry);
      if (turnKeyFilter && laneIdentity.turnKey !== turnKeyFilter) {
        continue;
      }
      const laneTurnKey = buildAssistantLaneTurnMatchKey(
        laneIdentity.turnKey,
        laneIdentity.laneKey,
      );
      if (laneTurnKey) {
        suppressToolCardLaneTurnKeys.add(laneTurnKey);
      }
    }
  };

  if (input.anchorTurnKey) {
    collectFromRange(0, input.timelineEntries.length, input.anchorTurnKey);
  } else {
    collectFromRange(input.mainStart, input.mainEnd);
  }

  return Array.from(suppressToolCardLaneTurnKeys).sort();
}

export function materializeExecutionGraphAtIndex({
  anchorIndex,
  anchors,
  graphSignature,
  graphByAnchor,
  keyIndex,
  timelineEntries,
  currentSessionKey,
  showThinking,
  subagentHistoryBySession,
  agentNameById,
  previousGraphCache,
  nextGraphCache,
  mainStepsCacheBySignature,
  childStepsCacheBySignature,
  executionGraphs,
}: MaterializeExecutionGraphAtIndexInput): string | null {
  const anchor = anchors[anchorIndex];
  if (!anchor) {
    return null;
  }

  const triggerMessageKey = keyIndex.keyByIndex.get(anchor.triggerIndex) ?? keyIndex.keyByIndex.get(anchor.eventIndex);
  if (!triggerMessageKey) {
    graphByAnchor[anchorIndex] = null;
    return null;
  }

  const subagentTimelineEntries = subagentHistoryBySession.get(anchor.sessionKey) ?? EMPTY_TIMELINE_ENTRIES;
  const resolvedAgentName = anchor.agentId
    ? (agentNameById.get(anchor.agentId) || anchor.agentId)
    : 'subagent';
  const cached = previousGraphCache.get(graphSignature);
  if (cached) {
    executionGraphs.push(cached);
    nextGraphCache.set(graphSignature, cached);
    graphByAnchor[anchorIndex] = cached;
    return anchor.sessionKey;
  }

  const replyMessageKey = anchor.replyIndex != null ? keyIndex.keyByIndex.get(anchor.replyIndex) : undefined;
  const mainStart = anchor.triggerIndex;
  const mainEnd = anchor.replyIndex != null ? anchor.replyIndex + 1 : timelineEntries.length;
  const anchorLaneIdentity = resolveExecutionGraphAnchorLaneIdentity(
    timelineEntries,
    mainStart,
    mainEnd,
    anchor.replyIndex,
  );
  const mainRangeFingerprint = buildMessageRangeFingerprint(timelineEntries, mainStart, mainEnd);
  const mainStepsSignature = buildMainStepsSignature({
    currentSessionKey,
    start: mainStart,
    endExclusive: mainEnd,
    showThinking,
    rangeFingerprint: mainRangeFingerprint,
  });
  const mainSteps = (() => {
    const cachedSteps = readTaskStepsCache(mainStepsCacheBySignature, mainStepsSignature);
    if (cachedSteps) {
      return cachedSteps;
    }
    const computedSteps = deriveTaskSteps({
      entries: timelineEntries.slice(mainStart, mainEnd),
      streamingEntry: null,
      streamingTools: [],
      sending: false,
      pendingFinal: false,
      showThinking,
    });
    writeTaskStepsCache(
      mainStepsCacheBySignature,
      mainStepsSignature,
      computedSteps,
      EXECUTION_GRAPH_MAIN_STEPS_CACHE_MAX,
    );
    return computedSteps;
  })();
  const childSteps = (() => {
    if (subagentTimelineEntries.length === 0) {
      return EMPTY_TASK_STEPS;
    }
    const childStepsSignature = buildChildStepsSignature({
      sessionKey: anchor.sessionKey,
      showThinking,
      subagentHistoryFingerprint: buildHistoryFingerprint(subagentTimelineEntries),
    });
    const cachedSteps = readTaskStepsCache(childStepsCacheBySignature, childStepsSignature);
    if (cachedSteps) {
      return cachedSteps;
    }
    const computedSteps = deriveTaskSteps({
      entries: subagentTimelineEntries,
      streamingEntry: null,
      streamingTools: [],
      sending: false,
      pendingFinal: false,
      showThinking,
    });
    writeTaskStepsCache(
      childStepsCacheBySignature,
      childStepsSignature,
      computedSteps,
      EXECUTION_GRAPH_CHILD_STEPS_CACHE_MAX,
    );
    return computedSteps;
  })();

  const steps = [...mainSteps];
  if (childSteps.length > 0) {
    const childRootId = `child-root:${anchor.sessionKey}`;
    steps.push({
      id: childRootId,
      label: `${resolvedAgentName} subagent`,
      status: 'completed',
      kind: 'system',
      detail: anchor.sessionKey,
      depth: 1,
      parentId: 'agent-run',
    });
    for (const [stepIndex, step] of childSteps.entries()) {
      steps.push({
        ...step,
        id: `child:${anchor.sessionKey}:${step.id || stepIndex}`,
        depth: Math.max(step.depth + 1, 2),
        parentId: childRootId,
      });
    }
  }

  const graph: ExecutionGraphData = {
    id: `${currentSessionKey}:${anchor.sessionKey}:${anchor.eventIndex}`,
    anchorMessageKey: replyMessageKey ?? triggerMessageKey,
    ...(anchorLaneIdentity.turnKey ? { anchorTurnKey: anchorLaneIdentity.turnKey } : {}),
    ...(anchorLaneIdentity.laneKey ? { anchorLaneKey: anchorLaneIdentity.laneKey } : {}),
    triggerMessageKey,
    ...(replyMessageKey ? { replyMessageKey } : {}),
    agentLabel: resolvedAgentName,
    sessionLabel: anchor.sessionId || anchor.sessionKey,
    steps: steps.slice(0, 32),
    active: anchor.replyIndex == null,
    suppressToolCardLaneTurnKeys: collectExecutionGraphSuppressLaneTurnKeys({
      timelineEntries,
      mainStart,
      mainEnd,
      anchorTurnKey: anchorLaneIdentity.turnKey,
    }),
  };
  executionGraphs.push(graph);
  nextGraphCache.set(graphSignature, graph);
  graphByAnchor[anchorIndex] = graph;
  return anchor.sessionKey;
}
