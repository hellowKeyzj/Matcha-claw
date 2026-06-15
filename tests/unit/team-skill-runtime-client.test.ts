import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const resolveSingleCapabilityScopeMock = vi.fn();
const testRuntimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
} as const;

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
  resolveSingleCapabilityScope: (...args: unknown[]) => resolveSingleCapabilityScopeMock(...args),
}));

vi.mock('@/services/openclaw/plugin-manager-client', () => ({
  ensurePluginEnabled: vi.fn(async () => undefined),
}));

describe('team skill runtime client', () => {
  beforeEach(() => {
    hostApiFetchMock.mockReset();
    resolveSingleCapabilityScopeMock.mockReset();
    resolveSingleCapabilityScopeMock.mockResolvedValue(testRuntimeScope);
  });

  it('creates TeamRuns through the team.runtime capability', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ runId: 'run-1', status: 'created', revision: 1 });
    const { createTeamRun } = await import('@/services/openclaw/team-runtime-client');

    const result = await createTeamRun({
      packagePath: '.tmp/team',
      runId: 'run-1',
      idempotencyKey: 'create-run-1',
    });

    expect(result).toEqual({ runId: 'run-1', status: 'created', revision: 1 });
    expect(resolveSingleCapabilityScopeMock).toHaveBeenCalledWith('team.runtime');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', {
      method: 'POST',
      body: JSON.stringify({
        id: 'team.runtime',
        operationId: 'team.runCreate',
        scope: testRuntimeScope,
        target: { kind: 'team', packagePath: '.tmp/team' },
        input: {
          packagePath: '.tmp/team',
          runId: 'run-1',
          idempotencyKey: 'create-run-1',
        },
      }),
      timeoutMs: 60000,
    });
  });

  it('plans workflows through the Team runtime gateway without synthetic status', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ plan: { workflowPlanId: 'plan-1' }, created: true });
    const { planTeamWorkflow } = await import('@/services/openclaw/team-runtime-client');

    await expect(planTeamWorkflow({
      runId: 'run-1',
      title: 'Workflow',
      summary: 'Leader-planned workflow',
      groups: [],
      tasks: [],
      idempotencyKey: 'plan-1',
    })).resolves.toEqual({ plan: { workflowPlanId: 'plan-1' }, created: true });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"operationId":"team.planWorkflow"'),
      timeoutMs: 60000,
    }));
    const requestBody = JSON.parse(hostApiFetchMock.mock.calls[0][1].body);
    expect(requestBody).toMatchObject({
      id: 'team.runtime',
      operationId: 'team.planWorkflow',
      scope: testRuntimeScope,
      target: { kind: 'team-run', runId: 'run-1' },
      input: {
        runId: 'run-1',
        title: 'Workflow',
        summary: 'Leader-planned workflow',
        groups: [],
        tasks: [],
        idempotencyKey: 'plan-1',
      },
    });
    expect(requestBody.input).not.toHaveProperty('status');
  });


  it('ticks TeamRuns through the Team runtime gateway', async () => {
    hostApiFetchMock.mockResolvedValueOnce({ action: 'dispatch_prepared', currentStageId: 'step-1-design-operator-blueprint' });
    const { tickTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await expect(tickTeamRun({
      runId: 'run-1',
      idempotencyKey: 'tick-1',
    })).resolves.toEqual({ action: 'dispatch_prepared', currentStageId: 'step-1-design-operator-blueprint' });
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/capabilities/execute', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"operationId":"team.runTick"'),
      timeoutMs: 60000,
    }));
    expect(JSON.parse(hostApiFetchMock.mock.calls[0][1].body)).toMatchObject({
      id: 'team.runtime',
      operationId: 'team.runTick',
      scope: testRuntimeScope,
      target: { kind: 'team-run', runId: 'run-1' },
      input: {
        runId: 'run-1',
        idempotencyKey: 'tick-1',
      },
    });
  });
});
