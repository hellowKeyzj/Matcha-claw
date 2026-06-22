import { describe, expect, it, vi } from 'vitest';
import { subagentRoutes } from '../../runtime-host/api/routes/subagent-routes';
import { OpenClawAgentSkillConfigProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-agent-skill-config-projection';
import { createAgentSkillConfigCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-skill-config-capability';
import { createSubagentManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/subagent-management-capability';
import { GatewayCapabilityService } from '../../runtime-host/application/gateway/gateway-capability-service';
import { AgentSkillConfigService } from '../../runtime-host/application/subagents/agent-skill-config-service';
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
    initializeAgentWorkspace?: (workspaceDir: string, options: { createDir?: boolean; workspaceInitialization: 'mainAgentTemplate' | 'emptyWorkspace' }) => Promise<unknown>;
    resolveCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<string[]>;
    resolveCanonicalSkillKeyMap?: (skillIds: readonly string[]) => Promise<Record<string, string>>;
    validateCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<{ ok: true; skillKeys: string[] } | { ok: false; unknownSkillKeys: string[]; nonCanonicalSkillKeys: string[] }>;
    nowMs?: number;
  },
): SubagentRuntimeService {
  const runtimeWorkflow = new SubagentRuntimeWorkflow({
    gateway: { gatewayRpc: deps.gatewayRpc },
    capabilities: new GatewayCapabilityService({ gateway: { inspectGatewayMethodReadiness: deps.inspectGatewayMethodReadiness } }),
    workspace: {
      initializeAgentWorkspace: deps.initializeAgentWorkspace ?? vi.fn(async () => undefined),
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

function createAgentSkillConfigService(deps: {
  snapshot?: (method: 'config.get', emptyPayload: Record<string, unknown>) => Promise<{ status: number; data: unknown }>;
  call?: (method: string, params: Record<string, unknown>, options?: { invalidateSnapshots?: boolean }) => Promise<{ status: number; data: unknown }>;
  status?: () => Promise<unknown>;
  resolveCanonicalSkillKeyMap?: (skillIds: readonly string[]) => Promise<Record<string, string>>;
  validateCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<{ ok: true; skillKeys: string[] } | { ok: false; unknownSkillKeys: string[]; nonCanonicalSkillKeys: string[] }>;
}): AgentSkillConfigService {
  const runtimeWorkflow = {
    snapshot: deps.snapshot ?? vi.fn(async () => ({ status: 200, data: { success: true, config: undefined } })),
    call: deps.call ?? vi.fn(async () => ({ status: 200, data: {} })),
  };
  return new AgentSkillConfigService({
    projection: new OpenClawAgentSkillConfigProjection({
      runtimeWorkflow,
      skillRuntimeWorkflow: {
        refreshStatus: deps.status ?? vi.fn(async () => ({ success: true, skills: [] })),
        resolveCanonicalSkillKeyMap: deps.resolveCanonicalSkillKeyMap ?? vi.fn(async (skillIds) => Object.fromEntries(skillIds.map((skillId) => [skillId.trim(), skillId.trim()]))),
        validateCanonicalSkillKeys: deps.validateCanonicalSkillKeys ?? vi.fn(async (skillIds) => ({ ok: true, skillKeys: [...skillIds] })),
      },
    }),
  });
}

function agentSkillConfigOperationRoute(agentSkillConfigService: AgentSkillConfigService, operationId: string) {
  const route = createAgentSkillConfigCapabilityOperationRoutes({ agentSkillConfigService })
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
      const unknownSkillKeys = skillIds.filter((skillId) => skillId === 'missing');
      const nonCanonicalSkillKeys = skillIds.filter((skillId) => skillId === 'Web Search');
      if (unknownSkillKeys.length > 0 || nonCanonicalSkillKeys.length > 0) {
        return { ok: false as const, unknownSkillKeys, nonCanonicalSkillKeys };
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

  it('invalidates pending config snapshots after config.set', async () => {
    const pendingConfigGets: Array<(value: unknown) => void> = [];
    const gatewayRpc = vi.fn((method: string) => {
      if (method === 'config.get') {
        return new Promise<unknown>((resolve) => {
          pendingConfigGets.push(resolve);
        });
      }
      if (method === 'config.set') {
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve({});
    });
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, nowMs: 3000 });
    const configGetRoute = subagentOperationRoute(subagentService, 'subagents.config.get');
    const configSetRoute = subagentOperationRoute(subagentService, 'subagents.config.set');

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
    await expect(configSetRoute.handle({
      target: { kind: 'agent', agentId: 'default' },
      domainInput: {
        raw: JSON.stringify({ agents: { list: [] } }),
        baseHash: 'hash-1',
      },
    } as never)).resolves.toEqual({ status: 200, data: { ok: true } });

    pendingConfigGets[0]?.({ config: { agents: { defaults: { workspace: 'E:/workspace/old' } } } });
    await Promise.resolve();

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
    expect(gatewayRpc).toHaveBeenNthCalledWith(1, 'config.get', {}, 60000);
    expect(gatewayRpc).toHaveBeenNthCalledWith(2, 'config.set', {
      raw: JSON.stringify({ agents: { list: [] } }),
      baseHash: 'hash-1',
    }, 60000);
    expect(gatewayRpc).toHaveBeenNthCalledWith(3, 'config.get', {}, 60000);

    pendingConfigGets[1]?.({ config: { agents: { defaults: { workspace: 'E:/workspace/new' } } } });
    await Promise.resolve();

    await expect(configGetRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toEqual({
        status: 200,
        data: {
          success: true,
          config: { agents: { defaults: { workspace: 'E:/workspace/new' } } },
          ready: true,
          refreshing: true,
          updatedAt: 3000,
          error: null,
        },
      });
    expect(gatewayRpc).toHaveBeenNthCalledWith(4, 'config.get', {}, 60000);
  });

  it('projects agent skill config through subagent target without exposing raw config', async () => {
    const snapshot = vi.fn(async () => ({ status: 200, data: { success: true, config: undefined, ready: false } }));
    const call = vi.fn(async () => ({
      status: 200,
      data: {
        success: true,
        hash: 'hash-1',
        config: {
          agents: {
            defaults: { skills: ['Web Search'] },
            list: [{ id: 'writer', skills: ['browser-flow'] }],
          },
        },
        updatedAt: 2000,
      },
    }));
    const status = vi.fn(async () => ({
      success: true,
      skills: [
        { skillKey: 'web-search', name: 'Web Search', description: 'Search the web', installed: true, disabled: false, source: 'managed' },
        { skillKey: 'browser-flow', name: 'Browser Flow', description: 'Run browser flows', installed: true, disabled: true },
      ],
    }));
    const resolveCanonicalSkillKeyMap = vi.fn(async () => ({ 'Web Search': 'web-search', 'browser-flow': 'browser-flow' }));
    const service = createAgentSkillConfigService({ snapshot, call, status, resolveCanonicalSkillKeyMap });
    const getRoute = agentSkillConfigOperationRoute(service, 'agentSkillConfig.get');

    await expect(getRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: {},
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        agentId: 'writer',
        support: { supportType: 'supported' },
        selectionMode: 'usesExplicitSkillAllowlist',
        explicitSkillKeys: ['browser-flow'],
        inheritedDefaultSkillKeys: ['web-search'],
        effectiveSkillKeys: ['browser-flow'],
        options: [
          { skillKey: 'web-search', displayName: 'Web Search', description: 'Search the web', installed: true, selectable: true },
          { skillKey: 'browser-flow', displayName: 'Browser Flow', description: 'Run browser flows', installed: true, selectable: false, unavailableReason: 'globalSkillDisabled' },
        ],
        revision: 'hash-1',
        updatedAt: 2000,
      },
    });
    expect(call).toHaveBeenCalledWith('config.get', {});
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('treats missing agent skill allowlist as all selectable OpenClaw skills enabled', async () => {
    const call = vi.fn(async () => ({
      status: 200,
      data: {
        success: true,
        hash: 'hash-all-skills',
        config: {
          agents: {
            list: [{ id: 'writer', name: 'Writer' }],
          },
        },
      },
    }));
    const status = vi.fn(async () => ({
      success: true,
      skills: [
        { skillKey: 'web-search', name: 'Web Search', description: 'Search the web', installed: true, disabled: false },
        { skillKey: 'browser-flow', name: 'Browser Flow', description: 'Run browser flows', installed: true, disabled: false },
        { skillKey: 'disabled-skill', name: 'Disabled Skill', description: 'Disabled', installed: true, disabled: true },
      ],
    }));
    const service = createAgentSkillConfigService({ call, status });
    const getRoute = agentSkillConfigOperationRoute(service, 'agentSkillConfig.get');

    await expect(getRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: {},
    } as never)).resolves.toMatchObject({
      status: 200,
      data: {
        selectionMode: 'inheritsDefaultSkills',
        explicitSkillKeys: [],
        inheritedDefaultSkillKeys: ['web-search', 'browser-flow'],
        effectiveSkillKeys: ['web-search', 'browser-flow'],
      },
    });
  });

  it('returns an empty unsupported skill config view and rejects writes when the OpenClaw agent is not configured', async () => {
    const call = vi.fn(async (method: string) => {
      if (method === 'config.get') {
        return {
          status: 200,
          data: {
            hash: 'hash-missing-agent',
            config: {
              agents: {
                list: [{ id: 'writer', name: 'Writer' }],
              },
            },
          },
        };
      }
      return { status: 200, data: {} };
    });
    const status = vi.fn(async () => ({
      success: true,
      skills: [
        { skillKey: 'web-search', name: 'Web Search', description: 'Search the web', installed: true, disabled: false },
        { skillKey: 'browser-flow', name: 'Browser Flow', description: 'Run browser flows', installed: true, disabled: false },
      ],
    }));
    const service = createAgentSkillConfigService({ call, status });
    const getRoute = agentSkillConfigOperationRoute(service, 'agentSkillConfig.get');
    const setRoute = agentSkillConfigOperationRoute(service, 'agentSkillConfig.set');
    const target = { kind: 'subagent' as const, agentId: 'default', subagentId: 'ghost' };

    await expect(getRoute.handle({
      target,
      domainInput: {},
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        agentId: 'ghost',
        support: { supportType: 'unsupported', reason: 'agentNotConfigured' },
        selectionMode: 'inheritsDefaultSkills',
        explicitSkillKeys: [],
        inheritedDefaultSkillKeys: [],
        effectiveSkillKeys: [],
        options: [],
        revision: 'hash-missing-agent',
        updatedAt: null,
      },
    });

    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'hash-missing-agent',
        selection: { selectionType: 'setExplicitSkillAllowlist', skillKeys: ['web-search'] },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: { resultType: 'unsupported', reason: 'agentNotConfigured' },
    });

    expect(status).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalledWith('config.set', expect.anything(), expect.anything());
  });

  it('writes agent skill config through canonical projection and rejects stale revisions', async () => {
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'config.get') {
        return {
          status: 200,
          data: {
            hash: 'hash-2',
            config: {
              other: true,
              agents: {
                defaults: { workspace: 'E:/workspace/main', skills: ['web-search'] },
                list: [{ id: 'writer', name: 'Writer', skills: ['browser-flow'] }],
              },
            },
          },
        };
      }
      if (method === 'config.set') {
        return { status: 200, data: { hash: 'hash-3', params } };
      }
      return { status: 200, data: {} };
    });
    const validateCanonicalSkillKeys = vi.fn(async (skillIds: readonly string[]) => {
      const unknownSkillKeys = skillIds.filter((skillId) => skillId === 'missing');
      const nonCanonicalSkillKeys = skillIds.filter((skillId) => skillId === 'Web Search');
      if (unknownSkillKeys.length > 0 || nonCanonicalSkillKeys.length > 0) {
        return { ok: false as const, unknownSkillKeys, nonCanonicalSkillKeys };
      }
      return { ok: true as const, skillKeys: [...skillIds] };
    });
    const status = vi.fn(async () => ({
      success: true,
      skills: [
        { skillKey: 'web-search', name: 'Web Search', description: 'Search the web', installed: true, disabled: false },
        { skillKey: 'browser-flow', name: 'Browser Flow', description: 'Run browser flows', installed: true, disabled: false },
      ],
    }));
    const service = createAgentSkillConfigService({ call, status, validateCanonicalSkillKeys });
    const setRoute = agentSkillConfigOperationRoute(service, 'agentSkillConfig.set');
    const target = { kind: 'subagent' as const, agentId: 'default', subagentId: 'writer' };

    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'hash-1',
        selection: { selectionType: 'setExplicitSkillAllowlist', skillKeys: ['browser-flow'] },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        resultType: 'staleRevision',
        latestView: {
          agentId: 'writer',
          support: { supportType: 'supported' },
          selectionMode: 'usesExplicitSkillAllowlist',
          explicitSkillKeys: ['browser-flow'],
          inheritedDefaultSkillKeys: ['web-search'],
          effectiveSkillKeys: ['browser-flow'],
          options: [
            { skillKey: 'web-search', displayName: 'Web Search', description: 'Search the web', installed: true, selectable: true },
            { skillKey: 'browser-flow', displayName: 'Browser Flow', description: 'Run browser flows', installed: true, selectable: true },
          ],
          revision: 'hash-2',
          updatedAt: null,
        },
      },
    });

    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'hash-2',
        selection: { selectionType: 'setExplicitSkillAllowlist', skillKeys: ['browser-flow'] },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        resultType: 'updated',
        view: {
          agentId: 'writer',
          support: { supportType: 'supported' },
          selectionMode: 'usesExplicitSkillAllowlist',
          explicitSkillKeys: ['browser-flow'],
          inheritedDefaultSkillKeys: ['web-search'],
          effectiveSkillKeys: ['browser-flow'],
          options: [
            { skillKey: 'web-search', displayName: 'Web Search', description: 'Search the web', installed: true, selectable: true },
            { skillKey: 'browser-flow', displayName: 'Browser Flow', description: 'Run browser flows', installed: true, selectable: true },
          ],
          revision: 'hash-3',
          updatedAt: null,
        },
      },
    });

    expect(call).toHaveBeenLastCalledWith('config.set', {
      raw: JSON.stringify({
        other: true,
        agents: {
          defaults: { workspace: 'E:/workspace/main', skills: ['web-search'] },
          list: [{ id: 'writer', name: 'Writer', skills: ['browser-flow'] }],
        },
      }),
      baseHash: 'hash-2',
    }, { invalidateSnapshots: true });
    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'hash-2',
        selection: { selectionType: 'setExplicitSkillAllowlist', skillKeys: ['missing', 'Web Search'] },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        resultType: 'invalidSkillKeys',
        unknownSkillKeys: ['missing'],
        nonCanonicalSkillKeys: ['Web Search'],
      },
    });

    expect(validateCanonicalSkillKeys).toHaveBeenCalledWith(['browser-flow']);
    expect(validateCanonicalSkillKeys).toHaveBeenCalledWith(['missing', 'Web Search']);
  });

  it('initializes the target workspace only after creating a subagent through Gateway', async () => {
    const callOrder: string[] = [];
    const gatewayRpc = vi.fn(async () => {
      callOrder.push('gateway');
      return { agentId: 'writer' };
    });
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const initializeAgentWorkspace = vi.fn(async () => {
      callOrder.push('workspace');
    });
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, initializeAgentWorkspace });
    const createRoute = subagentOperationRoute(subagentService, 'subagents.create');
    const workspace = 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\writer';

    await expect(createRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: { name: 'Writer', workspace },
    } as never))
      .resolves.toEqual({ status: 200, data: { agentId: 'writer' } });

    expect(gatewayRpc).toHaveBeenCalledWith('agents.create', { name: 'Writer', workspace }, 60000);
    expect(initializeAgentWorkspace).toHaveBeenCalledWith(workspace, {
      createDir: true,
      workspaceInitialization: 'mainAgentTemplate',
    });
    expect(callOrder).toEqual(['gateway', 'workspace']);
  });

  it('does not pass workspaceInitialization to Gateway and skips workspace initialization when create fails', async () => {
    const gatewayRpc = vi.fn(async () => {
      throw new Error('gateway create failed');
    });
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const initializeAgentWorkspace = vi.fn(async () => undefined);
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, initializeAgentWorkspace });
    const createRoute = subagentOperationRoute(subagentService, 'subagents.create');
    const workspace = 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\writer';

    await expect(createRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: { name: 'Writer', workspace, workspaceInitialization: 'emptyWorkspace' },
    } as never)).rejects.toThrow('gateway create failed');

    expect(gatewayRpc).toHaveBeenCalledWith('agents.create', { name: 'Writer', workspace }, 60000);
    expect(initializeAgentWorkspace).not.toHaveBeenCalled();
  });

  it('passes emptyWorkspace only to runtime-host workspace initialization', async () => {
    const gatewayRpc = vi.fn(async () => ({ agentId: 'template-agent' }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const initializeAgentWorkspace = vi.fn(async () => undefined);
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, initializeAgentWorkspace });
    const createRoute = subagentOperationRoute(subagentService, 'subagents.create');
    const workspace = 'C:\\Users\\Dev\\.openclaw\\workspace-subagents\\template-agent';

    await expect(createRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'template-agent' },
      domainInput: { name: 'Template Agent', workspace, workspaceInitialization: 'emptyWorkspace' },
    } as never))
      .resolves.toEqual({ status: 200, data: { agentId: 'template-agent' } });

    expect(gatewayRpc).toHaveBeenCalledWith('agents.create', { name: 'Template Agent', workspace }, 60000);
    expect(initializeAgentWorkspace).toHaveBeenCalledWith(workspace, {
      createDir: true,
      workspaceInitialization: 'emptyWorkspace',
    });
  });
});
