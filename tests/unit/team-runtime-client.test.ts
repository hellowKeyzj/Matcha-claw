import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityExecuteMock, hostApiFetchMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

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
  });

  it('createTeamRun executes typed team.runtime operation without enabling the plugin from the client', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', status: 'created', revision: 1 });
    const { createTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await createTeamRun({
      teamId: 'team-1',
      packagePath: '.tmp/team-skill',
      runId: 'run-1',
      idempotencyKey: 'create-1',
    });

    expect(hostApiFetchMock).not.toHaveBeenCalled();
    expect(capabilityExecuteMock).toHaveBeenCalledTimes(1);
    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runCreate',
        scope: runtimeInstanceScope,
        target: { kind: 'team', teamId: 'team-1', packagePath: '.tmp/team-skill' },
        input: {
          teamId: 'team-1',
          packagePath: '.tmp/team-skill',
          runId: 'run-1',
          idempotencyKey: 'create-1',
        },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('provisionTeamAgents executes team-level managed agent provisioning through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ teamId: 'team-1', managedAgentCount: 2 });
    const { provisionTeamAgents } = await import('@/services/openclaw/team-runtime-client');

    await provisionTeamAgents({
      teamId: 'team-1',
      packagePath: '.tmp/team-skill',
      idempotencyKey: 'team-1:provision-agents:ascendc-team:1.0.0',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.provisionAgents',
        scope: runtimeInstanceScope,
        target: { kind: 'team', teamId: 'team-1', packagePath: '.tmp/team-skill' },
        input: {
          teamId: 'team-1',
          packagePath: '.tmp/team-skill',
          idempotencyKey: 'team-1:provision-agents:ascendc-team:1.0.0',
        },
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

  it('deleteTeamInstance executes delete operation with team target and input identity', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ teamId: 'team-1', deleted: true, deletedRunIds: [], deletedAgentIds: [] });
    const { deleteTeamInstance } = await import('@/services/openclaw/team-runtime-client');

    await deleteTeamInstance({ teamId: 'team-1' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.delete',
        scope: runtimeInstanceScope,
        target: { kind: 'team', teamId: 'team-1' },
        input: { kind: 'team', teamId: 'team-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('validateTeamSkillPackage executes validation operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ valid: true, errors: [], warnings: [] });
    const { validateTeamSkillPackage } = await import('@/services/openclaw/team-runtime-client');

    await validateTeamSkillPackage({ packagePath: '.tmp/team-skill' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.packageValidate',
        scope: runtimeInstanceScope,
        target: { kind: 'team', packagePath: '.tmp/team-skill' },
        input: { packagePath: '.tmp/team-skill' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('listTeamRuns executes explicit team.runList operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ teamId: 'team-1', runs: [] });
    const { listTeamRuns } = await import('@/services/openclaw/team-runtime-client');

    await listTeamRuns({ teamId: 'team-1' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runList',
        scope: runtimeInstanceScope,
        target: { kind: 'team', teamId: 'team-1' },
        input: { teamId: 'team-1' },
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
        input: { runId: 'run-1', eventCursor: 1, eventLimit: 50 },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('tickTeamRun executes tick operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ success: true, runId: 'run-1', resultType: 'noop' });
    const { tickTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await tickTeamRun({ runId: 'run-1', idempotencyKey: 'tick-1' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runTick',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1', idempotencyKey: 'tick-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('resumeTeam executes team-level resume operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ success: true, teamId: 'team-1', restoredRunIds: [], activeRunIds: [], skippedTerminalRunIds: [] });
    const { resumeTeam } = await import('@/services/openclaw/team-runtime-client');

    await resumeTeam({ teamId: 'team-1', idempotencyKey: 'resume-1' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.resume',
        scope: runtimeInstanceScope,
        target: { kind: 'team', teamId: 'team-1' },
        input: { teamId: 'team-1', idempotencyKey: 'resume-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('submitTeamRunDecision executes decision operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ success: true, runId: 'run-1', decisionId: 'decision-1' });
    const { submitTeamRunDecision } = await import('@/services/openclaw/team-runtime-client');

    await submitTeamRunDecision({
      runId: 'run-1',
      decision: 'retry',
      note: 'Try again',
      idempotencyKey: 'decision-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runDecisionSubmit',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1', decision: 'retry', note: 'Try again', idempotencyKey: 'decision-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('resolveTeamApproval executes approval operation with approval target through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ success: true, runId: 'run-1', approvalId: 'approval-1', status: 'approved' });
    const { resolveTeamApproval } = await import('@/services/openclaw/team-runtime-client');

    await resolveTeamApproval({
      runId: 'run-1',
      approvalId: 'approval-1',
      decision: 'approve',
      note: 'Approved',
      idempotencyKey: 'approval-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.approvalResolve',
        scope: runtimeInstanceScope,
        target: { kind: 'team-approval', runId: 'run-1', approvalId: 'approval-1' },
        input: {
          runId: 'run-1',
          approvalId: 'approval-1',
          decision: 'approve',
          note: 'Approved',
          idempotencyKey: 'approval-1',
        },
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

  it('cancelTeamRun executes cancel operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', status: 'cancelled', revision: 3 });
    const { cancelTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await cancelTeamRun({ runId: 'run-1', reason: 'No longer needed', idempotencyKey: 'cancel-1' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runCancel',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1', reason: 'No longer needed', idempotencyKey: 'cancel-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('deleteTeamRun executes delete operation through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', deleted: true });
    const { deleteTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await deleteTeamRun({ runId: 'run-1' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runDelete',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

});
