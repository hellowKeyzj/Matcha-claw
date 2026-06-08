import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenClawTaskFlowProjection } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/openclaw-task-flow-projection';

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

const stage = {
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
};

function createManagedFlows() {
  let revision = 1;
  let flow: Record<string, unknown> | undefined;
  return {
    createManaged: vi.fn((params: Record<string, unknown>) => {
      flow = {
        flowId: 'flow-1',
        syncMode: 'managed',
        controllerId: params.controllerId,
        revision: revision++,
        status: params.status,
        updatedAt: params.updatedAt,
        stateJson: params.stateJson,
      };
      return flow;
    }),
    get: vi.fn(() => flow),
    findLatest: vi.fn(() => flow),
    setWaiting: vi.fn((params: Record<string, unknown>) => {
      flow = { ...flow, revision: revision++, status: 'waiting', currentStep: params.currentStep, stateJson: params.stateJson, waitJson: params.waitJson, updatedAt: params.updatedAt };
      return { applied: true, flow };
    }),
    resume: vi.fn((params: Record<string, unknown>) => {
      flow = { ...flow, revision: revision++, status: params.status ?? 'running', currentStep: params.currentStep, stateJson: params.stateJson, updatedAt: params.updatedAt };
      return { applied: true, flow };
    }),
    finish: vi.fn((params: Record<string, unknown>) => {
      flow = { ...flow, revision: revision++, status: 'succeeded', stateJson: params.stateJson, updatedAt: params.updatedAt, endedAt: params.endedAt };
      return { applied: true, flow };
    }),
    fail: vi.fn((params: Record<string, unknown>) => {
      flow = { ...flow, revision: revision++, status: 'failed', stateJson: params.stateJson, blockedSummary: params.blockedSummary, updatedAt: params.updatedAt, endedAt: params.endedAt };
      return { applied: true, flow };
    }),
    requestCancel: vi.fn((params: Record<string, unknown>) => {
      flow = { ...flow, revision: revision++, status: 'cancelled', cancelRequestedAt: params.cancelRequestedAt };
      return { applied: true, flow };
    }),
    cancel: vi.fn(() => ({ found: true, cancelled: true, flow })),
    runTask: vi.fn((params: Record<string, unknown>) => ({ created: true, flow, task: { taskId: 'task-1', ...params } })),
  };
}

describe('OpenClawTaskFlowProjection', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-task-flow-projection-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('creates and resumes a managed flow with TeamRun state', async () => {
    const flowRuntime = createManagedFlows();
    const bindSession = vi.fn(() => flowRuntime);
    const projection = new OpenClawTaskFlowProjection({
      taskFlows: { bindSession },
      config: {} as never,
      storageRoot,
      nowMs: () => 10,
    });

    await projection.projectTeamRun({ run, stages: [stage], reason: 'run:started' });

    expect(bindSession).toHaveBeenCalledWith({ sessionKey: 'matchaclaw-team:run-1' });
    expect(flowRuntime.createManaged).toHaveBeenCalledWith(expect.objectContaining({
      controllerId: 'matchaclaw.team-runtime',
      goal: 'ascendc-team run-1',
      status: 'running',
      currentStep: 'step-1-design-operator-blueprint',
    }));
    expect(flowRuntime.resume).toHaveBeenCalledWith(expect.objectContaining({
      flowId: 'flow-1',
      status: 'running',
      currentStep: 'step-1-design-operator-blueprint',
      stateJson: expect.objectContaining({
        source: 'matchaclaw.team-runtime',
        teamRunId: 'run-1',
        projectionReason: 'run:started',
      }),
    }));
  });

  it.each([
    ['waiting_for_user', 'setWaiting'],
    ['completed', 'finish'],
    ['failed', 'fail'],
    ['cancelled', 'requestCancel'],
  ] as const)('maps %s TeamRun status into managed flow mutation %s', async (status, mutationName) => {
    const flowRuntime = createManagedFlows();
    const projection = new OpenClawTaskFlowProjection({
      taskFlows: { bindSession: () => flowRuntime },
      config: {} as never,
      storageRoot,
      nowMs: () => 10,
    });

    await projection.projectTeamRun({ run, stages: [stage], reason: 'run:started' });
    await projection.projectTeamRun({ run: { ...run, status }, stages: [stage], reason: `run:${status}` });

    expect(flowRuntime[mutationName]).toHaveBeenCalled();
    if (status === 'cancelled') {
      expect(flowRuntime.cancel).toHaveBeenCalledWith(expect.objectContaining({ flowId: 'flow-1' }));
    }
  });

  it('projects role task updates into the managed flow task registry', async () => {
    const flowRuntime = createManagedFlows();
    const projection = new OpenClawTaskFlowProjection({
      taskFlows: { bindSession: () => flowRuntime },
      config: {} as never,
      storageRoot,
      nowMs: () => 10,
    });

    await projection.projectTeamRun({ run, stages: [stage], reason: 'run:started' });
    await projection.projectTaskUpdate({
      run,
      stage,
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Need clarification.',
      detail: 'Boundary condition unclear.',
      progress: 0.5,
    });

    expect(flowRuntime.runTask).toHaveBeenCalledWith(expect.objectContaining({
      flowId: 'flow-1',
      runtime: 'agent',
      sourceId: 'run-1:step-1-design-operator-blueprint:operator-designer',
      agentId: 'matchaclaw-team:run-1:operator-designer',
      label: 'operator-designer: step-1-design-operator-blueprint',
      status: 'running',
      progressSummary: 'Need clarification.',
    }));
    expect(flowRuntime.resume).toHaveBeenLastCalledWith(expect.objectContaining({
      stateJson: expect.objectContaining({
        taskUpdateStatus: 'blocked',
        summary: 'Need clarification.',
        progress: 0.5,
      }),
    }));
  });

  it('does not report cancel success when runtime found the flow but did not cancel it', async () => {
    const flowRuntime = createManagedFlows();
    flowRuntime.cancel.mockResolvedValue({ found: true, cancelled: false, reason: 'already running elsewhere', flow: undefined });
    const projection = new OpenClawTaskFlowProjection({
      taskFlows: { bindSession: () => flowRuntime },
      config: {} as never,
      storageRoot,
      nowMs: () => 10,
    });

    await projection.projectTeamRun({ run, stages: [stage], reason: 'run:started' });

    await expect(projection.projectTeamRun({
      run: { ...run, status: 'cancelled' },
      stages: [stage],
      reason: 'run:cancelled',
    })).rejects.toThrow('Task Flow projection failed: cancel_failed');
  });

  it('does not reuse findLatest flow from another TeamRun', async () => {
    const flowRuntime = createManagedFlows();
    const projection = new OpenClawTaskFlowProjection({
      taskFlows: { bindSession: () => flowRuntime },
      config: {} as never,
      storageRoot,
      nowMs: () => 10,
    });

    await projection.projectTeamRun({ run, stages: [stage], reason: 'run:started' });
    flowRuntime.get.mockReturnValue(undefined);

    await projection.projectTeamRun({
      run: { ...run, runId: 'run-2', revision: 1 },
      stages: [{ ...stage, runId: 'run-2' }],
      reason: 'run:started',
    });

    expect(flowRuntime.createManaged).toHaveBeenCalledTimes(2);
  });

  it('throws when runTask finds a task but does not apply the update', async () => {
    const flowRuntime = createManagedFlows();
    flowRuntime.runTask.mockReturnValue({ created: false, found: true, reason: 'source_conflict', flow: undefined });
    const projection = new OpenClawTaskFlowProjection({
      taskFlows: { bindSession: () => flowRuntime },
      config: {} as never,
      storageRoot,
      nowMs: () => 10,
    });

    await projection.projectTeamRun({ run, stages: [stage], reason: 'run:started' });

    await expect(projection.projectTaskUpdate({
      run,
      stage,
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Need clarification.',
    })).rejects.toThrow('Task Flow task update failed: source_conflict');
  });
});
