import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamRunService, type TeamRunContextPort } from '../../packages/openclaw-team-runtime-plugin/src/application/team-run-service';
import { TeamSkillPackageService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-skill-package-service';
import { buildTeamManagedAgentId } from '../../packages/openclaw-team-runtime-plugin/src/domain/team-role';
import {
  TEAM_DISPATCH_PROCESS_GATEWAY_METHOD,
  TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD,
} from '../../packages/openclaw-team-runtime-plugin/src/gateway/schemas';
import { OpenClawRoleSessionExecution } from '../../packages/openclaw-team-runtime-plugin/src/infrastructure/openclaw-role-session-execution';
import type { TeamGatewayRequestPort } from '../../packages/openclaw-team-runtime-plugin/src/gateway/team-gateway-methods';
import type { RoleSessionExecutionPort } from '../../packages/openclaw-team-runtime-plugin/src/ports/role-session-execution-port';
import type { TaskFlowProjectionPort } from '../../packages/openclaw-team-runtime-plugin/src/ports/task-flow-projection-port';

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0');

const clock = { nowMs: () => 1 };
let nextId = 0;
const idGenerator = { randomId: () => `id-${nextId += 1}` };
const dependencyChecker = {
  async check() {
    return { missingRequiredSkills: [], missingOptionalSkills: [], missingRequiredTools: [], missingOptionalTools: [] };
  },
};

function roleWorkspace(storageRoot: string, runId: string, roleId: string): string {
  return path.join(storageRoot, 'runs', runId, 'roles', roleId);
}

function leaderWorkspace(storageRoot: string, runId: string): string {
  return path.join(storageRoot, 'runs', runId, 'leader');
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    return (await stat(directoryPath)).isDirectory();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function workflowTasks(): Record<string, unknown>[] {
  return [
    {
      taskId: 'design-blueprint',
      roleId: 'operator-designer',
      title: 'Design operator blueprint',
      prompt: 'Produce the operator design blueprint.',
      dependsOnTaskIds: [],
      outputArtifactKind: 'design_report',
    },
    {
      taskId: 'code-kernel',
      roleId: 'kernel-coder',
      title: 'Implement kernel',
      prompt: 'Implement the kernel from the design blueprint.',
      dependsOnTaskIds: ['design-blueprint'],
      outputArtifactKind: 'compile_report',
    },
  ];
}

function workflowGroups(): Record<string, unknown>[] {
  return [
    {
      groupId: 'round-1',
      title: 'Design round',
      taskIds: ['design-blueprint'],
      join: { requireCompleted: true, allowFailed: false, retryLimit: 0 },
    },
    {
      groupId: 'round-2',
      title: 'Implementation round',
      taskIds: ['code-kernel'],
      join: { requireCompleted: true, allowFailed: false, retryLimit: 0 },
    },
  ];
}

function parallelWorkflowTasks(): Record<string, unknown>[] {
  return [
    {
      taskId: 'parallel-design',
      roleId: 'operator-designer',
      title: 'Design operator blueprint',
      prompt: 'Produce the operator design blueprint.',
      dependsOnTaskIds: [],
      outputArtifactKind: 'design_report',
    },
    {
      taskId: 'parallel-code',
      roleId: 'kernel-coder',
      title: 'Implement kernel',
      prompt: 'Implement the kernel from the design blueprint.',
      dependsOnTaskIds: [],
      outputArtifactKind: 'compile_report',
    },
  ];
}

function parallelWorkflowGroups(): Record<string, unknown>[] {
  return [
    {
      groupId: 'parallel-round-1',
      title: 'Parallel design round',
      taskIds: ['parallel-design'],
      join: { requireCompleted: true, allowFailed: false, retryLimit: 0 },
    },
    {
      groupId: 'parallel-round-2',
      title: 'Parallel implementation round',
      taskIds: ['parallel-code'],
      join: { requireCompleted: true, allowFailed: false, retryLimit: 0 },
    },
  ];
}

function singleTaskWorkflowTasks(taskId = 'retry-task', roleId = 'operator-designer'): Record<string, unknown>[] {
  return [
    {
      taskId,
      roleId,
      title: 'Single workflow task',
      prompt: `Execute ${taskId}.`,
      dependsOnTaskIds: [],
      outputArtifactKind: 'design_report',
    },
  ];
}

function singleTaskWorkflowGroups(taskId = 'retry-task', retryLimit = 0): Record<string, unknown>[] {
  return [
    {
      groupId: `${taskId}-group`,
      title: 'Single workflow group',
      taskIds: [taskId],
      join: { requireCompleted: true, allowFailed: false, retryLimit },
    },
  ];
}

function createExecuteLeader(runId: string) {
  return vi.fn(async (input) => ({
    executionId: `openclaw-session-${runId}-leader`,
    childSessionKey: `agent:${buildTeamManagedAgentId(runId, 'leader')}:main`,
    spawnMode: 'run' as const,
    status: 'queued' as const,
    roleId: input.dispatch.roleId,
    dispatchId: input.dispatch.dispatchId,
  }));
}

function createRoleSessionExecution(runId: string) {
  return {
    executeLeader: createExecuteLeader(runId),
    executeRole: vi.fn(),
    sendMessage: vi.fn(),
    cancelRunSessions: vi.fn().mockResolvedValue(undefined),
  };
}

function createRoleDispatchSessionExecution(runId: string) {
  return {
    ...createRoleSessionExecution(runId),
    executeRole: vi.fn(async (input) => ({
      executionId: `openclaw-session-${runId}-${input.taskId}`,
      childSessionKey: childSessionKey(runId, input.role.roleId, input.taskId),
      spawnMode: 'run' as const,
      status: 'queued' as const,
      roleId: input.dispatch.roleId,
      dispatchId: input.dispatch.dispatchId,
    })),
  };
}

function createService(
  storageRoot: string,
  roleSessionExecution: RoleSessionExecutionPort = createRoleSessionExecution('run'),
  disableAutoDispatch = true,
  taskFlowProjection?: TaskFlowProjectionPort,
  runContext?: TeamRunContextPort,
  teamGatewayRequest?: TeamGatewayRequestPort,
): TeamRunService {
  return new TeamRunService({
    storageRoot,
    clock,
    idGenerator,
    packageService: new TeamSkillPackageService(),
    dependencyChecker,
    roleSessionExecution,
    disableAutoDispatch,
    ...(taskFlowProjection ? { taskFlowProjection } : {}),
    ...(runContext ? { runContext } : {}),
    ...(teamGatewayRequest ? { teamGatewayRequest } : {}),
  });
}

function createOpenClawBackedService(storageRoot: string, deleteSession = vi.fn().mockResolvedValue(undefined), options?: { disableAutoDispatch?: boolean }): { service: TeamRunService; deleteSession: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async (input: { sessionKey: string }) => ({
    runId: `openclaw-session-${input.sessionKey}`,
  }));
  const service = new TeamRunService({
    storageRoot,
    clock,
    idGenerator,
    packageService: new TeamSkillPackageService(),
    dependencyChecker,
    roleSessionExecution: new OpenClawRoleSessionExecution({ run, deleteSession }),
    disableAutoDispatch: options?.disableAutoDispatch,
  });
  return { service, deleteSession };
}

async function createStartedRun(service: TeamRunService, runId: string): Promise<void> {
  await service.create({ packagePath: fixturePath, runId, idempotencyKey: `create-${runId}` });
  await service.start({ runId, idempotencyKey: `start-${runId}` });
}

async function planWorkflow(
  service: TeamRunService,
  storageRoot: string,
  runId: string,
  options?: {
    groups?: Record<string, unknown>[];
    tasks?: Record<string, unknown>[];
    title?: string;
    summary?: string;
    idempotencyKey?: string;
  },
) {
  return await service.planWorkflow({
    runId,
    title: options?.title ?? 'Operator workflow',
    summary: options?.summary ?? 'Leader-planned workflow',
    groups: options?.groups ?? workflowGroups(),
    tasks: options?.tasks ?? workflowTasks(),
    idempotencyKey: options?.idempotencyKey ?? `plan-${runId}`,
    workspaceDir: leaderWorkspace(storageRoot, runId),
  });
}

async function roleAgentId(service: TeamRunService, runId: string, roleId: string): Promise<string> {
  const snapshot = await service.snapshot({ runId, eventCursor: 0, eventLimit: 0 });
  const role = snapshot.roles.find((binding) => binding.roleId === roleId);
  if (!role) {
    throw new Error(`Test role not found: ${roleId}`);
  }
  return role.agentId;
}

function childSessionKey(runId: string, roleId: string, taskId: string): string {
  return `agent:${buildTeamManagedAgentId(runId, roleId)}:task:${taskId}`;
}

async function completeDefaultWorkflowTasks(service: TeamRunService, storageRoot: string, runId: string): Promise<void> {
  await service.submitArtifact({
    runId,
    stageId: 'design-blueprint',
    roleId: 'operator-designer',
    kind: 'design_report',
    title: 'Operator blueprint',
    content: 'Design complete.',
    idempotencyKey: `artifact-${runId}-design`,
    workspaceDir: roleWorkspace(storageRoot, runId, 'operator-designer'),
    callerAgentId: await roleAgentId(service, runId, 'operator-designer'),
    childSessionKey: childSessionKey(runId, 'operator-designer', 'design-blueprint'),
  });
  await service.submitArtifact({
    runId,
    stageId: 'code-kernel',
    roleId: 'kernel-coder',
    kind: 'compile_report',
    title: 'Kernel implementation',
    content: 'Implementation complete.',
    idempotencyKey: `artifact-${runId}-code`,
    workspaceDir: roleWorkspace(storageRoot, runId, 'kernel-coder'),
    callerAgentId: await roleAgentId(service, runId, 'kernel-coder'),
    childSessionKey: childSessionKey(runId, 'kernel-coder', 'code-kernel'),
  });
}

describe('TeamRunService native workflow execution', () => {
  let storageRoot = '';

  beforeEach(async () => {
    nextId = 0;
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'team-runtime-dispatch-execution-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('starts TeamRuns by queueing only the managed leader execution', async () => {
    const roleSessionExecution = createRoleSessionExecution('run-start-leader');
    const service = createService(storageRoot, roleSessionExecution);

    await service.create({ packagePath: fixturePath, runId: 'run-start-leader', idempotencyKey: 'create-start-leader' });

    await expect(service.start({ runId: 'run-start-leader', idempotencyKey: 'start-leader' })).resolves.toEqual(expect.objectContaining({
      runId: 'run-start-leader',
      status: 'running',
    }));
    const leaderExecutionInput = roleSessionExecution.executeLeader.mock.calls[0]?.[0];
    expect(leaderExecutionInput).toEqual(expect.objectContaining({
      runId: 'run-start-leader',
      dispatch: expect.objectContaining({ stageId: 'leader', roleId: 'leader' }),
      role: expect.objectContaining({ roleId: 'leader' }),
      prompt: expect.stringContaining('<team_workflow_orchestration>'),
    }));
    expect(leaderExecutionInput.prompt).toContain('You are the TeamRun leader. Your job is orchestration, not role execution.');
    expect(leaderExecutionInput.prompt).toContain('Core contract:');
    expect(leaderExecutionInput.prompt).toContain('- team_plan_workflow describes only work assigned to concrete Team roles from the roster.');
    expect(leaderExecutionInput.prompt).toContain('Execution pattern:');
    expect(leaderExecutionInput.prompt).toContain('If workflow.md contains leader-only context extraction, perform that extraction yourself before calling team_plan_workflow.');
    expect(leaderExecutionInput.prompt).toContain('Role id rules:');
    expect(leaderExecutionInput.prompt).toContain('Invalid tasks[].roleId values include "leader", managed OpenClaw agent ids, display names, and ad-hoc aliases.');
    expect(leaderExecutionInput.prompt).toContain('Correct example:');
    expect(leaderExecutionInput.prompt).toContain('"roleId": "financial-analyst"');
    expect(leaderExecutionInput.prompt).toContain('Incorrect example:');
    expect(leaderExecutionInput.prompt).toContain('"roleId": "leader"');
    expect(leaderExecutionInput.prompt).toContain('This is invalid because "leader" is not a dispatchable Team role and leader tasks cannot complete via team_submit_artifact.');
    expect(leaderExecutionInput.prompt).toContain('Tool boundary:');
    expect(leaderExecutionInput.prompt).toContain('Your first orchestration action must be a successful team_plan_workflow call once you finish any leader-only context extraction.');
    expect(leaderExecutionInput.prompt).toContain('Until team_plan_workflow returns success, do not claim that roles were dispatched, do not say work is running in parallel, and do not say you are waiting for role outputs.');
    expect(leaderExecutionInput.prompt).toContain('team_send_message is reserved for real role child sessions and mailbox/audit traffic, not leader follow-up dispatch.');
    expect(leaderExecutionInput.prompt).toContain('As leader, do not call team_send_message, team_submit_artifact, team_update_task, or team_request_approval.');
    expect(leaderExecutionInput.prompt).toContain('</team_workflow_orchestration>');
    await expect(service.snapshot({ runId: 'run-start-leader', eventCursor: 0, eventLimit: 20 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'running' }),
      stages: [],
      dispatches: [expect.objectContaining({ stageId: 'leader', roleId: 'leader' })],
      dispatchTasks: [],
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'run:started' }),
        expect.objectContaining({ type: 'leader:execution_queued' }),
      ]),
    }));
  });

  it('requires the leader workspace to submit a structured workflow plan', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-plan-auth'));
    await createStartedRun(service, 'run-plan-auth');

    await expect(service.planWorkflow({
      runId: 'run-plan-auth',
      title: 'Operator workflow',
      groups: workflowGroups(),
      tasks: workflowTasks(),
      idempotencyKey: 'plan-missing-workspace',
    })).rejects.toThrow('Tool caller workspace is required for Team leader');

    await expect(planWorkflow(service, storageRoot, 'run-plan-auth')).resolves.toEqual(expect.objectContaining({
      created: true,
      plan: expect.objectContaining({
        title: 'Operator workflow',
        groups: expect.arrayContaining([expect.objectContaining({ groupId: 'round-1' })]),
        tasks: expect.arrayContaining([expect.objectContaining({ taskId: 'design-blueprint', roleId: 'operator-designer' })]),
      }),
    }));
    await expect(planWorkflow(service, storageRoot, 'run-plan-auth')).resolves.toEqual(expect.objectContaining({ created: false }));
  });

  it('injects assigned task identity into auto-dispatched role prompts', async () => {
    const roleSessionExecution = createRoleDispatchSessionExecution('run-role-prompt');
    const gatewayRequest = { request: vi.fn(async (method: string, params: { runId: string }) => {
      if (method === TEAM_DISPATCH_PROCESS_GATEWAY_METHOD) {
        await service.processDispatchQueue(params);
        return;
      }
      if (method === TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD) {
        await service.processLeaderSynthesis(params);
        return;
      }
      throw new Error(`Unexpected gateway method: ${method}`);
    }) };
    const service = createService(storageRoot, roleSessionExecution, false, undefined, undefined, gatewayRequest);
    await createStartedRun(service, 'run-role-prompt');

    await planWorkflow(service, storageRoot, 'run-role-prompt');
    await expect.poll(() => roleSessionExecution.executeRole.mock.calls.length).toBeGreaterThan(0);
    expect(gatewayRequest.request).toHaveBeenCalledWith(TEAM_DISPATCH_PROCESS_GATEWAY_METHOD, { runId: 'run-role-prompt' });
    await service.cancel({ runId: 'run-role-prompt', reason: 'test cleanup', idempotencyKey: 'cancel-role-prompt' });

    const roleExecutionInput = roleSessionExecution.executeRole.mock.calls[0]?.[0];
    expect(roleExecutionInput).toEqual(expect.objectContaining({
      runId: 'run-role-prompt',
      taskId: 'design-blueprint',
      role: expect.objectContaining({ roleId: 'operator-designer' }),
      prompt: expect.stringContaining('# Team Workflow Task: design-blueprint'),
    }));
    expect(roleExecutionInput.prompt).toContain('<team_task_execution>');
    expect(roleExecutionInput.prompt).toContain('You are executing one assigned TeamRun workflow task as a role agent.');
    expect(roleExecutionInput.prompt).toContain('Assigned identity:');
    expect(roleExecutionInput.prompt).toContain('- runId: run-role-prompt');
    expect(roleExecutionInput.prompt).toContain('- stageId: design-blueprint');
    expect(roleExecutionInput.prompt).toContain('- roleId: operator-designer');
    expect(roleExecutionInput.prompt).toContain('Core contract:');
    expect(roleExecutionInput.prompt).toContain('- Use the exact runId, stageId, and roleId above for every Team Runtime tool call.');
    expect(roleExecutionInput.prompt).toContain('- Submit progress with team_update_task only while this task is still queued.');
    expect(roleExecutionInput.prompt).toContain('- Submit completion exactly once with team_submit_artifact using runId, stageId, roleId, and an idempotencyKey.');
    expect(roleExecutionInput.prompt).toContain('Execution pattern:');
    expect(roleExecutionInput.prompt).toContain('Correct example:');
    expect(roleExecutionInput.prompt).toContain('Incorrect example:');
    expect(roleExecutionInput.prompt).toContain('This is invalid because stageId must be the assigned task id, roleId must be your assigned role, and completion must use team_submit_artifact.');
    expect(roleExecutionInput.prompt).toContain('</team_task_execution>');
  });

  it('validates workflow plan roles, groups, tasks, and dependency references', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-plan-guards'));
    await createStartedRun(service, 'run-plan-guards');
    const workspaceDir = leaderWorkspace(storageRoot, 'run-plan-guards');

    await expect(service.planWorkflow({
      runId: 'run-plan-guards',
      title: 'Invalid role plan',
      groups: [{ ...workflowGroups()[0], taskIds: ['unknown-role-task'] }],
      tasks: [{ ...workflowTasks()[0], taskId: 'unknown-role-task', roleId: 'missing-role' }],
      idempotencyKey: 'plan-invalid-role',
      workspaceDir,
    })).rejects.toThrow('Team workflow task references unknown role: missing-role');

    await expect(service.planWorkflow({
      runId: 'run-plan-guards',
      title: 'Unassigned task plan',
      groups: workflowGroups().slice(0, 1),
      tasks: workflowTasks(),
      idempotencyKey: 'plan-unassigned-task',
      workspaceDir,
    })).rejects.toThrow('Team workflow task is not assigned to a group: code-kernel');

    await expect(service.planWorkflow({
      runId: 'run-plan-guards',
      title: 'Missing dependency plan',
      groups: [{ ...workflowGroups()[0], taskIds: ['design-blueprint'] }],
      tasks: [{ ...workflowTasks()[0], dependsOnTaskIds: ['missing-task'] }],
      idempotencyKey: 'plan-missing-dependency',
      workspaceDir,
    })).rejects.toThrow('Team workflow task dependency not found: missing-task');
  });

  it('limits initial task release by maxParallelTeammates without counting the leader execution', async () => {
    const roleSessionExecution = createRoleDispatchSessionExecution('run-max-parallel');
    const gatewayRequest = { request: vi.fn(async (method: string, params: { runId: string }) => {
      if (method === TEAM_DISPATCH_PROCESS_GATEWAY_METHOD) {
        await service.processDispatchQueue(params);
        return;
      }
      if (method === TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD) {
        await service.processLeaderSynthesis(params);
        return;
      }
      throw new Error(`Unexpected gateway method: ${method}`);
    }) };
    const service = createService(storageRoot, roleSessionExecution, false, undefined, undefined, gatewayRequest);
    await createStartedRun(service, 'run-max-parallel');

    await planWorkflow(service, storageRoot, 'run-max-parallel', {
      groups: parallelWorkflowGroups(),
      tasks: parallelWorkflowTasks(),
    });
    await expect.poll(() => roleSessionExecution.executeRole.mock.calls.length).toBe(1);

    const snapshot = await service.snapshot({ runId: 'run-max-parallel', eventCursor: 0, eventLimit: 40 });
    expect(snapshot.dispatchTasks).toHaveLength(1);
    expect(snapshot.dispatchTasks[0]).toEqual(expect.objectContaining({
      taskId: 'parallel-design',
      status: 'queued',
      roleId: 'operator-designer',
    }));
    expect(snapshot.dispatchExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'leader', roleId: 'leader', status: 'queued' }),
      expect.objectContaining({ stageId: 'parallel-design', roleId: 'operator-designer', status: 'queued' }),
    ]));
    expect(snapshot.dispatchExecutions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ stageId: 'parallel-code' }),
    ]));
    expect(roleSessionExecution.executeRole.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      taskId: 'parallel-design',
      role: expect.objectContaining({ roleId: 'operator-designer' }),
    }));

    await service.cancel({ runId: 'run-max-parallel', reason: 'test cleanup', idempotencyKey: 'cancel-max-parallel' });
  });

  it('lazy-activates a workflow task from a native child session for task updates', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-lazy-update'), true);
    await createStartedRun(service, 'run-lazy-update');
    await planWorkflow(service, storageRoot, 'run-lazy-update');
    const designChildSessionKey = childSessionKey('run-lazy-update', 'operator-designer', 'design-blueprint');

    await expect(service.updateTask({
      runId: 'run-lazy-update',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Started from native child session.',
      idempotencyKey: 'task-lazy-activate',
      workspaceDir: roleWorkspace(storageRoot, 'run-lazy-update', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-lazy-update', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    })).resolves.toEqual(expect.objectContaining({ stageId: 'design-blueprint', roleId: 'operator-designer', status: 'in_progress' }));

    await expect(service.snapshot({ runId: 'run-lazy-update', eventCursor: 0, eventLimit: 60 })).resolves.toEqual(expect.objectContaining({
      dispatchGroups: [expect.objectContaining({ groupId: 'round-1', status: 'queued' })],
      dispatchTasks: [expect.objectContaining({ taskId: 'design-blueprint', status: 'queued', roleId: 'operator-designer' })],
      dispatchExecutions: expect.arrayContaining([
        expect.objectContaining({ stageId: 'design-blueprint', roleId: 'operator-designer', status: 'queued', childSessionKey: designChildSessionKey }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch:group_queued' }),
        expect.objectContaining({ type: 'dispatch:task_queued' }),
        expect.objectContaining({ type: 'dispatch:execution_queued' }),
      ]),
    }));
  });

  it('records task flow projection events for role task updates', async () => {
    const projectTaskUpdate = vi.fn().mockResolvedValue(undefined);
    const service = createService(
      storageRoot,
      createRoleSessionExecution('run-task-update-projection'),
      true,
      { projectTeamRun: vi.fn(), projectTaskUpdate },
    );
    await createStartedRun(service, 'run-task-update-projection');
    await planWorkflow(service, storageRoot, 'run-task-update-projection');
    const designChildSessionKey = childSessionKey('run-task-update-projection', 'operator-designer', 'design-blueprint');

    await expect(service.updateTask({
      runId: 'run-task-update-projection',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Started design projection.',
      idempotencyKey: 'task-update-projection',
      workspaceDir: roleWorkspace(storageRoot, 'run-task-update-projection', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-task-update-projection', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    })).resolves.toEqual(expect.objectContaining({ stageId: 'design-blueprint' }));

    expect(projectTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Started design projection.',
    }));
    await expect(service.snapshot({ runId: 'run-task-update-projection', eventCursor: 0, eventLimit: 80 })).resolves.toEqual(expect.objectContaining({
      events: expect.arrayContaining([
        expect.objectContaining({
          type: 'projection:taskFlow:task_update_queued',
          payload: { stageId: 'design-blueprint', roleId: 'operator-designer', status: 'in_progress' },
        }),
      ]),
    }));
  });

  it('lazy-activates and completes workflow tasks from native child session artifacts', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-lazy-artifact'), true);
    await createStartedRun(service, 'run-lazy-artifact');
    await planWorkflow(service, storageRoot, 'run-lazy-artifact');
    const designChildSessionKey = childSessionKey('run-lazy-artifact', 'operator-designer', 'design-blueprint');

    const submitted = await service.submitArtifact({
      runId: 'run-lazy-artifact',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: 'Design complete from native child session.',
      idempotencyKey: 'artifact-lazy-activate',
      workspaceDir: roleWorkspace(storageRoot, 'run-lazy-artifact', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-lazy-artifact', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    });

    expect(submitted).toEqual(expect.objectContaining({
      artifact: expect.objectContaining({ stageId: 'design-blueprint', roleId: 'operator-designer' }),
      created: true,
    }));
    await expect(service.snapshot({ runId: 'run-lazy-artifact', eventCursor: 0, eventLimit: 80 })).resolves.toEqual(expect.objectContaining({
      dispatchGroups: [expect.objectContaining({ groupId: 'round-1', status: 'completed' })],
      dispatchTasks: [expect.objectContaining({ taskId: 'design-blueprint', status: 'completed', artifactId: submitted.artifact.artifactId })],
      dispatchExecutions: expect.arrayContaining([
        expect.objectContaining({ stageId: 'design-blueprint', status: 'completed', childSessionKey: designChildSessionKey }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'artifact:submitted' }),
        expect.objectContaining({ type: 'dispatch:execution_completed' }),
        expect.objectContaining({ type: 'dispatch:task_completed' }),
        expect.objectContaining({ type: 'dispatch:group_completed' }),
      ]),
    }));

    await expect(service.updateTask({
      runId: 'run-lazy-artifact',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Tried to update after artifact submission.',
      idempotencyKey: 'task-update-after-completion',
      workspaceDir: roleWorkspace(storageRoot, 'run-lazy-artifact', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-lazy-artifact', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    })).rejects.toThrow('Team workflow task is completed and cannot accept progress updates: design-blueprint');

    const codeChildSessionKey = childSessionKey('run-lazy-artifact', 'kernel-coder', 'code-kernel');
    await expect(service.updateTask({
      runId: 'run-lazy-artifact',
      stageId: 'code-kernel',
      roleId: 'kernel-coder',
      status: 'in_progress',
      summary: 'Started implementation after design completion.',
      idempotencyKey: 'task-code-lazy-activate',
      workspaceDir: roleWorkspace(storageRoot, 'run-lazy-artifact', 'kernel-coder'),
      callerAgentId: await roleAgentId(service, 'run-lazy-artifact', 'kernel-coder'),
      childSessionKey: codeChildSessionKey,
    })).resolves.toEqual(expect.objectContaining({ stageId: 'code-kernel', roleId: 'kernel-coder' }));
  });

  it('resolves approval requests against native child session workflow tasks', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-lazy-approval'), true);
    await createStartedRun(service, 'run-lazy-approval');
    await planWorkflow(service, storageRoot, 'run-lazy-approval');
    const designChildSessionKey = childSessionKey('run-lazy-approval', 'operator-designer', 'design-blueprint');

    const requested = await service.requestApproval({
      runId: 'run-lazy-approval',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      reason: 'Need user authorization.',
      requestedAction: 'Run live validation.',
      risk: 'May consume quota.',
      idempotencyKey: 'approval-lazy-activate',
      workspaceDir: roleWorkspace(storageRoot, 'run-lazy-approval', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-lazy-approval', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    });

    expect(requested).toEqual(expect.objectContaining({
      approval: expect.objectContaining({ stageId: 'design-blueprint', roleId: 'operator-designer', status: 'pending' }),
      created: true,
    }));
    await expect(service.resolveApproval({
      runId: 'run-lazy-approval',
      approvalId: requested.approval.approvalId,
      decision: 'deny',
      note: 'Not allowed.',
      idempotencyKey: 'approval-deny',
    })).resolves.toEqual(expect.objectContaining({ approval: expect.objectContaining({ status: 'denied' }) }));
    await expect(service.snapshot({ runId: 'run-lazy-approval', eventCursor: 0, eventLimit: 80 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'failed', currentStageId: 'design-blueprint' }),
      approvals: [expect.objectContaining({ status: 'denied', note: 'Not allowed.' })],
      dispatchTasks: expect.arrayContaining([
        expect.objectContaining({ taskId: 'design-blueprint', status: 'failed', statusReason: 'Approval denied' }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'approval:requested' }),
        expect.objectContaining({ type: 'approval:resolved', payload: expect.objectContaining({ decision: 'deny' }) }),
      ]),
    }));
  });

  it('stops retrying once retryLimit is exhausted and fails the workflow task', async () => {
    const gatewayRequest = { request: vi.fn(async (method: string, params: { runId: string }) => {
      if (method === TEAM_DISPATCH_PROCESS_GATEWAY_METHOD) {
        await service.processDispatchQueue(params);
        return;
      }
      if (method === TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD) {
        await service.processLeaderSynthesis(params);
        return;
      }
      throw new Error(`Unexpected gateway method: ${method}`);
    }) };
    const service = createService(storageRoot, createRoleSessionExecution('run-retry-limit'), true, undefined, undefined, gatewayRequest);
    await createStartedRun(service, 'run-retry-limit');

    const planned = await planWorkflow(service, storageRoot, 'run-retry-limit', {
      groups: singleTaskWorkflowGroups('retry-task', 1),
      tasks: singleTaskWorkflowTasks('retry-task', 'operator-designer'),
    });
    const runtimeRoot = service.resolveRuntimeRoot('run-retry-limit');
    const internals = service as unknown as {
      workflowStore: {
        saveGroup: (input: Record<string, unknown>) => Promise<{ group: { dispatchGroupId: string } }>;
        saveTask: (input: Record<string, unknown>) => Promise<unknown>;
      };
      dispatchQueueStore: {
        read: (runId: string) => Promise<Array<{ taskId?: string; status: string }>>;
      };
      markDispatchTaskFailed: (input: { runtimeRoot: string; dispatchId: string; reason: string }) => Promise<void>;
    };
    const savedGroup = await internals.workflowStore.saveGroup({
      runtimeRoot,
      runId: 'run-retry-limit',
      workflowPlanId: planned.plan.workflowPlanId,
      groupId: 'retry-task-group',
      taskIds: ['retry-task'],
      idempotencyKey: `${planned.plan.workflowPlanId}:group:retry-task-group`,
    });
    await internals.workflowStore.saveTask({
      runtimeRoot,
      runId: 'run-retry-limit',
      workflowPlanId: planned.plan.workflowPlanId,
      dispatchGroupId: savedGroup.group.dispatchGroupId,
      groupId: 'retry-task-group',
      taskId: 'retry-task',
      roleId: 'operator-designer',
      dispatchId: 'dispatch-retry-1',
      idempotencyKey: `${planned.plan.workflowPlanId}:group:retry-task-group:task:retry-task`,
    });

    await internals.markDispatchTaskFailed({ runtimeRoot, dispatchId: 'dispatch-retry-1', reason: 'first dispatch failed' });
    await expect(internals.dispatchQueueStore.read('run-retry-limit')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: 'retry-task', status: 'pending' }),
    ]));
    await internals.markDispatchTaskFailed({ runtimeRoot, dispatchId: 'dispatch-retry-1', reason: 'second dispatch failed' });

    const snapshot = await service.snapshot({ runId: 'run-retry-limit', eventCursor: 0, eventLimit: 80 });

    expect(snapshot.run).toEqual(expect.objectContaining({ status: 'failed', currentStageId: 'leader' }));
    expect(snapshot.workflowPlan).toEqual(expect.objectContaining({ status: 'failed' }));
    expect(snapshot.dispatchTasks).toEqual([
      expect.objectContaining({
        taskId: 'retry-task',
        status: 'failed',
        roleId: 'operator-designer',
        attemptCount: 2,
        statusReason: 'second dispatch failed',
      }),
    ]);
    expect(snapshot.dispatchGroups).toEqual([
      expect.objectContaining({ groupId: 'retry-task-group', status: 'failed' }),
    ]);
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'dispatch:task_retry_scheduled',
        payload: expect.objectContaining({ taskId: 'retry-task', attemptCount: 2, reason: 'first dispatch failed' }),
      }),
      expect.objectContaining({ type: 'dispatch:group_failed' }),
      expect.objectContaining({ type: 'run:failed' }),
    ]));

    await expect(service.delete({ runId: 'run-retry-limit' })).resolves.toEqual(expect.objectContaining({
      runId: 'run-retry-limit',
      deleted: true,
    }));
  });

  it('does not bootstrap leader synthesis directly from tick after workflow tasks complete', async () => {
    const roleSessionExecution = createRoleSessionExecution('run-tick-synthesis-ready');
    const service = createService(storageRoot, roleSessionExecution, true);

    await createStartedRun(service, 'run-tick-synthesis-ready');
    await planWorkflow(service, storageRoot, 'run-tick-synthesis-ready');
    await completeDefaultWorkflowTasks(service, storageRoot, 'run-tick-synthesis-ready');

    await expect(service.tick({ runId: 'run-tick-synthesis-ready', idempotencyKey: 'tick-synthesis-ready' })).resolves.toEqual(expect.objectContaining({
      action: 'noop',
      status: 'running',
      reason: 'TeamRun is driven by leader workflow tools',
    }));
    expect(roleSessionExecution.executeLeader).toHaveBeenCalledTimes(1);

    await expect(service.snapshot({ runId: 'run-tick-synthesis-ready', eventCursor: 0, eventLimit: 120 })).resolves.toEqual(expect.objectContaining({
      events: expect.not.arrayContaining([
        expect.objectContaining({ type: 'leader:synthesis_queued' }),
        expect.objectContaining({ type: 'leader:synthesis_failed' }),
      ]),
    }));
  })

  it('requests leader synthesis through the handler gateway path when no dispatch work is pending', async () => {
    const gatewayRequest = { request: vi.fn().mockResolvedValue(undefined) } satisfies TeamGatewayRequestPort;
    const service = createService(storageRoot, createRoleSessionExecution('run-synthesis-handler'), true, undefined, undefined, gatewayRequest);
    await createStartedRun(service, 'run-synthesis-handler');
    await planWorkflow(service, storageRoot, 'run-synthesis-handler');
    await completeDefaultWorkflowTasks(service, storageRoot, 'run-synthesis-handler');

    const internals = service as unknown as {
      eventBus: { enqueue(event: { type: 'poll:message'; runId: string; timestamp: number }): void };
    };
    internals.eventBus.enqueue({ type: 'poll:message', runId: 'run-synthesis-handler', timestamp: Date.now() });

    await expect.poll(() => gatewayRequest.request.mock.calls).toEqual(expect.arrayContaining([
      [TEAM_LEADER_SYNTHESIS_PROCESS_GATEWAY_METHOD, { runId: 'run-synthesis-handler' }],
    ]));
  });

  it('records why leader synthesis is skipped before workflow tasks are ready', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-synthesis-skipped'), true);
    await createStartedRun(service, 'run-synthesis-skipped');
    const planned = await planWorkflow(service, storageRoot, 'run-synthesis-skipped');

    await service.processLeaderSynthesis({ runId: 'run-synthesis-skipped' });
    await service.processLeaderSynthesis({ runId: 'run-synthesis-skipped' });

    const snapshot = await service.snapshot({ runId: 'run-synthesis-skipped', eventCursor: 0, eventLimit: 80 });
    const skippedEvents = snapshot.events.filter((event) => event.type === 'leader:synthesis_skipped');
    expect(skippedEvents).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          workflowPlanId: planned.plan.workflowPlanId,
          reason: 'workflow_not_ready',
          readyForSynthesis: false,
          finalStatus: 'running',
        }),
      }),
    ]);
  });

  it('binds leader synthesis lifecycle tracking to the OpenClaw execution run', async () => {
    const setRunContext = vi.fn().mockResolvedValue(true);
    const roleSessionExecution = createRoleSessionExecution('run-synthesis-track');
    const service = createService(storageRoot, roleSessionExecution, true, undefined, { setRunContext });
    await createStartedRun(service, 'run-synthesis-track');
    const planned = await planWorkflow(service, storageRoot, 'run-synthesis-track');
    await completeDefaultWorkflowTasks(service, storageRoot, 'run-synthesis-track');

    await service.processLeaderSynthesis({ runId: 'run-synthesis-track' });

    expect(setRunContext).toHaveBeenCalledWith({
      runId: 'openclaw-session-run-synthesis-track-leader',
      namespace: 'matchaclaw.team-runtime.leader-synthesis',
      value: { teamRunId: 'run-synthesis-track', workflowPlanId: planned.plan.workflowPlanId },
    });
    await expect(service.snapshot({ runId: 'run-synthesis-track', eventCursor: 0, eventLimit: 120 })).resolves.toEqual(expect.objectContaining({
      events: expect.arrayContaining([
        expect.objectContaining({
          type: 'leader:synthesis_queued',
          payload: expect.objectContaining({
            workflowPlanId: planned.plan.workflowPlanId,
            executionId: 'openclaw-session-run-synthesis-track-leader',
          }),
        }),
      ]),
    }));
  });

  it('records leader synthesis tracking failures when runContext binding is unavailable', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-synthesis-tracking-missing'), true);
    await createStartedRun(service, 'run-synthesis-tracking-missing');
    const planned = await planWorkflow(service, storageRoot, 'run-synthesis-tracking-missing');
    await completeDefaultWorkflowTasks(service, storageRoot, 'run-synthesis-tracking-missing');

    await service.processLeaderSynthesis({ runId: 'run-synthesis-tracking-missing' });

    await expect(service.snapshot({ runId: 'run-synthesis-tracking-missing', eventCursor: 0, eventLimit: 120 })).resolves.toEqual(expect.objectContaining({
      events: expect.arrayContaining([
        expect.objectContaining({
          type: 'leader:synthesis_tracking_failed',
          payload: expect.objectContaining({
            workflowPlanId: planned.plan.workflowPlanId,
            executionId: 'openclaw-session-run-synthesis-tracking-missing-leader',
            reason: 'run_context_missing',
          }),
        }),
      ]),
    }));
  });

  it('uses childSessionKey to resolve the queued workflow task when stageId is wrong', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-child-session-stage-correction'), true);
    await createStartedRun(service, 'run-child-session-stage-correction');
    await planWorkflow(service, storageRoot, 'run-child-session-stage-correction');
    const designChildSessionKey = childSessionKey('run-child-session-stage-correction', 'operator-designer', 'design-blueprint');
    await service.updateTask({
      runId: 'run-child-session-stage-correction',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Started design.',
      idempotencyKey: 'task-child-session-stage-correction',
      workspaceDir: roleWorkspace(storageRoot, 'run-child-session-stage-correction', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-child-session-stage-correction', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    });

    const submitted = await service.submitArtifact({
      runId: 'run-child-session-stage-correction',
      stageId: 'design',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: 'Design complete after correcting guessed stageId.',
      idempotencyKey: 'artifact-child-session-stage-correction',
      workspaceDir: roleWorkspace(storageRoot, 'run-child-session-stage-correction', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-child-session-stage-correction', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    });

    expect(submitted).toEqual(expect.objectContaining({
      artifact: expect.objectContaining({ stageId: 'design-blueprint', roleId: 'operator-designer' }),
      created: true,
    }));
  });

  it('rejects role tools without a native role child session', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-invalid-stage-actionable'));
    await createStartedRun(service, 'run-invalid-stage-actionable');
    await planWorkflow(service, storageRoot, 'run-invalid-stage-actionable');
    const operatorDesignerAgentId = await roleAgentId(service, 'run-invalid-stage-actionable', 'operator-designer');

    await expect(service.updateTask({
      runId: 'run-invalid-stage-actionable',
      stageId: 'design',
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Guessed a short stage id.',
      idempotencyKey: 'task-invalid-stage-actionable',
      workspaceDir: roleWorkspace(storageRoot, 'run-invalid-stage-actionable', 'operator-designer'),
      callerAgentId: operatorDesignerAgentId,
    })).rejects.toThrow('Team role lifecycle tools require a native role child session for role: operator-designer');

    await expect(service.updateTask({
      runId: 'run-invalid-stage-actionable',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Leader tried to update role task.',
      idempotencyKey: 'task-leader-main-session',
      workspaceDir: roleWorkspace(storageRoot, 'run-invalid-stage-actionable', 'operator-designer'),
      callerAgentId: operatorDesignerAgentId,
      childSessionKey: `agent:${buildTeamManagedAgentId('run-invalid-stage-actionable', 'leader')}:main`,
    })).rejects.toThrow('Team role lifecycle tools require a native role child session for role: operator-designer');
  });

  it('rejects another role childSessionKey at the role lifecycle tool boundary', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-child-session-cross-role'), true);
    await createStartedRun(service, 'run-child-session-cross-role');
    await planWorkflow(service, storageRoot, 'run-child-session-cross-role');
    const designChildSessionKey = childSessionKey('run-child-session-cross-role', 'operator-designer', 'design-blueprint');
    await service.submitArtifact({
      runId: 'run-child-session-cross-role',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      kind: 'design_report',
      title: 'Operator blueprint',
      content: 'Design complete before activating kernel task.',
      idempotencyKey: 'artifact-cross-role-design',
      workspaceDir: roleWorkspace(storageRoot, 'run-child-session-cross-role', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-child-session-cross-role', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    });
    const codeChildSessionKey = childSessionKey('run-child-session-cross-role', 'kernel-coder', 'code-kernel');
    await service.updateTask({
      runId: 'run-child-session-cross-role',
      stageId: 'code-kernel',
      roleId: 'kernel-coder',
      status: 'in_progress',
      summary: 'Started code task.',
      idempotencyKey: 'task-cross-role-code',
      workspaceDir: roleWorkspace(storageRoot, 'run-child-session-cross-role', 'kernel-coder'),
      callerAgentId: await roleAgentId(service, 'run-child-session-cross-role', 'kernel-coder'),
      childSessionKey: codeChildSessionKey,
    });

    await expect(service.updateTask({
      runId: 'run-child-session-cross-role',
      stageId: 'design',
      roleId: 'operator-designer',
      status: 'blocked',
      summary: 'Tried to use another role child session.',
      idempotencyKey: 'task-cross-role-child-session',
      workspaceDir: roleWorkspace(storageRoot, 'run-child-session-cross-role', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-child-session-cross-role', 'operator-designer'),
      childSessionKey: codeChildSessionKey,
    })).rejects.toThrow('Team role lifecycle tools require a native role child session for role: operator-designer');
  });

  it('deletes created TeamRun runtime storage and reports missing runs as unchanged', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-delete-created'));
    await service.create({ packagePath: fixturePath, runId: 'run-delete-created', idempotencyKey: 'create-delete-created' });
    const runtimeRoot = service.resolveRuntimeRoot('run-delete-created');

    await expect(directoryExists(runtimeRoot)).resolves.toBe(true);
    await expect(service.delete({ runId: 'run-delete-created' })).resolves.toEqual(expect.objectContaining({
      runId: 'run-delete-created',
      deleted: true,
      managedAgentConfig: expect.objectContaining({ runId: 'run-delete-created' }),
    }));
    await expect(directoryExists(runtimeRoot)).resolves.toBe(false);
    await expect(service.delete({ runId: 'run-delete-created' })).resolves.toEqual({
      runId: 'run-delete-created',
      deleted: false,
    });
  });

  it('cancels active native child sessions before deleting TeamRun runtime storage', async () => {
    let runtimeRoot = '';
    const deleteSession = vi.fn(async () => {
      expect(await directoryExists(runtimeRoot)).toBe(true);
    });
    const { service } = createOpenClawBackedService(storageRoot, deleteSession, { disableAutoDispatch: true });
    await createStartedRun(service, 'run-delete-active');
    await planWorkflow(service, storageRoot, 'run-delete-active');
    const designChildSessionKey = childSessionKey('run-delete-active', 'operator-designer', 'design-blueprint');
    await service.updateTask({
      runId: 'run-delete-active',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Started design.',
      idempotencyKey: 'task-delete-active',
      workspaceDir: roleWorkspace(storageRoot, 'run-delete-active', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-delete-active', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    });
    runtimeRoot = service.resolveRuntimeRoot('run-delete-active');

    await expect(service.delete({ runId: 'run-delete-active' })).resolves.toEqual(expect.objectContaining({
      runId: 'run-delete-active',
      deleted: true,
      managedAgentConfig: expect.objectContaining({ runId: 'run-delete-active' }),
    }));
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenCalledWith({ sessionKey: `agent:${buildTeamManagedAgentId('run-delete-active', 'leader')}:main` });
    expect(deleteSession).toHaveBeenCalledWith({ sessionKey: designChildSessionKey });
    expect(await directoryExists(runtimeRoot)).toBe(false);
  });

  it('cancels active workflow dispatch executions for non-terminal runs', async () => {
    const { service, deleteSession } = createOpenClawBackedService(storageRoot, undefined, { disableAutoDispatch: true });
    await createStartedRun(service, 'run-cancel-active');
    await planWorkflow(service, storageRoot, 'run-cancel-active');
    const designChildSessionKey = childSessionKey('run-cancel-active', 'operator-designer', 'design-blueprint');
    await service.updateTask({
      runId: 'run-cancel-active',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Started design.',
      idempotencyKey: 'task-cancel-active',
      workspaceDir: roleWorkspace(storageRoot, 'run-cancel-active', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-cancel-active', 'operator-designer'),
      childSessionKey: designChildSessionKey,
    });

    await expect(service.cancel({
      runId: 'run-cancel-active',
      reason: 'user requested cancellation',
      idempotencyKey: 'cancel-active',
    })).resolves.toEqual(expect.objectContaining({ status: 'cancelled' }));
    expect(deleteSession).toHaveBeenCalledTimes(2);
    expect(deleteSession).toHaveBeenCalledWith({ sessionKey: `agent:${buildTeamManagedAgentId('run-cancel-active', 'leader')}:main` });
    expect(deleteSession).toHaveBeenCalledWith({ sessionKey: designChildSessionKey });
    await expect(service.snapshot({ runId: 'run-cancel-active', eventCursor: 0, eventLimit: 40 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'cancelled' }),
      dispatchExecutions: expect.arrayContaining([
        expect.objectContaining({ status: 'cancelled', statusReason: 'user requested cancellation' }),
      ]),
      events: expect.arrayContaining([
        expect.objectContaining({ type: 'dispatch:execution_cancelled' }),
        expect.objectContaining({ type: 'run:cancelled' }),
      ]),
    }));
  });

  it('cancels queued workflow plan, groups, tasks, and queue items together', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-cancel-queued'), true);
    await createStartedRun(service, 'run-cancel-queued');
    const planned = await planWorkflow(service, storageRoot, 'run-cancel-queued');
    const runtimeRoot = service.resolveRuntimeRoot('run-cancel-queued');
    const internals = service as unknown as {
      workflowStore: {
        saveGroup: (input: Record<string, unknown>) => Promise<{ group: { dispatchGroupId: string } }>;
        saveTask: (input: Record<string, unknown>) => Promise<unknown>;
      };
      dispatchQueueStore: {
        enqueue: (input: Record<string, unknown>) => Promise<unknown>;
      };
    };
    const savedGroup = await internals.workflowStore.saveGroup({
      runtimeRoot,
      runId: 'run-cancel-queued',
      workflowPlanId: planned.plan.workflowPlanId,
      groupId: 'round-1',
      taskIds: ['design-blueprint'],
      idempotencyKey: `${planned.plan.workflowPlanId}:group:round-1`,
    });
    await internals.workflowStore.saveTask({
      runtimeRoot,
      runId: 'run-cancel-queued',
      workflowPlanId: planned.plan.workflowPlanId,
      dispatchGroupId: savedGroup.group.dispatchGroupId,
      groupId: 'round-1',
      taskId: 'design-blueprint',
      roleId: 'operator-designer',
      dispatchId: 'dispatch-cancel-queued-1',
      idempotencyKey: `${planned.plan.workflowPlanId}:group:round-1:task:design-blueprint`,
    });
    await internals.dispatchQueueStore.enqueue({
      runId: 'run-cancel-queued',
      toRoleId: 'operator-designer',
      taskId: 'design-blueprint',
      prompt: 'Produce the operator design blueprint.',
      idempotencyKey: 'orchestrate:run-cancel-queued:design-blueprint:queued',
    });

    await expect(service.cancel({
      runId: 'run-cancel-queued',
      reason: 'user requested cancellation',
      idempotencyKey: 'cancel-queued',
    })).resolves.toEqual(expect.objectContaining({ status: 'cancelled' }));

    const snapshot = await service.snapshot({ runId: 'run-cancel-queued', eventCursor: 0, eventLimit: 80 });
    expect(snapshot.run).toEqual(expect.objectContaining({ status: 'cancelled' }));
    expect(snapshot.workflowPlan).toEqual(expect.objectContaining({ status: 'cancelled' }));
    expect(snapshot.dispatchGroups).toEqual([
      expect.objectContaining({ groupId: 'round-1', status: 'cancelled' }),
    ]);
    expect(snapshot.dispatchTasks).toEqual([
      expect.objectContaining({
        taskId: 'design-blueprint',
        roleId: 'operator-designer',
        status: 'cancelled',
        statusReason: 'user requested cancellation',
      }),
    ]);
    expect(snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'workflow:cancelled' }),
      expect.objectContaining({
        type: 'dispatch:queue_cancelled',
        payload: expect.objectContaining({ taskId: 'design-blueprint', reason: 'user requested cancellation' }),
      }),
      expect.objectContaining({
        type: 'dispatch:task_cancelled',
        payload: expect.objectContaining({ taskId: 'design-blueprint', reason: 'user requested cancellation' }),
      }),
      expect.objectContaining({
        type: 'dispatch:group_cancelled',
        payload: expect.objectContaining({ groupId: 'round-1', reason: 'user requested cancellation' }),
      }),
      expect.objectContaining({ type: 'run:cancelled' }),
    ]));
  });

  it('fails running TeamRuns and queued workflow tasks when wall-clock budget is exceeded', async () => {
    let now = 1;
    const budgetClock = { nowMs: () => now };
    const service = new TeamRunService({
      storageRoot,
      clock: budgetClock,
      idGenerator,
      packageService: new TeamSkillPackageService(),
      dependencyChecker,
      roleSessionExecution: createRoleSessionExecution('run-budget'),
      disableAutoDispatch: true,
    });
    await createStartedRun(service, 'run-budget');
    await planWorkflow(service, storageRoot, 'run-budget');
    await service.updateTask({
      runId: 'run-budget',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      status: 'in_progress',
      summary: 'Started design.',
      idempotencyKey: 'task-budget',
      workspaceDir: roleWorkspace(storageRoot, 'run-budget', 'operator-designer'),
      callerAgentId: await roleAgentId(service, 'run-budget', 'operator-designer'),
      childSessionKey: childSessionKey('run-budget', 'operator-designer', 'design-blueprint'),
    });
    now = 2_700_002;

    await expect(service.tick({ runId: 'run-budget', idempotencyKey: 'tick-budget' })).resolves.toEqual(expect.objectContaining({
      action: 'noop',
      status: 'failed',
      reason: 'TeamRun wall-clock budget exceeded',
    }));
    await expect(service.snapshot({ runId: 'run-budget', eventCursor: 0, eventLimit: 60 })).resolves.toEqual(expect.objectContaining({
      run: expect.objectContaining({ status: 'failed' }),
      dispatchTasks: expect.arrayContaining([
        expect.objectContaining({ taskId: 'design-blueprint', status: 'failed', statusReason: 'TeamRun wall clock budget exceeded' }),
      ]),
      diagnostics: expect.objectContaining({ budgets: expect.objectContaining({ wallClockExceeded: true }) }),
      events: expect.arrayContaining([expect.objectContaining({ type: 'run:budget_exceeded' })]),
    }));
  });

  it('explicitly rejects removed public stage, direct dispatch, and gate endpoints', async () => {
    const service = createService(storageRoot, createRoleSessionExecution('run-old-endpoints'));
    await createStartedRun(service, 'run-old-endpoints');

    await expect(service.prepareDispatch({
      runId: 'run-old-endpoints',
      stageId: 'design-blueprint',
      roleId: 'operator-designer',
      idempotencyKey: 'old-prepare',
    })).rejects.toThrow('TeamRun stage dispatch is not supported; the leader must use team_plan_workflow and OpenClaw native sessions_spawn.');
    await expect(service.executeDispatch({
      runId: 'run-old-endpoints',
      dispatchId: 'dispatch-1',
      idempotencyKey: 'old-execute',
    })).rejects.toThrow('TeamRun direct dispatch execution is not supported; TeamRun uses OpenClaw native sessions_spawn.');
    await expect(service.completeStage({
      runId: 'run-old-endpoints',
      stageId: 'design-blueprint',
      idempotencyKey: 'old-complete',
    })).rejects.toThrow('TeamRun stage completion is not supported; roles complete workflow tasks by calling team_submit_artifact.');
    await expect(service.evaluateGate({
      runId: 'run-old-endpoints',
      artifactId: 'artifact-1',
      gateType: 'design',
      idempotencyKey: 'old-gate',
    })).rejects.toThrow('TeamRun gate evaluation is not supported; model review gates in the workflow plan and submitted artifacts instead.');
  });
});
