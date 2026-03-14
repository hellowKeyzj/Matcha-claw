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
  initRun(input: { runtimeRoot: string; teamId: string; leadAgentId: string }): Promise<TeamRunRecord>;
  readRun(runtimeRoot: string): Promise<TeamRunRecord | null>;
  appendEvent(input: {
    runtimeRoot: string;
    teamId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<TeamEventRecord>;
  buildSnapshot(input: {
    runtimeRoot: string;
    mailboxCursor?: string;
    mailboxLimit?: number;
  }): Promise<{
    run: TeamRunRecord | null;
    tasks: TeamTaskRecord[];
    mailbox: { messages: TeamMailboxMessage[]; nextCursor?: string };
    events: TeamEventRecord[];
  }>;
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

export class TeamRuntimeApplicationService {
  constructor(
    private readonly storage: TeamRuntimeStoragePort,
    private readonly resolveRuntimeRoot: (teamId: string) => string,
  ) {}

  async init(input: { teamId: string; leadAgentId: string }): Promise<{ runtimeRoot: string; run: TeamRunRecord }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamId);
    const run = await this.storage.initRun({
      runtimeRoot,
      teamId: input.teamId,
      leadAgentId: input.leadAgentId,
    });
    await this.storage.appendEvent({
      runtimeRoot,
      teamId: run.teamId,
      type: 'team:init',
      payload: { leadAgentId: run.leadAgentId },
    });
    return { runtimeRoot, run };
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
    return this.storage.buildSnapshot({
      runtimeRoot: this.resolveRuntimeRoot(input.teamId),
      mailboxCursor: input.mailboxCursor,
      mailboxLimit: input.mailboxLimit,
    });
  }

  async planUpsert(input: {
    teamId: string;
    tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
  }): Promise<{ tasks: TeamTaskRecord[] }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamId);
    const run = await this.storage.readRun(runtimeRoot);
    if (!run) {
      throw new Error(`Team run not initialized: ${input.teamId}`);
    }
    const tasks = await this.storage.upsertPlanTasks({
      runtimeRoot,
      tasks: input.tasks,
    });
    await this.storage.appendEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:planUpsert',
      payload: { taskCount: tasks.length },
    });
    return { tasks };
  }

  async claimNext(input: {
    teamId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }): Promise<{ task: TeamTaskRecord | null }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamId);
    const task = await this.storage.claimNextTask({
      runtimeRoot,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      leaseMs: input.leaseMs ?? 60_000,
    });
    await this.storage.appendEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:claimNext',
      payload: {
        agentId: input.agentId,
        taskId: task?.taskId ?? null,
      },
    });
    return { task };
  }

  async heartbeat(input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
    leaseMs?: number;
  }): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamId);
    const result = await this.storage.heartbeatTaskClaim({
      runtimeRoot,
      taskId: input.taskId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      leaseMs: input.leaseMs ?? 60_000,
    });
    if (result.ok) {
      await this.storage.appendEvent({
        runtimeRoot,
        teamId: input.teamId,
        type: 'team:heartbeat',
        payload: {
          taskId: input.taskId,
          agentId: input.agentId,
          leaseUntil: result.task?.leaseUntil ?? null,
        },
      });
    }
    return result;
  }

  async taskUpdate(input: {
    teamId: string;
    taskId: string;
    status: TeamTaskStatus;
    resultSummary?: string;
    error?: string;
  }): Promise<{ task: TeamTaskRecord }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamId);
    const task = await this.storage.updateTaskStatus({
      runtimeRoot,
      taskId: input.taskId,
      nextStatus: input.status,
      resultSummary: input.resultSummary,
      error: input.error,
    });
    await this.storage.appendEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:taskUpdate',
      payload: {
        taskId: input.taskId,
        status: input.status,
      },
    });
    return { task };
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
    const runtimeRoot = this.resolveRuntimeRoot(input.teamId);
    const result = await this.storage.mailboxPost({
      runtimeRoot,
      message: input.message,
    });
    await this.storage.appendEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:mailboxPost',
      payload: {
        msgId: result.message.msgId,
        fromAgentId: result.message.fromAgentId,
        kind: result.message.kind,
      },
    });
    return result;
  }

  async mailboxPull(input: {
    teamId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ messages: TeamMailboxMessage[]; nextCursor?: string }> {
    return this.storage.mailboxPull({
      runtimeRoot: this.resolveRuntimeRoot(input.teamId),
      cursor: input.cursor,
      limit: input.limit,
    });
  }

  async releaseClaim(input: {
    teamId: string;
    taskId: string;
    agentId: string;
    sessionKey: string;
  }): Promise<{ ok: boolean; task?: TeamTaskRecord }> {
    const runtimeRoot = this.resolveRuntimeRoot(input.teamId);
    const result = await this.storage.releaseTaskClaim({
      runtimeRoot,
      taskId: input.taskId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
    });
    await this.storage.appendEvent({
      runtimeRoot,
      teamId: input.teamId,
      type: 'team:releaseClaim',
      payload: {
        taskId: input.taskId,
        agentId: input.agentId,
        ok: result.ok,
      },
    });
    return result;
  }

  async reset(input: { teamId: string }): Promise<{ ok: true }> {
    await this.storage.clearRuntime(this.resolveRuntimeRoot(input.teamId));
    return { ok: true };
  }

  async listTasks(input: { teamId: string }): Promise<{ tasks: TeamTaskRecord[] }> {
    const tasks = await this.storage.listTasks(this.resolveRuntimeRoot(input.teamId));
    return { tasks };
  }
}
