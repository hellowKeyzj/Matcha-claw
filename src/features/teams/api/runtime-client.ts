import { hostCapabilityExecute } from '@/lib/host-api';
import type { RuntimeAddress } from '../../../../runtime-host/shared/runtime-address';

const TEAM_COORDINATION_CAPABILITY_ID = 'team.coordination';

async function teamCapabilityExecute<TResult>(operationId: string, runtimeAddress: RuntimeAddress, input: Record<string, unknown>): Promise<TResult> {
  return await hostCapabilityExecute<TResult>({
    id: TEAM_COORDINATION_CAPABILITY_ID,
    operationId,
    runtimeAddress,
    input: {
      ...input,
      runtimeAddress,
    },
  });
}

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
  runtimeAddress: RuntimeAddress;
  status: 'active' | 'paused' | 'closed';
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export async function teamInit(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
  leadAgentId: string;
}): Promise<{ runtimeRoot: string; run: TeamRunMeta }> {
  return teamCapabilityExecute('team.init', payload.runtimeAddress, payload);
}

export async function teamSnapshot(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
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
  return teamCapabilityExecute('team.snapshot', payload.runtimeAddress, payload);
}

export async function teamPlanUpsert(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
  tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
}): Promise<{ tasks: TeamTask[] }> {
  return teamCapabilityExecute('team.planUpsert', payload.runtimeAddress, payload);
}

export async function teamClaimNext(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
  agentId: string;
  sessionKey: string;
  leaseMs?: number;
}): Promise<{ task: TeamTask | null }> {
  return teamCapabilityExecute('team.claimNext', payload.runtimeAddress, payload);
}

export async function teamHeartbeat(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
  taskId: string;
  agentId: string;
  sessionKey: string;
  leaseMs?: number;
}): Promise<{ ok: boolean; task?: TeamTask }> {
  return teamCapabilityExecute('team.heartbeat', payload.runtimeAddress, payload);
}

export async function teamTaskUpdate(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
  taskId: string;
  status: TeamTaskStatus;
  resultSummary?: string;
  error?: string;
}): Promise<{ task: TeamTask }> {
  return teamCapabilityExecute('team.taskUpdate', payload.runtimeAddress, payload);
}

export async function teamMailboxPost(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
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
  return teamCapabilityExecute('team.mailboxPost', payload.runtimeAddress, payload);
}

export async function teamMailboxPull(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
  cursor?: string;
  limit?: number;
}): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }> {
  return teamCapabilityExecute('team.mailboxPull', payload.runtimeAddress, payload);
}

export async function teamReleaseClaim(payload: {
  teamId: string;
  runtimeAddress: RuntimeAddress;
  taskId: string;
  agentId: string;
  sessionKey: string;
}): Promise<{ ok: boolean; task?: TeamTask }> {
  return teamCapabilityExecute('team.releaseClaim', payload.runtimeAddress, payload);
}
