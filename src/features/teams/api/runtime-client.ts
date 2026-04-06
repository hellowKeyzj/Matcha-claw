import { hostApiFetch } from '@/lib/host-api';

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
  return hostApiFetch('/api/team-runtime/init', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
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
  return hostApiFetch('/api/team-runtime/snapshot', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function teamPlanUpsert(payload: {
  teamId: string;
  tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
}): Promise<{ tasks: TeamTask[] }> {
  return hostApiFetch('/api/team-runtime/plan-upsert', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function teamClaimNext(payload: {
  teamId: string;
  agentId: string;
  sessionKey: string;
  leaseMs?: number;
}): Promise<{ task: TeamTask | null }> {
  return hostApiFetch('/api/team-runtime/claim-next', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function teamHeartbeat(payload: {
  teamId: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
  leaseMs?: number;
}): Promise<{ ok: boolean; task?: TeamTask }> {
  return hostApiFetch('/api/team-runtime/heartbeat', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function teamTaskUpdate(payload: {
  teamId: string;
  taskId: string;
  status: TeamTaskStatus;
  resultSummary?: string;
  error?: string;
}): Promise<{ task: TeamTask }> {
  return hostApiFetch('/api/team-runtime/task-update', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
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
  return hostApiFetch('/api/team-runtime/mailbox-post', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function teamMailboxPull(payload: {
  teamId: string;
  cursor?: string;
  limit?: number;
}): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }> {
  return hostApiFetch('/api/team-runtime/mailbox-pull', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function teamReleaseClaim(payload: {
  teamId: string;
  taskId: string;
  agentId: string;
  sessionKey: string;
}): Promise<{ ok: boolean; task?: TeamTask }> {
  return hostApiFetch('/api/team-runtime/release-claim', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}
