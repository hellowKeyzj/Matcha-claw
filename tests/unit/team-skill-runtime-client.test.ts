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


});
