import { beforeEach, describe, expect, it } from 'vitest';
import { capabilityExecuteMock, resetGatewayClientMocks } from './helpers/mock-gateway-client';

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

  it('createTeamRun executes typed team.runtime operation', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', status: 'created', revision: 1 });
    const { createTeamRun } = await import('@/services/openclaw/team-runtime-client');

    await createTeamRun({
      packagePath: '.tmp/team-skill',
      runId: 'run-1',
      idempotencyKey: 'create-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
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

  it('executeTeamDispatch does not send synthetic status', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ execution: { executionId: 'openclaw-run-1' }, created: true });
    const { executeTeamDispatch } = await import('@/services/openclaw/team-runtime-client');

    await executeTeamDispatch({
      runId: 'run-1',
      dispatchId: 'dispatch-1',
      idempotencyKey: 'execute-1',
    });

    const payload = capabilityExecuteMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      id: 'team.runtime',
      operationId: 'team.dispatchExecute',
      scope: runtimeInstanceScope,
      target: { kind: 'team-dispatch', runId: 'run-1', dispatchId: 'dispatch-1' },
      input: {
        runId: 'run-1',
        dispatchId: 'dispatch-1',
        idempotencyKey: 'execute-1',
      },
    });
    expect(payload.input).not.toHaveProperty('status');
  });

  it('completeTeamStage does not send synthetic status', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ runId: 'run-1', status: 'running', revision: 2 });
    const { completeTeamStage } = await import('@/services/openclaw/team-runtime-client');

    await completeTeamStage({
      runId: 'run-1',
      stageId: 'stage-1',
      outputArtifactIds: ['artifact-1'],
      idempotencyKey: 'complete-1',
    });

    const payload = capabilityExecuteMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      id: 'team.runtime',
      operationId: 'team.stageComplete',
      scope: runtimeInstanceScope,
      target: { kind: 'team-stage', runId: 'run-1', stageId: 'stage-1' },
      input: {
        runId: 'run-1',
        stageId: 'stage-1',
        outputArtifactIds: ['artifact-1'],
        idempotencyKey: 'complete-1',
      },
    });
    expect(payload.input).not.toHaveProperty('status');
  });

  it('evaluateTeamGate does not send synthetic status', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ gate: { gateId: 'gate-1' }, created: true });
    const { evaluateTeamGate } = await import('@/services/openclaw/team-runtime-client');

    await evaluateTeamGate({
      runId: 'run-1',
      artifactId: 'artifact-1',
      gateType: 'design',
      idempotencyKey: 'gate-1',
    });

    const payload = capabilityExecuteMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      id: 'team.runtime',
      operationId: 'team.gateEvaluate',
      scope: runtimeInstanceScope,
      target: { kind: 'team-run', runId: 'run-1' },
      input: {
        runId: 'run-1',
        artifactId: 'artifact-1',
        gateType: 'design',
        idempotencyKey: 'gate-1',
      },
    });
    expect(payload.input).not.toHaveProperty('status');
  });

  it('prepareTeamDispatch targets the stage being prepared', async () => {
    capabilityExecuteMock.mockResolvedValueOnce({ dispatchId: 'dispatch-1' });
    const { prepareTeamDispatch } = await import('@/services/openclaw/team-runtime-client');

    await prepareTeamDispatch({
      runId: 'run-1',
      stageId: 'stage-1',
      roleId: 'operator',
      idempotencyKey: 'prepare-1',
    });

    expect(capabilityExecuteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'team.runtime',
        operationId: 'team.dispatchPrepare',
        scope: runtimeInstanceScope,
        target: { kind: 'team-stage', runId: 'run-1', stageId: 'stage-1' },
        input: expect.objectContaining({
          runId: 'run-1',
          stageId: 'stage-1',
          roleId: 'operator',
          idempotencyKey: 'prepare-1',
        }),
      }),
      { timeoutMs: 60_000 },
    );
  });
});
