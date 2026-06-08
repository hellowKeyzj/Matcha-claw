import { describe, expect, it, vi } from 'vitest';
import type { RuntimeScope } from '../../runtime-host/application/agent-runtime/contracts/runtime-address';
import { TeamSkillService } from '../../runtime-host/application/team-skill/team-skill-service';
import { openClawTestRuntimeEndpoint } from './helpers/runtime-address-fixtures';

const runtimeInstanceScope: RuntimeScope = {
  kind: 'runtime-instance',
  endpoint: openClawTestRuntimeEndpoint,
};

function teamRunScope(runId: string): RuntimeScope {
  return {
    kind: 'team-run',
    endpoint: openClawTestRuntimeEndpoint,
    runId,
  };
}

describe('TeamSkillService', () => {
  it('projects successful Team runtime mutations with team-run scope', async () => {
    const gatewayWorkflow = {
      invoke: vi.fn().mockResolvedValue({ status: 200, data: { runId: 'run-1', status: 'running', revision: 2 } }),
    };
    const taskProjectionWorkflow = {
      projectAfterOperation: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TeamSkillService(gatewayWorkflow, taskProjectionWorkflow);
    const scope = teamRunScope('run-1');

    await expect(service.invoke('team.runStart', { runId: 'run-1', idempotencyKey: 'start-1' }, scope)).resolves.toEqual({
      status: 200,
      data: { runId: 'run-1', status: 'running', revision: 2 },
    });

    expect(taskProjectionWorkflow.projectAfterOperation).toHaveBeenCalledWith({
      operationId: 'team.runStart',
      scope,
      params: { runId: 'run-1', idempotencyKey: 'start-1' },
      responseData: { runId: 'run-1', status: 'running', revision: 2 },
    });
  });

  it('does not project failed gateway responses', async () => {
    const gatewayWorkflow = {
      invoke: vi.fn().mockResolvedValue({ status: 400, data: { success: false, error: 'bad' } }),
    };
    const taskProjectionWorkflow = {
      projectAfterOperation: vi.fn(),
    };
    const service = new TeamSkillService(gatewayWorkflow, taskProjectionWorkflow);

    await service.invoke('team.runStart', { runId: 'run-1' }, teamRunScope('run-1'));

    expect(taskProjectionWorkflow.projectAfterOperation).not.toHaveBeenCalled();
  });

  it('keeps successful Team runtime responses when task projection fails', async () => {
    const gatewayWorkflow = {
      invoke: vi.fn().mockResolvedValue({ status: 200, data: { runId: 'run-1', status: 'running', revision: 2 } }),
    };
    const taskProjectionWorkflow = {
      projectAfterOperation: vi.fn().mockRejectedValue(new Error('TaskList failed')),
    };
    const service = new TeamSkillService(gatewayWorkflow, taskProjectionWorkflow);

    await expect(service.invoke('team.runStart', { runId: 'run-1' }, teamRunScope('run-1'))).resolves.toEqual({
      status: 200,
      data: { runId: 'run-1', status: 'running', revision: 2 },
    });
  });

  it('applies managed agent config before returning successful TeamRun create responses', async () => {
    const managedAgentConfig = { kind: 'matchaclaw-team-managed-openclaw-agents' };
    const gatewayWorkflow = {
      invoke: vi.fn().mockResolvedValue({
        status: 200,
        data: { runId: 'run-1', status: 'created', revision: 1, managedAgentConfig },
      }),
    };
    const taskProjectionWorkflow = {
      projectAfterOperation: vi.fn().mockResolvedValue(undefined),
    };
    const managedAgentConfigWorkflow = {
      readManagedAgentConfig: vi.fn().mockReturnValue(managedAgentConfig),
      apply: vi.fn().mockResolvedValue({ changed: true, agentIds: ['matchaclaw-team:run-1:leader'] }),
      stripManagedAgentConfig: vi.fn().mockReturnValue({ runId: 'run-1', status: 'created', revision: 1 }),
    };
    const service = new TeamSkillService(gatewayWorkflow, taskProjectionWorkflow, managedAgentConfigWorkflow as never);

    await expect(service.invoke('team.runCreate', { packagePath: '/pkg', idempotencyKey: 'create-1' }, runtimeInstanceScope)).resolves.toEqual({
      status: 200,
      data: { runId: 'run-1', status: 'created', revision: 1 },
    });

    expect(managedAgentConfigWorkflow.readManagedAgentConfig).toHaveBeenCalledWith(managedAgentConfig);
    expect(managedAgentConfigWorkflow.apply).toHaveBeenCalledWith(managedAgentConfig);
    expect(taskProjectionWorkflow.projectAfterOperation).toHaveBeenCalledWith(expect.objectContaining({
      operationId: 'team.runCreate',
      scope: runtimeInstanceScope,
      responseData: { runId: 'run-1', status: 'created', revision: 1 },
    }));
  });

  it('fails TeamRun create when managed agent config application fails', async () => {
    const managedAgentConfig = { kind: 'matchaclaw-team-managed-openclaw-agents' };
    const gatewayWorkflow = {
      invoke: vi.fn().mockResolvedValue({
        status: 200,
        data: { runId: 'run-1', status: 'created', revision: 1, managedAgentConfig },
      }),
    };
    const taskProjectionWorkflow = {
      projectAfterOperation: vi.fn(),
    };
    const managedAgentConfigWorkflow = {
      readManagedAgentConfig: vi.fn().mockReturnValue(managedAgentConfig),
      apply: vi.fn().mockRejectedValue(new Error('config write failed')),
      stripManagedAgentConfig: vi.fn(),
    };
    const service = new TeamSkillService(gatewayWorkflow, taskProjectionWorkflow, managedAgentConfigWorkflow as never);

    await expect(service.invoke('team.runCreate', { packagePath: '/pkg', idempotencyKey: 'create-1' }, runtimeInstanceScope)).resolves.toEqual({
      status: 500,
      data: { success: false, error: 'config write failed' },
    });
    expect(taskProjectionWorkflow.projectAfterOperation).not.toHaveBeenCalled();
  });

  it('fails TeamRun create when managedAgentConfig is present but malformed', async () => {
    const gatewayWorkflow = {
      invoke: vi.fn().mockResolvedValue({
        status: 200,
        data: { runId: 'run-1', status: 'created', revision: 1, managedAgentConfig: { kind: 'matchaclaw-team-managed-openclaw-agents' } },
      }),
    };
    const taskProjectionWorkflow = {
      projectAfterOperation: vi.fn(),
    };
    const managedAgentConfigWorkflow = {
      readManagedAgentConfig: vi.fn().mockImplementation(() => {
        throw new Error('Invalid Team managed agent config projection');
      }),
      apply: vi.fn(),
      stripManagedAgentConfig: vi.fn(),
    };
    const service = new TeamSkillService(gatewayWorkflow, taskProjectionWorkflow, managedAgentConfigWorkflow as never);

    await expect(service.invoke('team.runCreate', { packagePath: '/pkg', idempotencyKey: 'create-1' }, runtimeInstanceScope)).resolves.toEqual({
      status: 500,
      data: { success: false, error: 'Invalid Team managed agent config projection' },
    });
    expect(managedAgentConfigWorkflow.apply).not.toHaveBeenCalled();
    expect(taskProjectionWorkflow.projectAfterOperation).not.toHaveBeenCalled();
  });

  it('does not require managed config workflow when TeamRun create response has no managedAgentConfig field', async () => {
    const gatewayWorkflow = {
      invoke: vi.fn().mockResolvedValue({
        status: 200,
        data: { runId: 'run-1', status: 'created', revision: 1 },
      }),
    };
    const taskProjectionWorkflow = {
      projectAfterOperation: vi.fn().mockResolvedValue(undefined),
    };
    const service = new TeamSkillService(gatewayWorkflow, taskProjectionWorkflow);

    await expect(service.invoke('team.runCreate', { packagePath: '/pkg', idempotencyKey: 'create-1' }, runtimeInstanceScope)).resolves.toEqual({
      status: 200,
      data: { runId: 'run-1', status: 'created', revision: 1 },
    });
    expect(taskProjectionWorkflow.projectAfterOperation).toHaveBeenCalledWith(expect.objectContaining({
      scope: runtimeInstanceScope,
    }));
  });
});
