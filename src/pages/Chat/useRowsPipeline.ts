import { useDeferredValue, useEffect, useMemo, useState, type MutableRefObject } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import { scheduleIdleReady } from '@/lib/idle-ready';
import { projectLiveThreadMessages } from './live-thread-projection';
import { useExecutionGraphs } from './useExecutionGraphs';
import { useChatRows } from './useRows';

const EMPTY_MESSAGES: RawMessage[] = [];

interface ExecutionGraphAgent {
  id: string;
  name?: string;
}

interface SessionPipelineCost {
  sessionKey: string;
  rowSliceMs: number;
  staticRowsMs: number;
  runtimeRowsMs: number;
}

interface UseRowsPipelineInput {
  projectionScopeKey: string;
  rowSessionKey: string;
  canonicalMessages: RawMessage[];
  projectionMessages: RawMessage[];
  isHistoryProjection: boolean;
  agents: ExecutionGraphAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  pendingUserMessage?: RawMessage | null;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  streamingTimestamp: number;
  sessionPipelineCostRef: MutableRefObject<SessionPipelineCost>;
}

interface UseRowsPipelineResult {
  chatRows: ReturnType<typeof useChatRows>['chatRows'];
  suppressedToolCardRowKeys: ReturnType<typeof useExecutionGraphs>['suppressedToolCardRowKeys'];
  hiddenHistoryCount: number;
  rowSliceCostMs: number;
  runtimeRowsCostMs: number;
}

function nowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function useRowsPipeline(input: UseRowsPipelineInput): UseRowsPipelineResult {
  const {
    projectionScopeKey,
    rowSessionKey,
    canonicalMessages,
    projectionMessages,
    isHistoryProjection,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    pendingUserMessage,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
    sessionPipelineCostRef,
  } = input;
  const projectionResult = useMemo(() => {
    const projectionStartedAt = nowMs();
    const liveThreadProjection = (() => {
      if (isHistoryProjection) {
        return {
          messages: projectionMessages,
          hiddenRenderableCount: 0,
        };
      }
      return projectLiveThreadMessages(canonicalMessages);
    })();
    return {
      liveThreadProjection,
      rowSliceCostMs: Math.max(0, nowMs() - projectionStartedAt),
    };
  }, [
    canonicalMessages,
    isHistoryProjection,
    projectionMessages,
  ]);
  const rowSourceMessages = projectionResult.liveThreadProjection.messages;
  const rowSliceCostMs = projectionResult.rowSliceCostMs;

  const [executionGraphsEnabled, setExecutionGraphsEnabled] = useState(false);

  useEffect(() => {
    setExecutionGraphsEnabled(false);
    const cancel = scheduleIdleReady(() => {
      setExecutionGraphsEnabled(true);
    }, {
      idleTimeoutMs: 240,
      fallbackDelayMs: 90,
    });
    return cancel;
  }, [projectionScopeKey]);

  const deferredMessages = useDeferredValue(rowSourceMessages);
  const deferredSessionKey = useDeferredValue(projectionScopeKey);
  const executionGraphInputReady = deferredSessionKey === projectionScopeKey && deferredMessages === rowSourceMessages;
  const { executionGraphs, suppressedToolCardRowKeys } = useExecutionGraphs({
    enabled: !isHistoryProjection && executionGraphsEnabled && executionGraphInputReady,
    messages: executionGraphInputReady ? rowSourceMessages : EMPTY_MESSAGES,
    currentSessionKey: projectionScopeKey,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending,
    pendingFinal,
    showThinking,
    streamingMessage,
    streamingTools,
  });

  const {
    chatRows,
    staticRowsCostMs,
    runtimeRowsCostMs,
  } = useChatRows({
    currentSessionKey: rowSessionKey,
    rowSourceMessages,
    executionGraphs,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    pendingUserMessage,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
  });
  useEffect(() => {
    if (staticRowsCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey === projectionScopeKey) {
      cost.staticRowsMs += staticRowsCostMs;
    }
  }, [projectionScopeKey, sessionPipelineCostRef, staticRowsCostMs]);

  useEffect(() => {
    if (runtimeRowsCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey === projectionScopeKey) {
      cost.runtimeRowsMs += runtimeRowsCostMs;
    }
  }, [projectionScopeKey, runtimeRowsCostMs, sessionPipelineCostRef]);

  return {
    chatRows,
    suppressedToolCardRowKeys,
    hiddenHistoryCount: projectionResult.liveThreadProjection.hiddenRenderableCount,
    rowSliceCostMs,
    runtimeRowsCostMs,
  };
}
