import { trackUiTiming } from '@/lib/telemetry';

export type ExecutionGraphCacheState = 'cold' | 'warm';
export type ExecutionGraphPipelineOutcome = 'completed' | 'empty' | 'aborted';

export interface ExecutionGraphPipelineMetricInput {
  durationMs: number;
  sessionKey: string;
  cacheState: ExecutionGraphCacheState;
  outcome: ExecutionGraphPipelineOutcome;
  reason?: 'superseded' | 'cleanup';
  anchors: number;
  reusedAnchors: number;
  computedAnchors: number;
  graphCount: number;
  batchCount: number;
  fetchedSubagentSessions: number;
}

export function nowMonotonicMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

export function trackExecutionGraphPipelineMetric(input: ExecutionGraphPipelineMetricInput): void {
  trackUiTiming('chat.exec_graph_pipeline', input.durationMs, {
    sessionKey: input.sessionKey,
    cacheState: input.cacheState,
    outcome: input.outcome,
    reason: input.reason,
    anchors: input.anchors,
    reusedAnchors: input.reusedAnchors,
    computedAnchors: input.computedAnchors,
    graphCount: input.graphCount,
    batchCount: input.batchCount,
    fetchedSubagentSessions: input.fetchedSubagentSessions,
  });
}
