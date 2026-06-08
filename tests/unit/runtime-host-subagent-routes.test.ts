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
    resolveCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<string[]>;
    resolveCanonicalSkillKeyMap?: (skillIds: readonly string[]) => Promise<Record<string, string>>;
    validateCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<{ ok: true; skillKeys: string[] } | { ok: false; error: string }>;
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
  return new SubagentRuntimeService({
    runtimeWorkflow,
    skillRuntimeWorkflow: {
      resolveCanonicalSkillKeys: deps.resolveCanonicalSkillKeys ?? (async (skillIds) => [...skillIds]),
      resolveCanonicalSkillKeyMap: deps.resolveCanonicalSkillKeyMap ?? (async (skillIds) => Object.fromEntries(skillIds.map((skillId) => [skillId.trim(), skillId.trim()]))),
      validateCanonicalSkillKeys: deps.validateCanonicalSkillKeys ?? (async (skillIds) => ({ ok: true, skillKeys: [...skillIds] })),
    },
  });
}

function subagentOperationRoute(subagentService: SubagentRuntimeService, operationId: string) {
  const route = createSubagentManagementCapabilityOperationRoutes({ subagentService })
    .find((candidate) => candidate.operationId === operationId);
  if (!route) {
    throw new Error(`Expected ${operationId} operation route`);
  }
  return route;
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
    const listRoute = subagentOperationRoute(subagentService, 'subagents.list');

    const response = await listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never);

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

    const configSetRoute = subagentOperationRoute(subagentService, 'subagents.config.set');

    await expect(configSetRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: { raw: '{} ' } } as never)).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'baseHash is required' },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('returns canonical skill ids from config and agent snapshots', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const gatewayRpc = vi.fn((method: string) => new Promise<unknown>((resolve) => {
      pending.set(method, resolve);
    }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const resolveCanonicalSkillKeyMap = vi.fn(async (skillIds: readonly string[]) => Object.fromEntries(skillIds
      .filter((skillId) => skillId === 'Web Search')
      .map((skillId) => [skillId, 'web-search'])));
    const subagentService = createSubagentService({
      gatewayRpc,
      inspectGatewayMethodReadiness,
      resolveCanonicalSkillKeyMap,
      nowMs: 2000,
    });

    const listRoute = subagentOperationRoute(subagentService, 'subagents.list');
    const configGetRoute = subagentOperationRoute(subagentService, 'subagents.config.get');

    await listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never);
    await configGetRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never);
    pending.get('agents.list')?.({ agents: [{ id: 'main', name: 'Main', skills: ['Web Search', 'missing'] }] });
    pending.get('config.get')?.({ config: { agents: { list: [{ id: 'main', skills: ['Web Search', 'missing'] }] } } });
    await Promise.resolve();

    await expect(listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toMatchObject({
        status: 200,
        data: {
          agents: [{ id: 'main', name: 'Main', skills: ['web-search', 'missing'] }],
        },
      });
    await expect(configGetRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toMatchObject({
        status: 200,
        data: {
          config: { agents: { list: [{ id: 'main', skills: ['web-search', 'missing'] }] } },
        },
      });
    expect(resolveCanonicalSkillKeyMap).toHaveBeenCalledWith(['Web Search', 'missing']);
    expect(resolveCanonicalSkillKeyMap).not.toHaveBeenCalledWith(['Web Search']);
    expect(resolveCanonicalSkillKeyMap).not.toHaveBeenCalledWith(['missing']);
  });

  it('forwards canonical skill ids in config.set to gateway', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const validateCanonicalSkillKeys = vi.fn(async (skillIds: readonly string[]) => ({ ok: true as const, skillKeys: [...skillIds] }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, validateCanonicalSkillKeys });
    const configSetRoute = subagentOperationRoute(subagentService, 'subagents.config.set');

    await expect(configSetRoute.handle({
      target: { kind: 'agent', agentId: 'default' },
      domainInput: {
        raw: JSON.stringify({ agents: { list: [{ id: 'main', skills: ['web-search'] }] } }),
        baseHash: 'hash-1',
      },
    })).resolves.toEqual({ status: 200, data: { ok: true } });

    expect(gatewayRpc).toHaveBeenCalledWith(
      'config.set',
      {
        raw: JSON.stringify({ agents: { list: [{ id: 'main', skills: ['web-search'] }] } }),
        baseHash: 'hash-1',
      },
      60000,
    );
  });

  it('rejects unknown and noncanonical skill ids in config.set without calling gateway', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: true,
      methods: ['config.set'],
      missingMethods: [],
    }));
    const validateCanonicalSkillKeys = vi.fn(async (skillIds: readonly string[]) => {
      const unknown = skillIds.find((skillId) => skillId === 'missing');
      if (unknown) {
        return { ok: false as const, error: `Unknown skillKey: ${unknown}` };
      }
      const noncanonical = skillIds.find((skillId) => skillId === 'Web Search');
      if (noncanonical) {
        return { ok: false as const, error: `skillKey must be canonical: ${noncanonical}` };
      }
      return { ok: true as const, skillKeys: [...skillIds] };
    });
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, validateCanonicalSkillKeys });
    const configSetRoute = subagentOperationRoute(subagentService, 'subagents.config.set');

    await expect(configSetRoute.handle({
      target: { kind: 'agent', agentId: 'default' },
      domainInput: {
        raw: JSON.stringify({ agents: { list: [{ id: 'main', skills: ['web-search', 'missing'] }] } }),
        baseHash: 'hash-1',
      },
    })).resolves.toEqual({ status: 400, data: { success: false, error: 'Unknown skillKey: missing' } });
    await expect(configSetRoute.handle({
      target: { kind: 'agent', agentId: 'default' },
      domainInput: {
        raw: JSON.stringify({ agents: { list: [{ id: 'main', skills: ['Web Search'] }] } }),
        baseHash: 'hash-1',
      },
    })).resolves.toEqual({ status: 400, data: { success: false, error: 'skillKey must be canonical: Web Search' } });
    await expect(configSetRoute.handle({
      target: { kind: 'agent', agentId: 'default' },
      domainInput: {
        raw: JSON.stringify({ agents: { list: [{ id: 'main', skills: ['web-search', 123] }] } }),
        baseHash: 'hash-1',
      },
    })).resolves.toEqual({ status: 400, data: { success: false, error: 'skillKey must be a string' } });

    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('rejects subagent update/delete target mismatches before calling gateway', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });
    const routes = createSubagentManagementCapabilityOperationRoutes({ subagentService });
    const updateRoute = routes.find((route) => route.operationId === 'subagents.update');
    const deleteRoute = routes.find((route) => route.operationId === 'subagents.delete');
    if (!updateRoute || !deleteRoute) {
      throw new Error('Expected subagent update/delete operation routes');
    }
    const target = { kind: 'subagent' as const, agentId: 'default', subagentId: 'writer' };

    await expect(Promise.resolve(updateRoute.handle({
      domainInput: { agentId: 'other', name: 'Other' },
      target,
    } as never))).resolves.toEqual({ status: 400, data: { success: false, error: 'agentId must match subagent target' } });
    await expect(Promise.resolve(deleteRoute.handle({
      domainInput: { subagentId: 'other', deleteFiles: true },
      target,
    } as never))).resolves.toEqual({ status: 400, data: { success: false, error: 'subagentId must match subagent target' } });

    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('rejects legacy direct read routes', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const inspectGatewayMethodReadiness = vi.fn();
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });

    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/list',
      {},
      { subagentService },
    )).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Legacy subagent read route is disabled; use /api/capabilities/execute with an agent target' },
    });
    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/config/get',
      {},
      { subagentService },
    )).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Legacy subagent read route is disabled; use /api/capabilities/execute with an agent target' },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('routes file operations through subagent capability target and rejects legacy direct file routes', async () => {
    const gatewayRpc = vi.fn(async (method: string) => {
      if (method === 'agents.list') {
        return { agents: [{ id: 'writer' }] };
      }
      if (method === 'agents.files.get') {
        return { ok: true, method, file: { content: 'rules', path: '/tmp/leak/AGENTS.md' } };
      }
      if (method === 'agents.files.list') {
        return { ok: true, method, files: ['AGENTS.md', '../secret', { name: 'SOUL.md', path: '/tmp/SOUL.md', content: 'leak' }] };
      }
      return { ok: true, method };
    });
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });
    const fileRoutes = createSubagentManagementCapabilityOperationRoutes({ subagentService });
    const fileGetRoute = fileRoutes.find((route) => route.operationId === 'subagents.files.get');
    const fileSetRoute = fileRoutes.find((route) => route.operationId === 'subagents.files.set');
    const fileListRoute = fileRoutes.find((route) => route.operationId === 'subagents.files.list');
    if (!fileGetRoute || !fileSetRoute || !fileListRoute) {
      throw new Error('Expected subagent file operation routes');
    }
    const target = { kind: 'subagent' as const, agentId: 'default', subagentId: 'writer' };

    await expect(fileGetRoute.handle({ domainInput: { name: 'AGENTS.md' }, target } as never))
      .resolves.toEqual({ status: 200, data: { file: { content: 'rules' } } });
    await expect(fileSetRoute.handle({ domainInput: { agentId: 'writer', name: 'AGENTS.md', content: 'rules' }, target } as never))
      .resolves.toEqual({ status: 200, data: { ok: true, method: 'agents.files.set' } });
    await expect(fileListRoute.handle({ domainInput: {}, target } as never))
      .resolves.toEqual({ status: 200, data: { files: ['AGENTS.md', { name: 'SOUL.md' }] } });
    await expect(Promise.resolve(fileGetRoute.handle({ domainInput: { agentId: 'other', name: 'AGENTS.md' }, target } as never)))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'agentId must match subagent target' } });
    await expect(Promise.resolve(fileGetRoute.handle({ domainInput: { name: '../secret' }, target } as never)))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'name must be a supported subagent config file' } });
    await expect(Promise.resolve(fileListRoute.handle({
      domainInput: {},
      target: { kind: 'subagent', agentId: 'default', subagentId: '../writer' },
    } as never)))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'agentId is invalid' } });
    await expect(Promise.resolve(fileListRoute.handle({
      domainInput: {},
      target: { kind: 'subagent', agentId: 'default', subagentId: 'ghost' },
    } as never)))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'agentId is not manageable' } });
    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/files/get',
      { agentId: 'writer', name: '../secret' },
      { subagentService },
    )).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Legacy subagent file route is disabled; use /api/capabilities/execute with a subagent target' },
    });
    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/files/list',
      { agentId: 'writer' },
      { subagentService },
    )).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'Legacy subagent file route is disabled; use /api/capabilities/execute with a subagent target' },
    });
    await expect(dispatchRuntimeRouteDefinition(
      subagentRoutes,
      'POST',
      '/api/subagents/agent-wait',
      { runId: 'run-1', timeoutMs: 30000 },
      { subagentService },
    )).resolves.toBeNull();

    expect(gatewayRpc).toHaveBeenCalledWith('agents.files.get', { agentId: 'writer', name: 'AGENTS.md' }, 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('agents.files.set', { agentId: 'writer', name: 'AGENTS.md', content: 'rules' }, 60000);
    expect(gatewayRpc).toHaveBeenCalledWith('agents.files.list', { agentId: 'writer' }, 60000);
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

    const configGetRoute = subagentOperationRoute(subagentService, 'subagents.config.get');

    await expect(configGetRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
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
    const listRoute = subagentOperationRoute(subagentService, 'subagents.list');
    const configGetRoute = subagentOperationRoute(subagentService, 'subagents.config.get');

    await expect(listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
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
    await expect(configGetRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
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
    await listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never);

    expect(gatewayRpc).toHaveBeenCalledTimes(2);
    pending.get('agents.list')?.({ agents: [{ id: 'main', name: 'Main' }], defaultId: 'main' });
    pending.get('config.get')?.({ config: { agents: { defaults: { workspace: 'E:/workspace/main' } } } });
    await Promise.resolve();

    await expect(listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
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

    await expect(createRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: { name: 'Writer', workspace: 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\writer' },
    } as never))
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
