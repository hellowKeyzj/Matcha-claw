import type { RuntimeAddress } from '../../shared/runtime-address';

export type TeamRunStatus = 'active' | 'paused' | 'closed';

export type TeamTaskStatus = 'todo' | 'claimed' | 'running' | 'blocked' | 'done' | 'failed';

export type TeamMailboxKind = 'question' | 'proposal' | 'decision' | 'report';

export interface TeamRunRecord {
  teamId: string;
  leadAgentId: string;
  runtimeAddress: RuntimeAddress;
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

export interface TeamRuntimeStoragePort {
  initRun(input: { runtimeRoot: string; teamId: string; leadAgentId: string; runtimeAddress: RuntimeAddress }): Promise<TeamRunRecord>;
  readRun(runtimeRoot: string): Promise<TeamRunRecord | null>;
  appendEvent(input: {
    runtimeRoot: string;
    teamId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<TeamEventRecord>;
  readRecentEvents(runtimeRoot: string, limit?: number): Promise<TeamEventRecord[]>;
  upsertPlanTasks(input: {
    runtimeRoot: string;
    tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
  }): Promise<TeamTaskRecord[]>;
  claimNextTask(input: {
    runtimeRoot: string;
    agentId: string;
    sessionKey: string;
    leaseMs: number;
  }): Promise<TeamTaskRecord | null>;
  heartbeatTaskClaim(input: {
    runtimeRoot: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
    leaseMs: number;
  }): Promise<{ ok: boolean; task?: TeamTaskRecord }>;
  updateTaskStatus(input: {
    runtimeRoot: string;
    taskId: string;
    nextStatus: TeamTaskStatus;
    resultSummary?: string;
    error?: string;
  }): Promise<TeamTaskRecord>;
  mailboxPost(input: {
    runtimeRoot: string;
    message: {
      msgId: string;
      fromAgentId: string;
      to?: 'broadcast' | string;
      kind?: TeamMailboxKind;
      content: string;
      relatedTaskId?: string;
      replyToMsgId?: string;
      createdAt?: number;
    };
  }): Promise<{ created: boolean; message: TeamMailboxMessage }>;
  mailboxPull(input: {
    runtimeRoot: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }>;
  releaseTaskClaim(input: {
    runtimeRoot: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
  }): Promise<{ ok: boolean; task?: TeamTaskRecord }>;
  clearRuntime(runtimeRoot: string): Promise<void>;
  listTasks(runtimeRoot: string): Promise<TeamTaskRecord[]>;
}
