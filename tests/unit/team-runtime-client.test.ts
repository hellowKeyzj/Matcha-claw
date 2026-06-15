import { beforeEach, describe, expect, it, vi } from 'vitest';
import { capabilityExecuteMock, hostApiFetchMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

vi.mock('@/lib/host-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/host-api')>();
  return {
    ...actual,
    waitForRuntimeJobResult: vi.fn(async () => ({ execution: { enabledPluginIds: ['team-runtime'] } })),
  };
});

const runtimeInstanceScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
};

describe('team runtime client', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
    hostApiFetchMock.mockResolvedValue({ execution: { enabledPluginIds: ['team-runtime'] } });
  });

  it('createTeamRun enables the team-runtime plugin before executing typed team.runtime operation', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ execution: { enabledPluginIds: [] } });
    capabilityExecuteMock
      .mockResolvedValueOnce({ success: true, job: { id: 'job-1', type: 'plugins.setEnabled', status: 'succeeded', queuedAt: 1, attempts: 1, maxAttempts: 1 } })
      .mockResolvedValueOnce({ runId: 'run-1', status: 'created', revision: 1 });
    const { createTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await createTeamRun({
      packagePath: '.tmp/team-skill',
      runId: 'run-1',
      idempotencyKey: 'create-1',
    });

    expect(capabilityExecuteMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        id: 'plugin.runtime',
        operationId: 'plugins.setEnabled',
        scope: runtimeInstanceScope,
        target: { kind: 'plugin', pluginId: 'team-runtime' },
        input: { pluginIds: ['team-runtime'], enabled: true },
      }),
      { timeoutMs: undefined },
    );
    expect(capabilityExecuteMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runCreate',
        scope: runtimeInstanceScope,
        target: { kind: 'team', packagePath: '.tmp/team-skill' },
        input: expect.objectContaining({
          packagePath: '.tmp/team-skill',
          runId: 'run-1',
          idempotencyKey: 'create-1',
        }),
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('does not enable the team-runtime plugin again when runtime already has it enabled', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ execution: { enabledPluginIds: ['team-runtime'] } });
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', status: 'created', revision: 1 });
    const { createTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await createTeamRun({
      packagePath: '.tmp/team-skill',
      runId: 'run-1',
      idempotencyKey: 'create-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledTimes(1);
    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runCreate',
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('planTeamDependencies executes dependency plan operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ packageName: 'team-a', packageVersion: '1.0.0', items: [], canProceed: true });
    const { planTeamDependencies } = await import('@/services/openclaw/team-runtime-client');

    await planTeamDependencies({ packagePath: '.tmp/team-skill' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.dependencyPlan',
        scope: runtimeInstanceScope,
        target: { kind: 'team', packagePath: '.tmp/team-skill' },
        input: { packagePath: '.tmp/team-skill' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('readTeamRunDiagnostics executes diagnostics operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', recoveredFromStorage: true });
    const { readTeamRunDiagnostics } = await import('@/services/openclaw/team-runtime-client');

    await readTeamRunDiagnostics({ runId: 'run-1' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runDiagnostics',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: expect.objectContaining({ runId: 'run-1' }),
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('readTeamRunSnapshot forwards cursor options through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ run: null, stages: [], nextEventCursor: 2 });
    const { readTeamRunSnapshot } = await import('@/services/openclaw/team-runtime-client');

    await readTeamRunSnapshot({ runId: 'run-1', eventCursor: 1, eventLimit: 50 });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runSnapshot',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: expect.objectContaining({ runId: 'run-1', eventCursor: 1, eventLimit: 50 }),
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('planTeamWorkflow forwards workflow payload through team.runtime without synthetic status', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ plan: { workflowPlanId: 'plan-1' }, created: true });
    const { planTeamWorkflow } = await import('@/services/openclaw/team-runtime-client');

    await planTeamWorkflow({
      runId: 'run-1',
      title: 'Workflow plan',
      summary: 'Plan summary',
      groups: [{ groupId: 'group-1', taskIds: ['task-1'] }],
      tasks: [{ taskId: 'task-1', roleId: 'operator', title: 'Task 1' }],
      idempotencyKey: 'plan-1',
    });

    const payload = capabilityExecuteMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      id: 'team.runtime',
      operationId: 'team.planWorkflow',
      scope: runtimeInstanceScope,
      target: { kind: 'team-run', runId: 'run-1' },
      input: {
        runId: 'run-1',
        title: 'Workflow plan',
        summary: 'Plan summary',
        groups: [{ groupId: 'group-1', taskIds: ['task-1'] }],
        tasks: [{ taskId: 'task-1', roleId: 'operator', title: 'Task 1' }],
        idempotencyKey: 'plan-1',
      },
    });
    expect(payload.input).not.toHaveProperty('status');
  });

});
