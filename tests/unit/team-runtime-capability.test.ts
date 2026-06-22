import { describe, expect, it, vi } from 'vitest';
import { CapabilityRouter } from '../../runtime-host/application/capabilities/contracts/capability-router';
import {
  createTeamRuntimeCapabilityOperationRoutes,
  teamRuntimeCapabilityOperations,
  TEAM_RUNTIME_CAPABILITY_ID,
} from '../../runtime-host/application/capabilities/team/team-runtime-capability';
import { TeamRuntimeService } from '../../runtime-host/application/team-runtime/team-runtime-service';
import type { TeamRuntimeJobPort } from '../../runtime-host/application/team-runtime/team-runtime-jobs';
import type { TeamInboundEnvelope } from '../../runtime-host/application/team-runtime/domain/team-envelope';
import type { TeamOutboxRecord } from '../../runtime-host/application/team-runtime/domain/team-outbox';
import type { TeamIngressPort } from '../../runtime-host/application/team-runtime/ports/team-ingress-port';
import type { TeamMailDeliveryPort } from '../../runtime-host/application/team-runtime/ports/team-mail-delivery-port';
import type { TeamRoleSessionPort } from '../../runtime-host/application/team-runtime/ports/team-role-session-port';
import type { RuntimeEndpointRef } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import type { TeamRuntimeStateStore } from '../../runtime-host/application/team-runtime/team-runtime-state-store';

type TeamRuntimeCapabilityOperationId = typeof teamRuntimeCapabilityOperations[number]['id'];
type TeamDrainOperation =
  | { type: 'ack'; sequences: number[] }
  | { type: 'write'; state: Record<string, unknown> };

const runtimeScope = {
  kind: 'runtime-instance',
  endpoint: {
    kind: 'native-runtime',
    runtimeAdapterId: 'openclaw',
    runtimeInstanceId: 'local',
  },
} as const;

const teamRunScope = {
  kind: 'team-run',
  endpoint: runtimeScope.endpoint,
  runId: 'run-input',
} as const;

function buildEnvelope(overrides: Partial<TeamInboundEnvelope> = {}): TeamInboundEnvelope {
  return {
    type: 'task.completed',
    envelopeId: 'envelope-1',
    runId: 'run-1',
    sourceEndpoint: runtimeScope.endpoint,
    sourceAgentId: 'agent-1',
    sourceSessionKey: 'session-1',
    sourceRoleId: 'operator',
    workflowTaskId: 'task-1',
    roleId: 'operator',
    summary: 'done',
    idempotencyKey: 'task-completed-1',
    createdAt: 10,
    ...overrides,
  } as TeamInboundEnvelope;
}

function buildOutboxRecord(sequence: number, envelope: TeamInboundEnvelope): TeamOutboxRecord {
  return {
    recordId: `record-${sequence}`,
    runId: envelope.runId,
    sequence,
    idempotencyKey: envelope.idempotencyKey,
    envelope,
    status: 'claimed',
    claimedBy: 'runtime-host-team-runtime:0:run-1',
    claimExpiresAt: 60_000,
    createdAt: envelope.createdAt,
  };
}

class FakeTeamIngressPort implements TeamIngressPort {
  pullQueue: TeamOutboxRecord[][] = [];
  ackedSequences: number[] = [];
  nextAckedSequences: number[] | null = null;
  concurrentPulls = 0;
  maxConcurrentPulls = 0;

  constructor(private readonly operations?: TeamDrainOperation[]) {}

  async pull() {
    this.concurrentPulls += 1;
    this.maxConcurrentPulls = Math.max(this.maxConcurrentPulls, this.concurrentPulls);
    await Promise.resolve();
    this.concurrentPulls -= 1;
    const records = this.pullQueue.shift() ?? [];
    return { runId: 'run-1', records, hasMore: this.pullQueue.length > 0 };
  }

  async ack(input: { runId?: string; sequences: readonly number[] }) {
    const sequences = [...input.sequences];
    const ackedSequences = this.nextAckedSequences ?? sequences;
    this.nextAckedSequences = null;
    this.ackedSequences.push(...ackedSequences);
    this.operations?.push({ type: 'ack', sequences });
    return { runId: input.runId ?? 'run-1', ackedSequences };
  }
}

class FakeTeamRuntimeJobPort implements TeamRuntimeJobPort {
  deleteManagedAgentsSubmissions: Array<{ teamId: string; endpoint: RuntimeEndpointRef; agentIds: readonly string[]; workspacePaths: readonly string[] }> = [];

  async submitDeleteManagedAgents(payload: { teamId: string; endpoint: RuntimeEndpointRef; agentIds: readonly string[]; workspacePaths: readonly string[] }) {
    this.deleteManagedAgentsSubmissions.push(payload);
    return {
      success: true,
      job: {
        id: `job-${this.deleteManagedAgentsSubmissions.length}`,
        type: 'teamRuntime.deleteManagedAgents',
        queue: 'low',
        status: 'queued',
        queuedAt: 1000,
        attempts: 0,
        maxAttempts: 3,
      },
    } as const;
  }
}

class FakeTeamMailDeliveryPort implements TeamMailDeliveryPort {
  deliveries: Parameters<TeamMailDeliveryPort['deliver']>[0][] = [];

  async deliver(input: Parameters<TeamMailDeliveryPort['deliver']>[0]) {
    this.deliveries.push(input);
    return { mailId: input.mail.mailId, status: 'delivered', deliveredAt: 1000 } as const;
  }
}

function buildTeamPackageValidation(overrides: Record<string, unknown> = {}) {
  return {
    valid: true,
    package: {
      name: 'package-1',
      version: '1.0.0',
      description: 'package',
      sourcePath: '/pkg',
      roles: [],
      skill: { markdown: '' },
      workflow: { markdown: '' },
      dependencies: { skills: [], tools: [], yaml: '' },
      ...overrides,
    },
    errors: [],
    warnings: [],
  };
}

class FakeTeamRuntimeStateStore implements TeamRuntimeStateStore {
  writes: Record<string, unknown>[] = [];
  runStates: Record<string, unknown> = {};
  teamInstances: Record<string, unknown> = {};
  deletedRunIds: string[] = [];
  deletedTeamInstanceIds: string[] = [];
  writeTeamInstanceCount = 0;

  constructor(private readonly operations: TeamDrainOperation[]) {}

  async readRunState(runId: string) {
    return this.runStates[runId] ?? null;
  }

  async writeRunState(runId: string, state: unknown) {
    const snapshot = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    this.runStates[runId] = snapshot;
    this.writes.push(snapshot);
    this.operations.push({ type: 'write', state: snapshot });
  }

  async deleteRunState(runId: string) {
    this.deletedRunIds.push(runId);
  }

  async readTeamInstance(teamId: string) {
    return this.teamInstances[teamId] ?? null;
  }

  async writeTeamInstance(teamId: string, instance: unknown) {
    this.writeTeamInstanceCount += 1;
    this.teamInstances[teamId] = JSON.parse(JSON.stringify(instance));
  }

  async deleteTeamInstance(teamId: string) {
    this.deletedTeamInstanceIds.push(teamId);
    delete this.teamInstances[teamId];
  }
}

function createRouteFor(operationId: TeamRuntimeCapabilityOperationId, invoke = vi.fn()) {
  const route = createTeamRuntimeCapabilityOperationRoutes({
    teamRuntimeService: { invoke } as never,
  }).find((candidate) => candidate.operationId === operationId);

  if (!route) {
    throw new Error(`Missing Team runtime capability route: ${operationId}`);
  }

  return { route, invoke };
}

async function expectRouteDeniedBeforeInvoke(input: {
  operationId: TeamRuntimeCapabilityOperationId;
  target: Record<string, unknown>;
  domainInput: Record<string, unknown>;
  scope?: typeof runtimeScope | typeof teamRunScope;
  error: string;
}) {
  const { route, invoke } = createRouteFor(input.operationId);
  const result = await Promise.resolve(route.handle({
    capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
    operationId: input.operationId,
    scope: input.scope ?? runtimeScope,
    target: input.target,
    input: input.domainInput,
    domainInput: input.domainInput,
  }));

  expect(result).toEqual(expect.objectContaining({
    status: 400,
    data: expect.objectContaining({ error: input.error }),
  }));
  expect(invoke).not.toHaveBeenCalled();
}

describe('team runtime capability', () => {
  it('describes run listing, workflow planning, approval resolution, resume, and team deletion with final target operations', () => {
    expect(teamRuntimeCapabilityOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'team.delete', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.runList', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.planWorkflow', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.resume', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.approvalResolve', targetKind: 'team-approval' }),
    ]));
    expect(teamRuntimeCapabilityOperations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'team.dispatchGroup' }),
      expect.objectContaining({ id: 'team.dispatchTask' }),
    ]));
  });

  it.each([
    ['team.packageValidate', { packagePath: '/pkg-input' }],
    ['team.dependencyPlan', { packagePath: '/pkg-input' }],
    ['team.runCreate', { packagePath: '/pkg-input', runId: 'run-1', idempotencyKey: 'create-1' }],
  ] as const)('rejects %s target and input packagePath mismatches before invoking the service', async (operationId, domainInput) => {
    await expectRouteDeniedBeforeInvoke({
      operationId,
      target: { kind: 'team', packagePath: '/pkg-target' },
      domainInput,
      error: 'Team runtime target packagePath must match input packagePath',
    });
  });

  it.each([
    'team.delete',
    'team.runList',
  ] as const)('rejects %s target and input teamId mismatches before invoking the service', async (operationId) => {
    await expectRouteDeniedBeforeInvoke({
      operationId,
      target: { kind: 'team', teamId: 'team-target' },
      domainInput: { kind: 'team', teamId: 'team-input' },
      error: 'Team runtime target teamId must match input teamId',
    });
  });

  it('rejects runList missing target teamId before invoking the service', async () => {
    await expectRouteDeniedBeforeInvoke({
      operationId: 'team.runList',
      target: { kind: 'team' },
      domainInput: { teamId: 'team-input' },
      error: 'Team runtime teamId/teamId is required',
    });
  });

  it('invokes runList only with matching team target and input identity', async () => {
    const response = { status: 200, data: { teamId: 'team-1', runs: [] } };
    const invoke = vi.fn(async () => response);
    const { route } = createRouteFor('team.runList', invoke);
    const domainInput = { teamId: 'team-1' };

    await expect(Promise.resolve(route.handle({
      capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.runList',
      scope: runtimeScope,
      target: { kind: 'team', teamId: 'team-1' },
      input: domainInput,
      domainInput,
    }))).resolves.toBe(response);
    expect(invoke).toHaveBeenCalledWith(
      'team.runList',
      domainInput,
      runtimeScope,
    );
  });

  it.each([
    ['team.runSnapshot', { runId: 'run-input' }],
    ['team.runDiagnostics', { runId: 'run-input' }],
    ['team.runDecisionSubmit', { runId: 'run-input', decision: 'retry', idempotencyKey: 'decision-1' }],
    ['team.planWorkflow', { runId: 'run-input', title: 'Workflow plan', groups: [], tasks: [], idempotencyKey: 'plan-1' }],
    ['team.runTick', { runId: 'run-input', idempotencyKey: 'tick-1' }],
    ['team.runCancel', { runId: 'run-input', reason: 'stop', idempotencyKey: 'cancel-1' }],
    ['team.runDelete', { runId: 'run-input' }],
  ] as const)('rejects %s target and input runId mismatches before invoking the service', async (operationId, domainInput) => {
    await expectRouteDeniedBeforeInvoke({
      operationId,
      target: { kind: 'team-run', runId: 'run-target' },
      domainInput,
      error: 'Team runtime target runId must match input runId',
    });
  });

  it.each([
    ['team.runTick', { runId: 'run-target', idempotencyKey: 'tick-1' }],
  ] as const)('rejects %s team-run target and scope runId mismatches before invoking the service', async (operationId, domainInput) => {
    await expectRouteDeniedBeforeInvoke({
      operationId,
      scope: teamRunScope,
      target: { kind: 'team-run', runId: 'run-target' },
      domainInput,
      error: 'Team runtime target runId must match scope runId',
    });
  });

  it('rejects workflow plan requests missing required workflow fields before invoking the service', async () => {
    await expectRouteDeniedBeforeInvoke({
      operationId: 'team.planWorkflow',
      target: { kind: 'team-run', runId: 'run-1' },
      domainInput: { runId: 'run-1', title: 'Workflow plan', tasks: [], idempotencyKey: 'plan-1' },
      error: 'Team runtime input groups is required',
    });
  });

  it.each([
    ['team.runTick', { runId: 'run-1' }, 'Team runtime input idempotencyKey is required'],
    ['team.resume', { teamId: 'team-1' }, 'Team runtime input idempotencyKey is required'],
    ['team.runCancel', { runId: 'run-1' }, 'Team runtime input idempotencyKey is required'],
    ['team.runDecisionSubmit', { runId: 'run-1', idempotencyKey: 'decision-1' }, 'Team runtime input decision is required'],
    ['team.runDecisionSubmit', { runId: 'run-1', decision: 'retry' }, 'Team runtime input idempotencyKey is required'],
    ['team.planWorkflow', { runId: 'run-1', title: 'Workflow plan', groups: [], tasks: [] }, 'Team runtime input idempotencyKey is required'],
  ] as const)('rejects %s missing required action input before invoking the service', async (operationId, domainInput, error) => {
    await expectRouteDeniedBeforeInvoke({
      operationId,
      target: operationId === 'team.resume' ? { kind: 'team', teamId: 'team-1' } : { kind: 'team-run', runId: 'run-1' },
      domainInput,
      error,
    });
  });

  it('rejects approvalResolve missing idempotencyKey before invoking the service', async () => {
    await expectRouteDeniedBeforeInvoke({
      operationId: 'team.approvalResolve',
      target: { kind: 'team-approval', runId: 'run-1', approvalId: 'approval-1' },
      domainInput: { runId: 'run-1', approvalId: 'approval-1', decision: 'approve' },
      error: 'Team runtime input idempotencyKey is required',
    });
  });

  it.each([
    [
      'runId',
      { kind: 'team-approval', runId: 'run-target', approvalId: 'approval-1' },
      { runId: 'run-input', approvalId: 'approval-1', decision: 'approve', idempotencyKey: 'approval-1' },
      'Team runtime target runId must match input runId',
    ],
    [
      'approvalId',
      { kind: 'team-approval', runId: 'run-1', approvalId: 'approval-target' },
      { runId: 'run-1', approvalId: 'approval-input', decision: 'approve', idempotencyKey: 'approval-1' },
      'Team runtime target approvalId must match input approvalId',
    ],
  ] as const)('rejects approvalResolve target and input %s mismatches before invoking the service', async (_field, target, domainInput, error) => {
    await expectRouteDeniedBeforeInvoke({
      operationId: 'team.approvalResolve',
      target,
      domainInput,
      error,
    });
  });

  it('invokes approvalResolve only with matching team-approval target and input identity', async () => {
    const response = { status: 200, data: { success: true } };
    const invoke = vi.fn(async () => response);
    const { route } = createRouteFor('team.approvalResolve', invoke);
    const domainInput = {
      runId: 'run-1',
      approvalId: 'approval-1',
      decision: 'approve',
      note: 'Approved',
      idempotencyKey: 'approval-1',
    };

    await expect(Promise.resolve(route.handle({
      capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.approvalResolve',
      scope: runtimeScope,
      target: { kind: 'team-approval', runId: 'run-1', approvalId: 'approval-1' },
      input: domainInput,
      domainInput,
    }))).resolves.toBe(response);
    expect(invoke).toHaveBeenCalledWith(
      'team.approvalResolve',
      domainInput,
      runtimeScope,
    );
  });

  it('allows dependencyPlan team targets under the runtime-instance scope without teamId binding', async () => {
    const invoke = vi.fn(async () => ({ status: 200, data: { success: true, canProceed: true } }));
    const router = new CapabilityRouter({
      getCapability: () => ({
        id: TEAM_RUNTIME_CAPABILITY_ID,
        kind: TEAM_RUNTIME_CAPABILITY_ID,
        scopeKind: 'runtime-instance',
        scope: runtimeScope,
        targetKinds: ['team', 'team-run', 'team-approval'],
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        supportLevel: 'native',
        availability: 'available',
        operations: teamRuntimeCapabilityOperations,
        policyScope: TEAM_RUNTIME_CAPABILITY_ID,
        ownerModuleId: 'test',
        routeOwnerId: 'test',
      }),
      operations: createTeamRuntimeCapabilityOperationRoutes({
        teamRuntimeService: { invoke } as never,
      }),
    });

    await expect(router.execute({
      id: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.dependencyPlan',
      scope: runtimeScope,
      target: { kind: 'team', packagePath: '/pkg' },
      input: { packagePath: '/pkg' },
    })).resolves.toEqual({ status: 200, data: { success: true, canProceed: true } });
    expect(invoke).toHaveBeenCalledWith(
      'team.dependencyPlan',
      { packagePath: '/pkg' },
      runtimeScope,
    );
  });

  it('allows packageValidate team targets under the runtime-instance scope without teamId binding', async () => {
    const invoke = vi.fn(async () => ({ status: 200, data: { success: true, valid: true } }));
    const router = new CapabilityRouter({
      getCapability: () => ({
        id: TEAM_RUNTIME_CAPABILITY_ID,
        kind: TEAM_RUNTIME_CAPABILITY_ID,
        scopeKind: 'runtime-instance',
        scope: runtimeScope,
        targetKinds: ['team', 'team-run', 'team-approval'],
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        supportLevel: 'native',
        availability: 'available',
        operations: teamRuntimeCapabilityOperations,
        policyScope: TEAM_RUNTIME_CAPABILITY_ID,
        ownerModuleId: 'test',
        routeOwnerId: 'test',
      }),
      operations: createTeamRuntimeCapabilityOperationRoutes({
        teamRuntimeService: { invoke } as never,
      }),
    });

    await expect(router.execute({
      id: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.packageValidate',
      scope: runtimeScope,
      target: { kind: 'team', packagePath: '/pkg' },
      input: { packagePath: '/pkg' },
    })).resolves.toEqual({ status: 200, data: { success: true, valid: true } });
    expect(invoke).toHaveBeenCalledWith(
      'team.packageValidate',
      { packagePath: '/pkg' },
      runtimeScope,
    );
  });

  it('allows runCreate team targets under the runtime-instance scope without teamId binding', async () => {
    const invoke = vi.fn(async () => ({ status: 200, data: { success: true, runId: 'run-1', status: 'created' } }));
    const router = new CapabilityRouter({
      getCapability: () => ({
        id: TEAM_RUNTIME_CAPABILITY_ID,
        kind: TEAM_RUNTIME_CAPABILITY_ID,
        scopeKind: 'runtime-instance',
        scope: runtimeScope,
        targetKinds: ['team', 'team-run', 'team-approval'],
        runtimeAdapterId: 'openclaw',
        runtimeInstanceId: 'local',
        supportLevel: 'native',
        availability: 'available',
        operations: teamRuntimeCapabilityOperations,
        policyScope: TEAM_RUNTIME_CAPABILITY_ID,
        ownerModuleId: 'test',
        routeOwnerId: 'test',
      }),
      operations: createTeamRuntimeCapabilityOperationRoutes({
        teamRuntimeService: { invoke } as never,
      }),
    });

    await expect(router.execute({
      id: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.runCreate',
      scope: runtimeScope,
      target: { kind: 'team', packagePath: '/pkg' },
      input: { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' },
    })).resolves.toEqual({ status: 200, data: { success: true, runId: 'run-1', status: 'created' } });
    expect(invoke).toHaveBeenCalledWith(
      'team.runCreate',
      { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' },
      runtimeScope,
    );
  });

  it('provisions TeamInstance managed agents without creating a run', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const removeTeamAgents = vi.fn();
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{
              id: 'financial-analyst',
              purpose: 'Analyze financials',
              agentsMd: '# financial analyst',
              skills: [],
              tools: [],
            }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'financial-analyst', agentId: 'analyst-agent', displayName: 'financial-analyst', workspace: '/team/roles/financial-analyst', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents,
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);

    const teamInstance = stateStore.teamInstances['team-package'] as Record<string, unknown>;
    expect(teamInstance).toEqual(expect.objectContaining({
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      managedAgents: [
        expect.objectContaining({ roleId: 'leader', agentId: 'leader-agent', workspace: '/team/leader' }),
        expect.objectContaining({ roleId: 'financial-analyst', agentId: 'analyst-agent', workspace: '/team/roles/financial-analyst' }),
      ],
      runs: [],
    }));
  });

  it('lists TeamInstance runs sorted by updatedAt without synthetic run data', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [],
      runs: [
        { teamId: 'team-package', runId: 'run-old', status: 'completed', revision: 3, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 100, updatedAt: 200 },
        { teamId: 'team-package', runId: 'run-new-a', status: 'running', revision: 4, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 300, updatedAt: 400 },
        { teamId: 'team-package', runId: 'run-new-b', status: 'waiting_for_user', revision: 5, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 350, updatedAt: 400 },
        { teamId: 'team-package', runId: 'run-middle', status: 'waiting_for_user', revision: 6, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 200, updatedAt: 300 },
      ],
      createdAt: 100,
      updatedAt: 400,
    };
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await expect(service.invoke('team.runList', { teamId: 'team-package' }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 200,
      data: {
        teamId: 'team-package',
        runs: [
          expect.objectContaining({ runId: 'run-new-a', updatedAt: 400 }),
          expect.objectContaining({ runId: 'run-new-b', updatedAt: 400 }),
          expect.objectContaining({ runId: 'run-middle', updatedAt: 300 }),
          expect.objectContaining({ runId: 'run-old', updatedAt: 200 }),
        ],
      },
    }));
    expect(stateStore.writes).toHaveLength(0);
    expect(stateStore.writeTeamInstanceCount).toBe(0);
  });

  it('returns an empty run list for missing TeamInstance without creating fallback data', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await expect(service.invoke('team.runList', { teamId: 'missing-team' }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 200,
      data: { teamId: 'missing-team', runs: [] },
    }));
    expect(stateStore.teamInstances['missing-team']).toBeUndefined();
    expect(stateStore.writes).toHaveLength(0);
    expect(stateStore.writeTeamInstanceCount).toBe(0);
  });

  it('creates run role session bindings from TeamInstance agents when reusing existing Team agents', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'existing-leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
        { teamId: 'team-package', roleId: 'financial-analyst', agentId: 'existing-analyst-agent', displayName: 'financial-analyst', workspace: '/team/roles/financial-analyst', endpoint: runtimeScope.endpoint },
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 900,
    };
    const materialize = vi.fn();
    const ensureRoleSession = vi.fn(async (input) => ({
      teamId: input.teamId,
      runId: input.runId,
      roleId: input.roleId,
      agentId: input.agentId,
      sessionIdentity: input.sessionIdentity,
      sessionKey: input.sessionIdentity.sessionKey,
    }));
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{
              id: 'financial-analyst',
              purpose: 'Analyze financials',
              agentsMd: '# financial analyst',
              skills: [],
              tools: [],
            }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize,
        removeTeamAgents: vi.fn(),
      },
      roleSessions: {
        ensureRoleSession,
        promptRoleSession: vi.fn(),
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-2', idempotencyKey: 'create-2' }, runtimeScope);

    expect(materialize).not.toHaveBeenCalled();
    expect(ensureRoleSession).not.toHaveBeenCalled();
    expect(stateStore.teamInstances['team-package']).toEqual(expect.objectContaining({
      runs: [expect.objectContaining({
        runId: 'run-2',
        sessions: [
          expect.objectContaining({ roleId: 'leader', agentId: 'existing-leader-agent' }),
          expect.objectContaining({ roleId: 'financial-analyst', agentId: 'existing-analyst-agent' }),
        ],
      })],
    }));
  });

  it('resumes every TeamInstance run into the global run registry and skips terminal runs as active', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [],
      runs: [
        { teamId: 'team-package', runId: 'run-active', status: 'running', revision: 2, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 900, updatedAt: 1000 },
        { teamId: 'team-package', runId: 'run-terminal', status: 'completed', revision: 3, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 900, updatedAt: 1100 },
      ],
      createdAt: 900,
      updatedAt: 1100,
    };
    stateStore.runStates['run-active'] = {
      run: { teamId: 'team-package', runId: 'run-active', status: 'waiting_for_user', revision: 4, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', createdAt: 900, updatedAt: 1200 },
      processedIdempotencyKeys: [],
      acknowledgedOutboxSequence: 0,
    };
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    const response = await service.invoke('team.resume', { teamId: 'team-package', idempotencyKey: 'resume-1' }, runtimeScope);

    expect(response.data).toEqual({
      success: true,
      teamId: 'team-package',
      restoredRunIds: ['run-active', 'run-terminal'],
      activeRunIds: ['run-active'],
      skippedTerminalRunIds: ['run-terminal'],
    });
    expect(service.runRegistry.listNonTerminalRunIds()).toEqual(['run-active']);
  });

  it('rejects runCreate when Team agents have not been provisioned', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const materialize = vi.fn();
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{
              id: 'financial-analyst',
              purpose: 'Analyze financials',
              agentsMd: '# financial analyst',
              skills: [],
              tools: [],
            }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize,
        removeTeamAgents: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await expect(service.invoke(
      'team.runCreate',
      { packagePath: '/pkg', runId: 'run-2', idempotencyKey: 'create-2' },
      runtimeScope,
    )).rejects.toThrow('Team managed agents must be provisioned before creating TeamRun');
    expect(materialize).not.toHaveBeenCalled();
    expect(stateStore.writeTeamInstanceCount).toBe(0);
  });

  it('deletes TeamInstance runs and enqueues managed agent deletion without blocking on agents.delete', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'shared-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
        { teamId: 'team-package', roleId: 'financial-analyst', agentId: 'shared-agent', displayName: 'financial-analyst', workspace: '/team/roles/financial-analyst', endpoint: runtimeScope.endpoint },
      ],
      runs: [
        { teamId: 'team-package', runId: 'run-1', status: 'completed', revision: 3, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 100, updatedAt: 200 },
        { teamId: 'team-package', runId: 'run-2', status: 'completed', revision: 4, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 300, updatedAt: 400 },
      ],
      createdAt: 100,
      updatedAt: 400,
    };
    const jobs = new FakeTeamRuntimeJobPort();
    const removeTeamAgents = vi.fn();
    const roleSessions = {
      ensureRoleSession: vi.fn(),
      promptRoleSession: vi.fn(),
      abortRoleSession: vi.fn(),
      deleteRoleSession: vi.fn(),
      readRoleSessionWindow: vi.fn(),
    } satisfies TeamRoleSessionPort;
    stateStore.teamInstances['team-package'] = {
      ...stateStore.teamInstances['team-package']!,
      runs: [
        {
          ...stateStore.teamInstances['team-package']!.runs[0]!,
          sessions: [{ teamId: 'team-package', runId: 'run-1', roleId: 'leader', agentId: 'shared-agent', sessionKey: 'agent:shared-agent:team-role:run-1:leader', sessionIdentity: { endpoint: runtimeScope.endpoint, agentId: 'shared-agent', sessionKey: 'agent:shared-agent:team-role:run-1:leader' } }],
        },
        {
          ...stateStore.teamInstances['team-package']!.runs[1]!,
          sessions: [{ teamId: 'team-package', runId: 'run-2', roleId: 'financial-analyst', agentId: 'shared-agent', sessionKey: 'agent:shared-agent:team-role:run-2:financial-analyst', sessionIdentity: { endpoint: runtimeScope.endpoint, agentId: 'shared-agent', sessionKey: 'agent:shared-agent:team-role:run-2:financial-analyst' } }],
        },
      ],
    };
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      jobs,
      agentMaterialization: {
        materialize: vi.fn(),
        removeTeamAgents,
      },
      roleSessions,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await expect(service.invoke('team.delete', { teamId: 'team-package' }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 200,
      data: expect.objectContaining({
        teamId: 'team-package',
        deleted: true,
        deletedRunIds: ['run-1', 'run-2'],
        deletedAgentIds: ['shared-agent'],
      }),
    }));
    expect(stateStore.deletedRunIds).toEqual(['run-1', 'run-2']);
    expect(roleSessions.deleteRoleSession).toHaveBeenCalledTimes(2);
    expect(roleSessions.deleteRoleSession).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ sessionKey: 'agent:shared-agent:team-role:run-1:leader' }),
    }));
    expect(roleSessions.deleteRoleSession).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ sessionKey: 'agent:shared-agent:team-role:run-2:financial-analyst' }),
    }));
    expect(removeTeamAgents).not.toHaveBeenCalled();
    expect(jobs.deleteManagedAgentsSubmissions).toEqual([{
      teamId: 'team-package',
      endpoint: runtimeScope.endpoint,
      agentIds: ['shared-agent'],
      workspacePaths: ['/team/leader', '/team/roles/financial-analyst'],
    }]);
    expect(stateStore.writeTeamInstanceCount).toBe(0);
    expect(stateStore.deletedTeamInstanceIds).toEqual(['team-package']);
    expect(stateStore.teamInstances['team-package']).toBeUndefined();
  });

  it('materializes the leader with workflow planning and role messaging tools', async () => {
    const materialize = vi.fn(async (input) => ({
      teamId: input.teamId,
      managedAgents: [
        { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
      ],
    }));
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{
              id: 'financial-analyst',
              purpose: 'Analyze financials',
              agentsMd: '# financial analyst',
              skills: [],
              tools: [],
            }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            bind: { markdown: '# bind' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize,
        removeTeamAgents: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);

    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'team-package',
      leader: expect.objectContaining({
        roleId: 'leader',
        agentName: 'leader',
        tools: ['team_submit_workflow_plan', 'team_send_message'],
      }),
      roles: [expect.objectContaining({
        roleId: 'financial-analyst',
        agentName: 'financial-analyst',
      })],
    }));
  });

  it('does not ensure or prompt role sessions when creating a run', async () => {
    const mailDelivery = new FakeTeamMailDeliveryPort();
    const ensureRoleSession = vi.fn(async (input) => ({ ...input, sessionKey: input.sessionIdentity.sessionKey }));
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
        { teamId: 'team-package', roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 900,
    };
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      stateStore,
      mailDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents: vi.fn(),
      },
      roleSessions: {
        ensureRoleSession,
        promptRoleSession: vi.fn(),
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' }, runtimeScope);

    expect(ensureRoleSession).not.toHaveBeenCalled();
    expect(mailDelivery.deliveries).toHaveLength(0);
    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const snapshot = snapshotResponse.data as { run: { status: string }; events: Array<{ type: string }>; mails: Array<{ kind: string; status: string }> };
    expect(snapshot.run.status).toBe('created');
    expect(snapshot.events).toEqual([]);
    expect(snapshot.mails).toEqual([]);
  });

  it.each([
    ['team.runTick', 'tick-1'],
  ] as const)('dispatches ready workflow tasks through Team mail delivery after dependencies complete via %s', async (operationId, idempotencyKey) => {
    const ingress = new FakeTeamIngressPort();
    const mailDelivery = new FakeTeamMailDeliveryPort();
    const promptRoleSession = vi.fn();
    const service = new TeamRuntimeService({
      ingress,
      mailDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents: vi.fn(),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(async (input) => ({ ...input, sessionKey: input.sessionIdentity.sessionKey })),
        promptRoleSession,
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);
    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' }, runtimeScope);
    await service.invoke('team.planWorkflow', {
      runId: 'run-1',
      title: 'Workflow plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1', 'task-2'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [
        { taskId: 'task-1', roleId: 'operator', title: 'Task 1', prompt: 'Do task 1' },
        { taskId: 'task-2', roleId: 'operator', title: 'Task 2', prompt: 'Do task 2', dependsOnTaskIds: ['task-1'] },
      ],
      idempotencyKey: 'plan-1',
    }, runtimeScope);

    expect(mailDelivery.deliveries).toHaveLength(1);
    expect(mailDelivery.deliveries[0]).toEqual(expect.objectContaining({
      binding: expect.objectContaining({ roleId: 'operator', agentId: 'operator-agent' }),
      mail: expect.objectContaining({
        kind: 'task.assignment',
        threadId: 'task-1',
        toAgentId: 'operator-agent',
        relatedEntity: { kind: 'task', id: 'task-1' },
      }),
    }));
    expect(mailDelivery.deliveries[0]?.mail.body).toContain('follow TOOLS.md and call Team Complete Task');
    expect(mailDelivery.deliveries[0]?.mail.body).toContain('Do not claim completion if the tool call fails');
    expect(promptRoleSession).not.toHaveBeenCalled();

    ingress.pullQueue = [[buildOutboxRecord(1, buildEnvelope({ envelopeId: 'task-envelope', idempotencyKey: 'task-1-complete', workflowTaskId: 'task-1', roleId: 'operator', summary: 'task 1 done' }))]];
    await service.invoke(operationId, { runId: 'run-1', idempotencyKey }, runtimeScope);

    expect(ingress.ackedSequences).toEqual([1]);
    expect(mailDelivery.deliveries).toHaveLength(2);
    expect(mailDelivery.deliveries[1]?.mail).toEqual(expect.objectContaining({
      kind: 'task.assignment',
      threadId: 'task-2',
      relatedEntity: { kind: 'task', id: 'task-2' },
    }));
  });

  it('limits active role task prompts and dispatches more after a task completes', async () => {
    const ingress = new FakeTeamIngressPort();
    const mailDelivery = new FakeTeamMailDeliveryPort();
    const service = new TeamRuntimeService({
      ingress,
      mailDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [
              { id: 'operator-a', purpose: 'Operate A', agentsMd: '# operator a', skills: [], tools: [] },
              { id: 'operator-b', purpose: 'Operate B', agentsMd: '# operator b', skills: [], tools: [] },
              { id: 'operator-c', purpose: 'Operate C', agentsMd: '# operator c', skills: [], tools: [] },
            ],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator-a', agentId: 'operator-a-agent', displayName: 'operator-a', workspace: '/team/operator-a', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator-b', agentId: 'operator-b-agent', displayName: 'operator-b', workspace: '/team/operator-b', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator-c', agentId: 'operator-c-agent', displayName: 'operator-c', workspace: '/team/operator-c', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents: vi.fn(),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(async (input) => ({ ...input, sessionKey: input.sessionIdentity.sessionKey })),
        promptRoleSession: vi.fn(),
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);
    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' }, runtimeScope);
    await service.invoke('team.planWorkflow', {
      runId: 'run-1',
      title: 'Workflow plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1', 'task-2', 'task-3'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [
        { taskId: 'task-1', roleId: 'operator-a', title: 'Task 1', prompt: 'Do task 1' },
        { taskId: 'task-2', roleId: 'operator-b', title: 'Task 2', prompt: 'Do task 2' },
        { taskId: 'task-3', roleId: 'operator-c', title: 'Task 3', prompt: 'Do task 3' },
      ],
      idempotencyKey: 'plan-1',
    }, runtimeScope);

    expect(mailDelivery.deliveries.map((delivery) => delivery.mail.threadId)).toEqual(['task-1', 'task-2']);

    ingress.pullQueue = [[buildOutboxRecord(1, buildEnvelope({ envelopeId: 'task-envelope', idempotencyKey: 'task-1-complete', workflowTaskId: 'task-1', roleId: 'operator-a', summary: 'task 1 done' }))]];
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope);

    expect(mailDelivery.deliveries.map((delivery) => delivery.mail.threadId)).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('rejects workflow task roleId values that use managed agent ids instead of TeamSkill role ids', async () => {
    const mailDelivery = new FakeTeamMailDeliveryPort();
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      mailDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents: vi.fn(),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(async (input) => ({ ...input, sessionKey: input.sessionIdentity.sessionKey })),
        promptRoleSession: vi.fn(),
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);
    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' }, runtimeScope);
    await expect(service.invoke('team.planWorkflow', {
      runId: 'run-1',
      title: 'Workflow plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [{ taskId: 'task-1', roleId: 'operator-agent', title: 'Task 1', prompt: 'Do task 1' }],
      idempotencyKey: 'plan-1',
    }, runtimeScope)).rejects.toThrow('tasks[0].roleId must be the TeamSkill role id "operator", not the managed agent id "operator-agent"');
    expect(mailDelivery.deliveries).toHaveLength(0);
  });

  it('limits each runTick to the outbox batch budget and continues on the next tick', async () => {
    const ingress = new FakeTeamIngressPort();
    ingress.pullQueue = [
      [buildOutboxRecord(1, buildEnvelope({ envelopeId: 'task-envelope-1', idempotencyKey: 'task-1', summary: 'one' }))],
      [buildOutboxRecord(2, buildEnvelope({ envelopeId: 'task-envelope-2', idempotencyKey: 'task-2', summary: 'two' }))],
      [buildOutboxRecord(3, buildEnvelope({ envelopeId: 'task-envelope-3', idempotencyKey: 'task-3', summary: 'three' }))],
    ];
    const service = new TeamRuntimeService({ ingress, nowMs: () => 1000, randomId: () => 'id' });

    const firstTick = await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope);
    const firstTickData = firstTick.data as { resultType: string; drainedRecords: number; snapshot: { events: unknown[] } };

    expect(firstTickData).toEqual(expect.objectContaining({ resultType: 'outbox_pending', drainedRecords: 2 }));
    expect(firstTickData.snapshot.events).toHaveLength(2);
    expect(ingress.ackedSequences).toEqual([1, 2]);

    const secondTick = await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-2' }, runtimeScope);
    const secondTickData = secondTick.data as { resultType: string; drainedRecords: number; snapshot: { events: unknown[] } };

    expect(secondTickData).toEqual(expect.objectContaining({ resultType: 'outbox_pending', drainedRecords: 1 }));
    expect(secondTickData.snapshot.events).toHaveLength(3);
    expect(ingress.ackedSequences).toEqual([1, 2, 3]);
  });

  it('does not advance the outbox cursor when ack does not commit any sequence', async () => {
    const operations: TeamDrainOperation[] = [];
    const ingress = new FakeTeamIngressPort(operations);
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    ingress.nextAckedSequences = [];
    ingress.pullQueue = [[
      buildOutboxRecord(1, buildEnvelope({ envelopeId: 'task-envelope-1', idempotencyKey: 'task-1', summary: 'done' })),
    ]];
    const service = new TeamRuntimeService({ ingress, stateStore, nowMs: () => 1000, randomId: () => 'id' });

    const tick = await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope);
    const tickData = tick.data as { resultType: string; drainedRecords: number; snapshot: { events: unknown[] } };

    expect(tickData).toEqual(expect.objectContaining({ resultType: 'noop', drainedRecords: 0 }));
    expect(operations.some((operation) => operation.type === 'write' && operation.state.acknowledgedOutboxSequence === 1)).toBe(false);
  });

  it('flushes consumed outbox state before ack and persists the cursor after ack', async () => {
    const operations: TeamDrainOperation[] = [];
    const ingress = new FakeTeamIngressPort(operations);
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    ingress.pullQueue = [[
      buildOutboxRecord(1, buildEnvelope({ envelopeId: 'task-envelope-1', idempotencyKey: 'task-1', summary: 'done' })),
    ]];
    const service = new TeamRuntimeService({ ingress, stateStore, nowMs: () => 1000, randomId: () => 'id' });

    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope);

    const ackIndex = operations.findIndex((operation) => operation.type === 'ack');
    const writesBeforeAck = operations.slice(0, ackIndex).filter((operation) => operation.type === 'write');
    const writeBeforeAck = writesBeforeAck[writesBeforeAck.length - 1];
    const writeAfterAck = operations.slice(ackIndex + 1).find((operation) => operation.type === 'write' && operation.state.acknowledgedOutboxSequence === 1);

    expect(ackIndex).toBeGreaterThan(0);
    expect(operations[ackIndex]).toEqual({ type: 'ack', sequences: [1] });
    expect(writeBeforeAck).toEqual({
      type: 'write',
      state: expect.objectContaining({
        acknowledgedOutboxSequence: 0,
        events: [expect.objectContaining({ type: 'task.completed' })],
      }),
    });
    expect(writeAfterAck).toEqual({
      type: 'write',
      state: expect.objectContaining({ acknowledgedOutboxSequence: 1 }),
    });
  });

  it('drains one run serially, consumes envelopes before ack, and avoids duplicate idempotency projection', async () => {
    const ingress = new FakeTeamIngressPort();
    const workflowPlan = buildEnvelope({
      type: 'workflow.plan_submitted',
      envelopeId: 'plan-envelope',
      idempotencyKey: 'plan-1',
      title: 'Workflow plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [{ taskId: 'task-1', roleId: 'operator', title: 'Task 1', prompt: 'Do task 1' }],
    });
    const evidenceRefs = [
      { type: 'workspacePath', path: 'reports/task-1.md', label: 'report' },
      { type: 'inlineText', text: 'Evidence summary', label: 'summary' },
    ] as const;
    const taskCompleted = buildEnvelope({ envelopeId: 'task-envelope', idempotencyKey: 'task-1', summary: 'done', evidenceRefs });
    const duplicateTaskCompleted = buildEnvelope({ envelopeId: 'task-envelope-duplicate', idempotencyKey: 'task-1', summary: 'duplicate', evidenceRefs });
    const messageSent = buildEnvelope({
      type: 'message.sent',
      envelopeId: 'message-envelope',
      idempotencyKey: 'message-1',
      fromRoleId: 'operator',
      toRoleId: 'leader',
      summary: 'note',
      body: 'details',
      kind: 'note',
    });
    const approvalRequested = buildEnvelope({
      type: 'approval.requested',
      envelopeId: 'approval-envelope',
      idempotencyKey: 'approval-1',
      workflowTaskId: 'task-1',
      roleId: 'operator',
      reason: 'Need approval',
      requestedAction: 'Write file',
      risk: 'Changes workspace',
    });
    ingress.pullQueue = [[
      buildOutboxRecord(1, workflowPlan),
      buildOutboxRecord(2, taskCompleted),
      buildOutboxRecord(3, duplicateTaskCompleted),
      buildOutboxRecord(4, messageSent),
      buildOutboxRecord(5, approvalRequested),
    ]];
    const service = new TeamRuntimeService({ ingress, nowMs: () => 1000, randomId: () => 'id' });

    await Promise.all([
      service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope),
      service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-2' }, runtimeScope),
    ]);
    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const snapshot = snapshotResponse.data as {
      workflowPlan?: { workflowPlanId: string };
      dispatchTasks: Array<{ status: string; statusReason?: string; artifactId?: string }>;
      artifacts: Array<{ artifactId: string; roleId: string; stageId: string; summary?: string; evidenceRefs: unknown[]; sourceEnvelopeId: string; idempotencyKey: string }>;
      messages: unknown[];
      approvals: unknown[];
      gates: unknown[];
      kickbacks: unknown[];
      events: Array<{ type: string }>;
    };

    expect(ingress.maxConcurrentPulls).toBe(1);
    expect(ingress.ackedSequences).toEqual([1, 2, 3, 4, 5]);
    expect(snapshot.workflowPlan).toEqual(expect.objectContaining({ workflowPlanId: 'workflow-plan-plan-1' }));
    expect(snapshot.artifacts).toEqual([expect.objectContaining({
      artifactId: 'team-artifact-task-1',
      roleId: 'operator',
      stageId: 'task-1',
      summary: 'done',
      evidenceRefs,
      sourceEnvelopeId: 'task-envelope',
      idempotencyKey: 'task-1',
    })]);
    expect(snapshot.dispatchTasks).toEqual([expect.objectContaining({ status: 'completed', statusReason: 'done', artifactId: 'team-artifact-task-1' })]);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.approvals).toHaveLength(1);
    expect(snapshot.gates).toHaveLength(0);
    expect(snapshot.kickbacks).toHaveLength(0);
    expect(snapshot.events.map((event) => event.type)).toEqual([
      'workflow.plan_submitted',
      'task.completed',
      'message.sent',
      'approval.requested',
    ]);
  });

  it('keeps approval resolution separate from gates and kickbacks', async () => {
    const ingress = new FakeTeamIngressPort();
    const approvalRequested = buildEnvelope({
      type: 'approval.requested',
      envelopeId: 'approval-envelope',
      idempotencyKey: 'approval-1',
      workflowTaskId: 'task-1',
      roleId: 'operator',
      reason: 'Needs review',
      requestedAction: 'Proceed',
      risk: 'Incorrect result',
    });
    ingress.pullQueue = [[buildOutboxRecord(1, approvalRequested)]];
    const service = new TeamRuntimeService({ ingress, nowMs: () => 1000, randomId: () => 'id' });

    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope);
    await service.invoke('team.approvalResolve', {
      runId: 'run-1',
      approvalId: 'team-approval-approval-1',
      decision: 'deny',
      note: 'Needs rework',
      idempotencyKey: 'approval-deny-1',
    }, runtimeScope);

    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const snapshot = snapshotResponse.data as {
      approvals: Array<{ approvalId: string; status: string; note?: string }>;
      gates: unknown[];
      kickbacks: unknown[];
      events: Array<{ type: string }>;
    };

    expect(snapshot.approvals).toEqual([expect.objectContaining({ approvalId: 'team-approval-approval-1', status: 'denied', note: 'Needs rework' })]);
    expect(snapshot.gates).toHaveLength(0);
    expect(snapshot.kickbacks).toHaveLength(0);
    expect(snapshot.events.map((event) => event.type)).toEqual(expect.arrayContaining(['approval.requested', 'approval.resolved']));
    expect(snapshot.events.map((event) => event.type)).not.toContain('kickback.created');
  });

  it('persists Team mail delivery state and retries until prompt delivery succeeds', async () => {
    const ingress = new FakeTeamIngressPort();
    let now = 1000;
    const deliveries: Parameters<TeamMailDeliveryPort['deliver']>[0][] = [];
    const taskDeliveries: Parameters<TeamMailDeliveryPort['deliver']>[0][] = [];
    const mailDelivery: TeamMailDeliveryPort = {
      async deliver(input) {
        deliveries.push(input);
        if (input.mail.kind === 'task.assignment') {
          taskDeliveries.push(input);
          if (taskDeliveries.length === 1) {
            return { mailId: input.mail.mailId, status: 'failed', reason: 'session busy' };
          }
        }
        return { mailId: input.mail.mailId, status: 'delivered', deliveredAt: now };
      },
    };
    const service = new TeamRuntimeService({
      ingress,
      mailDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents: vi.fn(),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(async (input) => ({ ...input, sessionKey: input.sessionIdentity.sessionKey })),
        promptRoleSession: vi.fn(),
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nowMs: () => now,
      randomId: () => 'id',
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);
    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' }, runtimeScope);
    await service.invoke('team.planWorkflow', {
      runId: 'run-1',
      title: 'Workflow plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [{ taskId: 'task-1', roleId: 'operator', title: 'Task 1', prompt: 'Do task 1' }],
      idempotencyKey: 'plan-1',
    }, runtimeScope);

    let snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    let snapshot = snapshotResponse.data as { mails: Array<{ status: string; attempt: number; nextRetryAt?: number; lastError?: string }>; run: { status: string } };
    expect(taskDeliveries).toHaveLength(1);
    expect(snapshot.mails).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task.assignment', status: 'retry_scheduled', attempt: 1, nextRetryAt: 31_000, lastError: 'session busy' })]));
    expect(snapshot.run.status).toBe('waiting_for_user');

    now = 31_000;
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-retry-1' }, runtimeScope);
    snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const retrySnapshot = snapshotResponse.data as { mails: Array<{ kind: string; status: string; attempt: number; deliveredAt?: number }> };
    expect(taskDeliveries).toHaveLength(2);
    expect(retrySnapshot.mails).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task.assignment', status: 'delivered', attempt: 2, deliveredAt: 31_000 })]));
  });

  it('marks the run failed when required mail exhausts retries', async () => {
    const ingress = new FakeTeamIngressPort();
    let now = 1000;
    const mailDelivery: TeamMailDeliveryPort = {
      async deliver(input) {
        return { mailId: input.mail.mailId, status: 'failed', reason: 'session offline' };
      },
    };
    const service = new TeamRuntimeService({
      ingress,
      mailDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents: vi.fn(),
      },
      nowMs: () => now,
      randomId: () => 'id',
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);
    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' }, runtimeScope);
    await service.invoke('team.planWorkflow', {
      runId: 'run-1',
      title: 'Workflow plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [{ taskId: 'task-1', roleId: 'operator', title: 'Task 1', prompt: 'Do task 1' }],
      idempotencyKey: 'plan-1',
    }, runtimeScope);

    now = 31_000;
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-retry-1' }, runtimeScope);
    now = 61_000;
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-retry-2' }, runtimeScope);

    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const snapshot = snapshotResponse.data as { run: { status: string }; mails: Array<{ kind: string; status: string; attempt: number; lastError?: string }> };
    expect(snapshot.run.status).toBe('failed');
    expect(snapshot.mails).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'task.assignment', status: 'failed', attempt: 3, lastError: 'session offline' })]));
  });

  it('delivers role messages through Team mail with message-specific mail kinds', async () => {
    const ingress = new FakeTeamIngressPort();
    const mailDelivery = new FakeTeamMailDeliveryPort();
    const service = new TeamRuntimeService({
      ingress,
      mailDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      agentMaterialization: {
        materialize: vi.fn(async (input) => ({
          teamId: input.teamId,
          managedAgents: [
            { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
            { teamId: input.teamId, roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
          ],
        })),
        removeTeamAgents: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });
    const note = buildEnvelope({
      type: 'message.sent',
      envelopeId: 'message-note-envelope',
      idempotencyKey: 'message-note-1',
      kind: 'note',
      fromRoleId: 'operator',
      toRoleId: 'leader',
      summary: 'FYI',
      body: 'details',
    });
    const kickback = buildEnvelope({
      type: 'message.sent',
      envelopeId: 'message-kickback-envelope',
      idempotencyKey: 'message-kickback-1',
      kind: 'kickback',
      fromRoleId: 'leader',
      toRoleId: 'operator',
      summary: 'Needs rework',
      body: 'Fix missing citation',
      relatedTaskId: 'task-1',
      failureItems: [{ code: 'missing-source', message: 'Add source citation' }],
    });

    await service.invoke('team.provisionAgents', { packagePath: '/pkg', idempotencyKey: 'provision-1' }, runtimeScope);
    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-1', idempotencyKey: 'create-1' }, runtimeScope);
    ingress.pullQueue = [[buildOutboxRecord(1, note), buildOutboxRecord(2, kickback)]];
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope);

    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const snapshot = snapshotResponse.data as { mails: Array<{ kind: string; toAgentId: string; required?: boolean; relatedEntity: { kind: string; id: string } }>; kickbacks: unknown[] };
    expect(mailDelivery.deliveries.map((delivery) => delivery.mail.kind)).toEqual(['message.note', 'message.kickback']);
    expect(snapshot.mails).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'message.note', toAgentId: 'leader-agent', required: false, relatedEntity: { kind: 'message', id: 'team-message-message-note-1' } }),
      expect.objectContaining({ kind: 'message.kickback', toAgentId: 'operator-agent', required: true, relatedEntity: { kind: 'task', id: 'task-1' } }),
    ]));
    expect(snapshot.kickbacks).toHaveLength(1);
  });

  it('does not mark failed envelope idempotency as processed before a successful retry', async () => {
    const ingress = new FakeTeamIngressPort();
    const artifactUpdatedBeforePublish = buildEnvelope({
      type: 'artifact.updated',
      envelopeId: 'artifact-update-envelope',
      idempotencyKey: 'artifact-update-1',
      artifactId: 'artifact-1',
      summary: 'updated summary',
    });
    const artifactPublished = buildEnvelope({
      type: 'artifact.published',
      envelopeId: 'artifact-publish-envelope',
      idempotencyKey: 'artifact-publish-1',
      artifactId: 'artifact-1',
      stageId: 'task-1',
      roleId: 'operator',
      kind: 'report',
      title: 'Report',
      contentRef: 'artifact:report',
    });
    const service = new TeamRuntimeService({ ingress, nowMs: () => 1000, randomId: () => 'id' });

    ingress.pullQueue = [[buildOutboxRecord(1, artifactUpdatedBeforePublish)]];
    await expect(service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-fail' }, runtimeScope)).rejects.toThrow('Artifact must exist before update: artifact-1');

    ingress.pullQueue = [[buildOutboxRecord(2, artifactPublished), buildOutboxRecord(3, artifactUpdatedBeforePublish)]];
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-retry' }, runtimeScope);

    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const snapshot = snapshotResponse.data as { artifacts: Array<{ artifactId: string; summary?: string }> };
    expect(snapshot.artifacts).toEqual([expect.objectContaining({ artifactId: 'artifact-1', summary: 'updated summary' })]);
  });

  it('projects generic gate failures into kickback messages and blocks completion until resolved', async () => {
    const ingress = new FakeTeamIngressPort();
    const workflowPlan = buildEnvelope({
      type: 'workflow.plan_submitted',
      envelopeId: 'plan-envelope',
      idempotencyKey: 'plan-1',
      title: 'Workflow plan',
      groups: [{ groupId: 'group-1', title: 'Group 1', taskIds: ['task-1'], join: { requireCompleted: true, allowFailed: false, retryLimit: 0 } }],
      tasks: [{ taskId: 'task-1', roleId: 'operator', title: 'Task 1', prompt: 'Do task 1' }],
    });
    const taskCompleted = buildEnvelope({ envelopeId: 'task-envelope', idempotencyKey: 'task-1', summary: 'done' });
    const gateOpened = buildEnvelope({
      type: 'gate.opened',
      envelopeId: 'gate-open-envelope',
      idempotencyKey: 'gate-open-1',
      gateId: 'review-gate-1',
      stageId: 'task-1',
      gateType: 'review',
      subjectArtifactId: 'team-artifact-task-1',
      relatedTaskId: 'task-1',
      blocking: true,
      summary: 'Review task output',
    });
    const gateFailed = buildEnvelope({
      type: 'gate.resolved',
      envelopeId: 'gate-failed-envelope',
      idempotencyKey: 'gate-failed-1',
      gateId: 'review-gate-1',
      verdict: 'Needs rework',
      passed: false,
      failureItems: [{ code: 'missing-source', message: 'Add source citation', severity: 'blocker' }],
    });
    const gatePassed = buildEnvelope({
      type: 'gate.resolved',
      envelopeId: 'gate-passed-envelope',
      idempotencyKey: 'gate-passed-1',
      gateId: 'review-gate-1',
      verdict: 'Accepted',
      passed: true,
      failureItems: [],
    });
    ingress.pullQueue = [[buildOutboxRecord(1, workflowPlan), buildOutboxRecord(2, taskCompleted)]];
    const service = new TeamRuntimeService({ ingress, nowMs: () => 1000, randomId: () => 'id' });

    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' }, runtimeScope);
    let snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    let snapshot = snapshotResponse.data as { run: { status: string }; kickbacks: unknown[] };
    expect(snapshot.run.status).toBe('completed');
    expect(snapshot.kickbacks).toHaveLength(0);

    ingress.pullQueue = [[buildOutboxRecord(3, gateOpened), buildOutboxRecord(4, gateFailed)]];
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-2' }, runtimeScope);
    snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    snapshot = snapshotResponse.data as {
      run: { status: string };
      gates: Array<{ gateId: string; status: string; passed?: boolean; failureItems: unknown[] }>;
      kickbacks: Array<{ gateId: string; taskId: string; resolvedAt?: number; failureItems: unknown[] }>;
      messages: Array<{ kind: string; relatedGateId?: string; relatedTaskId?: string; failureItems: unknown[] }>;
    };
    expect(snapshot.run.status).toBe('waiting_for_user');
    expect(snapshot.gates).toEqual([expect.objectContaining({ gateId: 'review-gate-1', status: 'failed', passed: false })]);
    expect(snapshot.kickbacks).toEqual([expect.objectContaining({ gateId: 'review-gate-1', taskId: 'task-1', failureItems: [expect.objectContaining({ code: 'missing-source' })] })]);
    expect(snapshot.messages).toEqual([expect.objectContaining({ kind: 'kickback', relatedGateId: 'review-gate-1', relatedTaskId: 'task-1' })]);

    ingress.pullQueue = [[buildOutboxRecord(5, gatePassed)]];
    await service.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-3' }, runtimeScope);
    snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    snapshot = snapshotResponse.data as { run: { status: string }; gates: Array<{ status: string; passed?: boolean }>; kickbacks: Array<{ resolvedAt?: number }> };
    expect(snapshot.run.status).toBe('completed');
    expect(snapshot.gates).toEqual([expect.objectContaining({ status: 'passed', passed: true })]);
    expect(snapshot.kickbacks).toEqual([expect.objectContaining({ resolvedAt: 10 })]);
  });

  it('plans TeamSkill dependencies from the skill catalog instead of marking every dependency available', async () => {
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      packageService: {
        validate: vi.fn(async () => buildTeamPackageValidation({
          dependencies: {
            skills: [
              { name: 'installed-skill', required: true, purpose: 'installed' },
              { name: 'missing-required', source: 'https://skills.sh/?q=missing-required', required: true, purpose: 'required' },
              { name: 'missing-optional', source: './skills/missing-optional', required: false, purpose: 'optional' },
            ],
            tools: [
              { name: 'read', source: 'builtin', required: false, purpose: 'read files' },
            ],
            yaml: '',
          },
        })),
      },
      skillCatalog: {
        snapshot: vi.fn(async () => ({
          skills: [
            { skillKey: 'installed-skill', name: 'Installed Skill', installed: true, eligible: true },
            { skillKey: 'disabled-skill', name: 'Disabled Skill', installed: true, disabled: true },
          ],
        })),
      },
    });

    const response = await service.invoke('team.dependencyPlan', { packagePath: '/pkg' }, runtimeScope);

    expect(response.status).toBe(200);
    expect(response.data).toEqual(expect.objectContaining({
      canProceed: false,
      missingRequiredSkills: [expect.objectContaining({ name: 'missing-required' })],
      missingOptionalSkills: [expect.objectContaining({ name: 'missing-optional' })],
      missingRequiredTools: [],
      missingOptionalTools: [],
    }));
    expect((response.data as { items: Array<{ name: string; status: string; severity: string; installable: boolean }> }).items).toEqual([
      expect.objectContaining({ name: 'installed-skill', status: 'available', severity: 'ok', installable: false }),
      expect.objectContaining({ name: 'missing-required', status: 'missing', severity: 'blocker', installable: false }),
      expect.objectContaining({ name: 'missing-optional', status: 'missing', severity: 'warning', installable: true }),
      expect.objectContaining({ name: 'read', status: 'available', severity: 'ok', installable: false }),
    ]);
  });

  it('returns explicit port-unconfigured receipts instead of host-core-not-ready placeholders', async () => {
    const service = new TeamRuntimeService({ ingress: new FakeTeamIngressPort() });

    await expect(service.invoke('team.packageValidate', { packagePath: '/pkg' }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 202,
      data: expect.objectContaining({ code: 'TEAM_PACKAGE_VALIDATION_PORT_NOT_CONFIGURED' }),
    }));
    await expect(service.invoke('team.dependencyPlan', { packagePath: '/pkg' }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 202,
      data: expect.objectContaining({ code: 'TEAM_DEPENDENCY_PLAN_PORT_NOT_CONFIGURED' }),
    }));
  });

  it('rejects dependency planning when the skill catalog port is not configured', async () => {
    const service = new TeamRuntimeService({
      ingress: new FakeTeamIngressPort(),
      packageService: {
        validate: vi.fn(async () => buildTeamPackageValidation()),
      },
    });

    await expect(service.invoke('team.dependencyPlan', { packagePath: '/pkg' }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 202,
      data: expect.objectContaining({ code: 'TEAM_SKILL_CATALOG_PORT_NOT_CONFIGURED' }),
    }));
  });
});
