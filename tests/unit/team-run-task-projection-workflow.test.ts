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
    status: 'completed',
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
    status: 'queued',
    idempotencyKey: 'run-1:design-operator-blueprint',
    createdAt: 1,
  },
];

describe('TeamRunTaskProjectionWorkflow', () => {
  it('projects changed TeamRun workflow dispatch tasks into task-manager scope', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { tasks: [] } })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({ status: 200, data: { run, dispatchTasks } });
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
      }),
    });
    expect(invokeTool).toHaveBeenNthCalledWith(3, {
      method: 'TaskCreate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        teamKey: 'matchaclaw-team:run-1',
        subject: 'ascendc-team: design-operator-blueprint',
        description: 'TeamRun run-1 task design-operator-blueprint',
        activeForm: 'Running design-operator-blueprint',
        status: 'in_progress',
        owner: 'operator-designer',
        metadata: expect.objectContaining({
          teamTaskId: 'design-operator-blueprint',
          dispatchTaskStatus: 'queued',
        }),
      }),
    });
  });

  it('deletes existing projected tasks without reading deleted TeamRun snapshot', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          tasks: [
            {
              id: 'task-design',
              metadata: {
                source: 'matchaclaw.team-runtime',
                projectionIdentity: 'matchaclaw.team-runtime:run-1:design-operator-blueprint',
                projectionRevision: 2,
                teamRunId: 'run-1',
                teamTaskId: 'design-operator-blueprint',
              },
            },
            {
              id: 'task-other-run',
              metadata: {
                source: 'matchaclaw.team-runtime',
                projectionIdentity: 'matchaclaw.team-runtime:run-2:other-task',
                teamRunId: 'run-2',
              },
            },
            {
              id: 'task-unrelated',
              metadata: {
                source: 'manual',
                teamRunId: 'run-1',
              },
            },
          ],
        },
      })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn();
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.runDelete',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { runId: 'run-1', deleted: true },
    });

    expect(gatewayInvoke).not.toHaveBeenCalled();
    expect(invokeTool).toHaveBeenNthCalledWith(1, {
      method: 'TaskList',
      sessionKey: 'run-1',
      params: {
        sessionKey: 'run-1',
        teamKey: 'matchaclaw-team:run-1',
      },
    });
    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskUpdate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        taskId: 'task-design',
        teamKey: 'matchaclaw-team:run-1',
        status: 'deleted',
        metadata: expect.objectContaining({
          source: 'matchaclaw.team-runtime',
          projectionIdentity: 'matchaclaw.team-runtime:run-1:design-operator-blueprint',
          teamRunId: 'run-1',
          teamRunDeleted: true,
          projectionReason: 'run:deleted',
        }),
      }),
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  it('updates existing projected tasks from TeamRun tick dispatch actions', async () => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({
        status: 200,
        data: {
          tasks: [{
            id: 'task-design',
            metadata: {
              teamRunId: 'run-1',
              teamTaskId: 'design-operator-blueprint',
            },
          }],
        },
      })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({ status: 200, data: { run, dispatchTasks: [dispatchTasks[1]] } });
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.runTick',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { action: 'dispatch_prepared', currentStageId: 'design-operator-blueprint' },
    });

    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskUpdate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        taskId: 'task-design',
        teamKey: 'matchaclaw-team:run-1',
        metadata: expect.objectContaining({
          teamRunRevision: 2,
          projectionReason: 'dispatch:task_queued',
        }),
      }),
    });
    expect(invokeTool).toHaveBeenCalledTimes(2);
  });

  it.each(['failed', 'cancelled', 'stale'] as const)('projects %s TeamRun workflow dispatch tasks as completed tasks', async (dispatchTaskStatus) => {
    const invokeTool = vi.fn()
      .mockResolvedValueOnce({ status: 200, data: { tasks: [] } })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({
      status: 200,
      data: {
        run: { ...run, revision: 3 },
        dispatchTasks: [{ ...dispatchTasks[1], status: dispatchTaskStatus, statusReason: `${dispatchTaskStatus}:reason` }],
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
      responseData: { runId: 'run-1', status: dispatchTaskStatus, revision: 3 },
    });

    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskCreate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        status: 'completed',
        metadata: expect.objectContaining({
          teamRunStatus: 'running',
          dispatchTaskStatus,
          projectionReason: 'decision:submitted',
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
        },
      })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({
      status: 200,
      data: { run: { ...run, revision: 3 }, dispatchTasks: [dispatchTasks[1]] },
    });
    const workflow = new TeamRunTaskProjectionWorkflow({
      taskService: { invokeTool },
      gatewayWorkflow: { invoke: gatewayInvoke },
    });

    await workflow.projectAfterOperation({
      operationId: 'team.runTick',
      scope: teamRunScope('run-1'),
      params: { runId: 'run-1' },
      responseData: { action: 'dispatch_prepared', currentStageId: 'design-operator-blueprint' },
    });

    expect(invokeTool).toHaveBeenNthCalledWith(2, {
      method: 'TaskUpdate',
      sessionKey: 'run-1',
      params: expect.objectContaining({
        taskId: '2',
        metadata: expect.objectContaining({
          projectionIdentity: 'matchaclaw.team-runtime:run-1:design-operator-blueprint',
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
              projectionIdentity: 'matchaclaw.team-runtime:run-1:design-operator-blueprint',
              projectionRevision: 4,
              teamRunId: 'run-1',
              teamTaskId: 'design-operator-blueprint',
            },
          }],
        },
      })
      .mockResolvedValue({ status: 200, data: {} });
    const gatewayInvoke = vi.fn().mockResolvedValue({ status: 200, data: { run, dispatchTasks: [dispatchTasks[1]] } });
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
