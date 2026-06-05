import { describe, expect, it, vi } from 'vitest';
import { subagentRoutes } from '../../runtime-host/api/routes/subagent-routes';
import { createSubagentManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/subagent-management-capability';
import { GatewayCapabilityService } from '../../runtime-host/application/gateway/gateway-capability-service';
import { SubagentRuntimeService } from '../../runtime-host/application/subagents/service';
import { SubagentRuntimeWorkflow } from '../../runtime-host/application/workflows/subagent-runtime/subagent-runtime-workflow';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';
import type { RuntimeClockPort } from '../../runtime-host/application/common/runtime-ports';

function clock(nowMs: number): RuntimeClockPort {
  return {
    nowMs: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    toIsoString: (ms) => new Date(ms).toISOString(),
  };
}

function createSubagentService(
  deps: {
    gatewayRpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
    inspectGatewayMethodReadiness: (methods: string[], timeoutMs?: number) => Promise<unknown>;
    ensureIdentityFile?: (workspaceDir: string, options?: { createDir?: boolean }) => Promise<{ wroteIdentity: boolean; replacedTemplate: boolean; removedBootstrap: boolean }>;
    nowMs?: number;
  },
): SubagentRuntimeService {
  const runtimeWorkflow = new SubagentRuntimeWorkflow({
    gateway: { gatewayRpc: deps.gatewayRpc },
    capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness: deps.inspectGatewayMethodReadiness } }),
    workspace: {
      ensureIdentityFile: deps.ensureIdentityFile ?? vi.fn(async () => ({ wroteIdentity: false, replacedTemplate: false, removedBootstrap: false })),
    },
    clock: clock(deps.nowMs ?? 1000),
  });
  return new SubagentRuntimeService({ runtimeWorkflow });
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
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });

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
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });

    const [configSetRoute] = createSubagentManagementCapabilityOperationRoutes({ subagentService });

    await expect(configSetRoute.handle({ raw: '{} ' })).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'baseHash is required' },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('routes file writes through subagent capability methods and does not expose direct agent wait', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });

    const fileSetRoute = createSubagentManagementCapabilityOperationRoutes({ subagentService })
      .find((route) => route.operationId === 'subagents.files.set');
    if (!fileSetRoute) {
      throw new Error('Expected subagents.files.set operation route');
    }

    await expect(fileSetRoute.handle({ agentId: 'writer', name: 'AGENTS.md', content: 'rules' }))
      .resolves.toEqual({ status: 200, data: { ok: true } });
    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/agent-wait',
      { runId: 'run-1', timeoutMs: 30000 },
      { subagentService },
    )).resolves.toBeNull();

    expect(gatewayRpc).toHaveBeenCalledWith(
      'agents.files.set',
      { agentId: 'writer', name: 'AGENTS.md', content: 'rules' },
      60000,
    );
    expect(gatewayRpc).not.toHaveBeenCalledWith(
      'agent.wait',
      expect.anything(),
      expect.anything(),
    );
  });

  it('returns structured 503 when subagent gateway method is absent', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: false,
      methods: ['config.get'],
      missingMethods: ['config.get'],
    }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });

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
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, nowMs: 2000 });

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

  it('seeds the target workspace identity before creating a subagent through Gateway', async () => {
    const gatewayRpc = vi.fn(async () => ({ agentId: 'writer' }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const ensureIdentityFile = vi.fn(async () => ({ wroteIdentity: true, replacedTemplate: false, removedBootstrap: false }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, ensureIdentityFile });

    const createRoute = createSubagentManagementCapabilityOperationRoutes({ subagentService })
      .find((route) => route.operationId === 'subagents.create');
    if (!createRoute) {
      throw new Error('Expected subagents.create operation route');
    }

    await expect(createRoute.handle({ name: 'Writer', workspace: 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\writer' }))
      .resolves.toEqual({ status: 200, data: { agentId: 'writer' } });

    expect(ensureIdentityFile).toHaveBeenCalledWith(
      'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\writer',
      { createDir: true },
    );
    expect(gatewayRpc).toHaveBeenCalledWith(
      'agents.create',
      { name: 'Writer', workspace: 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\writer' },
      60000,
    );
  });
});
