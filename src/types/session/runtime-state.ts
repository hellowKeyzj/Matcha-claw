export type GatewayIssueSource =
  | 'connect'
  | 'rpc'
  | 'socket-close'
  | 'heartbeat-timeout'
  | 'runtime';

export interface GatewayTransportIssue {
  readonly message: string;
  readonly source: GatewayIssueSource;
  readonly at: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly retryable?: boolean;
  readonly retryAfterMs?: number;
}

export type SessionRunPhase =
  | 'idle'
  | 'submitted'
  | 'streaming'
  | 'waiting_tool'
  | 'finalizing'
  | 'stopping'
  | 'done'
  | 'error'
  | 'aborted';

export type SessionRuntimeActivity = 'compacting';

export interface SessionRuntimeStateSnapshot {
  activeRunId: string | null;
  runPhase: SessionRunPhase;
  activeTurnItemKey: string | null;
  pendingTurnKey: string | null;
  pendingTurnLaneKey: string | null;
  runtimeActivity: SessionRuntimeActivity | null;
  lastUserMessageAt: number | null;
  lastError: string | null;
  lastIssue: GatewayTransportIssue | null;
  updatedAt: number | null;
}

const ACTIVE_RUN_PHASES: ReadonlySet<SessionRunPhase> = new Set([
  'submitted',
  'streaming',
  'waiting_tool',
  'finalizing',
  'stopping',
]);

/**
 * 单一事实源：runPhase 决定运行态。
 * isRunActive = 当前回合正在被 Gateway 处理（已 submit、还没收到 final/error/aborted）
 */
export function isRunActive(runtime: { runPhase: SessionRunPhase }): boolean {
  return ACTIVE_RUN_PHASES.has(runtime.runPhase);
}

/**
 * 是否在等工具结果（运行中且某个 tool 还在 running）。
 */
export function isWaitingTool(runtime: { runPhase: SessionRunPhase }): boolean {
  return runtime.runPhase === 'waiting_tool';
}
