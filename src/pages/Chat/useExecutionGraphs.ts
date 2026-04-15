import { useEffect, useMemo, useRef, useState } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import {
  canAppendMessageList,
  type ExecutionGraphData,
} from './chat-row-model';
import {
  EMPTY_ANCHOR_GRAPH_MAP,
  EMPTY_EXECUTION_GRAPHS,
  EMPTY_GRAPH_SIGNATURES,
  EMPTY_MESSAGES,
  EMPTY_SUPPRESSED_KEYS,
  EXECUTION_GRAPH_BATCH_SIZE,
  EXECUTION_GRAPH_FIRST_BATCH_SIZE,
  EXECUTION_GRAPH_IDLE_MIN_BUDGET_MS,
  SUBAGENT_HISTORY_CACHE_MAX_SESSIONS,
  SUBAGENT_HISTORY_LIMIT,
  type ExecutionGraphAgent,
  type IdleCallbackHandle,
  type SessionExecutionCache,
} from './exec-graph-types';
import {
  cancelIdleCallbackSafe,
  globalSessionExecutionCache,
  globalSubagentHistoryBySession,
  rememberSessionExecutionCache,
  scheduleIdleCallback,
  snapshotExecutionGraphs,
  snapshotSuppressedToolCardRowKeys,
} from './exec-graph-cache';
import { buildCompletionAnchors, buildMessageKeyIndex } from './exec-graph-index';
import {
  buildGraphSignaturesByAnchor,
  findFirstChangedCompletionAnchorIndex,
  buildStreamingSignature,
  findFirstChangedAnchorIndex,
} from './exec-graph-signature';
import {
  materializeExecutionGraphAtIndex,
} from './exec-graph-materialize';
import {
  nowMonotonicMs,
  trackExecutionGraphPipelineMetric,
  type ExecutionGraphPipelineOutcome,
} from './exec-graph-metrics';

function areAnchorsEqual(
  left: ReadonlyArray<{
    eventIndex: number;
    triggerIndex: number;
    replyIndex: number | null;
    sessionKey: string;
    sessionId?: string;
    agentId?: string;
  }>,
  right: ReadonlyArray<{
    eventIndex: number;
    triggerIndex: number;
    replyIndex: number | null;
    sessionKey: string;
    sessionId?: string;
    agentId?: string;
  }>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a.eventIndex !== b.eventIndex
      || a.triggerIndex !== b.triggerIndex
      || a.replyIndex !== b.replyIndex
      || a.sessionKey !== b.sessionKey
      || (a.sessionId ?? '') !== (b.sessionId ?? '')
      || (a.agentId ?? '') !== (b.agentId ?? '')
    ) {
      return false;
    }
  }
  return true;
}

function hasOpenAnchors(
  anchors: ReadonlyArray<{ replyIndex: number | null }>,
): boolean {
  for (const anchor of anchors) {
    if (anchor.replyIndex == null) {
      return true;
    }
  }
  return false;
}

function areAgentsEquivalent(
  left: ReadonlyArray<ExecutionGraphAgent>,
  right: ReadonlyArray<ExecutionGraphAgent>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a.id !== b.id || (a.name ?? '') !== (b.name ?? '')) {
      return false;
    }
  }
  return true;
}

function areStreamingToolsEquivalent(
  left: ReadonlyArray<ToolStatus>,
  right: ReadonlyArray<ToolStatus>,
): boolean {
  if (left === right) {
    return true;
  }
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      (a.id ?? '') !== (b.id ?? '')
      || (a.toolCallId ?? '') !== (b.toolCallId ?? '')
      || a.name !== b.name
      || a.status !== b.status
      || (a.durationMs ?? null) !== (b.durationMs ?? null)
      || (a.summary ?? '') !== (b.summary ?? '')
      || a.updatedAt !== b.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

function isStreamingStateEquivalent(
  previous: {
    sending: boolean;
    streamingMessageRef: unknown | null;
    streamingToolsRef: ToolStatus[];
  },
  current: {
    sending: boolean;
    streamingMessage: unknown | null;
    streamingTools: ToolStatus[];
  },
): boolean {
  if (!previous.sending && !current.sending) {
    return true;
  }
  return (
    previous.streamingMessageRef === current.streamingMessage
    && areStreamingToolsEquivalent(previous.streamingToolsRef, current.streamingTools)
  );
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
  const renderStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const cancelScheduledRenderState = useMemo(() => (
    () => {
      if (renderStateTimerRef.current != null) {
        clearTimeout(renderStateTimerRef.current);
        renderStateTimerRef.current = null;
      }
    }
  ), []);
  const scheduleRenderState = useMemo(() => (
    (next: {
      sessionKey: string;
      executionGraphs: ExecutionGraphData[];
      suppressedToolCardRowKeys: Set<string>;
    }) => {
      cancelScheduledRenderState();
      renderStateTimerRef.current = setTimeout(() => {
        renderStateTimerRef.current = null;
        setRenderState((previous) => {
          if (
            previous.sessionKey === next.sessionKey
            && previous.executionGraphs === next.executionGraphs
            && previous.suppressedToolCardRowKeys === next.suppressedToolCardRowKeys
          ) {
            return previous;
          }
          return next;
        });
      }, 0);
    }
  ), [cancelScheduledRenderState]);

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
    cancelScheduledRenderState();
    if (idleHandleRef.current != null) {
      cancelIdleCallbackSafe(idleHandleRef.current);
      idleHandleRef.current = null;
    }

    if (!isGatewayRunning) {
      return;
    }

    const cache = globalSessionExecutionCache.get(currentSessionKey);
    const hasEquivalentStreamingState = cache
      ? isStreamingStateEquivalent(cache, {
        sending,
        streamingMessage,
        streamingTools,
      })
      : false;
    const hasExactCache = Boolean(
      cache
      && cache.messagesRef === messages
      && areAgentsEquivalent(cache.agentsRef, agents)
      && cache.subagentHistoryRevision === subagentHistoryRevision
      && cache.sending === sending
      && cache.pendingFinal === pendingFinal
      && cache.showThinking === showThinking
      && hasEquivalentStreamingState,
    );
    if (hasExactCache && cache) {
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: cache.executionGraphs,
        suppressedToolCardRowKeys: cache.suppressedToolCardRowKeys,
      });
      return;
    }

    if (cache) {
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: cache.executionGraphs,
        suppressedToolCardRowKeys: cache.suppressedToolCardRowKeys,
      });
    } else {
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: EMPTY_EXECUTION_GRAPHS,
        suppressedToolCardRowKeys: EMPTY_SUPPRESSED_KEYS,
      });
    }

    const computeRunId = ++computeRunIdRef.current;
    const previousCache = globalSessionExecutionCache.get(currentSessionKey);
    const cacheState = previousCache ? 'warm' as const : 'cold' as const;
    const pipelineStartedAt = nowMonotonicMs();
    let pipelineSettled = false;
    let pipelineReusedAnchors = 0;
    let pipelineComputedAnchors = 0;
    let pipelineBatchCount = 0;
    const fetchedSubagentSessionKeys = new Set<string>();
    const finalizePipelineMetric = (
      outcome: ExecutionGraphPipelineOutcome,
      options?: { reason?: 'superseded' | 'cleanup'; graphCount?: number },
    ) => {
      if (pipelineSettled) {
        return;
      }
      pipelineSettled = true;
      trackExecutionGraphPipelineMetric({
        durationMs: Math.max(0, nowMonotonicMs() - pipelineStartedAt),
        sessionKey: currentSessionKey,
        cacheState,
        outcome,
        reason: options?.reason,
        anchors: anchors.anchors.length,
        reusedAnchors: pipelineReusedAnchors,
        computedAnchors: pipelineComputedAnchors,
        graphCount: options?.graphCount ?? 0,
        batchCount: pipelineBatchCount,
        fetchedSubagentSessions: fetchedSubagentSessionKeys.size,
      });
    };
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
        graphSignaturesByAnchor: EMPTY_GRAPH_SIGNATURES,
        graphByAnchor: EMPTY_ANCHOR_GRAPH_MAP,
        graphCacheBySignature: new Map(),
        mainStepsCacheBySignature: new Map(previousCache?.mainStepsCacheBySignature ?? []),
        childStepsCacheBySignature: new Map(previousCache?.childStepsCacheBySignature ?? []),
      };
      rememberSessionExecutionCache(currentSessionKey, nextCache);
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: nextCache.executionGraphs,
        suppressedToolCardRowKeys: nextCache.suppressedToolCardRowKeys,
      });
      finalizePipelineMetric('empty');
      return () => {
        finalizePipelineMetric('aborted', { reason: 'cleanup' });
        cancelScheduledRenderState();
        if (idleHandleRef.current != null) {
          cancelIdleCallbackSafe(idleHandleRef.current);
          idleHandleRef.current = null;
        }
      };
    }

    const canReuseClosedAnchors = Boolean(
      previousCache
      && canAppendMessageList(previousCache.messagesRef, messages)
      && areAgentsEquivalent(previousCache.agentsRef, agents)
      && previousCache.subagentHistoryRevision === subagentHistoryRevision
      && previousCache.sending === sending
      && previousCache.pendingFinal === pendingFinal
      && previousCache.showThinking === showThinking
      && isStreamingStateEquivalent(previousCache, {
        sending,
        streamingMessage,
        streamingTools,
      })
      && previousCache.graphByAnchor.length === anchors.anchors.length
      && areAnchorsEqual(previousCache.anchors.anchors, anchors.anchors)
      && !hasOpenAnchors(anchors.anchors)
    );
    if (canReuseClosedAnchors && previousCache) {
      pipelineReusedAnchors = anchors.anchors.length;
      const nextCache: SessionExecutionCache = {
        ...previousCache,
        messagesRef: messages,
        agentsRef: agents,
        subagentHistoryRevision,
        streamingMessageRef: streamingMessage,
        streamingToolsRef: streamingTools,
        sending,
        pendingFinal,
        showThinking,
        keyIndex,
        anchors,
      };
      rememberSessionExecutionCache(currentSessionKey, nextCache);
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: nextCache.executionGraphs,
        suppressedToolCardRowKeys: nextCache.suppressedToolCardRowKeys,
      });
      finalizePipelineMetric('completed', { graphCount: nextCache.executionGraphs.length });
      return () => {
        finalizePipelineMetric('aborted', { reason: 'cleanup', graphCount: nextCache.executionGraphs.length });
        cancelScheduledRenderState();
        if (idleHandleRef.current != null) {
          cancelIdleCallbackSafe(idleHandleRef.current);
          idleHandleRef.current = null;
        }
      };
    }

    const agentNameById = new Map(agents.map((agent) => [agent.id, agent.name || agent.id] as const));
    const streamingSignature = buildStreamingSignature(streamingMessage, streamingTools);
    const canReuseSignaturePrefix = Boolean(
      previousCache
      && !sending
      && !previousCache.sending
      && previousCache.pendingFinal === pendingFinal
      && previousCache.showThinking === showThinking
      && previousCache.subagentHistoryRevision === subagentHistoryRevision
      && areAgentsEquivalent(previousCache.agentsRef, agents)
    );
    const reusableSignaturePrefix = canReuseSignaturePrefix
      ? findFirstChangedCompletionAnchorIndex(previousCache?.anchors.anchors, anchors.anchors)
      : 0;
    const graphSignaturesByAnchor = buildGraphSignaturesByAnchor({
      anchors: anchors.anchors,
      currentSessionKey,
      sending,
      pendingFinal,
      showThinking,
      streamingSignature,
      subagentHistoryBySession: subagentHistoryBySessionRef.current,
      agentNameById,
      startIndex: reusableSignaturePrefix,
      previousSignatures: reusableSignaturePrefix > 0 ? previousCache?.graphSignaturesByAnchor : undefined,
    });
    const firstChangedAnchorIndex = findFirstChangedAnchorIndex(
      previousCache?.graphSignaturesByAnchor,
      graphSignaturesByAnchor,
    );
    if (
      previousCache
      && firstChangedAnchorIndex >= anchors.anchors.length
      && previousCache.graphByAnchor.length === anchors.anchors.length
    ) {
      pipelineReusedAnchors = anchors.anchors.length;
      const nextCache: SessionExecutionCache = {
        ...previousCache,
        messagesRef: messages,
        agentsRef: agents,
        subagentHistoryRevision,
        streamingMessageRef: streamingMessage,
        streamingToolsRef: streamingTools,
        sending,
        pendingFinal,
        showThinking,
        keyIndex,
        anchors,
        graphSignaturesByAnchor,
      };
      rememberSessionExecutionCache(currentSessionKey, nextCache);
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: nextCache.executionGraphs,
        suppressedToolCardRowKeys: nextCache.suppressedToolCardRowKeys,
      });
      finalizePipelineMetric('completed', { graphCount: nextCache.executionGraphs.length });
      return () => {
        finalizePipelineMetric('aborted', { reason: 'cleanup', graphCount: nextCache.executionGraphs.length });
        cancelScheduledRenderState();
        if (idleHandleRef.current != null) {
          cancelIdleCallbackSafe(idleHandleRef.current);
          idleHandleRef.current = null;
        }
      };
    }
    const previousGraphCache = previousCache?.graphCacheBySignature ?? new Map<string, ExecutionGraphData>();
    const mainStepsCacheBySignature = new Map(previousCache?.mainStepsCacheBySignature ?? []);
    const childStepsCacheBySignature = new Map(previousCache?.childStepsCacheBySignature ?? []);
    const nextGraphCache = new Map<string, ExecutionGraphData>();
    const graphByAnchor: Array<ExecutionGraphData | null> = new Array(anchors.anchors.length).fill(null);
    const executionGraphs: ExecutionGraphData[] = [];
    const suppressedToolCardRowKeys = new Set<string>();
    const previousGraphByAnchor = previousCache?.graphByAnchor ?? [];
    const previousGraphSignaturesByAnchor = previousCache?.graphSignaturesByAnchor ?? [];
    const reusableAnchorCount = Math.min(firstChangedAnchorIndex, previousGraphByAnchor.length);
    const reusableAnchorIndexes = new Set<number>();
    const sharedAnchorLength = Math.min(
      anchors.anchors.length,
      previousGraphByAnchor.length,
      previousGraphSignaturesByAnchor.length,
      graphSignaturesByAnchor.length,
    );
    for (let index = reusableAnchorCount; index < sharedAnchorLength; index += 1) {
      if (previousGraphSignaturesByAnchor[index] !== graphSignaturesByAnchor[index]) {
        continue;
      }
      reusableAnchorIndexes.add(index);
    }
    pipelineReusedAnchors = reusableAnchorCount;
    pipelineReusedAnchors += reusableAnchorIndexes.size;
    for (let index = 0; index < reusableAnchorCount; index += 1) {
      const cachedGraph = previousGraphByAnchor[index];
      graphByAnchor[index] = cachedGraph ?? null;
      if (!cachedGraph) {
        continue;
      }
      executionGraphs.push(cachedGraph);
      const signature = graphSignaturesByAnchor[index];
      if (signature) {
        nextGraphCache.set(signature, cachedGraph);
      }
      for (const key of cachedGraph.suppressToolCardMessageKeys || []) {
        suppressedToolCardRowKeys.add(key);
      }
    }

    let cursor = firstChangedAnchorIndex;
    let firstBatch = true;
    let publishedGraphCount = executionGraphs.length;
    let publishedSuppressedCount = suppressedToolCardRowKeys.size;

    const publishProgress = () => {
      if (
        executionGraphs.length === publishedGraphCount
        && suppressedToolCardRowKeys.size === publishedSuppressedCount
      ) {
        return;
      }
      publishedGraphCount = executionGraphs.length;
      publishedSuppressedCount = suppressedToolCardRowKeys.size;
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
    };

    const commitFinalState = () => {
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
        graphSignaturesByAnchor,
        graphByAnchor,
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
      finalizePipelineMetric('completed', { graphCount: finalExecutionGraphs.length });
    };

    const scheduleChunk = () => {
      idleHandleRef.current = scheduleIdleCallback((deadline) => {
        if (computeRunId !== computeRunIdRef.current) {
          finalizePipelineMetric('aborted', { reason: 'superseded', graphCount: executionGraphs.length });
          return;
        }
        const batchLimit = firstBatch ? EXECUTION_GRAPH_FIRST_BATCH_SIZE : EXECUTION_GRAPH_BATCH_SIZE;
        firstBatch = false;
        let processedAnchors = 0;
        let computedAnchors = 0;
        const relatedSubagentSessionKeys = new Set<string>();

        while (cursor < anchors.anchors.length && processedAnchors < batchLimit) {
          if (reusableAnchorIndexes.has(cursor)) {
            const cachedGraph = previousGraphByAnchor[cursor] ?? null;
            graphByAnchor[cursor] = cachedGraph;
            if (cachedGraph) {
              executionGraphs.push(cachedGraph);
              const signature = graphSignaturesByAnchor[cursor];
              if (signature) {
                nextGraphCache.set(signature, cachedGraph);
              }
              for (const key of cachedGraph.suppressToolCardMessageKeys || []) {
                suppressedToolCardRowKeys.add(key);
              }
            }
            cursor += 1;
            processedAnchors += 1;
            if (!deadline.didTimeout && deadline.timeRemaining() <= EXECUTION_GRAPH_IDLE_MIN_BUDGET_MS) {
              break;
            }
            continue;
          }

          const relatedSessionKey = materializeExecutionGraphAtIndex({
            anchorIndex: cursor,
            anchors: anchors.anchors,
            graphSignature: graphSignaturesByAnchor[cursor] ?? '',
            graphByAnchor,
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
          processedAnchors += 1;
          computedAnchors += 1;
          if (!deadline.didTimeout && deadline.timeRemaining() <= EXECUTION_GRAPH_IDLE_MIN_BUDGET_MS) {
            break;
          }
        }

        if (processedAnchors > 0) {
          pipelineBatchCount += 1;
          pipelineComputedAnchors += computedAnchors;
          publishProgress();
          if (relatedSubagentSessionKeys.size > 0) {
            for (const key of relatedSubagentSessionKeys) {
              fetchedSubagentSessionKeys.add(key);
            }
            fetchMissingSubagentHistories(Array.from(relatedSubagentSessionKeys));
          }
        }

        if (cursor < anchors.anchors.length) {
          scheduleChunk();
          return;
        }

        commitFinalState();
      });
    };

    if (cursor >= anchors.anchors.length) {
      commitFinalState();
      return () => {
        finalizePipelineMetric('aborted', { reason: 'cleanup', graphCount: executionGraphs.length });
        cancelScheduledRenderState();
        if (idleHandleRef.current != null) {
          cancelIdleCallbackSafe(idleHandleRef.current);
          idleHandleRef.current = null;
        }
      };
    }

    scheduleChunk();

    return () => {
      finalizePipelineMetric('aborted', { reason: 'cleanup', graphCount: executionGraphs.length });
      cancelScheduledRenderState();
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
    cancelScheduledRenderState,
    sending,
    scheduleRenderState,
    showThinking,
    streamingMessage,
    streamingTools,
    subagentHistoryRevision,
  ]);

  if (!isGatewayRunning) {
    return {
      executionGraphs: EMPTY_EXECUTION_GRAPHS,
      suppressedToolCardRowKeys: EMPTY_SUPPRESSED_KEYS,
    };
  }

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
