import { useEffect, useMemo, useRef, useState } from 'react';
import type { RawMessage } from '@/stores/chat';
import {
  canAppendMessageList,
} from './chat-row-model';
import type { ExecutionGraphData } from './execution-graph-model';
import {
  EMPTY_ANCHOR_GRAPH_MAP,
  EMPTY_EXECUTION_GRAPHS,
  EMPTY_GRAPH_SIGNATURES,
  EMPTY_MESSAGES,
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
} from './exec-graph-cache';
import { getIsChatScrollDraining } from './chat-scroll-drain';
import { buildCompletionAnchors, buildMessageKeyIndex } from './exec-graph-index';
import {
  buildGraphSignaturesByAnchor,
  findFirstChangedCompletionAnchorIndex,
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

interface UseExecutionGraphsInput {
  enabled: boolean;
  messages: RawMessage[];
  currentSessionKey: string;
  agents: ExecutionGraphAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  showThinking: boolean;
}
export function useExecutionGraphs({
  enabled,
  messages,
  currentSessionKey,
  agents,
  isGatewayRunning,
  gatewayRpc,
  showThinking,
}: UseExecutionGraphsInput): ExecutionGraphData[] {
  const subagentHistoryBySessionRef = useRef<Map<string, RawMessage[]>>(globalSubagentHistoryBySession);
  const [subagentHistoryRevision, setSubagentHistoryRevision] = useState(0);
  const subagentHistoryLoadingRef = useRef<Set<string>>(new Set());
  const idleHandleRef = useRef<IdleCallbackHandle | null>(null);
  const renderStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const computeRunIdRef = useRef(0);
  const [renderState, setRenderState] = useState<{
    sessionKey: string;
    executionGraphs: ExecutionGraphData[];
  }>({
    sessionKey: currentSessionKey,
    executionGraphs: EMPTY_EXECUTION_GRAPHS,
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
    }) => {
      cancelScheduledRenderState();
      renderStateTimerRef.current = setTimeout(() => {
        renderStateTimerRef.current = null;
        setRenderState((previous) => {
          if (
            previous.sessionKey === next.sessionKey
            && previous.executionGraphs === next.executionGraphs
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

    if (!enabled || !isGatewayRunning) {
      return;
    }

    const cache = globalSessionExecutionCache.get(currentSessionKey);
    const hasExactCache = Boolean(
      cache
      && cache.messagesRef === messages
      && areAgentsEquivalent(cache.agentsRef, agents)
      && cache.subagentHistoryRevision === subagentHistoryRevision
      && cache.showThinking === showThinking
    );
    if (hasExactCache && cache) {
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: cache.executionGraphs,
      });
      return;
    }

    if (cache) {
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: cache.executionGraphs,
      });
    } else {
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: EMPTY_EXECUTION_GRAPHS,
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
        showThinking,
        executionGraphs: EMPTY_EXECUTION_GRAPHS,
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
      && previousCache.showThinking === showThinking
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
        showThinking,
        keyIndex,
        anchors,
      };
      rememberSessionExecutionCache(currentSessionKey, nextCache);
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: nextCache.executionGraphs,
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
    const canReuseSignaturePrefix = Boolean(
      previousCache
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
      showThinking,
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
        showThinking,
        keyIndex,
        anchors,
        graphSignaturesByAnchor,
      };
      rememberSessionExecutionCache(currentSessionKey, nextCache);
      scheduleRenderState({
        sessionKey: currentSessionKey,
        executionGraphs: nextCache.executionGraphs,
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
    }

    let cursor = firstChangedAnchorIndex;
    let firstBatch = true;
    let publishedGraphCount = executionGraphs.length;

    const publishProgress = () => {
      if (executionGraphs.length === publishedGraphCount) {
        return;
      }
      publishedGraphCount = executionGraphs.length;
      const executionGraphsSnapshot = snapshotExecutionGraphs(executionGraphs);
      setRenderState((previous) => {
        if (previous.sessionKey !== currentSessionKey) {
          return previous;
        }
        if (previous.executionGraphs === executionGraphsSnapshot) {
          return previous;
        }
        return {
          sessionKey: currentSessionKey,
          executionGraphs: executionGraphsSnapshot,
        };
      });
    };

    const commitFinalState = () => {
      const finalExecutionGraphs = snapshotExecutionGraphs(executionGraphs);
      const nextCache: SessionExecutionCache = {
        messagesRef: messages,
        agentsRef: agents,
        subagentHistoryRevision,
        showThinking,
        executionGraphs: finalExecutionGraphs,
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
        if (previous.executionGraphs === finalExecutionGraphs) {
          return previous;
        }
        return {
          sessionKey: currentSessionKey,
          executionGraphs: finalExecutionGraphs,
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
        if (getIsChatScrollDraining()) {
          scheduleChunk();
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
            showThinking,
            subagentHistoryBySession: subagentHistoryBySessionRef.current,
            agentNameById,
            previousGraphCache,
            nextGraphCache,
            mainStepsCacheBySignature,
            childStepsCacheBySignature,
            executionGraphs,
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
    enabled,
    fetchMissingSubagentHistories,
    isGatewayRunning,
    messages,
    cancelScheduledRenderState,
    scheduleRenderState,
    showThinking,
    subagentHistoryRevision,
  ]);

  if (!enabled || !isGatewayRunning) {
    return EMPTY_EXECUTION_GRAPHS;
  }

  if (renderState.sessionKey !== currentSessionKey) {
    const immediateCache = globalSessionExecutionCache.get(currentSessionKey);
    if (immediateCache) {
      return immediateCache.executionGraphs;
    }
    return EMPTY_EXECUTION_GRAPHS;
  }

  return renderState.executionGraphs;
}
