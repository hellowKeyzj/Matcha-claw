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
export type SessionRunStartupPhase =
  | 'preparing_workspace'
  | 'naming_worktree'
  | 'creating_worktree'
  | 'running_setup'
  | 'provisioning_environment'
  | 'preparing_context'
  | 'starting_model';
export type SessionRunProgress =
  | { kind: 'startup'; phase: SessionRunStartupPhase }
  | { kind: 'retrying'; attempt: number; maxAttempts: number };

export interface SessionRuntimeErrorDetail {
  kind: 'fallback' | 'error';
  failoverReason: string | null;
  providerRuntimeFailureKind: string | null;
  providerErrorType: string | null;
  providerErrorMessagePreview: string | null;
  httpStatus: number | null;
}

export interface SessionRuntimeNotice {
  runId: string;
  kind: 'guardian_reviewing' | 'guardian_approved' | 'guardian_denied' | 'guardian_warning' | 'guardian_strict_review_required';
  command: string | null;
  riskLevel: string | null;
  rationale: string | null;
  message: string | null;
}

export interface SessionRuntimeStateSnapshot {
  activeRunId: string | null;
  runPhase: SessionRunPhase;
  activeTurnItemKey: string | null;
  pendingTurnKey: string | null;
  pendingTurnLaneKey: string | null;
  runProgress: SessionRunProgress | null;
  runtimeActivity: SessionRuntimeActivity | null;
  errorDetail: SessionRuntimeErrorDetail | null;
  runtimeNotice?: SessionRuntimeNotice | null;
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
