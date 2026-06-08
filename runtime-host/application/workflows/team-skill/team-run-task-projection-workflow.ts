import type { RuntimeScope } from '../../agent-runtime/contracts/runtime-address';
import type { TaskManagerService } from '../../tasks/service';
import type { TeamSkillGatewayWorkflow } from './team-skill-gateway-workflow';

export interface TeamRunTaskProjectionWorkflowDeps {
  readonly taskService: Pick<TaskManagerService, 'invokeTool'>;
  readonly gatewayWorkflow: Pick<TeamSkillGatewayWorkflow, 'invoke'>;
}

type TaskMethod = 'TaskList' | 'TaskCreate' | 'TaskUpdate';

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

type TeamStageStatus = 'pending' | 'running' | 'waiting_for_user' | 'passed' | 'failed' | 'skipped';

interface TeamRunProjectionRun {
  runId: string;
  packageName: string;
  packageVersion: string;
  status: TeamRunStatus;
  currentStageId?: string;
  revision: number;
}

interface TeamRunProjectionStage {
  stageId: string;
  roleId?: string;
  status: TeamStageStatus;
  attempt: number;
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
    status: 'pending' | 'in_progress' | 'completed';
    metadata: Record<string, unknown>;
  };
}

const TEAM_RUNTIME_PROJECTION_SOURCE = 'matchaclaw.team-runtime';

const PROJECTED_OPERATION_REASONS = new Map<string, string>([
  ['team.runStart', 'run:started'],
  ['team.runCancel', 'run:cancelled'],
  ['team.runDecisionSubmit', 'decision:submitted'],
  ['team.approvalResolve', 'approval:resolved'],
  ['team.stageComplete', 'stage:completed'],
  ['team.runTick', 'run:tick'],
  ['team.gateEvaluate', 'stage:gate_transitioned'],
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
    const projected = await this.readTeamSnapshot(runId);
    if (!projected) {
      return;
    }
    await this.projectTeamRun({
      sessionKey,
      run: projected.run,
      stages: projected.stages,
      reason,
      existingTasks: this.readTasks(existingTasksResponse.data),
    });
  }

  private async readTeamSnapshot(runId: string): Promise<{ run: TeamRunProjectionRun; stages: TeamRunProjectionStage[] } | null> {
    const response = await this.deps.gatewayWorkflow.invoke('team.runSnapshot', { runId });
    if (response.status >= 400) {
      return null;
    }
    return this.readSnapshot(response.data);
  }

  private async projectTeamRun(input: {
    readonly sessionKey: string;
    readonly run: TeamRunProjectionRun;
    readonly stages: readonly TeamRunProjectionStage[];
    readonly reason: string;
    readonly existingTasks: readonly TaskProjectionRow[];
  }): Promise<void> {
    for (const stage of input.stages) {
      const model = this.buildTaskProjectionModel(input.run, stage, input.reason);
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
    if (operationId === 'team.stageComplete') {
      const status = this.readRecord(responseData).status;
      return status === 'completed' ? 'run:completed' : 'stage:completed';
    }
    if (operationId === 'team.runTick') {
      const action = this.readString(this.readRecord(responseData).action);
      if (action === 'dependency_missing') {
        return 'dependency:missing';
      }
      if (action === 'stage_completed') {
        return 'stage:completed';
      }
      return '';
    }
    return PROJECTED_OPERATION_REASONS.get(operationId) ?? '';
  }

  private buildTaskProjectionModel(run: TeamRunProjectionRun, stage: TeamRunProjectionStage, reason: string): TaskProjectionModel {
    const identity = this.projectionIdentity(run.runId, stage.stageId);
    return {
      identity,
      revision: run.revision,
      params: {
        subject: `${run.packageName}: ${stage.stageId}`,
        description: `TeamRun ${run.runId} stage ${stage.stageId}`,
        activeForm: `Running ${stage.stageId}`,
        owner: stage.roleId ?? 'team-runtime',
        status: this.taskStatusForStage(run, stage),
        metadata: {
          source: TEAM_RUNTIME_PROJECTION_SOURCE,
          projectionIdentity: identity,
          projectionRevision: run.revision,
          teamRunId: run.runId,
          teamStageId: stage.stageId,
          teamRunStatus: run.status,
          teamRunRevision: run.revision,
          stageStatus: stage.status,
          stageAttempt: stage.attempt,
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
      .filter((task) => this.isSameProjection(task.metadata, model.identity, model.params.metadata.teamRunId, model.params.metadata.teamStageId))
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

  private taskStatusForStage(run: TeamRunProjectionRun, stage: TeamRunProjectionStage): 'pending' | 'in_progress' | 'completed' {
    if (stage.status === 'passed' || stage.status === 'failed' || stage.status === 'skipped') {
      return 'completed';
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      return 'completed';
    }
    if (run.status === 'running' && stage.status === 'running') {
      return 'in_progress';
    }
    return 'pending';
  }

  private projectionIdentity(runId: string, stageId: string): string {
    return `${TEAM_RUNTIME_PROJECTION_SOURCE}:${runId}:${stageId}`;
  }

  private isSameProjection(metadata: Record<string, unknown>, identity: string, runId: unknown, stageId: unknown): boolean {
    if (metadata.projectionIdentity === identity) {
      return true;
    }
    return metadata.teamRunId === runId && metadata.teamStageId === stageId;
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

  private readSnapshot(value: unknown): { run: TeamRunProjectionRun; stages: TeamRunProjectionStage[] } | null {
    const record = this.readRecord(value);
    const run = this.readRun(record.run);
    const stages = this.readStages(record.stages);
    return run && stages.length > 0 ? { run, stages } : null;
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

  private readStages(value: unknown): TeamRunProjectionStage[] {
    return Array.isArray(value) ? value.flatMap((item): TeamRunProjectionStage[] => {
      const record = this.readRecord(item);
      const stageId = this.readString(record.stageId);
      const status = this.readString(record.status) as TeamStageStatus;
      const attempt = typeof record.attempt === 'number' && Number.isFinite(record.attempt) ? record.attempt : null;
      if (!stageId || !status || attempt === null) {
        return [];
      }
      return [{
        stageId,
        status,
        attempt,
        ...(this.readString(record.roleId) ? { roleId: this.readString(record.roleId) } : {}),
      }];
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
