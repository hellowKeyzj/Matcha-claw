export type TeamRunStatus = 'active' | 'paused' | 'closed';

export type TeamTaskStatus = 'todo' | 'claimed' | 'running' | 'blocked' | 'done' | 'failed';

export type TeamMailboxKind = 'question' | 'proposal' | 'decision' | 'report';

export interface TeamRunRecord {
  teamId: string;
  leadAgentId: string;
  status: TeamRunStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface TeamTaskRecord {
  taskId: string;
  title: string;
  instruction: string;
  dependsOn: string[];
  status: TeamTaskStatus;
  ownerAgentId?: string;
  claimSessionKey?: string;
  claimedAt?: number;
  leaseUntil?: number;
  attempt: number;
  resultSummary?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TeamClaimLockRecord {
  taskId: string;
  ownerAgentId: string;
  sessionKey: string;
  claimedAt: number;
  leaseUntil: number;
}

export interface TeamMailboxMessage {
  msgId: string;
  fromAgentId: string;
  to: 'broadcast' | string;
  relatedTaskId?: string;
  replyToMsgId?: string;
  kind: TeamMailboxKind;
  content: string;
  createdAt: number;
}

export interface TeamEventRecord {
  id: string;
  teamId: string;
  type: string;
  createdAt: number;
  payload: Record<string, unknown>;
}
