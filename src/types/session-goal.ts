import type { SessionIdentity } from './desktop/runtime-address';

export type SessionGoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budget_limited' | 'usage_limited';

/** Read-only native facts; token accounting and transitions belong to the peer runtime. */
export type SessionGoal = {
  schemaVersion: 1;
  id: string;
  objective: string;
  status: SessionGoalStatus;
  createdAt: number;
  updatedAt: number;
  tokenStart: number;
  tokenStartFresh?: boolean;
  tokensUsed: number;
  tokenBudget?: number;
  continuationTurns: number;
  lastStatusNote?: string;
  pausedAt?: number;
  blockedAt?: number;
  completedAt?: number;
  usageLimitedAt?: number;
  budgetLimitedAt?: number;
};

export type SessionGoalView =
  | { kind: 'known'; goal: SessionGoal | null }
  | { kind: 'unknown' }
  | { kind: 'unsupported' };

export type SessionSendIntent = { kind: 'goalStart'; issuedAtMs: number };

export type SessionGoalOperationIdentity = {
  sessionIdentity: SessionIdentity;
  endpointSessionId: string;
  goalId: string;
  operationId: string;
  issuedAtMs: number;
};

export type SessionGoalUpdate =
  | { action: 'edit'; objective: string }
  | { action: 'pause' | 'resume' | 'complete' | 'block'; note?: string };

export type SessionGoalUpdateInput = SessionGoalOperationIdentity & SessionGoalUpdate;
export type SessionGoalClearInput = SessionGoalOperationIdentity;
export type SessionGoalAction = SessionGoalUpdate['action'] | 'start' | 'clear';

export type SessionGoalReceipt = {
  operationId: string;
  action: SessionGoalAction;
  sessionId: string;
  goalId: string;
  goal?: SessionGoal;
  runId?: string;
  replayed?: true;
  status: 'started' | 'updated' | 'cleared';
};

export type SessionGoalOutcome =
  | { outcome: 'succeeded'; receipt: SessionGoalReceipt }
  | { outcome: 'target_rejected' | 'unknown' | 'unsupported' | 'unavailable' };
