import type { RuntimeAddress } from '../../../shared/runtime-address';
import type {
  TeamEventRecord,
  TeamMailboxKind,
  TeamMailboxMessage,
  TeamRunRecord,
  TeamRuntimeStoragePort,
  TeamTaskRecord,
  TeamTaskStatus,
} from '../../team-runtime/types';

export interface TeamRuntimeStateWorkflowDeps {
  readonly storage: TeamRuntimeStoragePort;
  readonly resolveRuntimeRoot: (teamId: string) => string;
  readonly onEventEmitted?: (event: TeamEventRecord) => void;
}

export class TeamRuntimeStateWorkflow {
  constructor(private readonly deps: TeamRuntimeStateWorkflowDeps) {}

  async init(input: { teamId: string; leadAgentId: string; runtimeAddress: RuntimeAddress }): Promise<{ runtimeRoot: string; run: TeamRunRecord }> {
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const run = await this.deps.storage.initRun({
      runtimeRoot,
      teamId: input.teamId,
      leadAgentId: input.leadAgentId,
      runtimeAddress: input.runtimeAddress,
    });
    await this.appendAndEmit({
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
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const [run, tasks, mailbox, events] = await Promise.all([
      this.deps.storage.readRun(runtimeRoot),
      this.deps.storage.listTasks(runtimeRoot),
      this.deps.storage.mailboxPull({
        runtimeRoot,
        cursor: input.mailboxCursor,
        limit: input.mailboxLimit ?? 100,
      }),
      this.deps.storage.readRecentEvents(runtimeRoot, 200),
    ]);
    return {
      run,
      tasks,
      mailbox,
      events,
    };
  }

  async planUpsert(input: {
    teamId: string;
    tasks: Array<{ taskId: string; title?: string; instruction: string; dependsOn?: string[] }>;
  }): Promise<{ tasks: TeamTaskRecord[] }> {
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const run = await this.deps.storage.readRun(runtimeRoot);
    if (!run) {
      throw new Error(`Team run not initialized: ${input.teamId}`);
    }

    const tasks = await this.deps.storage.upsertPlanTasks({
      runtimeRoot,
      tasks: input.tasks,
    });
    await this.appendAndEmit({
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
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const task = await this.deps.storage.claimNextTask({
      runtimeRoot,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      leaseMs: input.leaseMs ?? 60_000,
    });
    await this.appendAndEmit({
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
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const result = await this.deps.storage.heartbeatTaskClaim({
      runtimeRoot,
      taskId: input.taskId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      leaseMs: input.leaseMs ?? 60_000,
    });
    if (result.ok) {
      await this.appendAndEmit({
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
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const task = await this.deps.storage.updateTaskStatus({
      runtimeRoot,
      taskId: input.taskId,
      nextStatus: input.status,
      resultSummary: input.resultSummary,
      error: input.error,
    });
    await this.appendAndEmit({
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
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const result = await this.deps.storage.mailboxPost({
      runtimeRoot,
      message: input.message,
    });
    await this.appendAndEmit({
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
    return await this.deps.storage.mailboxPull({
      runtimeRoot: this.deps.resolveRuntimeRoot(input.teamId),
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
    const runtimeRoot = this.deps.resolveRuntimeRoot(input.teamId);
    const result = await this.deps.storage.releaseTaskClaim({
      runtimeRoot,
      taskId: input.taskId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
    });
    await this.appendAndEmit({
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
    await this.deps.storage.clearRuntime(this.deps.resolveRuntimeRoot(input.teamId));
    return { ok: true };
  }

  async listTasks(input: { teamId: string }): Promise<{ tasks: TeamTaskRecord[] }> {
    const tasks = await this.deps.storage.listTasks(this.deps.resolveRuntimeRoot(input.teamId));
    return { tasks };
  }

  private async appendAndEmit(input: {
    runtimeRoot: string;
    teamId: string;
    type: string;
    payload: Record<string, unknown>;
  }): Promise<TeamEventRecord> {
    const event = await this.deps.storage.appendEvent(input);
    this.deps.onEventEmitted?.(event);
    return event;
  }
}
