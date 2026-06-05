import { validateRuntimeAddress, type RuntimeAddress } from '../../../shared/runtime-address';
import type { ApplicationResponseOf } from '../../common/application-response';
import { badRequest, ok } from '../../common/application-response';
import type { SessionPromptService } from '../../sessions/session-prompt-service';
import type { TaskManagerService } from '../../tasks/service';
import type { TeamRuntimeService } from '../../team-runtime/service';
import type { TeamTaskRecord } from '../../team-runtime/types';

interface MultiAgentTaskAgentInput {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly message?: string;
}

interface MultiAgentTaskPayload {
  readonly runtimeAddress: RuntimeAddress;
  readonly teamId: string;
  readonly leadAgentId: string;
  readonly agents: MultiAgentTaskAgentInput[];
  readonly tasks: Array<{
    readonly taskId: string;
    readonly title?: string;
    readonly instruction: string;
    readonly dependsOn?: string[];
  }>;
  readonly leaseMs?: number;
}

export interface MultiAgentTaskWorkflowDeps {
  readonly teamRuntimeService: Pick<TeamRuntimeService, 'init' | 'planUpsert' | 'claimNext' | 'taskUpdate'>;
  readonly taskService: Pick<TaskManagerService, 'buildTaskSnapshot'>;
  readonly promptService: Pick<SessionPromptService, 'promptSession'>;
}

export class MultiAgentTaskWorkflow {
  constructor(private readonly deps: MultiAgentTaskWorkflowDeps) {}

  async start(payload: unknown): Promise<ApplicationResponseOf> {
    const request = this.readRequest(payload);
    if ('error' in request) {
      return badRequest(request.error);
    }

    await this.deps.teamRuntimeService.init({
      teamId: request.teamId,
      leadAgentId: request.leadAgentId,
      runtimeAddress: request.runtimeAddress,
    });
    await this.deps.teamRuntimeService.planUpsert({
      teamId: request.teamId,
      tasks: request.tasks,
    });

    const assignments = await Promise.all(request.agents.map((agent) => this.startAgentTask(request, agent)));
    return ok({
      success: true,
      teamId: request.teamId,
      assignments,
    });
  }

  private async startAgentTask(request: MultiAgentTaskPayload, agent: MultiAgentTaskAgentInput) {
    const claim = await this.deps.teamRuntimeService.claimNext({
      teamId: request.teamId,
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      leaseMs: request.leaseMs,
    }) as { task?: TeamTaskRecord | null };
    const task = claim.task ?? null;
    if (!task) {
      return {
        agentId: agent.agentId,
        sessionKey: agent.sessionKey,
        task: null,
        prompt: null,
      };
    }

    await this.deps.teamRuntimeService.taskUpdate({
      teamId: request.teamId,
      taskId: task.taskId,
      status: 'running',
    });
    const snapshot = await this.deps.taskService.buildTaskSnapshot({
      sessionKey: agent.sessionKey,
      teamKey: request.teamId,
    });
    const prompt = await this.deps.promptService.promptSession({
      runtimeAddress: this.buildAgentRuntimeAddress(request.runtimeAddress, agent),
      sessionKey: agent.sessionKey,
      message: this.buildPromptMessage(task, agent.message, snapshot),
    });

    return {
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
      task,
      prompt,
    };
  }

  private buildAgentRuntimeAddress(runtimeAddress: RuntimeAddress, agent: MultiAgentTaskAgentInput): RuntimeAddress {
    return {
      ...runtimeAddress,
      agentId: agent.agentId,
      sessionKey: agent.sessionKey,
    };
  }

  private buildPromptMessage(task: TeamTaskRecord, message: string | undefined, snapshot: unknown): string {
    const taskLines = [
      `Task: ${task.title || task.taskId}`,
      task.instruction,
      ...(task.dependsOn.length ? [`Depends on: ${task.dependsOn.join(', ')}`] : []),
    ];
    const context = snapshot ? [`Task snapshot: ${JSON.stringify(snapshot)}`] : [];
    return [
      ...(message ? [message] : []),
      ...taskLines,
      ...context,
    ].join('\n\n');
  }

  private readRequest(payload: unknown): MultiAgentTaskPayload | { error: string } {
    const body = this.readRecord(payload);
    const runtimeAddress = body.runtimeAddress;
    const runtimeAddressError = validateRuntimeAddress(runtimeAddress);
    if (runtimeAddressError) {
      return { error: runtimeAddress === undefined ? 'RuntimeAddress is required' : runtimeAddressError };
    }
    const teamId = this.readString(body.teamId);
    if (!teamId) {
      return { error: 'teamId is required' };
    }
    const leadAgentId = this.readString(body.leadAgentId);
    if (!leadAgentId) {
      return { error: 'leadAgentId is required' };
    }
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
      return { error: 'tasks must be a non-empty array' };
    }
    if (!Array.isArray(body.agents) || body.agents.length === 0) {
      return { error: 'agents must be a non-empty array' };
    }

    const tasks = body.tasks.map((item, index) => this.readTask(item, index));
    const invalidTask = tasks.find((task): task is { error: string } => 'error' in task);
    if (invalidTask) {
      return invalidTask;
    }
    const agents = body.agents.map((item, index) => this.readAgent(item, index));
    const invalidAgent = agents.find((agent): agent is { error: string } => 'error' in agent);
    if (invalidAgent) {
      return invalidAgent;
    }

    return {
      runtimeAddress: runtimeAddress as unknown as RuntimeAddress,
      teamId,
      leadAgentId,
      tasks,
      agents,
      ...(typeof body.leaseMs === 'number' ? { leaseMs: body.leaseMs } : {}),
    };
  }

  private readTask(value: unknown, index: number): MultiAgentTaskPayload['tasks'][number] | { error: string } {
    const task = this.readRecord(value);
    const taskId = this.readString(task.taskId);
    const instruction = this.readString(task.instruction);
    if (!taskId) {
      return { error: `tasks[${index}].taskId is required` };
    }
    if (!instruction) {
      return { error: `tasks[${index}].instruction is required` };
    }
    return {
      taskId,
      instruction,
      ...(this.readString(task.title) ? { title: this.readString(task.title) } : {}),
      ...(Array.isArray(task.dependsOn) ? { dependsOn: task.dependsOn.filter((item): item is string => typeof item === 'string') } : {}),
    };
  }

  private readAgent(value: unknown, index: number): MultiAgentTaskAgentInput | { error: string } {
    const agent = this.readRecord(value);
    const agentId = this.readString(agent.agentId);
    const sessionKey = this.readString(agent.sessionKey);
    if (!agentId) {
      return { error: `agents[${index}].agentId is required` };
    }
    if (!sessionKey) {
      return { error: `agents[${index}].sessionKey is required` };
    }
    return {
      agentId,
      sessionKey,
      ...(this.readString(agent.message) ? { message: this.readString(agent.message) } : {}),
    };
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return this.isRecord(value) ? value : {};
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}
