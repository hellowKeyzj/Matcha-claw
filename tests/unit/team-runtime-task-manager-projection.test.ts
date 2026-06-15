import { describe, expect, it, vi } from 'vitest';
import { TaskManagerGatewayProjection } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/task-manager-gateway-projection';

const run = {
  runId: 'run-1',
  packageName: 'ascendc-team',
  packageVersion: '1.0.0',
  sourcePath: '.tmp/team',
  status: 'running' as const,
  currentStageId: 'design-operator-blueprint',
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};

const dispatchTasks = [
  {
    dispatchTaskId: 'dispatch-task-pre-flight',
    runId: 'run-1',
    workflowPlanId: 'workflow-plan-1',
    dispatchGroupId: 'dispatch-group-pre-flight',
    groupId: 'pre-flight',
    taskId: 'pre-flight-dependency-check',
    roleId: 'team-runtime',
    dispatchId: 'dispatch-pre-flight',
    status: 'completed' as const,
    idempotencyKey: 'run-1:pre-flight-dependency-check',
    createdAt: 1,
    completedAt: 2,
    artifactId: 'artifact-pre-flight',
  },
  {
    dispatchTaskId: 'dispatch-task-design',
    runId: 'run-1',
    workflowPlanId: 'workflow-plan-1',
    dispatchGroupId: 'dispatch-group-design',
    groupId: 'design',
    taskId: 'design-operator-blueprint',
    roleId: 'operator-designer',
    dispatchId: 'dispatch-design',
    status: 'queued' as const,
    idempotencyKey: 'run-1:design-operator-blueprint',
    createdAt: 1,
  },
];

describe('TaskManagerGatewayProjection', () => {
  it('creates missing Team workflow dispatch tasks with TeamRun metadata', async () => {
    const call = vi.fn().mockResolvedValueOnce({ tasks: [] }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({ run, dispatchTasks, reason: 'run:started' });

    expect(call).toHaveBeenNthCalledWith(1, 'TaskList', { teamKey: 'matchaclaw-team:run-1' });
    expect(call).toHaveBeenNthCalledWith(2, 'TaskCreate', expect.objectContaining({
      teamKey: 'matchaclaw-team:run-1',
      subject: 'ascendc-team: pre-flight-dependency-check',
      description: 'TeamRun run-1 task pre-flight-dependency-check',
      status: 'completed',
      owner: 'team-runtime',
      metadata: expect.objectContaining({
        source: 'matchaclaw.team-runtime',
        projectionIdentity: 'matchaclaw.team-runtime:run-1:pre-flight-dependency-check',
        projectionRevision: 2,
        teamRunId: 'run-1',
        teamTaskId: 'pre-flight-dependency-check',
        dispatchTaskStatus: 'completed',
        projectionReason: 'run:started',
      }),
    }));
    expect(call).toHaveBeenNthCalledWith(3, 'TaskCreate', expect.objectContaining({
      subject: 'ascendc-team: design-operator-blueprint',
      description: 'TeamRun run-1 task design-operator-blueprint',
      activeForm: 'Running design-operator-blueprint',
      status: 'in_progress',
      owner: 'operator-designer',
      metadata: expect.objectContaining({
        teamTaskId: 'design-operator-blueprint',
        dispatchTaskStatus: 'queued',
      }),
    }));
  });

  it('updates existing projected tasks instead of creating duplicates', async () => {
    const call = vi.fn().mockResolvedValueOnce({
      tasks: [{
        id: 'task-design',
        metadata: {
          teamRunId: 'run-1',
          teamTaskId: 'design-operator-blueprint',
        },
      }],
    }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call }, teamKeyPrefix: 'team' });

    await projection.projectTeamRun({ run, dispatchTasks: [dispatchTasks[1]], reason: 'dispatch:task_queued' });

    expect(call).toHaveBeenNthCalledWith(1, 'TaskList', { teamKey: 'team:run-1' });
    expect(call).toHaveBeenNthCalledWith(2, 'TaskUpdate', expect.objectContaining({
      taskId: 'task-design',
      teamKey: 'team:run-1',
      status: 'in_progress',
      metadata: expect.objectContaining({
        teamRunRevision: 2,
        projectionReason: 'dispatch:task_queued',
      }),
    }));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'cancelled', 'stale'] as const)('projects %s TeamRun workflow dispatch tasks as completed tasks with TeamRun metadata', async (dispatchTaskStatus) => {
    const call = vi.fn().mockResolvedValueOnce({ tasks: [] }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({
      run: { ...run, revision: 3 },
      dispatchTasks: [{ ...dispatchTasks[1], status: dispatchTaskStatus, statusReason: `${dispatchTaskStatus}:reason` }],
      reason: 'decision:submitted',
    });

    expect(call).toHaveBeenNthCalledWith(2, 'TaskCreate', expect.objectContaining({
      status: 'completed',
      metadata: expect.objectContaining({
        teamRunStatus: 'running',
        dispatchTaskStatus,
        projectionReason: 'decision:submitted',
      }),
    }));
  });

  it('updates the newest duplicate projection task instead of creating another task', async () => {
    const call = vi.fn().mockResolvedValueOnce({
      tasks: [
        {
          id: '1',
          metadata: {
            teamRunId: 'run-1',
            teamTaskId: 'design-operator-blueprint',
            teamRunRevision: 1,
          },
        },
        {
          id: '2',
          metadata: {
            projectionIdentity: 'matchaclaw.team-runtime:run-1:design-operator-blueprint',
            projectionRevision: 2,
            teamRunId: 'run-1',
            teamTaskId: 'design-operator-blueprint',
          },
        },
      ],
    }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({ run: { ...run, revision: 3 }, dispatchTasks: [dispatchTasks[1]], reason: 'dispatch:task_queued' });

    expect(call).toHaveBeenNthCalledWith(2, 'TaskUpdate', expect.objectContaining({
      taskId: '2',
      metadata: expect.objectContaining({
        projectionIdentity: 'matchaclaw.team-runtime:run-1:design-operator-blueprint',
        projectionRevision: 3,
      }),
    }));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('skips stale projection input when an existing task has a newer revision', async () => {
    const call = vi.fn().mockResolvedValueOnce({
      tasks: [{
        id: 'task-design',
        metadata: {
          projectionIdentity: 'matchaclaw.team-runtime:run-1:design-operator-blueprint',
          projectionRevision: 4,
          teamRunId: 'run-1',
          teamTaskId: 'design-operator-blueprint',
        },
      }],
    }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({ run, dispatchTasks: [dispatchTasks[1]], reason: 'run:tick' });

    expect(call).toHaveBeenCalledTimes(1);
  });
});
