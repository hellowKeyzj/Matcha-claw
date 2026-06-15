import type { RuntimeScope } from '../../agent-runtime/contracts/runtime-address';
import type { TaskManagerService } from '../../tasks/service';
import type { TeamSkillGatewayWorkflow } from './team-skill-gateway-workflow';

export interface TeamRunTaskProjectionWorkflowDeps {
  readonly taskService: Pick<TaskManagerService, 'invokeTool'>;
  readonly gatewayWorkflow: Pick<TeamSkillGatewayWorkflow, 'invoke'>;
}

type TaskMethod = 'TaskList' | 'TaskCreate' | 'TaskUpdate';

type TaskProjectionStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

type TeamRunStatus =
  | 'created'
  | 'provisioning'
  | 'waiting_for_user'
  | 'running'
  | 'paused'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

type TeamDispatchTaskStatus = 'queued' | 'completed' | 'failed' | 'cancelled' | 'stale';

interface TeamRunProjectionRun {
  runId: string;
  packageName: string;
  packageVersion: string;
  status: TeamRunStatus;
  currentStageId?: string;
  revision: number;
}

interface TeamRunProjectionTask {
  taskId: string;
  roleId: string;
  status: TeamDispatchTaskStatus;
}

interface TaskProjectionRow {
  id: string;
  metadata: Record<string, unknown>;
}

interface TaskProjectionModel {
  identity: string;
  revision: number;
  params: {
    subject: string;
    description: string;
    activeForm: string;
    owner: string;
    status: TaskProjectionStatus;
    metadata: Record<string, unknown>;
  };
}

const TEAM_RUNTIME_PROJECTION_SOURCE = 'matchaclaw.team-runtime';

const PROJECTED_OPERATION_REASONS = new Map<string, string>([
  ['team.runStart', 'run:started'],
  ['team.planWorkflow', 'workflow:planned'],
  ['team.runCancel', 'run:cancelled'],
  ['team.runDelete', 'run:deleted'],
  ['team.runDecisionSubmit', 'decision:submitted'],
  ['team.approvalResolve', 'approval:resolved'],
  ['team.runTick', 'run:tick'],
]);

export class TeamRunTaskProjectionWorkflow {
  constructor(private readonly deps: TeamRunTaskProjectionWorkflowDeps) {}

  async projectAfterOperation(input: {
    readonly operationId: string;
    readonly scope: RuntimeScope;
    readonly params: Record<string, unknown>;
    readonly responseData: unknown;
  }): Promise<void> {
    const sessionKey = this.sessionKeyForScope(input.scope);
    const runId = this.readString(input.params.runId) || this.readString(this.readRecord(input.responseData).runId);
    const reason = this.projectionReason(input.operationId, input.responseData);
    if (!sessionKey || !runId || !reason) {
      return;
    }
    const existingTasksResponse = await this.deps.taskService.invokeTool({
      method: 'TaskList',
      sessionKey,
      params: {
        sessionKey,
        teamKey: this.teamKey(runId),
      },
    });
    if (existingTasksResponse.status >= 400) {
      throw new Error('Task manager projection failed: TaskList');
    }
    const existingTasks = this.readTasks(existingTasksResponse.data);
    if (input.operationId === 'team.runDelete') {
      await this.deleteProjectedTasks({ sessionKey, runId, existingTasks });
      return;
    }
    const projected = await this.readTeamSnapshot(runId);
    if (!projected) {
      return;
    }
    await this.projectTeamRun({
      sessionKey,
      run: projected.run,
      tasks: projected.tasks,
      reason,
      existingTasks,
    });
  }

  private async deleteProjectedTasks(input: {
    readonly sessionKey: string;
    readonly runId: string;
    readonly existingTasks: readonly TaskProjectionRow[];
  }): Promise<void> {
    for (const task of input.existingTasks) {
      if (!this.belongsToRunProjection(task.metadata, input.runId)) {
        continue;
      }
      await this.callTaskTool('TaskUpdate', input.sessionKey, {
        taskId: task.id,
        sessionKey: input.sessionKey,
        teamKey: this.teamKey(input.runId),
        status: 'deleted',
        metadata: {
          ...task.metadata,
          source: TEAM_RUNTIME_PROJECTION_SOURCE,
          teamRunId: input.runId,
          teamRunDeleted: true,
          projectionReason: 'run:deleted',
        },
      });
    }
  }

  private async readTeamSnapshot(runId: string): Promise<{ run: TeamRunProjectionRun; tasks: TeamRunProjectionTask[] } | null> {
    const response = await this.deps.gatewayWorkflow.invoke('team.runSnapshot', { runId });
    if (response.status >= 400) {
      return null;
    }
    return this.readSnapshot(response.data);
  }

  private async projectTeamRun(input: {
    readonly sessionKey: string;
    readonly run: TeamRunProjectionRun;
    readonly tasks: readonly TeamRunProjectionTask[];
    readonly reason: string;
    readonly existingTasks: readonly TaskProjectionRow[];
  }): Promise<void> {
    for (const task of input.tasks) {
      const model = this.buildTaskProjectionModel(input.run, task, input.reason);
      const target = this.selectProjectionTarget(input.existingTasks, model);
      if (target.action === 'skip') {
        continue;
      }
      const params = {
        sessionKey: input.sessionKey,
        teamKey: this.teamKey(input.run.runId),
        ...model.params,
      };
      await this.callTaskTool(target.action === 'update' ? 'TaskUpdate' : 'TaskCreate', input.sessionKey, target.action === 'update' ? {
        taskId: target.task.id,
        ...params,
      } : params);
    }
  }

  private async callTaskTool(method: TaskMethod, sessionKey: string, params: Record<string, unknown>): Promise<void> {
    const response = await this.deps.taskService.invokeTool({ method, sessionKey, params });
    if (response.status >= 400) {
      throw new Error(`Task manager projection failed: ${method}`);
    }
  }

  private projectionReason(operationId: string, responseData: unknown): string {
    if (operationId === 'team.runTick') {
      const action = this.readString(this.readRecord(responseData).action);
      if (action === 'dependency_missing') {
        return 'dependency:missing';
      }
      if (action === 'dispatch_prepared' || action === 'dispatch_execution_queued') {
        return 'dispatch:task_queued';
      }
      return 'run:tick';
    }
    return PROJECTED_OPERATION_REASONS.get(operationId) ?? '';
  }

  private buildTaskProjectionModel(run: TeamRunProjectionRun, task: TeamRunProjectionTask, reason: string): TaskProjectionModel {
    const identity = this.projectionIdentity(run.runId, task.taskId);
    return {
      identity,
      revision: run.revision,
      params: {
        subject: `${run.packageName}: ${task.taskId}`,
        description: `TeamRun ${run.runId} task ${task.taskId}`,
        activeForm: `Running ${task.taskId}`,
        owner: task.roleId,
        status: this.taskStatusForDispatchTask(run, task),
        metadata: {
          source: TEAM_RUNTIME_PROJECTION_SOURCE,
          projectionIdentity: identity,
          projectionRevision: run.revision,
          teamRunId: run.runId,
          teamTaskId: task.taskId,
          teamRunStatus: run.status,
          teamRunRevision: run.revision,
          dispatchTaskStatus: task.status,
          packageName: run.packageName,
          packageVersion: run.packageVersion,
          currentStageId: run.currentStageId ?? null,
          projectionReason: reason,
        },
      },
    };
  }

  private selectProjectionTarget(tasks: readonly TaskProjectionRow[], model: TaskProjectionModel): { action: 'create' } | { action: 'update'; task: TaskProjectionRow } | { action: 'skip'; task: TaskProjectionRow } {
    const candidates = tasks
      .filter((task) => this.isSameProjection(task.metadata, model.identity, model.params.metadata.teamRunId, model.params.metadata.teamTaskId))
      .sort((left, right) => this.compareProjectionRows(right, left, model.identity));
    const task = candidates[0];
    if (!task) {
      return { action: 'create' };
    }
    const currentRevision = this.projectionRevision(task.metadata);
    if (currentRevision !== null && currentRevision > model.revision) {
      return { action: 'skip', task };
    }
    return { action: 'update', task };
  }

  private taskStatusForDispatchTask(run: TeamRunProjectionRun, task: TeamRunProjectionTask): 'pending' | 'in_progress' | 'completed' {
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'stale') {
      return 'completed';
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return 'completed';
    }
    return task.status === 'queued' ? 'in_progress' : 'pending';
  }

  private projectionIdentity(runId: string, taskId: string): string {
    return `${TEAM_RUNTIME_PROJECTION_SOURCE}:${runId}:${taskId}`;
  }

  private isSameProjection(metadata: Record<string, unknown>, identity: string, runId: unknown, taskId: unknown): boolean {
    if (metadata.projectionIdentity === identity) {
      return true;
    }
    return metadata.teamRunId === runId && metadata.teamTaskId === taskId;
  }

  private belongsToRunProjection(metadata: Record<string, unknown>, runId: string): boolean {
    if (metadata.source !== TEAM_RUNTIME_PROJECTION_SOURCE) {
      return false;
    }
    if (metadata.teamRunId === runId) {
      return true;
    }
    return typeof metadata.projectionIdentity === 'string' && metadata.projectionIdentity.startsWith(`${TEAM_RUNTIME_PROJECTION_SOURCE}:${runId}:`);
  }

  private compareProjectionRows(left: TaskProjectionRow, right: TaskProjectionRow, identity: string): number {
    const leftExact = left.metadata.projectionIdentity === identity ? 1 : 0;
    const rightExact = right.metadata.projectionIdentity === identity ? 1 : 0;
    if (leftExact !== rightExact) {
      return leftExact - rightExact;
    }
    const leftRevision = this.projectionRevision(left.metadata) ?? -1;
    const rightRevision = this.projectionRevision(right.metadata) ?? -1;
    if (leftRevision !== rightRevision) {
      return leftRevision - rightRevision;
    }
    return this.numericTaskId(left.id) - this.numericTaskId(right.id);
  }

  private projectionRevision(metadata: Record<string, unknown>): number | null {
    if (typeof metadata.projectionRevision === 'number' && Number.isFinite(metadata.projectionRevision)) {
      return metadata.projectionRevision;
    }
    if (typeof metadata.teamRunRevision === 'number' && Number.isFinite(metadata.teamRunRevision)) {
      return metadata.teamRunRevision;
    }
    return null;
  }

  private numericTaskId(taskId: string): number {
    const parsed = Number.parseInt(taskId, 10);
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  }

  private readSnapshot(value: unknown): { run: TeamRunProjectionRun; tasks: TeamRunProjectionTask[] } | null {
    const record = this.readRecord(value);
    const run = this.readRun(record.run);
    const tasks = this.readDispatchTasks(record.dispatchTasks);
    return run && tasks.length > 0 ? { run, tasks } : null;
  }

  private readRun(value: unknown): TeamRunProjectionRun | null {
    const record = this.readRecord(value);
    const runId = this.readString(record.runId);
    const packageName = this.readString(record.packageName);
    const packageVersion = this.readString(record.packageVersion);
    const status = this.readString(record.status) as TeamRunStatus;
    const revision = typeof record.revision === 'number' && Number.isFinite(record.revision) ? record.revision : null;
    if (!runId || !packageName || !packageVersion || !status || revision === null) {
      return null;
    }
    return {
      runId,
      packageName,
      packageVersion,
      status,
      revision,
      ...(this.readString(record.currentStageId) ? { currentStageId: this.readString(record.currentStageId) } : {}),
    };
  }

  private readDispatchTasks(value: unknown): TeamRunProjectionTask[] {
    return Array.isArray(value) ? value.flatMap((item): TeamRunProjectionTask[] => {
      const record = this.readRecord(item);
      const taskId = this.readString(record.taskId);
      const roleId = this.readString(record.roleId);
      const status = this.readString(record.status) as TeamDispatchTaskStatus;
      if (!taskId || !roleId || !status) {
        return [];
      }
      return [{ taskId, roleId, status }];
    }) : [];
  }

  private readTasks(value: unknown): TaskProjectionRow[] {
    const record = this.readRecord(value);
    return Array.isArray(record.tasks) ? record.tasks.flatMap((item): TaskProjectionRow[] => {
      const task = this.readRecord(item);
      const id = this.readString(task.id);
      if (!id) {
        return [];
      }
      const metadata = this.readRecord(task.metadata);
      return [{ id, metadata }];
    }) : [];
  }

  private teamKey(runId: string): string {
    return `matchaclaw-team:${runId}`;
  }

  private sessionKeyForScope(scope: RuntimeScope): string {
    if (scope.kind === 'session') {
      return scope.identity.sessionKey;
    }
    if (scope.kind === 'team-run') {
      return scope.runId;
    }
    return '';
  }

  private readRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }
}
