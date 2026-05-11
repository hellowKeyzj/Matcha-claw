import { describe, expect, it, vi } from 'vitest';
import { subagentRoutes } from '../../runtime-host/api/routes/subagent-routes';
import { GatewayCapabilityService } from '../../runtime-host/application/gateway/gateway-capability-service';
import { SubagentRuntimeService } from '../../runtime-host/application/subagents/service';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';
import type { RuntimeClockPort } from '../../runtime-host/application/common/runtime-ports';

function clock(nowMs: number): RuntimeClockPort {
  return {
    nowMs: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    toIsoString: (ms) => new Date(ms).toISOString(),
  };
}

describe('runtime-host subagent routes', () => {
  it('routes subagent list through SubagentRuntimeService and gateway agents.list', async () => {
    const gatewayRpc = vi.fn(async () => ({
      agents: [{ id: 'main', name: 'Main' }],
      defaultId: 'main',
    }));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: true,
      methods: ['agents.list'],
      missingMethods: [],
    }));
    const subagentService = new SubagentRuntimeService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(1000),
    });

    const response = await dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/list',
      {},
      { subagentService },
    );

    expect(response).toEqual({
      status: 200,
      data: {
        success: true,
        agents: [],
        ready: false,
        refreshing: true,
        updatedAt: null,
        error: null,
      },
    });
    expect(gatewayRpc).toHaveBeenCalledWith('agents.list', {}, 60000);
    expect(inspectGatewayMethodReadiness).toHaveBeenCalledWith(['agents.list'], 5000);
  });

  it('validates config.set before calling gateway', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn();
    const subagentService = new SubagentRuntimeService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(1000),
    });

    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/config/set',
      { raw: '{} ' },
      { subagentService },
    )).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'baseHash is required' },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('routes file writes and agent wait through explicit gateway methods', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentService = new SubagentRuntimeService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(1000),
    });

    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/files/set',
      { agentId: 'writer', name: 'AGENTS.md', content: 'rules' },
      { subagentService },
    )).resolves.toEqual({ status: 200, data: { ok: true } });
    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/agent-wait',
      { runId: 'run-1', timeoutMs: 30000 },
      { subagentService },
    )).resolves.toEqual({ status: 200, data: { ok: true } });

    expect(gatewayRpc).toHaveBeenCalledWith(
      'agents.files.set',
      { agentId: 'writer', name: 'AGENTS.md', content: 'rules' },
      60000,
    );
    expect(gatewayRpc).toHaveBeenCalledWith(
      'agent.wait',
      { runId: 'run-1', timeoutMs: 30000 },
      40000,
    );
  });

  it('returns structured 503 when subagent gateway method is absent', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: false,
      methods: ['config.get'],
      missingMethods: ['config.get'],
    }));
    const subagentService = new SubagentRuntimeService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(1000),
    });

    await expect(dispatchRuntimeRouteDefinition(subagentRoutes, 'POST', '/api/subagents/config/get', {}, { subagentService }))
      .resolves.toEqual({
        status: 503,
        data: {
          success: false,
          code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
          pluginId: 'subagents',
          missingMethods: ['config.get'],
          message: 'subagents plugin is not enabled or did not register required Gateway methods.',
        },
      });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('subagent list and config cold reads return not-ready while one background rpc refreshes each snapshot', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const gatewayRpc = vi.fn((method: string) => new Promise<unknown>((resolve) => {
      pending.set(method, resolve);
    }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentService = new SubagentRuntimeService({
      gateway: { gatewayRpc },
      capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness } }),
      clock: clock(2000),
    });

    await expect(dispatchRuntimeRouteDefinition(subagentRoutes, 'POST', '/api/subagents/list', {}, { subagentService }))
      .resolves.toEqual({
        status: 200,
        data: {
          success: true,
          agents: [],
          ready: false,
          refreshing: true,
          updatedAt: null,
          error: null,
        },
      });
    await expect(dispatchRuntimeRouteDefinition(subagentRoutes, 'POST', '/api/subagents/config/get', {}, { subagentService }))
      .resolves.toEqual({
        status: 200,
        data: {
          success: true,
          config: undefined,
          ready: false,
          refreshing: true,
          updatedAt: null,
          error: null,
        },
      });
    await dispatchRuntimeRouteDefinition(subagentRoutes, 'POST', '/api/subagents/list', {}, { subagentService });

    expect(gatewayRpc).toHaveBeenCalledTimes(2);
    pending.get('agents.list')?.({ agents: [{ id: 'main', name: 'Main' }], defaultId: 'main' });
    pending.get('config.get')?.({ config: { agents: { defaults: { workspace: 'E:/workspace/main' } } } });
    await Promise.resolve();

    await expect(dispatchRuntimeRouteDefinition(subagentRoutes, 'POST', '/api/subagents/list', {}, { subagentService }))
      .resolves.toEqual({
        status: 200,
        data: {
          success: true,
          agents: [{ id: 'main', name: 'Main' }],
          defaultId: 'main',
          ready: true,
          refreshing: true,
          updatedAt: 2000,
          error: null,
        },
      });
  });
});
