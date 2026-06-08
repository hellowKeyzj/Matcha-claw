import { describe, expect, it, vi } from 'vitest';
import { TaskManagerGatewayProjection } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/task-manager-gateway-projection';

const run = {
  runId: 'run-1',
  packageName: 'ascendc-team',
  packageVersion: '1.0.0',
  sourcePath: '.tmp/team',
  status: 'running' as const,
  currentStageId: 'step-1-design-operator-blueprint',
  revision: 2,
  createdAt: 1,
  updatedAt: 2,
};

const stages = [
  {
    runId: 'run-1',
    stageId: 'step-0-pre-flight-dependency-check',
    title: 'Pre-flight: dependency check',
    executor: 'Leader',
    status: 'passed' as const,
    attempt: 1,
    maxAttempts: 1,
    inputArtifactIds: [],
    outputArtifactIds: [],
    createdAt: 1,
    updatedAt: 2,
  },
  {
    runId: 'run-1',
    stageId: 'step-1-design-operator-blueprint',
    title: 'Design: operator blueprint',
    executor: 'operator-designer',
    roleId: 'operator-designer',
    gateType: 'design',
    status: 'running' as const,
    attempt: 1,
    maxAttempts: 2,
    inputArtifactIds: [],
    outputArtifactIds: [],
    createdAt: 1,
    updatedAt: 2,
  },
];

describe('TaskManagerGatewayProjection', () => {
  it('creates missing Team stage tasks with TeamRun metadata', async () => {
    const call = vi.fn().mockResolvedValueOnce({ tasks: [] }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({ run, stages, reason: 'run:started' });

    expect(call).toHaveBeenNthCalledWith(1, 'TaskList', { teamKey: 'matchaclaw-team:run-1' });
    expect(call).toHaveBeenNthCalledWith(2, 'TaskCreate', expect.objectContaining({
      teamKey: 'matchaclaw-team:run-1',
      subject: 'ascendc-team: step-0-pre-flight-dependency-check',
      status: 'completed',
      owner: 'team-runtime',
      metadata: expect.objectContaining({
        source: 'matchaclaw.team-runtime',
        projectionIdentity: 'matchaclaw.team-runtime:run-1:step-0-pre-flight-dependency-check',
        projectionRevision: 2,
        teamRunId: 'run-1',
        teamStageId: 'step-0-pre-flight-dependency-check',
        projectionReason: 'run:started',
      }),
    }));
    expect(call).toHaveBeenNthCalledWith(3, 'TaskCreate', expect.objectContaining({
      status: 'in_progress',
      owner: 'operator-designer',
      metadata: expect.objectContaining({ teamStageId: 'step-1-design-operator-blueprint' }),
    }));
  });

  it('updates existing projected tasks instead of creating duplicates', async () => {
    const call = vi.fn().mockResolvedValueOnce({
      tasks: [{
        id: 'task-design',
        metadata: {
          teamRunId: 'run-1',
          teamStageId: 'step-1-design-operator-blueprint',
        },
      }],
    }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call }, teamKeyPrefix: 'team' });

    await projection.projectTeamRun({ run, stages: [stages[1]], reason: 'stage:gate_transitioned' });

    expect(call).toHaveBeenNthCalledWith(1, 'TaskList', { teamKey: 'team:run-1' });
    expect(call).toHaveBeenNthCalledWith(2, 'TaskUpdate', expect.objectContaining({
      taskId: 'task-design',
      teamKey: 'team:run-1',
      status: 'in_progress',
      metadata: expect.objectContaining({
        teamRunRevision: 2,
        projectionReason: 'stage:gate_transitioned',
      }),
    }));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('projects failed TeamRun stages as completed tasks with TeamRun metadata', async () => {
    const call = vi.fn().mockResolvedValueOnce({ tasks: [] }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({
      run: { ...run, status: 'failed', revision: 3 },
      stages: [{ ...stages[1], status: 'failed' }],
      reason: 'decision:submitted',
    });

    expect(call).toHaveBeenNthCalledWith(2, 'TaskCreate', expect.objectContaining({
      status: 'completed',
      metadata: expect.objectContaining({
        teamRunStatus: 'failed',
        stageStatus: 'failed',
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
            teamStageId: 'step-1-design-operator-blueprint',
            teamRunRevision: 1,
          },
        },
        {
          id: '2',
          metadata: {
            projectionIdentity: 'matchaclaw.team-runtime:run-1:step-1-design-operator-blueprint',
            projectionRevision: 2,
            teamRunId: 'run-1',
            teamStageId: 'step-1-design-operator-blueprint',
          },
        },
      ],
    }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({ run: { ...run, revision: 3 }, stages: [stages[1]], reason: 'stage:gate_transitioned' });

    expect(call).toHaveBeenNthCalledWith(2, 'TaskUpdate', expect.objectContaining({
      taskId: '2',
      metadata: expect.objectContaining({
        projectionIdentity: 'matchaclaw.team-runtime:run-1:step-1-design-operator-blueprint',
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
          projectionIdentity: 'matchaclaw.team-runtime:run-1:step-1-design-operator-blueprint',
          projectionRevision: 4,
          teamRunId: 'run-1',
          teamStageId: 'step-1-design-operator-blueprint',
        },
      }],
    }).mockResolvedValue({});
    const projection = new TaskManagerGatewayProjection({ client: { call } });

    await projection.projectTeamRun({ run, stages: [stages[1]], reason: 'run:tick' });

    expect(call).toHaveBeenCalledTimes(1);
  });
});
