import type { RawMessage } from '@/stores/chat';
import type { ExecutionGraphData } from './execution-graph-model';
import { deriveTaskSteps, type TaskStep } from './task-viz';
import {
  EMPTY_MESSAGES,
  EMPTY_TASK_STEPS,
  EXECUTION_GRAPH_CHILD_STEPS_CACHE_MAX,
  EXECUTION_GRAPH_MAIN_STEPS_CACHE_MAX,
  type CompletionEventAnchor,
  type MessageKeyIndexSnapshot,
} from './exec-graph-types';
import { buildHistoryFingerprint } from './exec-graph-signature';

export interface MaterializeExecutionGraphAtIndexInput {
  anchorIndex: number;
  anchors: CompletionEventAnchor[];
  graphSignature: string;
  graphByAnchor: Array<ExecutionGraphData | null>;
  keyIndex: MessageKeyIndexSnapshot;
  messages: RawMessage[];
  currentSessionKey: string;
  showThinking: boolean;
  subagentHistoryBySession: Map<string, RawMessage[]>;
  agentNameById: Map<string, string>;
  previousGraphCache: Map<string, ExecutionGraphData>;
  nextGraphCache: Map<string, ExecutionGraphData>;
  mainStepsCacheBySignature: Map<string, TaskStep[]>;
  childStepsCacheBySignature: Map<string, TaskStep[]>;
  executionGraphs: ExecutionGraphData[];
}

function buildMessageRangeFingerprint(
  messages: RawMessage[],
  start: number,
  endExclusive: number,
): string {
  const length = Math.max(0, endExclusive - start);
  if (length <= 0) {
    return '0';
  }
  const first = messages[start];
  const last = messages[endExclusive - 1];
  return [
    length,
    first?.id ?? '',
    first?.timestamp ?? '',
    first?.role ?? '',
    last?.id ?? '',
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

export function materializeExecutionGraphAtIndex({
  anchorIndex,
  anchors,
  graphSignature,
  graphByAnchor,
  keyIndex,
  messages,
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

  const subagentMessages = subagentHistoryBySession.get(anchor.sessionKey) ?? EMPTY_MESSAGES;
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
  const mainEnd = anchor.replyIndex != null ? anchor.replyIndex + 1 : messages.length;
  const mainRangeFingerprint = buildMessageRangeFingerprint(messages, mainStart, mainEnd);
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
    const mainMessages = messages.slice(mainStart, mainEnd);
    const computedSteps = deriveTaskSteps({
      messages: mainMessages,
      streamingMessage: null,
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
    if (subagentMessages.length === 0) {
      return EMPTY_TASK_STEPS;
    }
    const childStepsSignature = buildChildStepsSignature({
      sessionKey: anchor.sessionKey,
      showThinking,
      subagentHistoryFingerprint: buildHistoryFingerprint(subagentMessages),
    });
    const cachedSteps = readTaskStepsCache(childStepsCacheBySignature, childStepsSignature);
    if (cachedSteps) {
      return cachedSteps;
    }
    const computedSteps = deriveTaskSteps({
      messages: subagentMessages,
      streamingMessage: null,
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

  const suppressToolCardMessageKeys: string[] = [];
  for (let index = mainStart; index < mainEnd; index += 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') {
      continue;
    }
    const key = keyIndex.keyByIndex.get(index);
    if (!key) {
      continue;
    }
    suppressToolCardMessageKeys.push(key);
  }

  const graph: ExecutionGraphData = {
    id: `${currentSessionKey}:${anchor.sessionKey}:${anchor.eventIndex}`,
    anchorMessageKey: triggerMessageKey,
    triggerMessageKey,
    ...(replyMessageKey ? { replyMessageKey } : {}),
    agentLabel: resolvedAgentName,
    sessionLabel: anchor.sessionId || anchor.sessionKey,
    steps: steps.slice(0, 32),
    active: anchor.replyIndex == null,
    suppressToolCardMessageKeys,
  };
  executionGraphs.push(graph);
  nextGraphCache.set(graphSignature, graph);
  graphByAnchor[anchorIndex] = graph;
  return anchor.sessionKey;
}
