import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityRouter } from '../../runtime-host/application/capabilities/contracts/capability-router';
import {
  createTeamRuntimeCapabilityOperationRoutes,
  teamRuntimeCapabilityOperations,
  TEAM_RUNTIME_CAPABILITY_ID,
} from '../../runtime-host/application/capabilities/team/team-runtime-capability';
import { TeamRuntimeService } from '../../runtime-host/application/team-runtime/team-runtime-service';
import type { DeleteTeamManagedAgentsJobPayload, TeamRuntimeJobPort } from '../../runtime-host/application/team-runtime/team-runtime-jobs';
import type { TeamAgentCommandLedgerRecord } from '../../runtime-host/application/team-runtime/domain/team-command-ledger';
import type { AppendTeamAgentCommandInput, TeamCommandLedgerPort } from '../../runtime-host/application/team-runtime/ports/team-command-ledger-port';
import type { TeamNodePromptDeliveryPort } from '../../runtime-host/application/team-runtime/ports/team-node-prompt-delivery-port';
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


class FakeTeamRuntimeJobPort implements TeamRuntimeJobPort {
  deleteManagedAgentsSubmissions: DeleteTeamManagedAgentsJobPayload[] = [];

  async submitDeleteManagedAgents(payload: DeleteTeamManagedAgentsJobPayload) {
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

class FakeTeamNodePromptDeliveryPort implements TeamNodePromptDeliveryPort {
  deliveries: Parameters<TeamNodePromptDeliveryPort['deliver']>[0][] = [];

  constructor(private readonly onDeliver?: (input: Parameters<TeamNodePromptDeliveryPort['deliver']>[0]) => Promise<void>) {}

  async deliver(input: Parameters<TeamNodePromptDeliveryPort['deliver']>[0]) {
    this.deliveries.push(input);
    await this.onDeliver?.(input);
    return { deliveryRecordId: input.delivery.deliveryRecordId, status: 'delivered', deliveredAt: 1000 } as const;
  }
}

class FakeTeamCommandLedgerPort implements TeamCommandLedgerPort {
  records: TeamAgentCommandLedgerRecord[] = [];

  async append(input: AppendTeamAgentCommandInput): Promise<TeamAgentCommandLedgerRecord> {
    const existing = this.records.find((record) => record.runId === input.command.runId && record.idempotencyKey === input.command.idempotencyKey);
    if (existing) return existing;
    const record: TeamAgentCommandLedgerRecord = {
      recordId: `team-command-record-${this.records.length + 1}`,
      runId: input.command.runId,
      sequence: this.records.filter((candidate) => candidate.runId === input.command.runId).length + 1,
      commandId: input.command.commandId,
      type: input.command.type,
      idempotencyKey: input.command.idempotencyKey,
      command: input.command,
      status: input.status,
      ...(input.rejectionReason ? { rejectionReason: input.rejectionReason } : {}),
      createdAt: input.command.createdAt,
      ...(input.status === 'accepted' ? { acceptedAt: input.command.createdAt } : { rejectedAt: input.command.createdAt }),
    };
    this.records.push(record);
    return record;
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

  async listTeamInstances() {
    return Object.values(this.teamInstances);
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
  it('describes run listing, graph commands, trigger commands, approval resolution, resume, and team deletion with final target operations', () => {
    expect(teamRuntimeCapabilityOperations).toEqual([
      expect.objectContaining({ id: 'team.packageValidate', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.dependencyPlan', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.provisionAgents', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.delete', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.runCreate', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.runList', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.triggerList', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.webhookTriggerFire', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.runSnapshot', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.graphSave', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.graphPatch', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.graphContext', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.graphExportYaml', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.graphImportYaml', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.triggerFire', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.roleMessageSubmit', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.nodePromptRetryDue', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.nodeEvent', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.runDiagnostics', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.runDecisionSubmit', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.resume', targetKind: 'team' }),
      expect.objectContaining({ id: 'team.approvalResolve', targetKind: 'team-approval' }),
      expect.objectContaining({ id: 'team.runCancel', targetKind: 'team-run' }),
      expect.objectContaining({ id: 'team.runDelete', targetKind: 'team-run' }),
    ]);
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

  it('invokes triggerList as an internal runtime-wide read without team target binding', async () => {
    const response = { status: 200, data: { triggers: [] } };
    const invoke = vi.fn(async () => response);
    const { route } = createRouteFor('team.triggerList', invoke);
    const domainInput = {};

    await expect(Promise.resolve(route.handle({
      capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.triggerList',
      scope: runtimeScope,
      target: null,
      input: domainInput,
      domainInput,
    }))).resolves.toBe(response);
    expect(invoke).toHaveBeenCalledWith(
      'team.triggerList',
      domainInput,
      runtimeScope,
    );
  });

  it.each([
    ['team.runSnapshot', { runId: 'run-input' }],
    ['team.runDiagnostics', { runId: 'run-input' }],
    ['team.graphSave', { runId: 'run-input', idempotencyKey: 'graph-1', graph: { nodes: [], edges: [], status: 'draft' } }],
    ['team.graphPatch', { runId: 'run-input', summary: 'Patch graph', patch: { operations: [{ op: 'set_metadata', metadata: { purpose: 'test' } }] }, idempotencyKey: 'patch-1' }],
    ['team.graphContext', { runId: 'run-input', view: 'graph_summary' }],
    ['team.graphExportYaml', { runId: 'run-input' }],
    ['team.graphImportYaml', { runId: 'run-input', yaml: 'nodes: []\nedges: []\n', idempotencyKey: 'import-1' }],
    ['team.triggerFire', { runId: 'run-input', startNodeId: 'start-1', triggerSource: 'webhook', idempotencyKey: 'trigger-1' }],
    ['team.roleMessageSubmit', { runId: 'run-input', roleId: 'leader', text: 'hello', idempotencyKey: 'chat-1' }],
    ['team.nodePromptRetryDue', { runId: 'run-input' }],
    ['team.nodeEvent', { runId: 'run-input', nodeExecutionId: 'node-execution-1', event: 'complete', summary: 'Completed', idempotencyKey: 'node-event-1' }],
    ['team.runDecisionSubmit', { runId: 'run-input', decision: 'retry', idempotencyKey: 'decision-1' }],
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
    ['team.graphPatch', { runId: 'run-target', summary: 'Patch graph', patch: { operations: [{ op: 'set_metadata', metadata: { purpose: 'test' } }] }, idempotencyKey: 'patch-1' }],
    ['team.graphContext', { runId: 'run-target', view: 'graph_summary' }],
    ['team.roleMessageSubmit', { runId: 'run-target', roleId: 'leader', text: 'hello', idempotencyKey: 'chat-1' }],
    ['team.nodeEvent', { runId: 'run-target', nodeExecutionId: 'node-execution-1', event: 'complete', summary: 'Completed', idempotencyKey: 'node-event-1' }],
  ] as const)('rejects %s team-run target and scope runId mismatches before invoking the service', async (operationId, domainInput) => {
    await expectRouteDeniedBeforeInvoke({
      operationId,
      scope: teamRunScope,
      target: { kind: 'team-run', runId: 'run-target' },
      domainInput,
      error: 'Team runtime target runId must match scope runId',
    });
  });

  it.each([
    ['team.graphSave', { runId: 'run-1', graph: { nodes: [], edges: [], status: 'draft' } }, 'Team runtime input idempotencyKey is required'],
    ['team.graphSave', { runId: 'run-1', idempotencyKey: 'graph-1' }, 'Team runtime input graph is required'],
    ['team.graphImportYaml', { runId: 'run-1', yaml: 'nodes: []\nedges: []\n' }, 'Team runtime input idempotencyKey is required'],
    ['team.graphImportYaml', { runId: 'run-1', idempotencyKey: 'import-1' }, 'Team runtime input yaml is required'],
    ['team.graphPatch', { runId: 'run-1', patch: { operations: [] }, idempotencyKey: 'patch-1' }, 'Team runtime input summary is required'],
    ['team.graphPatch', { runId: 'run-1', summary: 'Patch graph', idempotencyKey: 'patch-1' }, 'Team runtime input patch is required'],
    ['team.graphPatch', { runId: 'run-1', summary: 'Patch graph', patch: { operations: [] } }, 'Team runtime input idempotencyKey is required'],
    ['team.graphPatch', { runId: 'run-1', summary: 'Patch graph', patch: { operations: [] }, idempotencyKey: 'patch-1' }, 'Team runtime input patch.operations must be a non-empty array'],
    ['team.triggerFire', { runId: 'run-1', triggerSource: 'webhook', idempotencyKey: 'trigger-1' }, 'Team runtime input startNodeId is required'],
    ['team.triggerFire', { runId: 'run-1', startNodeId: 'start-1', idempotencyKey: 'trigger-1' }, 'Team runtime input triggerSource is required'],
    ['team.triggerFire', { runId: 'run-1', startNodeId: 'start-1', triggerSource: 'webhook' }, 'Team runtime input idempotencyKey is required'],
    ['team.roleMessageSubmit', { runId: 'run-1', text: 'hello', idempotencyKey: 'chat-1' }, 'Team runtime input roleId is required'],
    ['team.roleMessageSubmit', { runId: 'run-1', roleId: 'leader', idempotencyKey: 'chat-1' }, 'Team runtime input text is required'],
    ['team.roleMessageSubmit', { runId: 'run-1', roleId: 'leader', text: 'hello' }, 'Team runtime input idempotencyKey is required'],
    ['team.webhookTriggerFire', {}, 'Team runtime input webhookPath is required'],
    ['team.nodeEvent', { runId: 'run-1', event: 'complete', summary: 'Completed', idempotencyKey: 'node-event-1' }, 'Team runtime input nodeExecutionId is required'],
    ['team.nodeEvent', { runId: 'run-1', nodeExecutionId: 'node-execution-1', summary: 'Completed', idempotencyKey: 'node-event-1' }, 'Team runtime input event is required'],
    ['team.nodeEvent', { runId: 'run-1', nodeExecutionId: 'node-execution-1', event: 'complete', idempotencyKey: 'node-event-1' }, 'Team runtime input summary is required'],
    ['team.nodeEvent', { runId: 'run-1', nodeExecutionId: 'node-execution-1', event: 'complete', summary: 'Completed' }, 'Team runtime input idempotencyKey is required'],
    ['team.resume', { teamId: 'team-1' }, 'Team runtime input idempotencyKey is required'],
    ['team.runCancel', { runId: 'run-1' }, 'Team runtime input idempotencyKey is required'],
    ['team.runDecisionSubmit', { runId: 'run-1', idempotencyKey: 'decision-1' }, 'Team runtime input decision is required'],
    ['team.runDecisionSubmit', { runId: 'run-1', decision: 'retry' }, 'Team runtime input idempotencyKey is required'],
  ] as const)('rejects %s missing required action input before invoking the service', async (operationId, domainInput, error) => {
    await expectRouteDeniedBeforeInvoke({
      operationId,
      target: operationId === 'team.resume' || operationId === 'team.webhookTriggerFire' ? { kind: 'team', teamId: 'team-1' } : { kind: 'team-run', runId: 'run-1' },
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

  it('allows manual provisionAgents with manualTeam members before invoking the service', async () => {
    const response = { status: 200, data: { success: true, teamId: 'manual-team' } };
    const invoke = vi.fn(async () => response);
    const { route } = createRouteFor('team.provisionAgents', invoke);
    const domainInput = {
      packagePath: '/manual-team',
      sourceType: 'manual',
      idempotencyKey: 'manual-provision-1',
      manualTeam: {
        name: 'manual-team',
        members: [
          { agentId: 'existing-leader-agent', agentName: 'Existing Leader', workspace: '/agents/existing-leader', roleId: 'selected-leader', isLeader: true },
        ],
      },
    };

    await expect(Promise.resolve(route.handle({
      capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.provisionAgents',
      scope: runtimeScope,
      target: { kind: 'team', packagePath: '/manual-team' },
      input: domainInput,
      domainInput,
    }))).resolves.toBe(response);
    expect(invoke).toHaveBeenCalledWith(
      'team.provisionAgents',
      domainInput,
      runtimeScope,
    );
  });

  it.each([
    [
      'manualTeam',
      { packagePath: '/manual-team', sourceType: 'manual', idempotencyKey: 'manual-provision-1' },
      'Team runtime input manualTeam is required',
    ],
    [
      'manualTeam.members',
      { packagePath: '/manual-team', sourceType: 'manual', idempotencyKey: 'manual-provision-1', manualTeam: { name: 'manual-team' } },
      'Team runtime input manualTeam.members must be a non-empty array',
    ],
  ] as const)('rejects manual provisionAgents missing %s before invoking the service', async (_missingField, domainInput, error) => {
    await expectRouteDeniedBeforeInvoke({
      operationId: 'team.provisionAgents',
      target: { kind: 'team', packagePath: '/manual-team' },
      domainInput,
      error,
    });
  });

  it('provisions TeamInstance managed agents without creating a run', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const removeTeamAgents = vi.fn();
    const service = new TeamRuntimeService({
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

  it('provisions manual TeamInstance agents and creates manual runs from the existing TeamInstance', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const manualTeam = {
      name: 'manual-team',
      description: 'Manual team assembled from existing agents',
      version: 'manual-v1',
      members: [
        {
          agentId: 'existing-leader-agent',
          agentName: 'Existing Leader',
          workspace: '/agents/existing-leader',
          roleId: 'selected-leader',
          isLeader: true,
          skills: ['leader-skill'],
          tools: ['read'],
          model: 'claude-sonnet-4-5',
        },
        {
          agentId: 'existing-operator-agent',
          agentName: 'Existing Operator',
          workspace: '/agents/existing-operator',
          roleId: 'operator',
          skills: ['operator-skill'],
          tools: ['write'],
        },
      ],
    };
    const materialize = vi.fn(async (input) => ({
      teamId: input.teamId,
      managedAgents: [
        {
          teamId: input.teamId,
          roleId: input.leader.roleId,
          agentId: input.leader.sourceAgentId,
          displayName: input.leader.agentName,
          workspace: input.leader.sourceWorkspace,
          endpoint: runtimeScope.endpoint,
          model: input.leader.model,
          lifecycle: 'external' as const,
        },
        ...input.roles.map((role) => ({
          teamId: input.teamId,
          roleId: role.roleId,
          agentId: role.sourceAgentId,
          displayName: role.agentName,
          workspace: role.sourceWorkspace,
          endpoint: runtimeScope.endpoint,
          lifecycle: 'external' as const,
        })),
      ],
    }));
    const service = new TeamRuntimeService({
      stateStore,
      agentMaterialization: {
        materialize,
        removeTeamAgents: vi.fn(),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await expect(service.invoke('team.provisionAgents', {
      packagePath: '/manual-team',
      sourceType: 'manual',
      manualTeam,
      idempotencyKey: 'manual-provision-1',
    }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 200,
      data: { teamId: 'manual-team', managedAgentCount: 2 },
    }));
    expect(materialize).toHaveBeenCalledWith(expect.objectContaining({
      teamId: 'manual-team',
      sourceType: 'manual',
      leader: expect.objectContaining({
        roleId: 'leader',
        sourceAgentId: 'existing-leader-agent',
        sourceWorkspace: '/agents/existing-leader',
      }),
      roles: [expect.objectContaining({
        roleId: 'operator',
        sourceAgentId: 'existing-operator-agent',
        sourceWorkspace: '/agents/existing-operator',
      })],
    }));
    expect(materialize.mock.calls[0]![0].leader.roleId).toBe('leader');
    expect(materialize.mock.calls[0]![0].leader.roleMarkdown).toContain('## Role baseline');
    expect(materialize.mock.calls[0]![0].roles[0]?.roleMarkdown).toContain('Treat the current node prompt as the assignment source.');
    expect(materialize.mock.calls[0]![0].roles[0]).not.toHaveProperty('purpose');
    expect(stateStore.teamInstances['manual-team']).toEqual(expect.objectContaining({
      teamId: 'manual-team',
      teamSkillName: 'manual-team',
      teamSkillVersion: 'manual-v1',
      packagePath: '/manual-team',
      sourceType: 'manual',
      managedAgents: [
        expect.objectContaining({ roleId: 'leader', agentId: 'existing-leader-agent', workspace: '/agents/existing-leader', lifecycle: 'external' }),
        expect.objectContaining({ roleId: 'operator', agentId: 'existing-operator-agent', workspace: '/agents/existing-operator', lifecycle: 'external' }),
      ],
      runs: [],
    }));

    materialize.mockClear();
    await expect(service.invoke('team.runCreate', {
      packagePath: '/manual-team',
      sourceType: 'manual',
      runId: 'manual-run-1',
      idempotencyKey: 'manual-create-1',
    }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 200,
      data: expect.objectContaining({ runId: 'manual-run-1', status: 'created' }),
    }));

    expect(materialize).not.toHaveBeenCalled();
    expect(stateStore.teamInstances['manual-team']).toEqual(expect.objectContaining({
      runs: [expect.objectContaining({
        runId: 'manual-run-1',
        sessions: [
          expect.objectContaining({ roleId: 'leader', agentId: 'existing-leader-agent' }),
          expect.objectContaining({ roleId: 'operator', agentId: 'existing-operator-agent' }),
        ],
      })],
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
    };
    const service = new TeamRuntimeService({
      stateStore,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    const response = await service.invoke('team.resume', { teamId: 'team-package', idempotencyKey: 'resume-1' }, runtimeScope);

    expect(response.data).toEqual(expect.objectContaining({
      success: true,
      teamId: 'team-package',
      restoredRunIds: ['run-active', 'run-terminal'],
      activeRunIds: ['run-active'],
      skippedTerminalRunIds: ['run-terminal'],
      runs: [
        expect.objectContaining({ runId: 'run-active', status: 'waiting_for_user', updatedAt: 1200 }),
        expect.objectContaining({ runId: 'run-terminal', status: 'completed', updatedAt: 1100 }),
      ],
    }));
    expect(service.runRegistry.listNonTerminalRunIds()).toEqual(['run-active']);
  });

  it('rehydrates persisted non-terminal TeamRuns into the run registry without UI resume', async () => {
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
        { teamId: 'team-package', runId: 'run-webhook', status: 'running', revision: 2, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 900, updatedAt: 1000 },
        { teamId: 'team-package', runId: 'run-done', status: 'completed', revision: 3, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 900, updatedAt: 1100 },
      ],
      createdAt: 900,
      updatedAt: 1100,
    };
    stateStore.runStates['run-webhook'] = {
      run: { teamId: 'team-package', runId: 'run-webhook', status: 'running', revision: 4, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', createdAt: 900, updatedAt: 1200 },
      graphRunState: {
        runId: 'run-webhook',
        workflowPlanId: 'workflow-1',
        definition: {
          graphId: 'graph-1',
          workflowPlanId: 'workflow-1',
          runId: 'run-webhook',
          title: 'Graph',
          status: 'draft',
          idempotencyKey: 'graph-1',
          createdAt: 900,
          nodes: [{ nodeId: 'start', kind: 'start', nodeKind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/deploy/ready' } }, metadata: {} }],
          edges: [],
          groups: [],
        },
        nodeExecutionsByNodeId: {},
        readyQueue: [],
        readyQueueItems: [],
        readyQueueHead: 0,
        queuedReadyNodeIds: [],
        completedNodeIds: [],
        nodeInputStateByNodeId: {},
      },
      processedIdempotencyKeys: [],
    };
    const service = new TeamRuntimeService({ stateStore, nowMs: () => 1000, randomId: () => 'id' });

    const rehydrated = await service.rehydrateActiveRuns();
    const triggerList = await service.invoke('team.triggerList', {}, runtimeScope);

    expect(rehydrated).toEqual({
      success: true,
      restoredRunIds: ['run-webhook', 'run-done'],
      activeRunIds: ['run-webhook'],
      skippedTerminalRunIds: ['run-done'],
    });
    expect(triggerList.data).toEqual({
      triggers: [expect.objectContaining({ runId: 'run-webhook', startNodeId: 'start', trigger: { mode: 'webhook', path: '/deploy/ready' } })],
    });
  });

  it('fires webhook triggers by path inside R3 and rejects duplicate matches before firing', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'operator', agentId: 'operator-agent', displayName: 'operator', workspace: '/team/operator', endpoint: runtimeScope.endpoint },
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 1100,
    };
    let randomIdSequence = 0;
    const service = new TeamRuntimeService({ stateStore, nowMs: () => 1000, randomId: () => `id-${randomIdSequence += 1}` });
    for (const runId of ['run-a', 'run-b']) {
      await service.invoke('team.runCreate', { packagePath: '/pkg', runId, idempotencyKey: `create-${runId}` }, runtimeScope);
      await service.invoke('team.graphSave', {
        runId,
        idempotencyKey: `graph-${runId}`,
        graph: {
          nodes: [
            { nodeId: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: runId === 'run-a' ? '/deploy/ready/' : 'deploy/ready' } } },
            { nodeId: 'work', kind: 'work', taskId: 'work', roleId: 'operator', title: 'Work', config: { prompt: 'Do work' } },
          ],
          edges: [{ edgeId: 'start-work', sourceNodeId: 'start', targetNodeId: 'work', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } }],
          status: 'draft',
        },
      }, runtimeScope);
    }

    await expect(service.invoke('team.webhookTriggerFire', {
      webhookPath: '/deploy/ready',
      deterministicBodyHash: 'body-hash',
    }, runtimeScope)).resolves.toEqual(expect.objectContaining({
      status: 409,
      data: expect.objectContaining({ success: false }),
    }));

    await service.invoke('team.runCancel', { runId: 'run-b', idempotencyKey: 'cancel-run-b' }, runtimeScope);
    const fired = await service.invoke('team.webhookTriggerFire', {
      webhookPath: 'deploy/ready',
      deterministicBodyHash: 'body-hash',
      payloadSummary: 'body:12 bytes',
    }, runtimeScope);
    const duplicateFallback = await service.invoke('team.webhookTriggerFire', {
      webhookPath: 'deploy/ready',
      deterministicBodyHash: 'body-hash',
      payloadSummary: 'body:12 bytes',
    }, runtimeScope);
    const changedBody = await service.invoke('team.webhookTriggerFire', {
      webhookPath: 'deploy/ready',
      deterministicBodyHash: 'other-body-hash',
      payloadSummary: 'body:12 bytes',
    }, runtimeScope);
    const firedData = fired.data as { fired: boolean; snapshot: { events: Array<{ type: string; payload: Record<string, unknown> }> } };
    const duplicateData = duplicateFallback.data as { fired: boolean };
    const changedBodyData = changedBody.data as { fired: boolean };

    expect(fired.status).toBe(200);
    expect(firedData.fired).toBe(true);
    expect(duplicateData.fired).toBe(true);
    expect(changedBodyData.fired).toBe(true);
    expect(firedData.snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'trigger.fired', payload: expect.objectContaining({ startNodeId: 'start', triggerSource: 'webhook', payloadSummary: 'body:12 bytes', deterministicBodyHash: 'body-hash' }) }),
    ]));
  });

  it('rejects runCreate when Team agents have not been provisioned', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const materialize = vi.fn();
    const service = new TeamRuntimeService({
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
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'shared-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
        { teamId: 'team-package', roleId: 'financial-analyst', agentId: 'shared-agent', displayName: 'financial-analyst', workspace: '/team/roles/financial-analyst', endpoint: runtimeScope.endpoint },
      ],
    }]);
    expect(stateStore.writeTeamInstanceCount).toBe(0);
    expect(stateStore.deletedTeamInstanceIds).toEqual(['team-package']);
    expect(stateStore.teamInstances['team-package']).toBeUndefined();
  });

  it('materializes the leader without deprecated TeamRun MCP allowlist tools', async () => {
    const materialize = vi.fn(async (input) => ({
      teamId: input.teamId,
      managedAgents: [
        { teamId: input.teamId, roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
      ],
    }));
    const service = new TeamRuntimeService({
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
      }),
      roles: [expect.objectContaining({
        roleId: 'financial-analyst',
        agentName: 'financial-analyst',
      })],
    }));
    expect(materialize.mock.calls[0]![0].leader.tools).toBeUndefined();
  });

  it('saves TeamRun graph config into the run snapshot without plugin tools or script execution', async () => {
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
      stateStore,
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
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-graph', idempotencyKey: 'create-graph' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-graph',
      idempotencyKey: 'graph-save-1',
      graph: {
        nodes: [
          {
            nodeId: 'node-a',
            taskId: 'task-a',
            roleId: 'operator',
            title: 'Task A',
            executor: { kind: 'team-role', roleId: 'operator', retry: 2 },
            config: { prompt: 'Do task A', temperature: 0.2 },
            metadata: { canvas: { x: 10, y: 20 }, position: { x: 30, y: 40 } },
          },
          {
            nodeId: 'node-b',
            taskId: 'task-b',
            roleId: 'operator',
            title: 'Task B',
            executor: { kind: 'team-role', roleId: 'operator' },
            config: { prompt: 'Do task B' },
          },
        ],
        edges: [
          { edgeId: 'edge-a-b', sourceNodeId: 'node-a', targetNodeId: 'node-b', action: 'activate', payload: { includeUpstreamResult: true }, metadata: { manual: true } },
        ],
        status: 'draft',
        metadata: { layout: 'manual' },
      },
    }, runtimeScope);

    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-graph' }, runtimeScope);
    const snapshot = snapshotResponse.data as { graph: { nodes: Array<{ nodeId: string; executor?: Record<string, unknown>; config?: Record<string, unknown>; metadata?: Record<string, unknown> }>; edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string; metadata?: Record<string, unknown> }>; metadata?: Record<string, unknown> } | null };
    expect(snapshot.graph?.edges).toEqual([expect.objectContaining({ edgeId: 'edge-a-b', sourceNodeId: 'node-a', targetNodeId: 'node-b', action: 'activate', payload: { includeUpstreamResult: true }, metadata: { manual: true } })]);
    expect(snapshot.graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'node-a',
        executor: expect.objectContaining({ kind: 'team-role', roleId: 'operator', retry: 2 }),
        config: expect.objectContaining({ prompt: 'Do task A', temperature: 0.2 }),
        metadata: expect.objectContaining({ canvas: { x: 10, y: 20 }, position: { x: 30, y: 40 } }),
      }),
    ]));
    expect(snapshot.graph?.metadata).toEqual({ layout: 'manual' });

    const graphContextResponse = await service.invoke('team.graphContext', { runId: 'run-graph', view: 'graph_summary' }, runtimeScope);
    const graphContext = graphContextResponse.data as { fieldGuide: Record<string, string>; graph: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } | null };
    expect(graphContext.fieldGuide['graph.edges[].status']).toBe('satisfied means the source node has produced this sourcePort. waiting means this edge is not yet satisfied.');
    expect(graphContext.graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'node-a', kind: 'work', title: 'Task A', roleId: 'operator' }),
    ]));
    expect(graphContext.graph?.nodes[0]).not.toHaveProperty('config');
    expect(graphContext.graph?.nodes[0]).not.toHaveProperty('executor');
    expect(graphContext.graph?.nodes[0]).not.toHaveProperty('metadata');
    expect(graphContext.graph?.edges).toEqual([expect.objectContaining({ edgeId: 'edge-a-b', sourceNodeId: 'node-a', targetNodeId: 'node-b', status: 'waiting', action: 'activate', payload: { includeUpstreamResult: true } })]);
    expect(stateStore.writes.at(-1)).toEqual(expect.objectContaining({ graphRunState: expect.any(Object) }));

    const writeCountBeforeExport = stateStore.writes.length;
    const exportResponse = await service.invoke('team.graphExportYaml', { runId: 'run-graph' }, runtimeScope);
    const exported = exportResponse.data as { runId: string; fileName: string; yaml: string };
    const exportedYaml = parseYaml(exported.yaml) as {
      version: number;
      runId: string;
      workflowPlanId: string;
      status: string;
      nodes: Array<{ id: string; kind: string; roleId?: string; config?: Record<string, unknown>; metadata?: Record<string, unknown> }>;
      edges: Array<{ id: string; from: string; to: string; edgeType: string; action: string; payload: { includeUpstreamResult: boolean }; metadata?: Record<string, unknown> }>;
      metadata?: Record<string, unknown>;
      nodeExecutions?: unknown;
      nodeDeliveries?: unknown;
    };

    expect(exported.runId).toBe('run-graph');
    expect(exported.fileName).toBe('TeamRun graph.yaml');
    expect(exportedYaml).toEqual(expect.objectContaining({
      version: 1,
      runId: 'run-graph',
      workflowPlanId: 'graph-graph-save-1',
      status: 'draft',
      metadata: { layout: 'manual' },
    }));
    expect(exportedYaml.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'node-a',
        kind: 'work',
        roleId: 'operator',
        config: expect.objectContaining({ prompt: 'Do task A' }),
        metadata: expect.objectContaining({ canvas: { x: 10, y: 20 }, position: { x: 30, y: 40 } }),
      }),
    ]));
    expect(exportedYaml.edges).toEqual([
      expect.objectContaining({ id: 'edge-a-b', from: 'node-a', to: 'node-b', edgeType: 'completed_success', action: 'activate', payload: { includeUpstreamResult: true }, metadata: { manual: true } }),
    ]);
    expect(exportedYaml.nodeExecutions).toBeUndefined();
    expect(exportedYaml.nodeDeliveries).toBeUndefined();
    expect(stateStore.writes).toHaveLength(writeCountBeforeExport);

    const importResponse = await service.invoke('team.graphImportYaml', {
      runId: 'run-graph',
      yaml: exported.yaml,
      idempotencyKey: 'graph-import-yaml-1',
    }, runtimeScope);
    const imported = importResponse.data as { imported: boolean; snapshot: { graph: { nodes: Array<{ nodeId: string; metadata?: Record<string, unknown> }>; edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }> } | null } };
    expect(imported.imported).toBe(true);
    expect(imported.snapshot.graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: 'node-a',
        roleId: 'operator',
        metadata: expect.objectContaining({ canvas: { x: 10, y: 20 }, position: { x: 30, y: 40 } }),
      }),
    ]));
    expect(imported.snapshot.graph?.edges).toEqual([
      expect.objectContaining({ edgeId: 'edge-a-b', sourceNodeId: 'node-a', targetNodeId: 'node-b' }),
    ]);
  });

  it('instantiates saved Team graph template into each new TeamRun without execution history', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const commandLedger = new FakeTeamCommandLedgerPort();
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
      commandLedger,
      stateStore,
      packageService: {
        validate: async () => buildTeamPackageValidation({
          name: 'team-package',
          roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
        }),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { teamId: 'team-package', packagePath: '/pkg', runId: 'run-template-source', idempotencyKey: 'create-template-source' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-template-source',
      idempotencyKey: 'graph-template-save',
      graph: {
        nodes: [
          { nodeId: 'start', kind: 'start', title: 'Start', metadata: { position: { x: 0, y: 0 } } },
          { nodeId: 'work', kind: 'work', roleId: 'operator', title: 'Do Work', config: { prompt: 'Use this prompt' }, metadata: { position: { x: 120, y: 0 } } },
        ],
        edges: [{ edgeId: 'edge-start-work', sourceNodeId: 'start', targetNodeId: 'work', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } }],
        status: 'draft',
      },
    }, runtimeScope);
    await service.invoke('team.nodeEvent', {
      runId: 'run-template-source',
      nodeExecutionId: 'start:attempt:1',
      event: 'complete',
      summary: 'source run completed start',
      result: { kind: 'trigger', summary: 'source' },
      idempotencyKey: 'node-event-template-source-start',
    }, runtimeScope);

    await service.invoke('team.runCreate', { teamId: 'team-package', packagePath: '/pkg', runId: 'run-template-new', idempotencyKey: 'create-template-new' }, runtimeScope);
    const newSnapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-template-new' }, runtimeScope);
    const newSnapshot = newSnapshotResponse.data as { graph: { runId?: string; nodes: Array<{ nodeId: string; roleId?: string; status?: string; config?: Record<string, unknown>; metadata?: Record<string, unknown> }>; edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }> } | null; nodeExecutions: Array<{ runId: string; nodeId: string; nodeExecutionId?: string; status: string; summary?: string }> };

    expect(newSnapshot.graph?.runId).toBe('run-template-new');
    expect(newSnapshot.graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'start', status: 'ready', metadata: expect.objectContaining({ runId: 'run-template-new', position: { x: 0, y: 0 } }) }),
      expect.objectContaining({ nodeId: 'work', roleId: 'operator', status: 'pending', config: expect.objectContaining({ prompt: 'Use this prompt' }), metadata: expect.objectContaining({ runId: 'run-template-new', position: { x: 120, y: 0 } }) }),
    ]));
    expect(newSnapshot.graph?.edges).toEqual([
      expect.objectContaining({ edgeId: 'edge-start-work', sourceNodeId: 'start', targetNodeId: 'work' }),
    ]);
    expect(newSnapshot.nodeExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'run-template-new', nodeId: 'start', nodeExecutionId: 'start:attempt:1', status: 'ready' }),
      expect.objectContaining({ runId: 'run-template-new', nodeId: 'work', nodeExecutionId: 'work:attempt:1', status: 'pending' }),
    ]));
    expect(newSnapshot.nodeExecutions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'run-template-new', summary: 'source run completed start' }),
    ]));
  });

  it('promotes a legacy TeamRun graph into the Team graph template before creating the next TeamRun', async () => {
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
      runs: [
        { teamId: 'team-package', runId: 'run-legacy-source', status: 'running', revision: 3, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', sessions: [], createdAt: 900, updatedAt: 1200 },
      ],
      createdAt: 900,
      updatedAt: 1200,
    };
    stateStore.runStates['run-legacy-source'] = {
      run: { teamId: 'team-package', runId: 'run-legacy-source', status: 'running', revision: 3, packageName: 'team-package', packageVersion: '1.0.0', sourcePath: '/pkg', createdAt: 900, updatedAt: 1200 },
      graphRunState: {
        runId: 'run-legacy-source',
        workflowPlanId: 'graph-legacy',
        definition: {
          graphId: 'team-graph:run-legacy-source',
          workflowPlanId: 'graph-legacy',
          runId: 'run-legacy-source',
          title: 'Team graph',
          status: 'draft',
          idempotencyKey: 'graph-legacy-save',
          createdAt: 950,
          nodes: [
            { nodeId: 'start', nodeKind: 'start', kind: 'start', title: 'Start', metadata: { workflowPlanId: 'graph-legacy', runId: 'run-legacy-source', title: 'Start', position: { x: 0, y: 0 } } },
            { nodeId: 'work', nodeKind: 'work', kind: 'work', taskId: 'work', roleId: 'operator', title: 'Do Work', executor: { kind: 'team-role', roleId: 'operator' }, config: { prompt: 'Legacy prompt' }, metadata: { workflowPlanId: 'graph-legacy', runId: 'run-legacy-source', taskId: 'work', roleId: 'operator', title: 'Do Work', position: { x: 120, y: 0 } } },
          ],
          edges: [{ edgeId: 'edge-start-work', sourceNodeId: 'start', targetNodeId: 'work', kind: 'completed_success', type: 'completed_success', sourcePort: 'completed', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true }, metadata: {} }],
          groups: [],
          metadata: { layout: 'legacy' },
        },
        nodeExecutionsByNodeId: {
          start: { attempts: [{ attemptId: 'start:attempt:1', nodeExecutionId: 'start:attempt:1', attemptNumber: 1, nodeId: 'start', nodeKind: 'start', status: 'completed', reason: 'initial', inputContexts: [], outputArtifactIds: [], createdAt: 950, updatedAt: 960, completedAt: 960, summary: 'legacy source completed start' }] },
          work: { attempts: [{ attemptId: 'work:attempt:1', nodeExecutionId: 'work:attempt:1', attemptNumber: 1, nodeId: 'work', nodeKind: 'work', status: 'pending', reason: 'initial', inputContexts: [], outputArtifactIds: [], createdAt: 950, updatedAt: 950 }] },
        },
        readyQueue: [],
        readyQueueItems: [],
        readyQueueHead: 0,
        queuedReadyNodeIds: [],
        completedNodeIds: ['start'],
        completedNodeOutputPortsByNodeId: { start: ['completed'] },
        nodeInputStateByNodeId: {},
      },
      processedIdempotencyKeys: ['graph-legacy-save'],
    };
    const service = new TeamRuntimeService({
      stateStore,
      nowMs: () => 2000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { teamId: 'team-package', packagePath: '/pkg', runId: 'run-legacy-new', idempotencyKey: 'create-legacy-new' }, runtimeScope);
    const newSnapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-legacy-new' }, runtimeScope);
    const newSnapshot = newSnapshotResponse.data as { graph: { runId?: string; nodes: Array<{ nodeId: string; roleId?: string; status?: string; config?: Record<string, unknown>; metadata?: Record<string, unknown> }>; edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }> } | null; nodeExecutions: Array<{ runId: string; nodeId: string; nodeExecutionId?: string; status: string; summary?: string }> };

    expect(newSnapshot.graph?.runId).toBe('run-legacy-new');
    expect(newSnapshot.graph?.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'start', status: 'ready', metadata: expect.objectContaining({ runId: 'run-legacy-new', position: { x: 0, y: 0 } }) }),
      expect.objectContaining({ nodeId: 'work', roleId: 'operator', status: 'pending', config: expect.objectContaining({ prompt: 'Legacy prompt' }), metadata: expect.objectContaining({ runId: 'run-legacy-new', position: { x: 120, y: 0 } }) }),
    ]));
    expect(newSnapshot.graph?.edges).toEqual([
      expect.objectContaining({ edgeId: 'edge-start-work', sourceNodeId: 'start', targetNodeId: 'work' }),
    ]);
    expect(newSnapshot.nodeExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'run-legacy-new', nodeId: 'start', nodeExecutionId: 'start:attempt:1', status: 'ready' }),
      expect.objectContaining({ runId: 'run-legacy-new', nodeId: 'work', nodeExecutionId: 'work:attempt:1', status: 'pending' }),
    ]));
    expect(newSnapshot.nodeExecutions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'run-legacy-new', summary: 'legacy source completed start' }),
    ]));
    expect(stateStore.teamInstances['team-package']).toEqual(expect.objectContaining({
      graphTemplate: expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({ nodeId: 'work', config: expect.objectContaining({ prompt: 'Legacy prompt' }) }),
        ]),
      }),
    }));
  });

  it('upgrades a Team role message into the current role entry WorkNode attempt input', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort();
    const promptRoleSession = vi.fn(async (input: Parameters<TeamRoleSessionPort['promptRoleSession']>[0]) => ({
      runId: input.binding.runId,
      roleId: input.binding.roleId,
      sessionKey: input.binding.sessionKey,
      promptRunId: 'role-chat-run-1',
    }));
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 900,
    };
    const service = new TeamRuntimeService({
      stateStore,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(),
        promptRoleSession,
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nodePromptDelivery,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-role-message', idempotencyKey: 'create-role-message' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-role-message',
      idempotencyKey: 'graph-role-message',
      graph: {
        nodes: [
          { nodeId: 'leader-plan', kind: 'work', taskId: 'leader-plan', roleId: 'leader', title: 'Plan', config: { prompt: 'Plan the team run' } },
        ],
        edges: [],
        status: 'draft',
      },
    }, runtimeScope);

    const response = await service.invoke('team.roleMessageSubmit', {
      runId: 'run-role-message',
      roleId: 'leader',
      text: 'Analyze Series B investment in Anthropic',
      idempotencyKey: 'chat-leader-1',
    }, runtimeScope);

    expect(promptRoleSession).not.toHaveBeenCalled();
    expect(nodePromptDelivery.deliveries).toHaveLength(1);
    const deliveredPrompt = nodePromptDelivery.deliveries[0]!.delivery.prompt;
    expect(deliveredPrompt).toContain('### Node event lifecycle');
    expect(deliveredPrompt).toContain('stop calling Team Node Event for this nodeExecutionId');
    expect(deliveredPrompt).toContain('wait for a new TeamRun node prompt with a new nodeExecutionId');
    expect(deliveredPrompt).toContain('### Attempt user message');
    expect(deliveredPrompt.indexOf('### Node work')).toBeLessThan(deliveredPrompt.indexOf('### Attempt user message'));
    expect(deliveredPrompt.trim().endsWith('Analyze Series B investment in Anthropic')).toBe(true);
    expect(nodePromptDelivery.deliveries[0]!.delivery.displayMessage).toBe('Analyze Series B investment in Anthropic');
    const result = response.data as { submitted: boolean; snapshot: { nodeExecutions: Array<{ nodeId: string; status: string }>; events: Array<{ type: string }> } };
    expect(result.submitted).toBe(true);
    expect(result.snapshot.nodeExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'leader-plan', status: 'running' }),
    ]));
    expect(result.snapshot.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'entry_message.submitted' }),
      expect.objectContaining({ type: 'dispatch.task_prompted' }),
    ]));

    await expect(service.invoke('team.roleMessageSubmit', {
      runId: 'run-role-message',
      roleId: 'leader',
      text: 'Do not steer into the active node run',
      idempotencyKey: 'chat-leader-2',
    }, runtimeScope)).rejects.toThrow('TEAM_ROLE_NODE_PROMPT_ACTIVE');
    expect(promptRoleSession).not.toHaveBeenCalled();
    expect(nodePromptDelivery.deliveries).toHaveLength(1);
  });

  it('cancels active TeamRun graph work and releases role prompt occupancy', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort();
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 900,
    };
    const service = new TeamRuntimeService({
      stateStore,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(),
        promptRoleSession: vi.fn(async (input: Parameters<TeamRoleSessionPort['promptRoleSession']>[0]) => ({
          runId: input.binding.runId,
          roleId: input.binding.roleId,
          sessionKey: input.binding.sessionKey,
          promptRunId: 'role-chat-after-cancel',
        })),
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nodePromptDelivery,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-cancel-active', idempotencyKey: 'create-cancel-active' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-cancel-active',
      idempotencyKey: 'graph-cancel-active',
      graph: {
        nodes: [
          { nodeId: 'leader-plan', kind: 'work', taskId: 'leader-plan', roleId: 'leader', title: 'Plan', config: { prompt: 'Plan the team run' } },
        ],
        edges: [],
        status: 'draft',
      },
    }, runtimeScope);
    const cancelResponse = await service.invoke('team.runCancel', { runId: 'run-cancel-active', reason: 'stop', idempotencyKey: 'cancel-active' }, runtimeScope);
    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-cancel-active' }, runtimeScope);
    const snapshot = snapshotResponse.data as {
      graph: { status: string } | null;
      nodeExecutions: Array<{ nodeId: string; status: string }>;
      dispatchTasks: Array<{ status: string; statusReason?: string }>;
      dispatchExecutions: Array<{ status: string; statusReason?: string }>;
      events: Array<{ type: string }>;
    };

    expect(cancelResponse.data).toEqual(expect.objectContaining({ runId: 'run-cancel-active', status: 'cancelled' }));
    expect(snapshot.graph?.status).toBe('cancelled');
    expect(snapshot.nodeExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'leader-plan', status: 'cancelled' }),
    ]));
    expect(snapshot.dispatchTasks).toEqual([]);
    expect(snapshot.dispatchExecutions).toEqual([]);
    expect(snapshot.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'run.cancelled' })]));
    const chatAfterCancel = await service.invoke('team.roleMessageSubmit', {
      runId: 'run-cancel-active',
      roleId: 'leader',
      text: 'send after cancel',
      idempotencyKey: 'chat-after-cancel',
    }, runtimeScope);
    expect(chatAfterCancel.data).toEqual(expect.objectContaining({ submitted: true }));
    expect(nodePromptDelivery.deliveries).toHaveLength(0);
  });

  it('submits Team role chat without firing StartNode-only graphs', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort();
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 900,
    };
    const service = new TeamRuntimeService({
      stateStore,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(),
        promptRoleSession: vi.fn(async (input: Parameters<TeamRoleSessionPort['promptRoleSession']>[0]) => ({
          runId: input.binding.runId,
          roleId: input.binding.roleId,
          sessionKey: input.binding.sessionKey,
          promptRunId: 'role-chat-start-only',
        })),
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nodePromptDelivery,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-start-only', idempotencyKey: 'create-start-only' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-start-only',
      idempotencyKey: 'graph-start-only',
      graph: {
        nodes: [{ nodeId: 'start-webhook', kind: 'start', title: 'Webhook', config: { trigger: { mode: 'webhook', path: 'incoming' } } }],
        edges: [],
        status: 'draft',
      },
    }, runtimeScope);

    const response = await service.invoke('team.roleMessageSubmit', {
      runId: 'run-start-only',
      roleId: 'leader',
      text: 'hello',
      idempotencyKey: 'chat-start-only',
    }, runtimeScope);

    expect(response.data).toEqual(expect.objectContaining({ submitted: true }));
    expect(nodePromptDelivery.deliveries).toHaveLength(0);
  });

  it('submits a non-entry Team role message to the workspace session with workspace context only', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort();
    const promptRoleSession = vi.fn(async (input: Parameters<TeamRoleSessionPort['promptRoleSession']>[0]) => ({
      runId: input.binding.runId,
      roleId: input.binding.roleId,
      sessionKey: input.binding.sessionKey,
      promptRunId: 'role-chat-non-entry',
    }));
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
      stateStore,
      packageService: {
        validate: async () => buildTeamPackageValidation({ name: 'team-package', sourcePath: '/pkg', roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }] }),
      },
      roleSessions: {
        ensureRoleSession: vi.fn(),
        promptRoleSession,
        abortRoleSession: vi.fn(),
        deleteRoleSession: vi.fn(),
        readRoleSessionWindow: vi.fn(),
      },
      nodePromptDelivery,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-non-entry-chat', idempotencyKey: 'create-non-entry-chat' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-non-entry-chat',
      idempotencyKey: 'graph-non-entry-chat',
      graph: {
        nodes: [
          { nodeId: 'leader-plan', kind: 'work', taskId: 'leader-plan', roleId: 'leader', title: 'Plan', config: { prompt: 'Plan the team run' } },
          { nodeId: 'operator-work', kind: 'work', taskId: 'operator-work', roleId: 'operator', title: 'Operate', config: { prompt: 'Operate after leader' } },
        ],
        edges: [
          { edgeId: 'leader-to-operator', sourceNodeId: 'leader-plan', targetNodeId: 'operator-work', sourcePort: 'completed', targetPort: 'input', action: 'activate', payload: { includeUpstreamResult: true } },
        ],
        status: 'draft',
      },
    }, runtimeScope);

    const response = await service.invoke('team.roleMessageSubmit', {
      runId: 'run-non-entry-chat',
      roleId: 'operator',
      text: 'hello operator',
      idempotencyKey: 'chat-operator-1',
    }, runtimeScope);

    expect(response.data).toEqual(expect.objectContaining({ submitted: true }));
    expect(nodePromptDelivery.deliveries).toHaveLength(0);
    expect(promptRoleSession).toHaveBeenCalledWith(expect.objectContaining({
      binding: expect.objectContaining({ roleId: 'operator', agentId: 'operator-agent' }),
      message: expect.stringContaining('### TeamRun workspace context'),
      displayMessage: 'hello operator',
      idempotencyKey: 'chat-operator-1',
    }));
    const message = promptRoleSession.mock.calls[0]![0].message;
    expect(message).toContain('hello operator');
    expect(message).toContain('- runId: run-non-entry-chat');
    expect(message).toContain('- roleId: operator');
    expect(message).not.toContain('- nodeExecutionId:');
    expect(message).not.toContain('### Attempt user message');
  });

  it('accepts nodeEvent complete through the command ledger and rejects unknown nodeExecutionId with a rejected ledger record', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const commandLedger = new FakeTeamCommandLedgerPort();
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
      commandLedger,
      stateStore,
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
      nodePromptDelivery: new FakeTeamNodePromptDeliveryPort(),
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-node-event', idempotencyKey: 'create-node-event' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-node-event',
      idempotencyKey: 'graph-save-node-event',
      graph: {
        nodes: [
          { nodeId: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/incoming' } } },
          { nodeId: 'work', kind: 'work', taskId: 'work', roleId: 'operator', title: 'Work', config: { outputArtifactKind: 'report' } },
        ],
        edges: [{ edgeId: 'start-work', sourceNodeId: 'start', targetNodeId: 'work', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } }],
        status: 'draft',
      },
    }, runtimeScope);
    const fired = await service.invoke('team.triggerFire', {
      runId: 'run-node-event',
      startNodeId: 'start',
      triggerSource: 'webhook',
      idempotencyKey: 'trigger-node-event',
    }, runtimeScope);
    const firedSnapshot = fired.data as { snapshot: { nodeExecutions: Array<{ nodeId: string; nodeExecutionId?: string; status: string }> } };
    const workExecution = firedSnapshot.snapshot.nodeExecutions.find((execution) => execution.nodeId === 'work');

    expect(workExecution).toEqual(expect.objectContaining({ status: 'running', nodeExecutionId: expect.any(String) }));

    const completeResponse = await service.invoke('team.nodeEvent', {
      runId: 'run-node-event',
      nodeExecutionId: workExecution?.nodeExecutionId,
      event: 'complete',
      roleId: 'operator',
      summary: 'Work completed',
      outputPort: 'completed',
      evidenceRefs: [{ type: 'artifact', id: 'artifact-1', label: 'Work report' }],
      idempotencyKey: 'node-event-complete',
    }, runtimeScope);
    const completeData = completeResponse.data as { record: TeamAgentCommandLedgerRecord; snapshot: { graph: { nodes: Array<{ nodeId: string; status?: string; artifactId?: string }>; status: string }; artifacts: Array<{ artifactId: string; kind: string; summary?: string; evidenceRefs: unknown[]; sourceEnvelopeId: string; idempotencyKey: string }> } };

    expect(completeData.record).toEqual(expect.objectContaining({
      status: 'accepted',
      type: 'team.node_event',
      idempotencyKey: 'node-event-complete',
    }));
    expect(commandLedger.records).toEqual([expect.objectContaining({ status: 'accepted', idempotencyKey: 'node-event-complete' })]);
    expect(completeData.snapshot.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'work', status: 'completed', artifactId: 'team-artifact-node-event-complete' }),
    ]));
    expect(completeData.snapshot.artifacts).toEqual([expect.objectContaining({
      artifactId: 'team-artifact-node-event-complete',
      kind: 'artifact',
      summary: 'Work completed',
      evidenceRefs: [{ type: 'artifact', id: 'artifact-1', label: 'Work report' }],
      idempotencyKey: 'node-event-complete',
    })]);

    await expect(service.invoke('team.nodeEvent', {
      runId: 'run-node-event',
      nodeExecutionId: 'missing-node-execution',
      event: 'complete',
      summary: 'Invalid completion',
      idempotencyKey: 'node-event-invalid',
    }, runtimeScope)).rejects.toThrow('nodeExecutionId missing-node-execution does not belong to the current TeamRun graph state.');
    expect(commandLedger.records).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'rejected',
        idempotencyKey: 'node-event-invalid',
        rejectionReason: 'nodeExecutionId missing-node-execution does not belong to the current TeamRun graph state.',
      }),
    ]));

    await expect(service.invoke('team.nodeEvent', {
      runId: 'run-node-event',
      nodeExecutionId: 'missing-node-execution',
      event: 'complete',
      summary: 'Invalid completion retry',
      idempotencyKey: 'node-event-invalid',
    }, runtimeScope)).rejects.toThrow('nodeExecutionId missing-node-execution does not belong to the current TeamRun graph state.');
    expect(commandLedger.records.filter((record) => record.idempotencyKey === 'node-event-invalid')).toHaveLength(1);
  });

  it('preserves completed node execution state when graphSave only changes node position', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const commandLedger = new FakeTeamCommandLedgerPort();
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
      commandLedger,
      stateStore,
      nodePromptDelivery: new FakeTeamNodePromptDeliveryPort(),
      packageService: {
        validate: async () => buildTeamPackageValidation({
          name: 'team-package',
          sourcePath: '/pkg',
          roles: [{ id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] }],
        }),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-layout-preserve', idempotencyKey: 'create-layout-preserve' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-layout-preserve',
      idempotencyKey: 'graph-save-layout-preserve',
      graph: {
        nodes: [
          { nodeId: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/layout-preserve' } }, metadata: { position: { x: 0, y: 0 } } },
          { nodeId: 'work', kind: 'work', taskId: 'work', roleId: 'operator', title: 'Work', config: { outputArtifactKind: 'report' }, metadata: { position: { x: 100, y: 0 } } },
        ],
        edges: [{ edgeId: 'start-work', sourceNodeId: 'start', targetNodeId: 'work', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } }],
        status: 'draft',
      },
    }, runtimeScope);

    const fired = await service.invoke('team.triggerFire', {
      runId: 'run-layout-preserve',
      startNodeId: 'start',
      triggerSource: 'webhook',
      idempotencyKey: 'trigger-layout-preserve',
    }, runtimeScope);
    const firedSnapshot = fired.data as { snapshot: { nodeExecutions: Array<{ nodeId: string; nodeExecutionId?: string; status: string }> } };
    const workExecution = firedSnapshot.snapshot.nodeExecutions.find((execution) => execution.nodeId === 'work');

    expect(workExecution).toEqual(expect.objectContaining({ status: 'running', nodeExecutionId: expect.any(String) }));

    const completeResponse = await service.invoke('team.nodeEvent', {
      runId: 'run-layout-preserve',
      nodeExecutionId: workExecution?.nodeExecutionId,
      event: 'complete',
      roleId: 'operator',
      summary: 'Work completed',
      outputPort: 'completed',
      idempotencyKey: 'node-event-layout-preserve',
    }, runtimeScope);
    const completeData = completeResponse.data as { snapshot: { graph: { nodes: Array<{ nodeId: string; status?: string; metadata?: Record<string, unknown> }>; status: string; edges: unknown[] } } };

    expect(completeData.snapshot.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'work', status: 'completed' }),
    ]));

    const layoutGraph = {
      ...completeData.snapshot.graph,
      nodes: completeData.snapshot.graph.nodes.map((node) => node.nodeId === 'work'
        ? { ...node, metadata: { ...(node.metadata ?? {}), position: { x: 140, y: 40 } } }
        : node),
    };
    const layoutSave = await service.invoke('team.graphSave', {
      runId: 'run-layout-preserve',
      idempotencyKey: 'graph-save-layout-preserve-position',
      graph: layoutGraph,
    }, runtimeScope);
    const layoutData = layoutSave.data as { snapshot: { graph: { nodes: Array<{ nodeId: string; status?: string; metadata?: Record<string, unknown> }> } } };

    expect(layoutData.snapshot.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'work', status: 'completed', metadata: expect.objectContaining({ position: { x: 140, y: 40 } }) }),
    ]));
  });

  it('routes leader role assignments to the matching downstream role prompt only', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const commandLedger = new FakeTeamCommandLedgerPort();
    const roleAssignments = [
      { roleId: 'financial-analyst', text: 'Analyze financing, valuation, and comparable rounds.' },
      { roleId: 'risk-analyst', text: 'Analyze key technical, market, and execution risks.' },
      { roleId: 'business-model-analyst', text: 'Analyze revenue model, margins, and go-to-market durability.' },
      { roleId: 'contrarian-investor', text: 'Challenge the bull case and write a no-vote memo.' },
    ];
    stateStore.teamInstances['team-package'] = {
      teamId: 'team-package',
      teamSkillName: 'team-package',
      teamSkillVersion: '1.0.0',
      packagePath: '/pkg',
      sourcePath: '/pkg',
      managedAgents: [
        { teamId: 'team-package', roleId: 'leader', agentId: 'leader-agent', displayName: 'leader', workspace: '/team/leader', endpoint: runtimeScope.endpoint },
        ...roleAssignments.map((assignment) => ({ teamId: 'team-package', roleId: assignment.roleId, agentId: `${assignment.roleId}-agent`, displayName: assignment.roleId, workspace: `/team/${assignment.roleId}`, endpoint: runtimeScope.endpoint })),
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 900,
    };
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort();
    const service = new TeamRuntimeService({
      commandLedger,
      stateStore,
      nodePromptDelivery,
      packageService: {
        validate: async () => buildTeamPackageValidation({
          name: 'team-package',
          sourcePath: '/pkg',
          roles: roleAssignments.map((assignment) => ({ id: assignment.roleId, purpose: assignment.text, agentsMd: `# ${assignment.roleId}`, skills: [], tools: [] })),
        }),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-role-assignments', idempotencyKey: 'create-role-assignments' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-role-assignments',
      idempotencyKey: 'graph-save-role-assignments',
      graph: {
        nodes: [
          { nodeId: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/assign' } } },
          { nodeId: 'leader-plan', kind: 'work', taskId: 'leader-plan', roleId: 'leader', title: 'Plan', config: { prompt: 'Plan role assignments' } },
          ...roleAssignments.map((assignment) => ({ nodeId: `${assignment.roleId}-work`, kind: 'work', taskId: `${assignment.roleId}-work`, roleId: assignment.roleId, title: assignment.roleId, config: { prompt: `Run ${assignment.roleId} analysis` } })),
        ],
        edges: [
          { edgeId: 'start-leader', sourceNodeId: 'start', targetNodeId: 'leader-plan', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } },
          ...roleAssignments.map((assignment) => ({ edgeId: `leader-${assignment.roleId}`, sourceNodeId: 'leader-plan', targetNodeId: `${assignment.roleId}-work`, sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } })),
        ],
        status: 'draft',
      },
    }, runtimeScope);
    const fired = await service.invoke('team.triggerFire', {
      runId: 'run-role-assignments',
      startNodeId: 'start',
      triggerSource: 'webhook',
      idempotencyKey: 'trigger-role-assignments',
    }, runtimeScope);
    const firedSnapshot = fired.data as { snapshot: { nodeExecutions: Array<{ nodeId: string; nodeExecutionId?: string; status: string }> } };
    const leaderExecution = firedSnapshot.snapshot.nodeExecutions.find((execution) => execution.nodeId === 'leader-plan');

    expect(leaderExecution).toEqual(expect.objectContaining({ status: 'running', nodeExecutionId: expect.any(String) }));

    await service.invoke('team.nodeEvent', {
      runId: 'run-role-assignments',
      nodeExecutionId: leaderExecution?.nodeExecutionId,
      event: 'complete',
      roleId: 'leader',
      outputPort: 'completed',
      summary: 'Leader assigned four role-specific work items',
      result: {
        kind: 'work',
        summary: 'Leader assigned four role-specific work items',
        assignments: roleAssignments,
      },
      idempotencyKey: 'leader-assign-roles',
    }, runtimeScope);

    const completedRoleNodeIds = new Set<string>();
    const completeDeliveredRoleNodes = async (): Promise<void> => {
      const deliveriesToComplete = nodePromptDelivery.deliveries.filter((delivery) => (
        roleAssignments.some((assignment) => delivery.delivery.nodeId === `${assignment.roleId}-work`)
        && !completedRoleNodeIds.has(delivery.delivery.nodeId)
      ));
      for (const delivery of deliveriesToComplete) {
        completedRoleNodeIds.add(delivery.delivery.nodeId);
        await service.invoke('team.nodeEvent', {
          runId: 'run-role-assignments',
          nodeExecutionId: delivery.delivery.nodeExecutionId,
          event: 'complete',
          roleId: delivery.delivery.roleId,
          summary: `${delivery.delivery.roleId} done`,
          idempotencyKey: `${delivery.delivery.roleId}-done`,
        }, runtimeScope);
      }
    };

    for (let attempt = 0; attempt < roleAssignments.length; attempt += 1) {
      const deliveredRoleNodeIds = new Set(nodePromptDelivery.deliveries
        .filter((delivery) => roleAssignments.some((assignment) => delivery.delivery.nodeId === `${assignment.roleId}-work`))
        .map((delivery) => delivery.delivery.nodeId));
      if (deliveredRoleNodeIds.size === roleAssignments.length) break;
      await completeDeliveredRoleNodes();
    }

    const promptsByNodeId = new Map(nodePromptDelivery.deliveries.map((delivery) => [delivery.delivery.nodeId, delivery.delivery.prompt]));
    expect(commandLedger.records).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'accepted', idempotencyKey: 'leader-assign-roles' })]));
    for (const assignment of roleAssignments) {
      const prompt = promptsByNodeId.get(`${assignment.roleId}-work`) ?? '';
      expect(prompt).toContain('## Upstream inputs');
      expect(prompt).toContain('leader-plan');
      expect(prompt).toContain(`assignments=${assignment.roleId}: ${assignment.text}`);
      for (const otherAssignment of roleAssignments.filter((candidate) => candidate.roleId !== assignment.roleId)) {
        expect(prompt).not.toContain(`${otherAssignment.roleId}: ${otherAssignment.text}`);
      }
    }
  });

  it('does not deliver a second prompt for the same role while the first node execution is active', async () => {
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
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort();
    const service = new TeamRuntimeService({
      stateStore,
      nodePromptDelivery,
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
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-same-role-prompts', idempotencyKey: 'create-same-role-prompts' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-same-role-prompts',
      idempotencyKey: 'graph-save-same-role-prompts',
      graph: {
        nodes: [
          { nodeId: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/same-role' } } },
          { nodeId: 'a', kind: 'work', taskId: 'a', roleId: 'operator', title: 'A', config: { prompt: 'Do A' } },
          { nodeId: 'b', kind: 'work', taskId: 'b', roleId: 'operator', title: 'B', config: { prompt: 'Do B' } },
        ],
        edges: [
          { edgeId: 'start-a', sourceNodeId: 'start', targetNodeId: 'a', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } },
          { edgeId: 'start-b', sourceNodeId: 'start', targetNodeId: 'b', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } },
        ],
        status: 'draft',
      },
    }, runtimeScope);
    const triggerResponse = await service.invoke('team.triggerFire', {
      runId: 'run-same-role-prompts',
      startNodeId: 'start',
      triggerSource: 'webhook',
      idempotencyKey: 'trigger-same-role-prompts',
    }, runtimeScope);
    const snapshot = triggerResponse.data as { snapshot: { nodePromptDeliveries: Array<{ nodeId: string; status: string }>; nodeExecutions: Array<{ nodeId: string; status: string }> } };

    expect(nodePromptDelivery.deliveries.map((delivery) => delivery.delivery.nodeId)).toEqual(['a']);
    expect(snapshot.snapshot.nodePromptDeliveries.map((delivery) => delivery.nodeId)).toEqual(['a']);
    expect(snapshot.snapshot.nodeExecutions).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'a', status: 'running' }),
      expect.objectContaining({ nodeId: 'b', status: 'ready' }),
    ]));
  });

  it('delivers ready node prompts concurrently and applies projections in scheduler order', async () => {
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
        { teamId: 'team-package', roleId: 'reviewer', agentId: 'reviewer-agent', displayName: 'reviewer', workspace: '/team/reviewer', endpoint: runtimeScope.endpoint },
      ],
      runs: [],
      createdAt: 900,
      updatedAt: 900,
    };
    let activeDeliveries = 0;
    let overlappedDeliveries = false;
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort(async () => {
      activeDeliveries += 1;
      overlappedDeliveries = overlappedDeliveries || activeDeliveries > 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeDeliveries -= 1;
    });
    const service = new TeamRuntimeService({
      stateStore,
      nodePromptDelivery,
      packageService: {
        validate: async () => ({
          valid: true,
          package: {
            name: 'team-package',
            version: '1.0.0',
            description: 'Team package',
            sourcePath: '/pkg',
            roles: [
              { id: 'operator', purpose: 'Operate', agentsMd: '# operator', skills: [], tools: [] },
              { id: 'reviewer', purpose: 'Review', agentsMd: '# reviewer', skills: [], tools: [] },
            ],
            skill: { markdown: '# skill' },
            workflow: { markdown: '# workflow' },
            dependencies: { skills: [], tools: [], yaml: 'skills: []\ntools: []\n' },
          },
          errors: [],
          warnings: [],
        }),
      },
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-parallel-prompts', idempotencyKey: 'create-parallel-prompts' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-parallel-prompts',
      idempotencyKey: 'graph-save-parallel-prompts',
      graph: {
        nodes: [
          { nodeId: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/parallel' } } },
          { nodeId: 'a', kind: 'work', taskId: 'a', roleId: 'operator', title: 'A', config: { prompt: 'Do A' } },
          { nodeId: 'c', kind: 'work', taskId: 'c', roleId: 'reviewer', title: 'C', config: { prompt: 'Do C' } },
        ],
        edges: [
          { edgeId: 'start-a', sourceNodeId: 'start', targetNodeId: 'a', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } },
          { edgeId: 'start-c', sourceNodeId: 'start', targetNodeId: 'c', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } },
        ],
        status: 'draft',
      },
    }, runtimeScope);
    const triggerResponse = await service.invoke('team.triggerFire', {
      runId: 'run-parallel-prompts',
      startNodeId: 'start',
      triggerSource: 'webhook',
      idempotencyKey: 'trigger-parallel-prompts',
    }, runtimeScope);
    const snapshot = triggerResponse.data as { snapshot: { nodePromptDeliveries: Array<{ nodeId: string; status: string }>; nodeDeliveries: Array<{ nodeId: string }>; dispatches: Array<{ taskId?: string; promptRef: string }> } };

    expect(nodePromptDelivery.deliveries.map((delivery) => delivery.delivery.nodeId)).toEqual(['a', 'c']);
    for (const delivery of nodePromptDelivery.deliveries) {
      expect(delivery.delivery.prompt).toContain('### Node context');
      expect(delivery.delivery.prompt).toContain('### Runtime endpoint tool arguments');
      expect(delivery.delivery.prompt).toContain('TeamRun tools use flat runtime endpoint fields.');
      expect(delivery.delivery.prompt).toContain('- runtimeKind: native-runtime');
      expect(delivery.delivery.prompt).toContain('- runtimeAdapterId: openclaw');
      expect(delivery.delivery.prompt).toContain('- runtimeInstanceId: local');
      expect(delivery.delivery.prompt).toContain('Correct tool argument fragment:');
      expect(delivery.delivery.prompt).toContain('"runtimeKind": "native-runtime",\n  "runtimeAdapterId": "openclaw",\n  "runtimeInstanceId": "local"');
      expect(delivery.delivery.prompt).not.toContain('runtimeEndpoint');
      expect(delivery.delivery.prompt).not.toContain('### TeamRun tool arguments');
      expect(delivery.delivery.prompt).not.toContain('runtimeEndpoint:\n{"kind":"native-runtime"');
      expect(delivery.delivery.prompt).not.toContain('## TeamRun command contract');
    }
    expect(overlappedDeliveries).toBe(true);
    expect(snapshot.snapshot.nodePromptDeliveries.map((delivery) => delivery.nodeId)).toEqual(['a', 'c']);
    expect(snapshot.snapshot.nodeDeliveries.map((delivery) => delivery.nodeId)).toEqual(['a', 'c']);
    expect(snapshot.snapshot.dispatches.map((dispatch) => dispatch.taskId)).toEqual(['a', 'c']);
  });

  it('rejects nodeEvent for a missing run without creating synthetic run state', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const commandLedger = new FakeTeamCommandLedgerPort();
    const service = new TeamRuntimeService({
      commandLedger,
      stateStore,
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await expect(service.invoke('team.nodeEvent', {
      runId: 'missing-node-event-run',
      nodeExecutionId: 'node-execution-1',
      event: 'complete',
      summary: 'Should not create a run',
      idempotencyKey: 'missing-run-node-event',
    }, runtimeScope)).rejects.toThrow('TeamRun missing-node-event-run must exist before accepting node events.');

    expect(commandLedger.records).toEqual([expect.objectContaining({
      status: 'rejected',
      idempotencyKey: 'missing-run-node-event',
      rejectionReason: 'TeamRun missing-node-event-run must exist before accepting node events.',
    })]);
    expect(stateStore.writes.at(-1)).toEqual(expect.objectContaining({ run: null }));
    expect(service.runRegistry.listNonTerminalRunIds()).toEqual([]);
  });

  it('resolves WorkNode approval requests without completing the node execution', async () => {
    const operations: TeamDrainOperation[] = [];
    const stateStore = new FakeTeamRuntimeStateStore(operations);
    const commandLedger = new FakeTeamCommandLedgerPort();
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
      commandLedger,
      stateStore,
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
      nodePromptDelivery: new FakeTeamNodePromptDeliveryPort(),
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-approval', idempotencyKey: 'create-approval' }, runtimeScope);
    await service.invoke('team.graphSave', {
      runId: 'run-approval',
      idempotencyKey: 'graph-save-approval',
      graph: {
        nodes: [
          { nodeId: 'start', kind: 'start', title: 'Start', config: { trigger: { mode: 'webhook', path: '/approval' } } },
          { nodeId: 'work', kind: 'work', taskId: 'work', roleId: 'operator', title: 'Work', config: { prompt: 'Work' } },
        ],
        edges: [{ edgeId: 'start-work', sourceNodeId: 'start', targetNodeId: 'work', sourcePort: 'completed', action: 'activate', payload: { includeUpstreamResult: true } }],
        status: 'draft',
      },
    }, runtimeScope);
    const fired = await service.invoke('team.triggerFire', {
      runId: 'run-approval',
      startNodeId: 'start',
      triggerSource: 'webhook',
      idempotencyKey: 'trigger-approval',
    }, runtimeScope);
    const firedSnapshot = fired.data as { snapshot: { nodeExecutions: Array<{ nodeId: string; nodeExecutionId?: string; status: string }> } };
    const workExecution = firedSnapshot.snapshot.nodeExecutions.find((execution) => execution.nodeId === 'work');

    await service.invoke('team.nodeEvent', {
      runId: 'run-approval',
      nodeExecutionId: workExecution?.nodeExecutionId,
      event: 'request_approval',
      roleId: 'operator',
      summary: 'Approve next step',
      idempotencyKey: 'node-event-approval',
    }, runtimeScope);
    const approvalResponse = await service.invoke('team.approvalResolve', {
      runId: 'run-approval',
      approvalId: 'team-approval-node-event-approval',
      decision: 'approve',
      idempotencyKey: 'approval-resolve-work-node',
    }, runtimeScope);
    const approvalData = approvalResponse.data as { snapshot: { graph: { nodes: Array<{ nodeId: string; status?: string }> }; approvals: Array<{ approvalId: string; status: string }> } };

    expect(approvalData.snapshot.approvals).toEqual([expect.objectContaining({
      approvalId: 'team-approval-node-event-approval',
      status: 'approved',
    })]);
    expect(approvalData.snapshot.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'work', status: 'waiting' }),
    ]));
    expect(approvalData.snapshot.graph.nodes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: 'work', status: 'completed' }),
    ]));
  });

  it('rejects TeamRun graph YAML export when the run has no saved graph', async () => {
    const service = new TeamRuntimeService({
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await service.invoke('team.runCreate', { packagePath: '/pkg', runId: 'run-without-graph', idempotencyKey: 'create-without-graph' }, runtimeScope);

    await expect(service.invoke('team.graphExportYaml', { runId: 'run-without-graph' }, runtimeScope)).rejects.toThrow(
      'TeamRun run-without-graph has no saved graph to export. Save the TeamRun graph before exporting YAML.',
    );
  });

  it('rejects TeamRun graph YAML export when the run does not exist', async () => {
    const service = new TeamRuntimeService({
      nowMs: () => 1000,
      randomId: () => 'id',
    });

    await expect(service.invoke('team.graphExportYaml', { runId: 'missing-run' }, runtimeScope)).rejects.toThrow(
      'TeamRun missing-run must exist before exporting graph YAML.',
    );
  });

  it('does not ensure or prompt role sessions when creating a run', async () => {
    const nodePromptDelivery = new FakeTeamNodePromptDeliveryPort();
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
      stateStore,
      nodePromptDelivery,
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
    expect(nodePromptDelivery.deliveries).toHaveLength(0);
    const snapshotResponse = await service.invoke('team.runSnapshot', { runId: 'run-1' }, runtimeScope);
    const snapshot = snapshotResponse.data as { run: { status: string }; events: Array<{ type: string }>; nodePromptDeliveries: Array<{ kind: string; status: string }> };
    expect(snapshot.run.status).toBe('created');
    expect(snapshot.events).toEqual([]);
    expect(snapshot.nodePromptDeliveries).toEqual([]);
  });


});
