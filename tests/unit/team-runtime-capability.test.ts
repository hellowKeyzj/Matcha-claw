import { describe, expect, it, vi } from 'vitest';
import { CapabilityRouter } from '../../runtime-host/application/capabilities/contracts/capability-router';
import {
  createTeamRuntimeCapabilityOperationRoutes,
  teamRuntimeCapabilityOperations,
  TEAM_RUNTIME_CAPABILITY_ID,
} from '../../runtime-host/application/capabilities/team/team-runtime-capability';

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

describe('team runtime capability', () => {
  it('describes dispatch prepare as a stage target operation', () => {
    expect(teamRuntimeCapabilityOperations.find((operation) => operation.id === 'team.dispatchPrepare')).toEqual(
      expect.objectContaining({ targetKind: 'team-stage' }),
    );
  });

  it('rejects target and input runId mismatches before invoking the service', async () => {
    const invoke = vi.fn();
    const [route] = createTeamRuntimeCapabilityOperationRoutes({
      teamSkillService: { invoke } as never,
    }).filter((candidate) => candidate.operationId === 'team.runStart');

    await expect(Promise.resolve(route?.handle({
      capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.runStart',
      scope: teamRunScope,
      target: { kind: 'team-run', runId: 'run-target' },
      input: { runId: 'run-input', idempotencyKey: 'start-1' },
      domainInput: { runId: 'run-input', idempotencyKey: 'start-1' },
    }))).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Team runtime target runId must match input runId' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects dispatch prepare target and input stageId mismatches', async () => {
    const invoke = vi.fn();
    const [route] = createTeamRuntimeCapabilityOperationRoutes({
      teamSkillService: { invoke } as never,
    }).filter((candidate) => candidate.operationId === 'team.dispatchPrepare');

    await expect(Promise.resolve(route?.handle({
      capabilityId: TEAM_RUNTIME_CAPABILITY_ID,
      operationId: 'team.dispatchPrepare',
      scope: { ...teamRunScope, runId: 'run-1' },
      target: { kind: 'team-stage', runId: 'run-1', stageId: 'stage-target' },
      input: { runId: 'run-1', stageId: 'stage-input', idempotencyKey: 'prepare-1' },
      domainInput: { runId: 'run-1', stageId: 'stage-input', idempotencyKey: 'prepare-1' },
    }))).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Team runtime target stageId must match input stageId' },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('allows packageValidate team targets under the runtime-instance scope without teamId binding', async () => {
    const invoke = vi.fn(async () => ({ status: 200, data: { success: true, valid: true } }));
    const router = new CapabilityRouter({
      getCapability: () => ({
        id: TEAM_RUNTIME_CAPABILITY_ID,
        kind: TEAM_RUNTIME_CAPABILITY_ID,
        scopeKind: 'runtime-instance',
        scope: runtimeScope,
        targetKinds: ['team', 'team-run', 'team-stage', 'team-dispatch', 'team-approval'],
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
        teamSkillService: { invoke } as never,
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
        targetKinds: ['team', 'team-run', 'team-stage', 'team-dispatch', 'team-approval'],
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
        teamSkillService: { invoke } as never,
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
});
