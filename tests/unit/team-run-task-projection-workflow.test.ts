import { describe, expect, it, vi } from 'vitest';
import type { RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { TeamRunTaskProjectionWorkflow } from '../../runtime-host/application/workflows/team-skill/team-run-task-projection-workflow';
import { openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

function teamRunScope(runId: string): RuntimeScope {
  return {
    kind: 'team-run',
    endpoint: openClawTestRuntimeEndpoint,
    runId,
  };
}

const runtimeInstanceScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: openClawTestRuntimeEndpoint,
};

const run = {
  runId: 'run-1',
  packageName: 'ascendc-team',
  packageVersion: '1.0.0',
  sourcePath: '.tmp/team',
  status: 'running',
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
    status: 'passed',
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
    status: 'running',
    attempt: 1,
    maxAttempts: 2,
    inputArtifactIds: [],
    outputArtifactIds: [],
    createdAt: 1,
    updatedAt: 2,
  },
];

describe('TeamRunTaskProjectionWorkflow', () => {
  it('projects changed TeamRun stages into task-manager scope', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { tasks: [] } })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({ status: 200, data: { run, stages } });
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.runStart',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { runId: 'run-1', status: 'running', revision: 2 },
    });

    expect(gatewayInvoke).toHaveBeenCalledWith('team.runSnapshot', { runId: 'run-1' });
    expect(invokeTool).toHaveBeenNthCalledWith(1, {
      method: 'TaskList',
      sessionKey: 'run-1',
      params: {
        sessionKey: 'run-1',
        teamKey: 'matchaclaw-team:run-1',
      },
    });
    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskCreate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
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
      }),
    });
    expect(invokeTool).toHaveBeenNthCalledWith(3, {
      method: 'TaskCreate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        teamKey: 'matchaclaw-team:run-1',
        status: 'in_progress',
        owner: 'operator-designer',
        metadata: expect.objectContaining({ teamStageId: 'step-1-design-operator-blueprint' }),
      }),
    });
  });

  it('updates existing projected tasks by TeamRun metadata', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          tasks: [{
            id: 'task-design',
            metadata: {
              teamRunId: 'run-1',
              teamStageId: 'step-1-design-operator-blueprint',
            },
          }],
        },
      })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({ status: 200, data: { run, stages: [stages[1]] } });
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.gateEvaluate',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { gate: { created: true } },
    });

    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskUpdate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        taskId: 'task-design',
        teamKey: 'matchaclaw-team:run-1',
        metadata: expect.objectContaining({
          teamRunRevision: 2,
          projectionReason: 'stage:gate_transitioned',
        }),
      }),
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  it('projects failed and cancelled TeamRun stages as completed tasks', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { tasks: [] } })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        run: { ...run, status: 'failed', currentStageId: 'step-1-design-operator-blueprint', revision: 3 },
        stages: [{ ...stages[1], status: 'failed' }],
      },
    });
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.runDecisionSubmit',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { runId: 'run-1', status: 'failed', revision: 3 },
    });

    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskCreate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        status: 'completed',
        metadata: expect.objectContaining({
          teamRunStatus: 'failed',
          stageStatus: 'failed',
        }),
      }),
    });
  });

  it('updates the newest duplicate projected task instead of creating another task', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
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
        },
      })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({
      status: 200,
      data: { run: { ...run, revision: 3 }, stages: [stages[1]] },
    });
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.gateEvaluate',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { gate: { created: true } },
    });

    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskUpdate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        taskId: '2',
        metadata: expect.objectContaining({
          projectionIdentity: 'matchaclaw.team-runtime:run-1:step-1-design-operator-blueprint',
          projectionRevision: 3,
        }),
      }),
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  it('skips stale task projection instead of overwriting newer state', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          tasks: [{
            id: 'task-design',
            metadata: {
              projectionIdentity: 'matchaclaw.team-runtime:run-1:step-1-design-operator-blueprint',
              projectionRevision: 4,
              teamRunId: 'run-1',
              teamStageId: 'step-1-design-operator-blueprint',
            },
          }],
        },
      })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({ status: 200, data: { run, stages: [stages[1]] } });
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.runStart',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { runId: 'run-1', status: 'running', revision: 2 },
    });

    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it('skips projection when scope is not team-run scoped', async () => {
    const invokeTool = vi.fn();
    const gatewayInvoke = vi.fn();
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.runStart',
      scope: runtimeInstanceScope,
      params: { runId: 'run-1' },
      responseData: { runId: 'run-1', status: 'running', revision: 2 },
    });

    expect(invokeTool).not.toHaveBeenCalled();
    expect(gatewayInvoke).not.toHaveBeenCalled();
  });
});
