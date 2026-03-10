import { invokeIpc } from '@/lib/api-client';

export type TeamTaskStatus = 'todo' | 'claimed' | 'running' | 'blocked' | 'done' | 'failed';

export interface TeamTask {
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

export interface TeamMailboxMessage {
  msgId: string;
  fromAgentId: string;
  to: 'broadcast' | string;
  relatedTaskId?: string;
  replyToMsgId?: string;
  kind: 'question' | 'proposal' | 'decision' | 'report';
  content: string;
  createdAt: number;
}

export interface TeamRunMeta {
  teamId: string;
  leadAgentId: string;
  status: 'active' | 'paused' | 'closed';
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export async function teamInit(payload: {
  teamId: string;
  leadAgentId: string;
}): Promise<{ runtimeRoot: string; run: TeamRunMeta }> {
  return invokeIpc('team:init', payload);
}

export async function teamSnapshot(payload: {
  teamId: string;
  mailboxCursor?: string;
  mailboxLimit?: number;
}): Promise<{
  run: TeamRunMeta | null;
  tasks: TeamTask[];
  mailbox: {
    messages: TeamMailboxMessage[];
    nextCursor?: string;
  };
  events: Array<Record<string, unknown>>;
}> {
  return invokeIpc('team:snapshot', payload);
}

export async function teamPlanUpsert(payload: {
  teamId: string;
  tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
}): Promise<{ tasks: TeamTask[] }> {
  return invokeIpc('team:planUpsert', payload);
}

export async function teamClaimNext(payload: {
  teamId: string;
  agentId: string;
  sessionKey: string;
  leaseMs?: number;
}): Promise<{ task: TeamTask | null }> {
  return invokeIpc('team:claimNext', payload);
}

export async function teamHeartbeat(payload: {
  teamId: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
  leaseMs?: number;
}): Promise<{ ok: boolean; task?: TeamTask }> {
  return invokeIpc('team:heartbeat', payload);
}

export async function teamTaskUpdate(payload: {
  teamId: string;
  taskId: string;
  status: TeamTaskStatus;
  resultSummary?: string;
  error?: string;
}): Promise<{ task: TeamTask }> {
  return invokeIpc('team:taskUpdate', payload);
}

export async function teamMailboxPost(payload: {
  teamId: string;
  message: {
    msgId: string;
    fromAgentId: string;
    to?: 'broadcast' | string;
    kind?: 'question' | 'proposal' | 'decision' | 'report';
    content: string;
    relatedTaskId?: string;
    replyToMsgId?: string;
    createdAt?: number;
  };
}): Promise<{ created: boolean; message: TeamMailboxMessage }> {
  return invokeIpc('team:mailboxPost', payload);
}

export async function teamMailboxPull(payload: {
  teamId: string;
  cursor?: string;
  limit?: number;
}): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }> {
  return invokeIpc('team:mailboxPull', payload);
}

export async function teamReleaseClaim(payload: {
  teamId: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
}): Promise<{ ok: boolean; task?: TeamTask }> {
  return invokeIpc('team:releaseClaim', payload);
}
