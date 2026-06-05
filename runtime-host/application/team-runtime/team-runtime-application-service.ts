import type { RuntimeAddress } from '../../shared/runtime-address';
import type { TeamRuntimeStateWorkflow } from '../workflows/team-runtime/team-runtime-state-workflow';
import type { TeamEventRecord, TeamMailboxKind, TeamMailboxMessage, TeamRunRecord, TeamTaskRecord, TeamTaskStatus } from './types';

export type { TeamEventRecord, TeamMailboxMessage, TeamRunRecord, TeamRuntimeStoragePort, TeamTaskRecord } from './types';

export class TeamRuntimeApplicationService {
  constructor(private readonly stateWorkflow: Pick<
    TeamRuntimeStateWorkflow,
    | 'init'
    | 'snapshot'
    | 'planUpsert'
    | 'claimNext'
    | 'heartbeat'
    | 'taskUpdate'
    | 'mailboxPost'
    | 'mailboxPull'
    | 'releaseClaim'
    | 'reset'
    | 'listTasks'
  >) {}

  async init(input: { teamId: string; leadAgentId: string; runtimeAddress: RuntimeAddress }): Promise<{ runtimeRoot: string; run: TeamRunRecord }> {
    return await this.stateWorkflow.init(input);
  }

  async snapshot(input: {
    teamId: string;
    mailboxCursor?: string;
    mailboxLimit?: number;
  }): Promise<{
    run: TeamRunRecord | null;
    tasks: TeamTaskRecord[];
    mailbox: { messages: TeamMailboxMessage[]; nextCursor?: string };
    events: TeamEventRecord[];
  }> {
    return await this.stateWorkflow.snapshot(input);
  }

  async planUpsert(input: {
    teamId: string;
    tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
  }): Promise<{ tasks: TeamTaskRecord[] }> {
    return await this.stateWorkflow.planUpsert(input);
  }

  async claimNext(input: {
    teamId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }): Promise<{ task: TeamTaskRecord | null }> {
    return await this.stateWorkflow.claimNext(input);
  }

  async heartbeat(input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
    return await this.stateWorkflow.heartbeat(input);
  }

  async taskUpdate(input: {
    teamId: string;
    taskId: string;
    status: TeamTaskStatus;
    resultSummary?: string;
    error?: string;
  }): Promise<{ task: TeamTaskRecord }> {
    return await this.stateWorkflow.taskUpdate(input);
  }

  async mailboxPost(input: {
    teamId: string;
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
  }): Promise<{ created: boolean; message: TeamMailboxMessage }> {
    return await this.stateWorkflow.mailboxPost(input);
  }

  async mailboxPull(input: {
    teamId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }> {
    return await this.stateWorkflow.mailboxPull(input);
  }

  async releaseClaim(input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
  }): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
    return await this.stateWorkflow.releaseClaim(input);
  }

  async reset(input: { teamId: string }): Promise<{ ok: true }> {
    return await this.stateWorkflow.reset(input);
  }

  async listTasks(input: { teamId: string }): Promise<{ tasks: TeamTaskRecord[] }> {
    return await this.stateWorkflow.listTasks(input);
  }
}
