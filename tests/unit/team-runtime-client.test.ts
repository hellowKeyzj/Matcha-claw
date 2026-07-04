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

const manualTeam = {
  name: 'Manual Ops Team',
  description: 'Manual operators',
  version: '2026.1',
  members: [{
    agentId: 'leader-agent',
    agentName: 'Leader Agent',
    workspace: '/work/manual-team',
    roleId: 'leader',
    skills: ['planning'],
    tools: ['terminal'],
    model: 'claude-sonnet-4-5',
    isLeader: true,
  }],
};

describe('team runtime client', () => {
  beforeEach(() => {
    resetGatewayClientMocks();
  });

  it('readTeamWebhookAuth reads the runtime-host webhook auth projection without plugin calls', async () => {
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      enabled: true,
      source: 'settings',
      headerName: 'x-matchaclaw-webhook-token',
      authorizationScheme: 'Bearer',
      maskedToken: 'mctwh_…oken',
      copySupported: false,
    });
    const { readTeamWebhookAuth } = await import('@/services/openclaw/team-runtime-client');

    await expect(readTeamWebhookAuth()).resolves.toMatchObject({ maskedToken: 'mctwh_…oken', source: 'settings', copySupported: false });

    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/runtime-host/team-webhook-auth', undefined);
    expect(capabilityExecuteMock).not.toHaveBeenCalled();
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

  it('createTeamRun forwards manual source type through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', status: 'created', revision: 1 });
    const { createTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await createTeamRun({
      teamId: 'team-1',
      packagePath: 'manual:team-1',
      runId: 'run-1',
      idempotencyKey: 'create-1',
      sourceType: 'manual',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.runCreate',
        scope: runtimeInstanceScope,
        target: { kind: 'team', teamId: 'team-1', packagePath: 'manual:team-1' },
        input: {
          teamId: 'team-1',
          packagePath: 'manual:team-1',
          runId: 'run-1',
          idempotencyKey: 'create-1',
          sourceType: 'manual',
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

  it('provisionTeamAgents forwards manual source payload through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ teamId: 'team-1', managedAgentCount: 1 });
    const { provisionTeamAgents } = await import('@/services/openclaw/team-runtime-client');

    await provisionTeamAgents({
      teamId: 'team-1',
      packagePath: 'manual:team-1',
      idempotencyKey: 'team-1:provision-agents:manual:2026.1',
      sourceType: 'manual',
      manualTeam,
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.provisionAgents',
        scope: runtimeInstanceScope,
        target: { kind: 'team', teamId: 'team-1', packagePath: 'manual:team-1' },
        input: {
          teamId: 'team-1',
          packagePath: 'manual:team-1',
          idempotencyKey: 'team-1:provision-agents:manual:2026.1',
          sourceType: 'manual',
          manualTeam,
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

  it('saveTeamRunGraphProjection saves graph config through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ success: true, runId: 'run-1', saved: true });
    const { saveTeamRunGraphProjection } = await import('@/services/openclaw/team-runtime-client');
    const graph = {
      runId: 'run-1',
      nodes: [{ nodeId: 'node-1', kind: 'work', title: 'Task 1' }],
      edges: [],
      status: 'running',
      updatedAt: 123,
    };

    await saveTeamRunGraphProjection({
      runId: 'run-1',
      graph,
      idempotencyKey: 'graph-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.graphSave',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1', graph, idempotencyKey: 'graph-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('exportTeamRunGraphYaml exports graph YAML through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', fileName: 'run-1.yaml', yaml: 'nodes: []\n' });
    const { exportTeamRunGraphYaml } = await import('@/services/openclaw/team-runtime-client');

    await expect(exportTeamRunGraphYaml({ runId: 'run-1' })).resolves.toEqual({ runId: 'run-1', fileName: 'run-1.yaml', yaml: 'nodes: []\n' });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.graphExportYaml',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('importTeamRunGraphYaml imports graph YAML through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ success: true, runId: 'run-1', imported: true });
    const { importTeamRunGraphYaml } = await import('@/services/openclaw/team-runtime-client');

    await expect(importTeamRunGraphYaml({ runId: 'run-1', yaml: 'nodes: []\n', idempotencyKey: 'import-1' })).resolves.toEqual({ success: true, runId: 'run-1', imported: true });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.graphImportYaml',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1', yaml: 'nodes: []\n', idempotencyKey: 'import-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('fireTeamRunTrigger executes trigger fire through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ fired: true, snapshot: { run: null, graph: null, nodeExecutions: [] } });
    const { fireTeamRunTrigger } = await import('@/services/openclaw/team-runtime-client');

    await fireTeamRunTrigger({
      runId: 'run-1',
      startNodeId: 'start-1',
      triggerSource: 'webhook',
      payloadSummary: 'payload received',
      idempotencyKey: 'trigger-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.triggerFire',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1', startNodeId: 'start-1', triggerSource: 'webhook', payloadSummary: 'payload received', idempotencyKey: 'trigger-1' },
      }),
      { timeoutMs: 60_000 },
    );
  });

  it('submitTeamRunRoleMessage submits role chat text through team.runtime', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ submitted: true, snapshot: { run: null, graph: null, nodeExecutions: [] } });
    const { submitTeamRunRoleMessage } = await import('@/services/openclaw/team-runtime-client');

    await submitTeamRunRoleMessage({
      runId: 'run-1',
      roleId: 'leader',
      text: 'hello',
      idempotencyKey: 'chat-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.roleMessageSubmit',
        scope: runtimeInstanceScope,
        target: { kind: 'team-run', runId: 'run-1' },
        input: { runId: 'run-1', roleId: 'leader', text: 'hello', idempotencyKey: 'chat-1' },
      }),
      { timeoutMs: 60_000 },
    );
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
