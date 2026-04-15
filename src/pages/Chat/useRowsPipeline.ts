import { useDeferredValue, useEffect, type MutableRefObject } from 'react';
import type { RawMessage, ToolStatus } from '@/stores/chat';
import { useExecutionGraphs } from './useExecutionGraphs';
import { useChatWindowSlice } from './useWindowing';
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
  currentSessionKey: string;
  messages: RawMessage[];
  agents: ExecutionGraphAgent[];
  isGatewayRunning: boolean;
  gatewayRpc: <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;
  sending: boolean;
  pendingFinal: boolean;
  waitingApproval: boolean;
  showThinking: boolean;
  streamingMessage: unknown | null;
  streamingTools: ToolStatus[];
  streamingTimestamp: number;
  sessionPipelineCostRef: MutableRefObject<SessionPipelineCost>;
}

interface UseRowsPipelineResult {
  chatRows: ReturnType<typeof useChatRows>['chatRows'];
  suppressedToolCardRowKeys: ReturnType<typeof useExecutionGraphs>['suppressedToolCardRowKeys'];
  rowSliceCostMs: number;
  runtimeRowsCostMs: number;
  hasOlderRenderableRows: boolean;
  increaseRenderableWindowLimit: (sessionKey: string, step?: number) => void;
}

export function useRowsPipeline(input: UseRowsPipelineInput): UseRowsPipelineResult {
  const {
    currentSessionKey,
    messages,
    agents,
    isGatewayRunning,
    gatewayRpc,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
    sessionPipelineCostRef,
  } = input;

  const {
    rowSourceMessages,
    hasOlderRenderableRows,
    rowSliceCostMs,
    increaseRenderableWindowLimit,
  } = useChatWindowSlice({
    currentSessionKey,
    messages,
  });

  const deferredMessages = useDeferredValue(messages);
  const deferredSessionKey = useDeferredValue(currentSessionKey);
  const executionGraphInputReady = deferredSessionKey === currentSessionKey && deferredMessages === messages;
  const { executionGraphs, suppressedToolCardRowKeys } = useExecutionGraphs({
    messages: executionGraphInputReady ? rowSourceMessages : EMPTY_MESSAGES,
    currentSessionKey,
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
    currentSessionKey,
    rowSourceMessages,
    executionGraphs,
    sending,
    pendingFinal,
    waitingApproval,
    showThinking,
    streamingMessage,
    streamingTools,
    streamingTimestamp,
  });

  useEffect(() => {
    if (staticRowsCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey === currentSessionKey) {
      cost.staticRowsMs += staticRowsCostMs;
    }
  }, [currentSessionKey, sessionPipelineCostRef, staticRowsCostMs]);

  useEffect(() => {
    if (runtimeRowsCostMs <= 0) {
      return;
    }
    const cost = sessionPipelineCostRef.current;
    if (cost.sessionKey === currentSessionKey) {
      cost.runtimeRowsMs += runtimeRowsCostMs;
    }
  }, [currentSessionKey, runtimeRowsCostMs, sessionPipelineCostRef]);

  return {
    chatRows,
    suppressedToolCardRowKeys,
    rowSliceCostMs,
    runtimeRowsCostMs,
    hasOlderRenderableRows,
    increaseRenderableWindowLimit,
  };
}
