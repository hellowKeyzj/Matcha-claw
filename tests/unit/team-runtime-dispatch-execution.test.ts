import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamRunService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-run-service';
import { TeamSkillPackageService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-skill-package-service';

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0');

const clock = { nowMs: () => 1 };
let nextId = 0;
const idGenerator = { randomId: () => `id-${nextId += 1}` };
const dependencyChecker = {
  async check() {
    return { missingRequiredSkills: [], missingRequiredTools: [], missingOptionalTools: [] };
  },
};

function designCompleteReport(): string {
  return [
    '# Operator Design Report',
    '',
    '## Tiling Strategy',
    '- Split M dimension into 128-row tiles.',
    '- Use double buffering for input tiles.',
    '- Align tail handling to vector block size.',
    '',
    '## Memory Layout',
    '- Store input A in global memory contiguous by row.',
    '- Stage input B tiles into UB with 32-byte alignment.',
    '- Reuse output buffer across pipeline iterations.',
    '',
    '## Data Flow',
    '- Load shape metadata before kernel loop.',
    '- Copy input tiles from GM to UB.',
    '- Compute tile output and copy result back to GM.',
    '',
    '## Interface Specification',
    '- Accept GM pointers for input, output, and tiling data.',
    '- Validate dtype support for float16 and bfloat16.',
    '- Expose blockDim derived from tiling key.',
    '',
    '## Performance Estimation',
    '- Expected memory bandwidth utilization is 70%.',
    '- Expected vector utilization is 65%.',
    '- Tail tiles add less than 5% overhead.',
    '',
    'Verdict: DESIGN-COMPLETE',
  ].join('\n');
}

function passContentForStage(stageId: string): { kind: string; title: string; content: string } {
  if (stageId.includes('design')) {
    return { kind: 'design_report', title: 'Operator blueprint', content: designCompleteReport() };
  }
  if (stageId.includes('code')) {
    return { kind: 'compile_report', title: 'Kernel implementation', content: 'Compilation succeeded. Verdict: CODE-COMPILABLE' };
  }
  if (stageId.includes('adversarial')) {
    return { kind: 'adversary_report', title: 'Adversarial review', content: 'Review completed. Verdict: ACCEPTABLE-RISK' };
  }
  if (stageId.includes('precision')) {
    return { kind: 'precision_report', title: 'Precision validation', content: 'All cases passed. Verdict: PRECISION-PASS' };
  }
  if (stageId.includes('performance')) {
    return { kind: 'performance_report', title: 'Performance optimization', content: 'Optimization reached target. Verdict: PERFORMANCE-TARGET-MET' };
  }
  throw new Error(`No pass content for stage: ${stageId}`);
}

function roleIdForStage(stageId: string): string {
  if (stageId.includes('design')) return 'operator-designer';
  if (stageId.includes('code')) return 'kernel-coder';
  if (stageId.includes('adversarial')) return 'code-adversary';
  if (stageId.includes('precision')) return 'precision-validator';
  if (stageId.includes('performance')) return 'performance-optimizer';
  throw new Error(`No role for stage: ${stageId}`);
}

async function advanceToDesign(service: TeamRunService, runId: string): Promise<void> {
  await service.completeStage({
    runId,
    stageId: 'step-0-pre-flight-dependency-check',
    idempotencyKey: `advance-${runId}-preflight`,
  });
}

function roleWorkspace(storageRoot: string, runId: string, roleId: string): string {
  return path.join(storageRoot, 'runs', runId, 'roles', roleId);
}

async function patchRun(storageRoot: string, runId: string, patch: Record<string, unknown>): Promise<void> {
  const runPath = path.join(storageRoot, 'runs', runId, 'run.json');
  const run = JSON.parse(await readFile(runPath, 'utf8')) as Record<string, unknown>;
  await writeFile(runPath, `${JSON.stringify({ ...run, ...patch }, null, 2)}\n`, 'utf8');
}

function bindExecutionPort(service: TeamRunService, executeDispatch: ReturnType<typeof vi.fn>, cancelDispatchExecution = vi.fn(async () => ({ cancelled: true }))): void {
  Object.assign(service, { roleSessionExecution: { executeDispatch, cancelDispatchExecution } });
}

describe('TeamRunService dispatch execution', () => {
  let storageRoot = '';

  beforeEach(async () => {
    nextId = 0;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-runtime-dispatch-execution-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('pauses preflight when required dependencies are missing and proceeds only after user decision', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker: {
        async check() {
          return {
            missingRequiredSkills: ['ascendc-operator-design'],
            missingRequiredTools: ['bash'],
            missingOptionalTools: ['edit_file'],
          };
        },
      },
    });

    await service.create({ packagePath: fixturePath, runId: 'run-preflight-missing', idempotencyKey: 'create-preflight-missing' });
    await service.start({ runId: 'run-preflight-missing', idempotencyKey: 'start-preflight-missing' });

    await expect(service.tick({ runId: 'run-preflight-missing', idempotencyKey: 'tick-preflight-missing' })).resolves.toEqual(expect.objectContaining({
      action: 'dependency_missing',
      status: 'waiting_for_user',
      currentStageId: 'step-0-pre-flight-dependency-check',
      missingRequiredSkills: ['ascendc-operator-design'],
      missingRequiredTools: ['bash'],
      missingOptionalTools: ['edit_file'],
    }));
    await expect(service.snapshot({ runId: 'run-preflight-missing', eventCursor: 0 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'waiting_for_user', currentStageId: 'step-0-pre-flight-dependency-check' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'waiting_for_user' }),
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'pending' }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dependency:missing' }),
      ]),
    }));

    await expect(service.submitDecision({
      runId: 'run-preflight-missing',
      decision: 'proceed_degraded',
      idempotencyKey: 'decision-proceed-degraded',
    })).resolves.toEqual(expect.objectContaining({ created: true }));
    await expect(service.snapshot({ runId: 'run-preflight-missing', eventCursor: 0 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-0-pre-flight-dependency-check', status: 'passed' }),
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running' }),
      ]),
      decisions: [expect.objectContaining({ decision: 'proceed_degraded' })],
    }));
  });

  it('rejects starting terminal TeamRuns', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-start-terminal', idempotencyKey: 'create-start-terminal' });
    await service.start({ runId: 'run-start-terminal', idempotencyKey: 'start-start-terminal' });
    await advanceToDesign(service, 'run-start-terminal');
    const runtimeRoot = service.resolveRuntimeRoot('run-start-terminal');
    await service['stageStore'].updateStatus({ runtimeRoot, stageId: 'step-1-design-operator-blueprint', status: 'failed' });
    await service['runStore'].update({ runtimeRoot, status: 'failed', currentStageId: 'step-1-design-operator-blueprint' });

    await expect(service.start({ runId: 'run-start-terminal', idempotencyKey: 'restart-terminal' }))
      .rejects.toThrow('TeamRun cannot be started from status failed: run-start-terminal');
  });

  it('ticks role stages into queued dispatch executions when an execution port is configured', async () => {
    const executeDispatch = vi.fn(async (input) => ({
      executionId: 'openclaw-session-tick',
      childSessionKey: 'agent:matchaclaw-team:run-tick-exec:operator-designer:subagent:child-tick',
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
      roleSessionExecution: { executeDispatch, cancelDispatchExecution: vi.fn(async () => ({ cancelled: true })) },
    });

    await service.create({ packagePath: fixturePath, runId: 'run-tick-exec', idempotencyKey: 'create-tick-exec' });
    await service.start({ runId: 'run-tick-exec', idempotencyKey: 'start-tick-exec' });

    await expect(service.tick({ runId: 'run-tick-exec', idempotencyKey: 'tick-design' })).resolves.toEqual(expect.objectContaining({
      action: 'dispatch_execution_queued',
      currentStageId: 'step-1-design-operator-blueprint',
      dispatch: expect.objectContaining({ roleId: 'operator-designer' }),
      execution: expect.objectContaining({ executionId: 'openclaw-session-tick' }),
      created: false,
    }));
    expect(executeDispatch).toHaveBeenCalledTimes(1);
  });

  it('marks failed claimed dispatch executions when role session spawn fails', async () => {
    const executeDispatch = vi.fn().mockRejectedValue(new Error('subagent target is not allowed'));
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-spawn-fails', idempotencyKey: 'create-spawn-fails' });
    await service.start({ runId: 'run-spawn-fails', idempotencyKey: 'start-spawn-fails' });
    await advanceToDesign(service, 'run-spawn-fails');
    const prepared = await service.prepareDispatch({
      runId: 'run-spawn-fails',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-spawn-fails',
    });
    bindExecutionPort(service, executeDispatch);

    await expect(service.executeDispatch({
      runId: 'run-spawn-fails',
      dispatchId: prepared.dispatch.dispatchId,
      idempotencyKey: 'execute-spawn-fails',
    })).rejects.toThrow('subagent target is not allowed');
    await expect(service.snapshot({ runId: 'run-spawn-fails', eventCursor: 0, eventLimit: 30 })).resolves.toEqual(expect.objectContaining({
      dispatchExecutions: [expect.objectContaining({
        dispatchId: prepared.dispatch.dispatchId,
        status: 'failed',
        statusReason: 'subagent target is not allowed',
      })],
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch:execution_failed' }),
      ]),
    }));
  });

  it('marks completed dispatch executions after role artifact submission', async () => {
    const executeDispatch = vi.fn(async (input) => ({
      executionId: 'openclaw-session-complete',
      childSessionKey: 'agent:matchaclaw-team:run-complete-exec:operator-designer:subagent:child-1',
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-complete-exec', idempotencyKey: 'create-complete-exec' });
    await service.start({ runId: 'run-complete-exec', idempotencyKey: 'start-complete-exec' });
    await service.tick({ runId: 'run-complete-exec', idempotencyKey: 'tick-complete-preflight' });
    bindExecutionPort(service, executeDispatch);
    await service.tick({ runId: 'run-complete-exec', idempotencyKey: 'tick-complete-design' });

    await expect(service.submitArtifact({
      runId: 'run-complete-exec',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-complete-exec',
      workspaceDir: roleWorkspace(storageRoot, 'run-complete-exec', 'operator-designer'),
    })).resolves.toEqual(expect.objectContaining({ created: true }));

    await expect(service.snapshot({ runId: 'run-complete-exec', eventCursor: 0, eventLimit: 30 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'running', currentStageId: 'step-2-code-kernel-implementation' }),
      dispatchExecutions: expect.arrayContaining([expect.objectContaining({
        executionId: 'openclaw-session-complete',
        stageId: 'step-1-design-operator-blueprint',
        status: 'completed',
        statusReason: expect.stringContaining('Artifact submitted:'),
      })]),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'passed' }),
        expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'running' }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch:execution_completed' }),
        expect.objectContaining({ type: 'gate:evaluated' }),
        expect.objectContaining({ type: 'stage:gate_transitioned' }),
      ]),
    }));
  });

  it('cancels active stages and dispatch executions for non-terminal runs', async () => {
    const childSessionKey = 'agent:matchaclaw-team:run-cancel-active:operator-designer:subagent:child-1';
    const executeDispatch = vi.fn(async (input) => ({
      executionId: 'openclaw-session-cancel',
      childSessionKey,
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));
    const cancelDispatchExecution = vi.fn(async () => ({ cancelled: true }));
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-cancel-active', idempotencyKey: 'create-cancel-active' });
    await service.start({ runId: 'run-cancel-active', idempotencyKey: 'start-cancel-active' });
    await service.tick({ runId: 'run-cancel-active', idempotencyKey: 'tick-cancel-preflight' });
    bindExecutionPort(service, executeDispatch, cancelDispatchExecution);
    await service.tick({ runId: 'run-cancel-active', idempotencyKey: 'tick-cancel-design' });

    await expect(service.cancel({
      runId: 'run-cancel-active',
      reason: 'user requested cancellation',
      idempotencyKey: 'cancel-active',
    })).resolves.toEqual(expect.objectContaining({ status: 'cancelled' }));
    expect(cancelDispatchExecution).toHaveBeenCalledWith({
      execution: expect.objectContaining({
        executionId: 'openclaw-session-cancel',
        childSessionKey,
        status: 'queued',
      }),
      reason: 'user requested cancellation',
    });
    await expect(service.snapshot({ runId: 'run-cancel-active', eventCursor: 0, eventLimit: 40 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'cancelled', currentStageId: 'step-1-design-operator-blueprint' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'cancelled' }),
      ]),
      dispatchExecutions: [expect.objectContaining({
        stageId: 'step-1-design-operator-blueprint',
        status: 'cancelled',
        statusReason: 'user requested cancellation',
      })],
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch:execution_cancelled' }),
        expect.objectContaining({ type: 'run:cancelled' }),
      ]),
    }));
    await expect(service.cancel({ runId: 'run-cancel-active', idempotencyKey: 'cancel-terminal' }))
      .rejects.toThrow('TeamRun cannot be cancelled from terminal status cancelled: run-cancel-active');
  });

  it('requires role tool callers to present the provisioned run workspace', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-caller-auth', idempotencyKey: 'create-caller-auth' });
    await service.start({ runId: 'run-caller-auth', idempotencyKey: 'start-caller-auth' });
    await advanceToDesign(service, 'run-caller-auth');

    await expect(service.updateTask({
      runId: 'run-caller-auth',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Need clarification.',
      idempotencyKey: 'task-missing-workspace',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer');
    await expect(service.requestApproval({
      runId: 'run-caller-auth',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      reason: 'Need user authorization.',
      requestedAction: 'Run external validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'approval-missing-workspace',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer');
    await expect(service.sendMessage({
      runId: 'run-caller-auth',
      fromRoleId: 'operator-designer',
      toRoleId: 'leader',
      summary: 'Blocked',
      body: 'Need clarification.',
      idempotencyKey: 'message-missing-workspace',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer');
    await expect(service.submitArtifact({
      runId: 'run-caller-auth',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-missing-workspace',
    })).rejects.toThrow('Tool caller workspace is required for role: operator-designer');

    await expect(service.updateTask({
      runId: 'run-caller-auth',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Need clarification.',
      idempotencyKey: 'task-correct-workspace',
      workspaceDir: roleWorkspace(storageRoot, 'run-caller-auth', 'operator-designer'),
    })).resolves.toEqual(expect.objectContaining({ runId: 'run-caller-auth', roleId: 'operator-designer' }));
  });

  it('rejects cross-run reuse of a same-role workspace for team tool calls', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    for (const runId of ['run-caller-owner', 'run-caller-victim']) {
      await service.create({ packagePath: fixturePath, runId, idempotencyKey: `create-${runId}` });
      await service.start({ runId, idempotencyKey: `start-${runId}` });
      await advanceToDesign(service, runId);
    }

    await expect(service.sendMessage({
      runId: 'run-caller-victim',
      fromRoleId: 'operator-designer',
      toRoleId: 'leader',
      summary: 'Impersonated update',
      body: 'This should not be accepted.',
      idempotencyKey: 'message-cross-run',
      workspaceDir: roleWorkspace(storageRoot, 'run-caller-owner', 'operator-designer'),
    })).rejects.toThrow('Tool caller workspace does not match role: operator-designer');

    await expect(service.submitArtifact({
      runId: 'run-caller-victim',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-correct-workspace',
      workspaceDir: roleWorkspace(storageRoot, 'run-caller-victim', 'operator-designer'),
    })).resolves.toEqual(expect.objectContaining({ created: true }));
  });

  it('reconciles an already persisted passing gate when the run cursor was not advanced', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });
    const runId = 'run-gate-reconcile';
    await service.create({ packagePath: fixturePath, runId, idempotencyKey: 'create-gate-reconcile' });
    await service.start({ runId, idempotencyKey: 'start-gate-reconcile' });
    await advanceToDesign(service, runId);
    const submitted = await service.submitArtifact({
      runId,
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      ...passContentForStage('step-1-design-operator-blueprint'),
      idempotencyKey: 'artifact-gate-reconcile',
      workspaceDir: roleWorkspace(storageRoot, runId, 'operator-designer'),
    });
    await patchRun(storageRoot, runId, { status: 'running', currentStageId: 'step-1-design-operator-blueprint' });

    await expect(service.evaluateGate({
      runId,
      artifactId: submitted.artifact.artifactId,
      gateType: 'design',
      idempotencyKey: 'artifact-gate-reconcile:gate:step-1-design-operator-blueprint',
    })).resolves.toEqual(expect.objectContaining({ created: false }));
    await expect(service.snapshot({ runId, eventCursor: 0, eventLimit: 40 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'running', currentStageId: 'step-2-code-kernel-implementation' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'passed' }),
        expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'running' }),
      ]),
    }));
  });

  it('reconciles already persisted approval request and resolution transitions', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });
    const runId = 'run-approval-reconcile';
    await service.create({ packagePath: fixturePath, runId, idempotencyKey: 'create-approval-reconcile' });
    await service.start({ runId, idempotencyKey: 'start-approval-reconcile' });
    await advanceToDesign(service, runId);
    const requested = await service.requestApproval({
      runId,
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      reason: 'Need user authorization.',
      requestedAction: 'Run live validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'approval-reconcile-request',
      workspaceDir: roleWorkspace(storageRoot, runId, 'operator-designer'),
    });
    await patchRun(storageRoot, runId, { status: 'running', currentStageId: 'step-1-design-operator-blueprint' });

    await expect(service.requestApproval({
      runId,
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      reason: 'Need user authorization.',
      requestedAction: 'Run live validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'approval-reconcile-request',
      workspaceDir: roleWorkspace(storageRoot, runId, 'operator-designer'),
    })).resolves.toEqual(expect.objectContaining({ created: false }));
    await expect(service.snapshot({ runId, eventCursor: 0, eventLimit: 40 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'waiting_for_user', currentStageId: 'step-1-design-operator-blueprint' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'waiting_for_user' }),
      ]),
    }));

    await service.resolveApproval({
      runId,
      approvalId: requested.approval.approvalId,
      decision: 'approve',
      idempotencyKey: 'approval-reconcile-resolve',
    });
    await patchRun(storageRoot, runId, { status: 'waiting_for_user', currentStageId: 'step-1-design-operator-blueprint' });
    await expect(service.resolveApproval({
      runId,
      approvalId: requested.approval.approvalId,
      decision: 'approve',
      idempotencyKey: 'approval-reconcile-resolve',
    })).resolves.toEqual(expect.objectContaining({ approval: expect.objectContaining({ status: 'approved' }) }));
    await expect(service.snapshot({ runId, eventCursor: 0, eventLimit: 60 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running' }),
      ]),
    }));
  });

  it('requires approval requests to target the running current stage and assigned role', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-approval-guards', idempotencyKey: 'create-approval-guards' });
    await service.start({ runId: 'run-approval-guards', idempotencyKey: 'start-approval-guards' });
    await advanceToDesign(service, 'run-approval-guards');

    await expect(service.requestApproval({
      runId: 'run-approval-guards',
      stageId: 'step-2-code-kernel-implementation',
      roleId: 'kernel-coder',
      reason: 'Need user authorization.',
      requestedAction: 'Run compile validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'approval-wrong-stage',
      workspaceDir: roleWorkspace(storageRoot, 'run-approval-guards', 'kernel-coder'),
    })).rejects.toThrow('TeamRun current stage is step-1-design-operator-blueprint, got step-2-code-kernel-implementation');
    await expect(service.requestApproval({
      runId: 'run-approval-guards',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'kernel-coder',
      reason: 'Need user authorization.',
      requestedAction: 'Run design validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'approval-wrong-role',
      workspaceDir: roleWorkspace(storageRoot, 'run-approval-guards', 'kernel-coder'),
    })).rejects.toThrow('Team stage step-1-design-operator-blueprint expects role operator-designer, got kernel-coder');
  });

  it('marks stale queued dispatch executions during recovery snapshot reads', async () => {
    let now = 1;
    const recoveryClock = { nowMs: () => now };
    const executeDispatch = vi.fn(async (input) => ({
      executionId: 'openclaw-session-stale',
      childSessionKey: 'agent:matchaclaw-team:run-stale:operator-designer:subagent:child-1',
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));
    const service = new TeamRunService({
      storageRoot,
      clock: recoveryClock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
      staleDispatchExecutionMs: 10,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-stale', idempotencyKey: 'create-stale' });
    await service.start({ runId: 'run-stale', idempotencyKey: 'start-stale' });
    await advanceToDesign(service, 'run-stale');
    const prepared = await service.prepareDispatch({
      runId: 'run-stale',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-stale',
    });
    bindExecutionPort(service, executeDispatch);
    await service.executeDispatch({
      runId: 'run-stale',
      dispatchId: prepared.dispatch.dispatchId,
      idempotencyKey: 'execute-stale',
    });

    now = 20;
    const recoveredService = new TeamRunService({
      storageRoot,
      clock: recoveryClock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
      staleDispatchExecutionMs: 10,
    });

    await expect(recoveredService.snapshot({ runId: 'run-stale', eventCursor: 0, eventLimit: 30 })).resolves.toEqual(expect.objectContaining({
      dispatchExecutions: [expect.objectContaining({ status: 'stale', staleAt: 20 })],
      diagnostics: expect.objectContaining({
        recoveredFromStorage: true,
        staleDispatchExecutions: [expect.objectContaining({ executionId: 'openclaw-session-stale', status: 'stale' })],
      }),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch:execution_stale' }),
      ]),
    }));
  });

  it('fails running TeamRuns when the total wall-clock budget is exceeded before new dispatch', async () => {
    let now = 1;
    const budgetClock = { nowMs: () => now };
    const service = new TeamRunService({
      storageRoot,
      clock: budgetClock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-budget', idempotencyKey: 'create-budget' });
    await service.start({ runId: 'run-budget', idempotencyKey: 'start-budget' });
    now = 2_700_002;

    await expect(service.tick({ runId: 'run-budget', idempotencyKey: 'tick-budget' })).resolves.toEqual(expect.objectContaining({
      action: 'noop',
      status: 'failed',
      reason: 'TeamRun wall-clock budget exceeded',
    }));
    await expect(service.snapshot({ runId: 'run-budget', eventCursor: 0, eventLimit: 20 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'failed' }),
      diagnostics: expect.objectContaining({
        budgets: expect.objectContaining({ wallClockExceeded: true }),
      }),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'run:budget_exceeded' }),
      ]),
    }));
  });

  it('fails the run when approval is denied without leaving contradictory waiting state', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-approval-deny', idempotencyKey: 'create-approval-deny' });
    await service.start({ runId: 'run-approval-deny', idempotencyKey: 'start-approval-deny' });
    await advanceToDesign(service, 'run-approval-deny');
    const requested = await service.requestApproval({
      runId: 'run-approval-deny',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      reason: 'Need user authorization.',
      requestedAction: 'Run live validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'approval-deny-request',
      workspaceDir: roleWorkspace(storageRoot, 'run-approval-deny', 'operator-designer'),
    });

    await expect(service.resolveApproval({
      runId: 'run-approval-deny',
      approvalId: requested.approval.approvalId,
      decision: 'deny',
      note: 'Not allowed.',
      idempotencyKey: 'approval-deny-resolve',
    })).resolves.toEqual(expect.objectContaining({ approval: expect.objectContaining({ status: 'denied' }) }));
    await expect(service.snapshot({ runId: 'run-approval-deny', eventCursor: 0, eventLimit: 40 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'failed', currentStageId: 'step-1-design-operator-blueprint' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'failed' }),
      ]),
      approvals: [expect.objectContaining({ status: 'denied', note: 'Not allowed.' })],
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'approval:resolved', payload: expect.objectContaining({ decision: 'deny' }) }),
      ]),
    }));
  });

  it('recovers the artifact completion pipeline when an existing artifact retry finds a half-submitted stage', async () => {
    const executeDispatch = vi.fn(async (input) => ({
      executionId: 'openclaw-session-recover-artifact',
      childSessionKey: 'agent:matchaclaw-team:run-recover-artifact:operator-designer:subagent:child-1',
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-recover-artifact', idempotencyKey: 'create-recover-artifact' });
    await service.start({ runId: 'run-recover-artifact', idempotencyKey: 'start-recover-artifact' });
    await service.tick({ runId: 'run-recover-artifact', idempotencyKey: 'tick-recover-preflight' });
    bindExecutionPort(service, executeDispatch);
    await service.tick({ runId: 'run-recover-artifact', idempotencyKey: 'tick-recover-design' });

    const firstSubmit = await service.submitArtifact({
      runId: 'run-recover-artifact',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-recover-design',
      workspaceDir: roleWorkspace(storageRoot, 'run-recover-artifact', 'operator-designer'),
    });
    const runtimeRoot = service.resolveRuntimeRoot('run-recover-artifact');
    await service['stageStore'].updateStatus({ runtimeRoot, stageId: 'step-1-design-operator-blueprint', status: 'running' });
    await service['stageStore'].updateStatus({ runtimeRoot, stageId: 'step-2-code-kernel-implementation', status: 'pending', attempt: 0 });
    await service['runStore'].update({ runtimeRoot, status: 'running', currentStageId: 'step-1-design-operator-blueprint' });

    await expect(service.submitArtifact({
      runId: 'run-recover-artifact',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: designCompleteReport(),
      idempotencyKey: 'artifact-recover-design',
      workspaceDir: roleWorkspace(storageRoot, 'run-recover-artifact', 'operator-designer'),
    })).resolves.toEqual(expect.objectContaining({ created: false, artifact: expect.objectContaining({ artifactId: firstSubmit.artifact.artifactId }) }));

    await expect(service.snapshot({ runId: 'run-recover-artifact', eventCursor: 0, eventLimit: 50 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'running', currentStageId: 'step-2-code-kernel-implementation' }),
      dispatchExecutions: expect.arrayContaining([expect.objectContaining({ status: 'completed', stageId: 'step-1-design-operator-blueprint' })]),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'passed', outputArtifactIds: [firstSubmit.artifact.artifactId] }),
        expect.objectContaining({ stageId: 'step-2-code-kernel-implementation', status: 'running', inputArtifactIds: [firstSubmit.artifact.artifactId] }),
      ]),
      gates: [expect.objectContaining({ artifactId: firstSubmit.artifact.artifactId, passed: true })],
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch:execution_completed' }),
        expect.objectContaining({ type: 'stage:gate_transitioned' }),
      ]),
    }));
  });

  it('rejects artifact submission and dispatch preparation outside the current running stage', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-current-stage-guards', idempotencyKey: 'create-current-stage-guards' });
    await service.start({ runId: 'run-current-stage-guards', idempotencyKey: 'start-current-stage-guards' });
    await advanceToDesign(service, 'run-current-stage-guards');

    await expect(service.prepareDispatch({
      runId: 'run-current-stage-guards',
      stageId: 'step-2-code-kernel-implementation',
      roleId: 'kernel-coder',
      idempotencyKey: 'dispatch-non-current-stage',
    })).rejects.toThrow('TeamRun current stage is step-1-design-operator-blueprint, got step-2-code-kernel-implementation');
    await expect(service.submitArtifact({
      runId: 'run-current-stage-guards',
      stageId: 'step-2-code-kernel-implementation',
      roleId: 'kernel-coder',
      kind: 'compile_report',
      title: 'Kernel implementation',
      content: 'Compilation succeeded. Verdict: CODE-COMPILABLE',
      idempotencyKey: 'artifact-non-current-stage',
      workspaceDir: roleWorkspace(storageRoot, 'run-current-stage-guards', 'kernel-coder'),
    })).rejects.toThrow('TeamRun current stage is step-1-design-operator-blueprint, got step-2-code-kernel-implementation');
  });

  it('claims dispatch execution before spawning and does not spawn again for the same execution key', async () => {
    const executeDispatch = vi.fn(async (input) => ({
      executionId: 'openclaw-session-claim',
      childSessionKey: 'agent:matchaclaw-team:run-claim:operator-designer:subagent:child-1',
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-claim', idempotencyKey: 'create-claim' });
    await service.start({ runId: 'run-claim', idempotencyKey: 'start-claim' });
    await advanceToDesign(service, 'run-claim');
    const prepared = await service.prepareDispatch({
      runId: 'run-claim',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-claim',
    });
    const runtimeRoot = service.resolveRuntimeRoot('run-claim');
    await service['dispatchExecutionStore'].claim({
      runtimeRoot,
      runId: 'run-claim',
      dispatchId: prepared.dispatch.dispatchId,
      stageId: prepared.dispatch.stageId,
      roleId: prepared.dispatch.roleId,
      idempotencyKey: 'execute-claim',
    });
    bindExecutionPort(service, executeDispatch);

    await expect(service.executeDispatch({
      runId: 'run-claim',
      dispatchId: prepared.dispatch.dispatchId,
      idempotencyKey: 'execute-claim',
    })).resolves.toEqual(expect.objectContaining({
      created: false,
      execution: expect.objectContaining({ status: 'claimed', idempotencyKey: 'execute-claim' }),
    }));
    expect(executeDispatch).not.toHaveBeenCalled();
  });

  it('returns existing active execution for the same dispatch under concurrent claims', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-concurrent-claim', idempotencyKey: 'create-concurrent-claim' });
    await service.start({ runId: 'run-concurrent-claim', idempotencyKey: 'start-concurrent-claim' });
    await advanceToDesign(service, 'run-concurrent-claim');
    const prepared = await service.prepareDispatch({
      runId: 'run-concurrent-claim',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-concurrent-claim',
    });
    const runtimeRoot = service.resolveRuntimeRoot('run-concurrent-claim');

    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => service['dispatchExecutionStore'].claim({
      runtimeRoot,
      runId: 'run-concurrent-claim',
      dispatchId: prepared.dispatch.dispatchId,
      stageId: prepared.dispatch.stageId,
      roleId: prepared.dispatch.roleId,
      idempotencyKey: `execute-concurrent-claim-${index}`,
    })));
    const executions = await service['dispatchExecutionStore'].read(runtimeRoot);

    expect(executions).toHaveLength(1);
    expect(claims.filter((claim) => claim.created)).toHaveLength(1);
    expect(new Set(claims.map((claim) => claim.execution.executionRecordId)).size).toBe(1);
  });

  it('allows a new claim for the same dispatch after failed or stale execution records', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-reclaim', idempotencyKey: 'create-reclaim' });
    await service.start({ runId: 'run-reclaim', idempotencyKey: 'start-reclaim' });
    await advanceToDesign(service, 'run-reclaim');
    const prepared = await service.prepareDispatch({
      runId: 'run-reclaim',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-reclaim',
    });
    const runtimeRoot = service.resolveRuntimeRoot('run-reclaim');

    const failedClaim = await service['dispatchExecutionStore'].claim({
      runtimeRoot,
      runId: 'run-reclaim',
      dispatchId: prepared.dispatch.dispatchId,
      stageId: prepared.dispatch.stageId,
      roleId: prepared.dispatch.roleId,
      idempotencyKey: 'execute-reclaim-failed',
    });
    await service['dispatchExecutionStore'].markFailed({
      runtimeRoot,
      executionRecordId: failedClaim.execution.executionRecordId,
      reason: 'spawn failed',
    });
    const staleCandidate = await service['dispatchExecutionStore'].claim({
      runtimeRoot,
      runId: 'run-reclaim',
      dispatchId: prepared.dispatch.dispatchId,
      stageId: prepared.dispatch.stageId,
      roleId: prepared.dispatch.roleId,
      idempotencyKey: 'execute-reclaim-stale-candidate',
    });
    await service['dispatchExecutionStore'].markStale({
      runtimeRoot,
      executionRecordId: staleCandidate.execution.executionRecordId,
      reason: 'timed out',
    });
    const finalClaim = await service['dispatchExecutionStore'].claim({
      runtimeRoot,
      runId: 'run-reclaim',
      dispatchId: prepared.dispatch.dispatchId,
      stageId: prepared.dispatch.stageId,
      roleId: prepared.dispatch.roleId,
      idempotencyKey: 'execute-reclaim-final',
    });

    expect(finalClaim.created).toBe(true);
    await expect(service['dispatchExecutionStore'].read(runtimeRoot)).resolves.toEqual([
      expect.objectContaining({ status: 'failed', idempotencyKey: 'execute-reclaim-failed' }),
      expect.objectContaining({ status: 'stale', idempotencyKey: 'execute-reclaim-stale-candidate' }),
      expect.objectContaining({ status: 'claimed', idempotencyKey: 'execute-reclaim-final' }),
    ]);
  });

  it('rejects mismatched execution port dispatch and role identities', async () => {
    const executeDispatch = vi.fn().mockResolvedValue({
      executionId: 'openclaw-session-mismatch',
      childSessionKey: 'agent:matchaclaw-team:run-mismatch:operator-designer:subagent:child-1',
      spawnMode: 'run',
      status: 'queued',
      roleId: 'kernel-coder',
      dispatchId: 'wrong-dispatch',
    });
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-mismatch', idempotencyKey: 'create-mismatch' });
    await service.start({ runId: 'run-mismatch', idempotencyKey: 'start-mismatch' });
    await advanceToDesign(service, 'run-mismatch');
    const prepared = await service.prepareDispatch({
      runId: 'run-mismatch',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-mismatch',
    });
    bindExecutionPort(service, executeDispatch);

    await expect(service.executeDispatch({
      runId: 'run-mismatch',
      dispatchId: prepared.dispatch.dispatchId,
      idempotencyKey: 'execute-mismatch',
    })).rejects.toThrow(`Team dispatch execution returned dispatchId wrong-dispatch, expected ${prepared.dispatch.dispatchId}`);
    await expect(service.snapshot({ runId: 'run-mismatch', eventCursor: 0, eventLimit: 30 })).resolves.toEqual(expect.objectContaining({
      dispatchExecutions: [expect.objectContaining({ status: 'failed' })],
      events: expect.arrayContaining([expect.objectContaining({ type: 'dispatch:execution_failed' })]),
    }));
  });

  it('marks the TeamRun completed when the last gated role stage passes', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });
    const runId = 'run-final-gated';
    await service.create({ packagePath: fixturePath, runId, idempotencyKey: 'create-final-gated' });
    await service.start({ runId, idempotencyKey: 'start-final-gated' });
    await advanceToDesign(service, runId);

    for (const stageId of [
      'step-1-design-operator-blueprint',
      'step-2-code-kernel-implementation',
      'step-3-adversarial-review-defect-hunting',
      'step-4-precision-validation-accuracy-verification',
      'step-5-performance-optimization-bottleneck-elimination',
    ]) {
      const roleId = roleIdForStage(stageId);
      const artifact = passContentForStage(stageId);
      await service.submitArtifact({
        runId,
        stageId,
        roleId,
        ...artifact,
        idempotencyKey: `artifact-final-gated-${stageId}`,
        workspaceDir: roleWorkspace(storageRoot, runId, roleId),
      });
    }

    await expect(service.snapshot({ runId, eventCursor: 0, eventLimit: 80 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'completed', currentStageId: 'step-6-final-emit-operator-dev-optimize-report' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-5-performance-optimization-bottleneck-elimination', status: 'passed' }),
        expect.objectContaining({ stageId: 'step-6-final-emit-operator-dev-optimize-report', status: 'passed' }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'run:completed', payload: expect.objectContaining({ stageId: 'step-6-final-emit-operator-dev-optimize-report' }) }),
      ]),
    }));
  });

  it('rejects public completion of role stages so artifacts and gates cannot be bypassed', async () => {
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-role-complete-reject', idempotencyKey: 'create-role-complete-reject' });
    await service.start({ runId: 'run-role-complete-reject', idempotencyKey: 'start-role-complete-reject' });
    await advanceToDesign(service, 'run-role-complete-reject');

    await expect(service.completeStage({
      runId: 'run-role-complete-reject',
      stageId: 'step-1-design-operator-blueprint',
      idempotencyKey: 'complete-role-bypass',
    })).rejects.toThrow('Role stage must be completed by artifact submission and gate evaluation: step-1-design-operator-blueprint');
    await expect(service.snapshot({ runId: 'run-role-complete-reject', eventCursor: 0, eventLimit: 20 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'running', currentStageId: 'step-1-design-operator-blueprint' }),
      stages: expect.arrayContaining([
        expect.objectContaining({ stageId: 'step-1-design-operator-blueprint', status: 'running' }),
      ]),
      gates: [],
      artifacts: [],
    }));
  });

  it('executes prepared dispatches through the injected role execution port and records events idempotently', async () => {
    const executeDispatch = vi.fn(async (input) => ({
      executionId: 'openclaw-session-1',
      childSessionKey: 'agent:matchaclaw-team:run-exec:operator-designer:subagent:child-1',
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));
    const service = new TeamRunService({
      storageRoot,
      clock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
    });

    await service.create({ packagePath: fixturePath, runId: 'run-exec', idempotencyKey: 'create-exec' });
    await service.start({ runId: 'run-exec', idempotencyKey: 'start-exec' });
    await advanceToDesign(service, 'run-exec');
    const prepared = await service.prepareDispatch({
      runId: 'run-exec',
      stageId: 'step-1-design-operator-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'dispatch-exec',
    });
    bindExecutionPort(service, executeDispatch);
    executeDispatch.mockImplementation(async (input) => ({
      executionId: 'openclaw-session-1',
      childSessionKey: 'agent:matchaclaw-team:run-exec:operator-designer:subagent:child-1',
      spawnMode: 'run',
      status: 'queued',
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    }));

    await expect(service.executeDispatch({
      runId: 'run-exec',
      dispatchId: prepared.dispatch.dispatchId,
      idempotencyKey: 'execute-exec',
    })).resolves.toEqual({
      created: true,
      execution: expect.objectContaining({
        runId: 'run-exec',
        dispatchId: prepared.dispatch.dispatchId,
        stageId: 'step-1-design-operator-blueprint',
        roleId: 'operator-designer',
        executionId: 'openclaw-session-1',
        childSessionKey: 'agent:matchaclaw-team:run-exec:operator-designer:subagent:child-1',
        spawnMode: 'run',
        status: 'queued',
        idempotencyKey: 'execute-exec',
      }),
    });
    await expect(service.executeDispatch({
      runId: 'run-exec',
      dispatchId: prepared.dispatch.dispatchId,
      idempotencyKey: 'execute-exec',
    })).resolves.toEqual(expect.objectContaining({ created: false }));
    expect(executeDispatch).toHaveBeenCalledTimes(1);
    expect(executeDispatch).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-exec',
      dispatch: expect.objectContaining({ dispatchId: prepared.dispatch.dispatchId }),
      role: expect.objectContaining({ roleId: 'operator-designer' }),
      prompt: expect.stringContaining('Role: operator-designer'),
    }));

    await expect(service.snapshot({ runId: 'run-exec', eventCursor: 0, eventLimit: 30 })).resolves.toEqual(expect.objectContaining({
      dispatchExecutions: [expect.objectContaining({
        executionId: 'openclaw-session-1',
        childSessionKey: 'agent:matchaclaw-team:run-exec:operator-designer:subagent:child-1',
        spawnMode: 'run',
      })],
      events: expect.arrayContaining([
        expect.objectContaining({
          type: 'dispatch:execution_queued',
          payload: expect.objectContaining({
            dispatchId: prepared.dispatch.dispatchId,
            executionId: 'openclaw-session-1',
            childSessionKey: 'agent:matchaclaw-team:run-exec:operator-designer:subagent:child-1',
            spawnMode: 'run',
            roleId: 'operator-designer',
          }),
        }),
      ]),
    }));
  });
});
