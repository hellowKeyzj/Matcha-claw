import { useEffect, useMemo, useRef, useState } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import {
  canAppendMessageList,
  isRenderableChatMessage,
  resolveMessageRowKey,
  type ExecutionGraphData,
} from './chat-row-model';
import {
  deriveTaskSteps,
  type TaskStep,
  parseSubagentCompletionInfo,
} from './task-visualization';

const SUBAGENT_HISTORY_LIMIT = 200;
const SUBAGENT_HISTORY_CACHE_MAX_SESSIONS = 48;
const EXECUTION_GRAPH_FIRST_BATCH_SIZE = 1;
const EXECUTION_GRAPH_BATCH_SIZE = 3;
const EXECUTION_GRAPH_IDLE_MIN_BUDGET_MS = 4;
const EXECUTION_GRAPH_MAIN_STEPS_CACHE_MAX = 320;
const EXECUTION_GRAPH_CHILD_STEPS_CACHE_MAX = 320;
const EMPTY_MESSAGES: RawMessage[] = [];
const EMPTY_TASK_STEPS: TaskStep[] = [];
const EMPTY_EXECUTION_GRAPHS: ExecutionGraphData[] = [];
const EMPTY_SUPPRESSED_KEYS = new Set<string>();
const EXECUTION_GRAPH_CACHE_MAX_SESSIONS = 20;

interface CompletionEventAnchor {
  eventIndex: number;
  triggerIndex: number;
  replyIndex: number | null;
  sessionKey: string;
  sessionId?: string;
  agentId?: string;
}

interface ExecutionGraphAgent {
  id: string;
  name?: string;
}

interface UseExecutionGraphsInput {
  messages: RawMessage[];
  currentSessionKey: string;
  agents: ExecutionGraphAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  sending: boolean;
  pendingFinal: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
}

interface MessageKeyIndexSnapshot {
  messagesRef: RawMessage[];
  keyByIndex: Map<number, string>;
  renderableCount: number;
}

interface AnchorsSnapshot {
  messagesRef: RawMessage[];
  anchors: CompletionEventAnchor[];
}

interface SessionExecutionCache {
  messagesRef: RawMessage[];
  agentsRef: ExecutionGraphAgent[];
  subagentHistoryRevision: number;
  streamingMessageRef: unknown | null;
  streamingToolsRef: ToolStatus[];
  sending: boolean;
  pendingFinal: boolean;
  showThinking: boolean;
  executionGraphs: ExecutionGraphData[];
  suppressedToolCardRowKeys: Set<string>;
  keyIndex: MessageKeyIndexSnapshot;
  anchors: AnchorsSnapshot;
  graphCacheBySignature: Map<string, ExecutionGraphData>;
  mainStepsCacheBySignature: Map<string, TaskStep[]>;
  childStepsCacheBySignature: Map<string, TaskStep[]>;
}

interface MaterializeExecutionGraphAtIndexInput {
  anchorIndex: number;
  anchors: CompletionEventAnchor[];
  keyIndex: MessageKeyIndexSnapshot;
  messages: RawMessage[];
  currentSessionKey: string;
  sending: boolean;
  pendingFinal: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  streamingSignature: string;
  subagentHistoryBySession: Map<string, RawMessage[]>;
  agentNameById: Map<string, string>;
  previousGraphCache: Map<string, ExecutionGraphData>;
  nextGraphCache: Map<string, ExecutionGraphData>;
  mainStepsCacheBySignature: Map<string, TaskStep[]>;
  childStepsCacheBySignature: Map<string, TaskStep[]>;
  executionGraphs: ExecutionGraphData[];
  suppressedToolCardRowKeys: Set<string>;
}

const globalSessionExecutionCache = new Map<string, SessionExecutionCache>();
const globalSubagentHistoryBySession = new Map<string, RawMessage[]>();

function rememberSessionExecutionCache(sessionKey: string, cache: SessionExecutionCache): void {
  if (globalSessionExecutionCache.has(sessionKey)) {
    globalSessionExecutionCache.delete(sessionKey);
  }
  globalSessionExecutionCache.set(sessionKey, cache);
  while (globalSessionExecutionCache.size > EXECUTION_GRAPH_CACHE_MAX_SESSIONS) {
    const oldestKey = globalSessionExecutionCache.keys().next().value;
    if (typeof oldestKey !== 'string') {
      break;
    }
    globalSessionExecutionCache.delete(oldestKey);
  }
}

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining: () => number;
}

type IdleCallbackHandle = number | ReturnType<typeof setTimeout>;
type IdleCallback = (deadline: IdleDeadlineLike) => void;

function scheduleIdleCallback(callback: IdleCallback): IdleCallbackHandle {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      requestIdleCallback?: (cb: IdleCallback, options?: { timeout?: number }) => number;
    };
    if (typeof win.requestIdleCallback === 'function') {
      return win.requestIdleCallback(callback, { timeout: 120 });
    }
  }
  return setTimeout(() => {
    callback({
      didTimeout: true,
      timeRemaining: () => 0,
    });
  }, 0);
}

function cancelIdleCallbackSafe(handle: IdleCallbackHandle): void {
  if (typeof window !== 'undefined') {
    const win = window as Window & {
      cancelIdleCallback?: (id: number) => void;
    };
    if (typeof win.cancelIdleCallback === 'function' && typeof handle === 'number') {
      win.cancelIdleCallback(handle);
      return;
    }
  }
  clearTimeout(handle);
}

function buildMessageKeyIndex(
  sessionKey: string,
  messages: RawMessage[],
  previous?: MessageKeyIndexSnapshot,
): MessageKeyIndexSnapshot {
  if (previous && canAppendMessageList(previous.messagesRef, messages)) {
    const keyByIndex = new Map(previous.keyByIndex);
    let renderableCount = previous.renderableCount;
    for (let index = previous.messagesRef.length; index < messages.length; index += 1) {
      const message = messages[index];
      if (!isRenderableChatMessage(message)) {
        continue;
      }
      keyByIndex.set(index, resolveMessageRowKey(sessionKey, message, renderableCount));
      renderableCount += 1;
    }
    return {
      messagesRef: messages,
      keyByIndex,
      renderableCount,
    };
  }

  const keyByIndex = new Map<number, string>();
  let renderableCount = 0;
  for (const [index, message] of messages.entries()) {
    if (!isRenderableChatMessage(message)) {
      continue;
    }
    keyByIndex.set(index, resolveMessageRowKey(sessionKey, message, renderableCount));
    renderableCount += 1;
  }
  return {
    messagesRef: messages,
    keyByIndex,
    renderableCount,
  };
}

function findCompletionEventAnchors(messages: RawMessage[]): CompletionEventAnchor[] {
  const anchors: CompletionEventAnchor[] = [];
  for (const [eventIndex, message] of messages.entries()) {
    const completionInfo = parseSubagentCompletionInfo(message);
    if (!completionInfo) continue;

    let triggerIndex = eventIndex;
    for (let index = eventIndex - 1; index >= 0; index -= 1) {
      const previous = messages[index];
      if (previous.role !== 'user') continue;
      if (parseSubagentCompletionInfo(previous)) continue;
      triggerIndex = index;
      break;
    }

    let replyIndex: number | null = null;
    for (let index = eventIndex + 1; index < messages.length; index += 1) {
      if (messages[index]?.role === 'assistant') {
        replyIndex = index;
        break;
      }
    }

    anchors.push({
      eventIndex,
      triggerIndex,
      replyIndex,
      sessionKey: completionInfo.sessionKey,
      ...(completionInfo.sessionId ? { sessionId: completionInfo.sessionId } : {}),
      ...(completionInfo.agentId ? { agentId: completionInfo.agentId } : {}),
    });
  }
  return anchors;
}

function buildCompletionAnchors(
  messages: RawMessage[],
  previous?: AnchorsSnapshot,
): AnchorsSnapshot {
  if (!previous || !canAppendMessageList(previous.messagesRef, messages)) {
    return {
      messagesRef: messages,
      anchors: findCompletionEventAnchors(messages),
    };
  }

  const anchors = previous.anchors.map((anchor) => ({ ...anchor }));
  const unresolvedIndices: number[] = [];
  for (let index = 0; index < anchors.length; index += 1) {
    if (anchors[index].replyIndex == null) {
      unresolvedIndices.push(index);
    }
  }

  for (let index = previous.messagesRef.length; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === 'assistant') {
      while (unresolvedIndices.length > 0) {
        const unresolvedIndex = unresolvedIndices[0];
        if (anchors[unresolvedIndex].eventIndex < index) {
          anchors[unresolvedIndex].replyIndex = index;
          unresolvedIndices.shift();
          break;
        }
        break;
      }
    }

    const completionInfo = parseSubagentCompletionInfo(message);
    if (!completionInfo) {
      continue;
    }

    let triggerIndex = index;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previousMessage = messages[cursor];
      if (previousMessage.role !== 'user') continue;
      if (parseSubagentCompletionInfo(previousMessage)) continue;
      triggerIndex = cursor;
      break;
    }

    const nextAnchor: CompletionEventAnchor = {
      eventIndex: index,
      triggerIndex,
      replyIndex: null,
      sessionKey: completionInfo.sessionKey,
      ...(completionInfo.sessionId ? { sessionId: completionInfo.sessionId } : {}),
      ...(completionInfo.agentId ? { agentId: completionInfo.agentId } : {}),
    };
    anchors.push(nextAnchor);
    unresolvedIndices.push(anchors.length - 1);
  }

  return {
    messagesRef: messages,
    anchors,
  };
}

function buildHistoryFingerprint(messages: RawMessage[]): string {
  const count = messages.length;
  if (count === 0) {
    return '0';
  }
  const first = messages[0];
  const last = messages[count - 1];
  return [
    count,
    first?.id ?? '',
    first?.timestamp ?? '',
    last?.id ?? '',
    last?.timestamp ?? '',
  ].join('|');
}

function buildStreamingSignature(
  streamingMessage: unknown | null,
  streamingTools: ToolStatus[],
): string {
  const messageObj = streamingMessage && typeof streamingMessage === 'object'
    ? streamingMessage as Record<string, unknown>
    : null;
  const messageSignature = messageObj
    ? [
        String(messageObj.id ?? ''),
        String(messageObj.role ?? ''),
        String(messageObj.timestamp ?? ''),
      ].join(':')
    : String(streamingMessage ?? '');
  const toolsSignature = streamingTools
    .map((tool) => `${tool.toolCallId ?? tool.id ?? tool.name}:${tool.status}:${tool.updatedAt}`)
    .join(',');
  return `${messageSignature}|${toolsSignature}`;
}

function buildGraphSignature(input: {
  anchor: CompletionEventAnchor;
  includeStreaming: boolean;
  currentSessionKey: string;
  showThinking: boolean;
  pendingFinal: boolean;
  streamingSignature: string;
  subagentHistoryFingerprint: string;
}): string {
  const { anchor } = input;
  return [
    input.currentSessionKey,
    anchor.eventIndex,
    anchor.triggerIndex,
    anchor.replyIndex ?? -1,
    anchor.sessionKey,
    anchor.sessionId ?? '',
    anchor.agentId ?? '',
    input.includeStreaming ? '1' : '0',
    input.showThinking ? '1' : '0',
    input.pendingFinal ? '1' : '0',
    input.includeStreaming ? input.streamingSignature : '',
    input.subagentHistoryFingerprint,
  ].join('|');
}

function snapshotExecutionGraphs(executionGraphs: ExecutionGraphData[]): ExecutionGraphData[] {
  return executionGraphs.length > 0 ? [...executionGraphs] : EMPTY_EXECUTION_GRAPHS;
}

function snapshotSuppressedToolCardRowKeys(keys: Set<string>): Set<string> {
  return keys.size > 0 ? new Set(keys) : EMPTY_SUPPRESSED_KEYS;
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
  includeStreaming: boolean;
  showThinking: boolean;
  sending: boolean;
  pendingFinal: boolean;
  streamingSignature: string;
  rangeFingerprint: string;
}): string {
  return [
    input.currentSessionKey,
    input.start,
    input.endExclusive,
    input.rangeFingerprint,
    input.showThinking ? '1' : '0',
    input.includeStreaming ? '1' : '0',
    input.includeStreaming ? (input.sending ? '1' : '0') : '0',
    input.includeStreaming ? (input.pendingFinal ? '1' : '0') : '0',
    input.includeStreaming ? input.streamingSignature : '',
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
  // LRU refresh
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

function materializeExecutionGraphAtIndex({
  anchorIndex,
  anchors,
  keyIndex,
  messages,
  currentSessionKey,
  sending,
  pendingFinal,
  showThinking,
  streamingMessage,
  streamingTools,
  streamingSignature,
  subagentHistoryBySession,
  agentNameById,
  previousGraphCache,
  nextGraphCache,
  mainStepsCacheBySignature,
  childStepsCacheBySignature,
  executionGraphs,
  suppressedToolCardRowKeys,
}: MaterializeExecutionGraphAtIndexInput): string | null {
  const anchor = anchors[anchorIndex];
  if (!anchor) {
    return null;
  }

  const triggerMessageKey = keyIndex.keyByIndex.get(anchor.triggerIndex) ?? keyIndex.keyByIndex.get(anchor.eventIndex);
  if (!triggerMessageKey) {
    return null;
  }

  const includeStreaming = sending && anchorIndex === anchors.length - 1;
  const subagentMessages = subagentHistoryBySession.get(anchor.sessionKey) ?? EMPTY_MESSAGES;
  const graphSignature = buildGraphSignature({
    anchor,
    includeStreaming,
    currentSessionKey,
    showThinking,
    pendingFinal,
    streamingSignature,
    subagentHistoryFingerprint: buildHistoryFingerprint(subagentMessages),
  });
  const cached = previousGraphCache.get(graphSignature);
  if (cached) {
    executionGraphs.push(cached);
    nextGraphCache.set(graphSignature, cached);
    for (const key of cached.suppressToolCardMessageKeys || []) {
      suppressedToolCardRowKeys.add(key);
    }
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
    includeStreaming,
    showThinking,
    sending,
    pendingFinal,
    streamingSignature,
    rangeFingerprint: mainRangeFingerprint,
  });
  const resolvedAgentName = anchor.agentId
    ? (agentNameById.get(anchor.agentId) || anchor.agentId)
    : 'subagent';

  const mainSteps = (() => {
    const cachedSteps = readTaskStepsCache(mainStepsCacheBySignature, mainStepsSignature);
    if (cachedSteps) {
      return cachedSteps;
    }
    const mainMessages = messages.slice(mainStart, mainEnd);
    const computedSteps = deriveTaskSteps({
      messages: mainMessages,
      streamingMessage: includeStreaming ? streamingMessage : null,
      streamingTools: includeStreaming ? streamingTools : [],
      sending: includeStreaming ? sending : false,
      pendingFinal: includeStreaming ? pendingFinal : false,
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
    suppressedToolCardRowKeys.add(key);
  }

  const graph: ExecutionGraphData = {
    id: `${currentSessionKey}:${anchor.sessionKey}:${anchor.eventIndex}`,
    anchorMessageKey: triggerMessageKey,
    triggerMessageKey,
    ...(replyMessageKey ? { replyMessageKey } : {}),
    agentLabel: resolvedAgentName,
    sessionLabel: anchor.sessionId || anchor.sessionKey,
    steps: steps.slice(0, 32),
    active: includeStreaming,
    suppressToolCardMessageKeys,
  };
  executionGraphs.push(graph);
  nextGraphCache.set(graphSignature, graph);
  return anchor.sessionKey;
}

export function useExecutionGraphs({
  messages,
  currentSessionKey,
  agents,
  isGatewayRunning,
  gatewayRpc,
  sending,
  pendingFinal,
  showThinking,
  streamingMessage,
  streamingTools,
}: UseExecutionGraphsInput): {
  executionGraphs: ExecutionGraphData[];
  suppressedToolCardRowKeys: Set<string>;
} {
  const subagentHistoryBySessionRef = useRef<Map<string, RawMessage[]>>(globalSubagentHistoryBySession);
  const [subagentHistoryRevision, setSubagentHistoryRevision] = useState(0);
  const subagentHistoryLoadingRef = useRef<Set<string>>(new Set());
  const idleHandleRef = useRef<IdleCallbackHandle | null>(null);
  const computeRunIdRef = useRef(0);
  const [renderState, setRenderState] = useState<{
    sessionKey: string;
    executionGraphs: ExecutionGraphData[];
    suppressedToolCardRowKeys: Set<string>;
  }>({
    sessionKey: currentSessionKey,
    executionGraphs: EMPTY_EXECUTION_GRAPHS,
    suppressedToolCardRowKeys: EMPTY_SUPPRESSED_KEYS,
  });

  const rememberSubagentHistory = useMemo(() => (
    (sessionKey: string, messages: RawMessage[]) => {
      const cache = subagentHistoryBySessionRef.current;
      if (cache.has(sessionKey)) {
        return;
      }
      cache.set(sessionKey, messages);
      while (cache.size > SUBAGENT_HISTORY_CACHE_MAX_SESSIONS) {
        const oldestKey = cache.keys().next().value;
        if (typeof oldestKey !== 'string') {
          break;
        }
        cache.delete(oldestKey);
      }
      setSubagentHistoryRevision((value) => value + 1);
    }
  ), []);

  const fetchMissingSubagentHistories = useMemo(() => (
    (sessionKeys: string[]) => {
      if (!isGatewayRunning || sessionKeys.length === 0) {
        return;
      }
      const existing = subagentHistoryBySessionRef.current;
      const pendingSessionKeys = Array.from(new Set(
        sessionKeys.filter((sessionKey) => (
          Boolean(sessionKey)
          && !existing.has(sessionKey)
          && !subagentHistoryLoadingRef.current.has(sessionKey)
        )),
      ));
      if (pendingSessionKeys.length === 0) {
        return;
      }

      for (const sessionKey of pendingSessionKeys) {
        subagentHistoryLoadingRef.current.add(sessionKey);
        void gatewayRpc<Record<string, unknown>>('chat.history', {
          sessionKey,
          limit: SUBAGENT_HISTORY_LIMIT,
        }).then((result) => {
          const loaded = Array.isArray(result.messages) ? result.messages as RawMessage[] : EMPTY_MESSAGES;
          rememberSubagentHistory(sessionKey, loaded);
        }).catch(() => {
          rememberSubagentHistory(sessionKey, EMPTY_MESSAGES);
        }).finally(() => {
          subagentHistoryLoadingRef.current.delete(sessionKey);
        });
      }
    }
  ), [gatewayRpc, isGatewayRunning, rememberSubagentHistory]);

  useEffect(() => {
    if (idleHandleRef.current != null) {
      cancelIdleCallbackSafe(idleHandleRef.current);
      idleHandleRef.current = null;
    }

    if (!isGatewayRunning) {
      setRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: EMPTY_EXECUTION_GRAPHS,
        suppressedToolCardRowKeys: EMPTY_SUPPRESSED_KEYS,
      });
      return;
    }

    const cache = globalSessionExecutionCache.get(currentSessionKey);
    const hasExactCache = Boolean(
      cache
      && cache.messagesRef === messages
      && cache.agentsRef === agents
      && cache.subagentHistoryRevision === subagentHistoryRevision
      && cache.sending === sending
      && cache.pendingFinal === pendingFinal
      && cache.showThinking === showThinking
      && cache.streamingMessageRef === streamingMessage
      && cache.streamingToolsRef === streamingTools,
    );
    if (hasExactCache && cache) {
      setRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: cache.executionGraphs,
        suppressedToolCardRowKeys: cache.suppressedToolCardRowKeys,
      });
      return;
    }

    if (cache) {
      setRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: cache.executionGraphs,
        suppressedToolCardRowKeys: cache.suppressedToolCardRowKeys,
      });
    } else if (renderState.sessionKey !== currentSessionKey) {
      setRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: EMPTY_EXECUTION_GRAPHS,
        suppressedToolCardRowKeys: EMPTY_SUPPRESSED_KEYS,
      });
    }

    const computeRunId = ++computeRunIdRef.current;
    const previousCache = globalSessionExecutionCache.get(currentSessionKey);
    const anchors = buildCompletionAnchors(messages, previousCache?.anchors);
    const keyIndex = buildMessageKeyIndex(currentSessionKey, messages, previousCache?.keyIndex);
    if (anchors.anchors.length === 0) {
      const nextCache: SessionExecutionCache = {
        messagesRef: messages,
        agentsRef: agents,
        subagentHistoryRevision,
        streamingMessageRef: streamingMessage,
        streamingToolsRef: streamingTools,
        sending,
        pendingFinal,
        showThinking,
        executionGraphs: EMPTY_EXECUTION_GRAPHS,
        suppressedToolCardRowKeys: EMPTY_SUPPRESSED_KEYS,
        keyIndex,
        anchors,
        graphCacheBySignature: new Map(),
        mainStepsCacheBySignature: new Map(previousCache?.mainStepsCacheBySignature ?? []),
        childStepsCacheBySignature: new Map(previousCache?.childStepsCacheBySignature ?? []),
      };
      rememberSessionExecutionCache(currentSessionKey, nextCache);
      setRenderState((previous) => {
        if (previous.sessionKey !== currentSessionKey) {
          return previous;
        }
        if (
          previous.executionGraphs === nextCache.executionGraphs
          && previous.suppressedToolCardRowKeys === nextCache.suppressedToolCardRowKeys
        ) {
          return previous;
        }
        return {
          sessionKey: currentSessionKey,
          executionGraphs: nextCache.executionGraphs,
          suppressedToolCardRowKeys: nextCache.suppressedToolCardRowKeys,
        };
      });
      return () => {
        if (idleHandleRef.current != null) {
          cancelIdleCallbackSafe(idleHandleRef.current);
          idleHandleRef.current = null;
        }
      };
    }

    const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name || agent.id] as const));
    const streamingSignature = buildStreamingSignature(streamingMessage, streamingTools);
    const previousGraphCache = previousCache?.graphCacheBySignature ?? new Map<string, ExecutionGraphData>();
    const mainStepsCacheBySignature = new Map(previousCache?.mainStepsCacheBySignature ?? []);
    const childStepsCacheBySignature = new Map(previousCache?.childStepsCacheBySignature ?? []);
    const nextGraphCache = new Map<string, ExecutionGraphData>();
    const executionGraphs: ExecutionGraphData[] = [];
    const suppressedToolCardRowKeys = new Set<string>();
    let cursor = 0;
    let firstBatch = true;

    const publishProgress = () => {
      const executionGraphsSnapshot = snapshotExecutionGraphs(executionGraphs);
      const suppressedSnapshot = snapshotSuppressedToolCardRowKeys(suppressedToolCardRowKeys);
      setRenderState((previous) => {
        if (previous.sessionKey !== currentSessionKey) {
          return previous;
        }
        if (
          previous.executionGraphs === executionGraphsSnapshot
          && previous.suppressedToolCardRowKeys === suppressedSnapshot
        ) {
          return previous;
        }
        return {
          sessionKey: currentSessionKey,
          executionGraphs: executionGraphsSnapshot,
          suppressedToolCardRowKeys: suppressedSnapshot,
        };
      });
      return {
        executionGraphsSnapshot,
        suppressedSnapshot,
      };
    };

    const scheduleChunk = () => {
      idleHandleRef.current = scheduleIdleCallback((deadline) => {
        if (computeRunId !== computeRunIdRef.current) {
          return;
        }
        const batchLimit = firstBatch ? EXECUTION_GRAPH_FIRST_BATCH_SIZE : EXECUTION_GRAPH_BATCH_SIZE;
        firstBatch = false;
        let processed = 0;
        const relatedSubagentSessionKeys = new Set<string>();

        while (cursor < anchors.anchors.length && processed < batchLimit) {
          const relatedSessionKey = materializeExecutionGraphAtIndex({
            anchorIndex: cursor,
            anchors: anchors.anchors,
            keyIndex,
            messages,
            currentSessionKey,
            sending,
            pendingFinal,
            showThinking,
            streamingMessage,
            streamingTools,
            streamingSignature,
            subagentHistoryBySession: subagentHistoryBySessionRef.current,
            agentNameById,
            previousGraphCache,
            nextGraphCache,
            mainStepsCacheBySignature,
            childStepsCacheBySignature,
            executionGraphs,
            suppressedToolCardRowKeys,
          });
          if (relatedSessionKey) {
            relatedSubagentSessionKeys.add(relatedSessionKey);
          }
          cursor += 1;
          processed += 1;
          if (!deadline.didTimeout && deadline.timeRemaining() <= EXECUTION_GRAPH_IDLE_MIN_BUDGET_MS) {
            break;
          }
        }

        if (processed > 0) {
          publishProgress();
          if (relatedSubagentSessionKeys.size > 0) {
            fetchMissingSubagentHistories(Array.from(relatedSubagentSessionKeys));
          }
        }

        if (cursor < anchors.anchors.length) {
          scheduleChunk();
          return;
        }

        const finalExecutionGraphs = snapshotExecutionGraphs(executionGraphs);
        const finalSuppressedKeys = snapshotSuppressedToolCardRowKeys(suppressedToolCardRowKeys);
        const nextCache: SessionExecutionCache = {
          messagesRef: messages,
          agentsRef: agents,
          subagentHistoryRevision,
          streamingMessageRef: streamingMessage,
          streamingToolsRef: streamingTools,
          sending,
          pendingFinal,
          showThinking,
          executionGraphs: finalExecutionGraphs,
          suppressedToolCardRowKeys: finalSuppressedKeys,
          keyIndex,
          anchors,
          graphCacheBySignature: nextGraphCache,
          mainStepsCacheBySignature,
          childStepsCacheBySignature,
        };
        rememberSessionExecutionCache(currentSessionKey, nextCache);
        setRenderState((previous) => {
          if (previous.sessionKey !== currentSessionKey) {
            return previous;
          }
          if (
            previous.executionGraphs === finalExecutionGraphs
            && previous.suppressedToolCardRowKeys === finalSuppressedKeys
          ) {
            return previous;
          }
          return {
            sessionKey: currentSessionKey,
            executionGraphs: finalExecutionGraphs,
            suppressedToolCardRowKeys: finalSuppressedKeys,
          };
        });
      });
    };

    scheduleChunk();

    return () => {
      if (idleHandleRef.current != null) {
        cancelIdleCallbackSafe(idleHandleRef.current);
        idleHandleRef.current = null;
      }
    };
  }, [
    agents,
    currentSessionKey,
    fetchMissingSubagentHistories,
    isGatewayRunning,
    messages,
    pendingFinal,
    renderState.sessionKey,
    sending,
    showThinking,
    streamingMessage,
    streamingTools,
    subagentHistoryRevision,
  ]);

  if (renderState.sessionKey !== currentSessionKey) {
    const immediateCache = globalSessionExecutionCache.get(currentSessionKey);
    if (immediateCache) {
      return {
        executionGraphs: immediateCache.executionGraphs,
        suppressedToolCardRowKeys: immediateCache.suppressedToolCardRowKeys,
      };
    }
    return {
      executionGraphs: EMPTY_EXECUTION_GRAPHS,
      suppressedToolCardRowKeys: EMPTY_SUPPRESSED_KEYS,
    };
  }

  return {
    executionGraphs: renderState.executionGraphs,
    suppressedToolCardRowKeys: renderState.suppressedToolCardRowKeys,
  };
}
