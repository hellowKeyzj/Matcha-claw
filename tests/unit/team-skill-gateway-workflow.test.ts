import { describe, expect, it, vi } from 'vitest';
import { TeamSkillGatewayWorkflow, TEAM_RUNTIME_GATEWAY_PLUGIN } from '../../runtime-host/application/workflows/team-skill/team-skill-gateway-workflow';

function createWorkflow() {
  const gatewayRpc = vi.fn();
  const requirePluginMethod = vi.fn();
  const workflow = new TeamSkillGatewayWorkflow({
    gateway: { gatewayRpc },
    capabilities: { requirePluginMethod },
  });
  return { workflow, gatewayRpc, requirePluginMethod };
}

describe('TeamSkillGatewayWorkflow', () => {
  it('forwards supported Team runtime operations after readiness check', async () => {
    const { workflow, gatewayRpc, requirePluginMethod } = createWorkflow();
    requirePluginMethod.mockResolvedValueOnce(null);
    gatewayRpc.mockResolvedValueOnce({ runId: 'run-1', status: 'running', revision: 2 });

    await expect(workflow.invoke('team.runStart', { runId: 'run-1', idempotencyKey: 'start-1' })).resolves.toEqual({
      status: 200,
      data: { runId: 'run-1', status: 'running', revision: 2 },
    });
    expect(requirePluginMethod).toHaveBeenCalledWith(
      TEAM_RUNTIME_GATEWAY_PLUGIN,
      'matchaclaw.team.run.start',
      5000,
    );
    expect(gatewayRpc).toHaveBeenCalledWith(
      'matchaclaw.team.run.start',
      { runId: 'run-1', idempotencyKey: 'start-1' },
      60000,
    );
  });

  it('rejects unsupported operations before calling OpenClaw gateway', async () => {
    const { workflow, gatewayRpc, requirePluginMethod } = createWorkflow();

    await expect(workflow.invoke('team.unsupported' as never, {})).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Team runtime operation not supported: team.unsupported' },
    });
    expect(requirePluginMethod).not.toHaveBeenCalled();
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('returns plugin readiness failures without calling the gateway', async () => {
    const { workflow, gatewayRpc, requirePluginMethod } = createWorkflow();
    const unavailable = {
      status: 503,
      data: {
        success: false,
        code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
        pluginId: 'team-runtime',
        missingMethods: ['matchaclaw.team.run.tick'],
        message: 'team-runtime plugin is not enabled or did not register required Gateway methods.',
      },
    };
    requirePluginMethod.mockResolvedValueOnce(unavailable);

    await expect(workflow.invoke('team.runTick', { runId: 'run-1', idempotencyKey: 'tick-1' })).resolves.toEqual(unavailable);
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('rejects non-object params without calling the gateway', async () => {
    const { workflow, gatewayRpc, requirePluginMethod } = createWorkflow();
    requirePluginMethod.mockResolvedValueOnce(null);

    await expect(workflow.invoke('team.runTick', 'run-1')).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Team runtime params must be an object' },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });
});
