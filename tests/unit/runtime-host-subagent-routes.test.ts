import { describe, expect, it, vi } from 'vitest';
import { subagentRoutes } from '../../runtime-host/api/routes/subagent-routes';
import { OpenClawAgentSkillConfigProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-agent-skill-config-projection';
import { OpenClawAgentToolConfigProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-agent-tool-config-projection';
import { OpenClawSubagentConfigProjection } from '../../runtime-host/application/adapters/openclaw/projections/openclaw-subagent-config-projection';
import { createAgentSkillConfigCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-skill-config-capability';
import { createAgentToolConfigCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/agent-tool-config-capability';
import { createSubagentManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/agent/subagent-management-capability';
import { GatewayCapabilityService } from '../../runtime-host/application/gateway/gateway-capability-service';
import { AgentSkillConfigService } from '../../runtime-host/application/subagents/agent-skill-config-service';
import { AgentToolConfigService } from '../../runtime-host/application/subagents/agent-tool-config-service';
import { SubagentRuntimeService } from '../../runtime-host/application/subagents/service';
import { SubagentRuntimeWorkflow } from '../../runtime-host/application/workflows/subagent-runtime/subagent-runtime-workflow';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';
import type { RuntimeClockPort } from '../../runtime-host/application/common/runtime-ports';
import type { SubagentConfigProjectionPort, SubagentConfigSnapshot } from '../../runtime-host/application/subagents/subagent-config-contracts';

function clock(nowMs: number): RuntimeClockPort {
  return {
    nowMs: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    toIsoString: (ms) => new Date(ms).toISOString(),
  };
}

function createTestSubagentConfigProjection(options?: {
  config?: Record<string, unknown>;
  revision?: string;
  updatedAt?: number | null;
}): SubagentConfigProjectionPort & {
  readDisplayConfig: ReturnType<typeof vi.fn>;
  setAgentDescription: ReturnType<typeof vi.fn>;
  setAgentModel: ReturnType<typeof vi.fn>;
  setAgentSkills: ReturnType<typeof vi.fn>;
  readConfig: ReturnType<typeof vi.fn>;
  replaceConfig: ReturnType<typeof vi.fn>;
} {
  let snapshot: SubagentConfigSnapshot = {
    config: options?.config ?? {},
    revision: options?.revision ?? 'hash-1',
    updatedAt: options?.updatedAt ?? null,
  };
  const makeSnapshot = () => snapshot;
  return {
    readDisplayConfig: vi.fn(async () => {
      const agents = snapshot.config.agents && typeof snapshot.config.agents === 'object' && !Array.isArray(snapshot.config.agents)
        ? snapshot.config.agents as { defaults?: unknown; list?: unknown }
        : {};
      return {
        agents: Array.isArray(agents.list) ? agents.list as never : [],
        ...(agents.defaults && typeof agents.defaults === 'object' && !Array.isArray(agents.defaults) ? { defaults: agents.defaults as never } : {}),
        revision: snapshot.revision,
        ready: true,
        refreshing: false,
        updatedAt: snapshot.updatedAt,
        error: null,
      };
    }),
    setAgentDescription: vi.fn(async () => makeSnapshot()),
    setAgentModel: vi.fn(async () => makeSnapshot()),
    setAgentSkills: vi.fn(async () => makeSnapshot()),
    readConfig: vi.fn(async () => makeSnapshot()),
    replaceConfig: vi.fn(async (command: { readonly revision: string; readonly config: Record<string, unknown> }) => {
      if (command.revision !== snapshot.revision) {
        return { resultType: 'staleRevision' as const, latestSnapshot: snapshot };
      }
      snapshot = { config: command.config, revision: nextRevision(snapshot.revision), updatedAt: snapshot.updatedAt };
      return { resultType: 'updated' as const, snapshot };
    }),
  };
}

function nextRevision(revision: string): string {
  const match = /^(.*?)(\d+)$/.exec(revision);
  if (!match) {
    return `${revision}-next`;
  }
  return `${match[1]}${Number(match[2]) + 1}`;
}

function createSubagentService(
  deps: {
    gatewayRpc: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
    inspectGatewayMethodReadiness: (methods: string[], timeoutMs?: number) => Promise<unknown>;
    initializeAgentWorkspace?: (workspaceDir: string, options: { createDir?: boolean; workspaceInitialization: 'mainAgentTemplate' | 'emptyWorkspace' }) => Promise<unknown>;
    resolveCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<string[]>;
    resolveCanonicalSkillKeyMap?: (skillIds: readonly string[]) => Promise<Record<string, string>>;
    validateCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<{ ok: true; skillKeys: string[] } | { ok: false; unknownSkillKeys: string[]; nonCanonicalSkillKeys: string[] }>;
    subagentConfigProjection?: SubagentConfigProjectionPort;
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
    subagentConfigProjection: deps.subagentConfigProjection ?? createTestSubagentConfigProjection(),
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
  subagentConfigProjection?: SubagentConfigProjectionPort;
  status?: () => Promise<unknown>;
  resolveCanonicalSkillKeyMap?: (skillIds: readonly string[]) => Promise<Record<string, string>>;
  validateCanonicalSkillKeys?: (skillIds: readonly string[]) => Promise<{ ok: true; skillKeys: string[] } | { ok: false; unknownSkillKeys: string[]; nonCanonicalSkillKeys: string[] }>;
}): AgentSkillConfigService {
  return new AgentSkillConfigService({
    projection: new OpenClawAgentSkillConfigProjection({
      subagentConfigProjection: deps.subagentConfigProjection ?? createTestSubagentConfigProjection(),
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

function createAgentToolConfigService(deps: {
  subagentConfigProjection?: SubagentConfigProjectionPort;
}): AgentToolConfigService {
  return new AgentToolConfigService({
    projection: new OpenClawAgentToolConfigProjection({
      subagentConfigProjection: deps.subagentConfigProjection ?? createTestSubagentConfigProjection(),
    }),
  });
}

function agentToolConfigOperationRoute(agentToolConfigService: AgentToolConfigService, operationId: string) {
  const route = createAgentToolConfigCapabilityOperationRoutes({ agentToolConfigService })
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

  it('validates semantic config writes before touching gateway', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn();
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });

    const skillsSetRoute = subagentOperationRoute(subagentService, 'subagents.skills.set');

    await expect(skillsSetRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: { skills: 'web-search' },
    } as never)).resolves.toEqual({
      status: 400,
      data: { success: false, error: 'skills must be an array' },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('returns canonical skill ids from agent snapshots and display config', async () => {
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
      subagentConfigProjection: createTestSubagentConfigProjection({
        config: { agents: { list: [{ id: 'main', skills: ['Web Search', 'missing'] }] } },
        revision: 'hash-config',
        updatedAt: 2000,
      }),
      nowMs: 2000,
    });

    const listRoute = subagentOperationRoute(subagentService, 'subagents.list');
    const displayConfigRoute = subagentOperationRoute(subagentService, 'subagents.displayConfig.get');

    await listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never);
    pending.get('agents.list')?.({ agents: [{ id: 'main', name: 'Main', skills: ['Web Search', 'missing'] }] });
    await Promise.resolve();

    await expect(listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toMatchObject({
        status: 200,
        data: {
          agents: [{ id: 'main', name: 'Main', skills: ['web-search', 'missing'] }],
        },
      });
    await expect(displayConfigRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toMatchObject({
        status: 200,
        data: {
          agents: [{ id: 'main', skills: ['web-search', 'missing'] }],
          revision: 'hash-config',
          updatedAt: 2000,
        },
      });
    expect(resolveCanonicalSkillKeyMap).toHaveBeenCalledWith(['Web Search', 'missing']);
    expect(resolveCanonicalSkillKeyMap).not.toHaveBeenCalledWith(['Web Search']);
    expect(resolveCanonicalSkillKeyMap).not.toHaveBeenCalledWith(['missing']);
  });

  it('writes canonical skill ids through semantic projection without gateway config rpc', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn();
    const validateCanonicalSkillKeys = vi.fn(async (skillIds: readonly string[]) => ({ ok: true as const, skillKeys: [...skillIds] }));
    const subagentConfigProjection = createTestSubagentConfigProjection({ revision: 'hash-1' });
    const subagentService = createSubagentService({
      gatewayRpc,
      inspectGatewayMethodReadiness,
      validateCanonicalSkillKeys,
      subagentConfigProjection,
    });
    const skillsSetRoute = subagentOperationRoute(subagentService, 'subagents.skills.set');

    await expect(skillsSetRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: { skills: ['web-search'] },
    } as never)).resolves.toEqual({
      status: 200,
      data: { config: {}, revision: 'hash-1', updatedAt: null },
    });

    expect(subagentConfigProjection.setAgentSkills).toHaveBeenCalledWith({ agentId: 'writer', skills: ['web-search'] });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect(inspectGatewayMethodReadiness).not.toHaveBeenCalled();
  });

  it('writes description through semantic projection without validating unrelated agent skills', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn();
    const validateCanonicalSkillKeys = vi.fn(async (skillIds: readonly string[]) => ({ ok: true as const, skillKeys: [...skillIds] }));
    const subagentConfigProjection = createTestSubagentConfigProjection({ revision: 'hash-1' });
    const subagentService = createSubagentService({
      gatewayRpc,
      inspectGatewayMethodReadiness,
      validateCanonicalSkillKeys,
      subagentConfigProjection,
    });
    const descriptionSetRoute = subagentOperationRoute(subagentService, 'subagents.description.set');

    await expect(descriptionSetRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: { description: 'Draft docs' },
    } as never)).resolves.toEqual({
      status: 200,
      data: { config: {}, revision: 'hash-1', updatedAt: null },
    });

    expect(subagentConfigProjection.setAgentDescription).toHaveBeenCalledWith({ agentId: 'writer', description: 'Draft docs' });
    expect(validateCanonicalSkillKeys).not.toHaveBeenCalled();
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('rejects unknown and noncanonical skill ids in semantic skills write without calling projection', async () => {
    const gatewayRpc = vi.fn(async () => ({ ok: true }));
    const inspectGatewayMethodReadiness = vi.fn();
    const subagentConfigProjection = createTestSubagentConfigProjection({ revision: 'hash-1' });
    const validateCanonicalSkillKeys = vi.fn(async (skillIds: readonly string[]) => {
      const unknownSkillKeys = skillIds.filter((skillId) => skillId === 'missing');
      const nonCanonicalSkillKeys = skillIds.filter((skillId) => skillId === 'Web Search');
      if (unknownSkillKeys.length > 0 || nonCanonicalSkillKeys.length > 0) {
        return { ok: false as const, unknownSkillKeys, nonCanonicalSkillKeys };
      }
      return { ok: true as const, skillKeys: [...skillIds] };
    });
    const subagentService = createSubagentService({
      gatewayRpc,
      inspectGatewayMethodReadiness,
      validateCanonicalSkillKeys,
      subagentConfigProjection,
    });
    const skillsSetRoute = subagentOperationRoute(subagentService, 'subagents.skills.set');
    const target = { kind: 'subagent' as const, agentId: 'default', subagentId: 'writer' };

    await expect(skillsSetRoute.handle({ target, domainInput: { skills: ['web-search', 'missing'] } } as never))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'Unknown skillKey: missing' } });
    await expect(skillsSetRoute.handle({ target, domainInput: { skills: ['Web Search'] } } as never))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'skillKey must be canonical: Web Search' } });
    await expect(skillsSetRoute.handle({ target, domainInput: { skills: ['web-search', 123] } } as never))
      .resolves.toEqual({ status: 400, data: { success: false, error: 'skillKey must be a string' } });

    expect(subagentConfigProjection.setAgentSkills).not.toHaveBeenCalled();
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

  it('returns structured 503 when subagent list gateway method is absent', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const inspectGatewayMethodReadiness = vi.fn(async () => ({
      ready: false,
      methods: ['agents.list'],
      missingMethods: ['agents.list'],
    }));
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness });

    const listRoute = subagentOperationRoute(subagentService, 'subagents.list');

    await expect(listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toEqual({
        status: 503,
        data: {
          success: false,
          code: 'PLUGIN_CAPABILITY_UNAVAILABLE',
          pluginId: 'subagents',
          missingMethods: ['agents.list'],
          message: 'subagents plugin is not enabled or did not register required Gateway methods.',
        },
      });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('subagent list cold reads return not-ready while one background rpc refreshes the snapshot', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const gatewayRpc = vi.fn((method: string) => new Promise<unknown>((resolve) => {
      pending.set(method, resolve);
    }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: { agents: { defaults: { workspace: 'E:/workspace/main' } } },
      revision: 'hash-config',
      updatedAt: 2000,
    });
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, subagentConfigProjection, nowMs: 2000 });
    const listRoute = subagentOperationRoute(subagentService, 'subagents.list');
    const displayConfigRoute = subagentOperationRoute(subagentService, 'subagents.displayConfig.get');

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
    await expect(displayConfigRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toEqual({
        status: 200,
        data: {
          agents: [],
          defaults: { workspace: 'E:/workspace/main' },
          revision: 'hash-config',
          ready: true,
          refreshing: false,
          updatedAt: 2000,
          error: null,
        },
      });
    await listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never);

    expect(gatewayRpc).toHaveBeenCalledTimes(1);
    expect(subagentConfigProjection.readDisplayConfig).toHaveBeenCalledTimes(1);
    pending.get('agents.list')?.({ agents: [{ id: 'main', name: 'Main' }], defaultId: 'main' });
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

  it('semantic config writes use projection and do not invalidate gateway snapshots', async () => {
    const pending = new Map<string, (value: unknown) => void>();
    const gatewayRpc = vi.fn((method: string) => new Promise<unknown>((resolve) => {
      pending.set(method, resolve);
    }));
    const inspectGatewayMethodReadiness = vi.fn(async (methods: string[]) => ({
      ready: true,
      methods,
      missingMethods: [],
    }));
    const subagentConfigProjection = createTestSubagentConfigProjection({ revision: 'hash-1' });
    const subagentService = createSubagentService({ gatewayRpc, inspectGatewayMethodReadiness, subagentConfigProjection, nowMs: 3000 });
    const listRoute = subagentOperationRoute(subagentService, 'subagents.list');
    const modelSetRoute = subagentOperationRoute(subagentService, 'subagents.model.set');

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
    await expect(modelSetRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: { model: undefined },
    } as never)).resolves.toEqual({ status: 200, data: { config: {}, revision: 'hash-1', updatedAt: null } });

    pending.get('agents.list')?.({ agents: [{ id: 'main', name: 'Main' }] });
    await Promise.resolve();

    await expect(listRoute.handle({ target: { kind: 'agent', agentId: 'default' }, domainInput: {} } as never))
      .resolves.toMatchObject({
        status: 200,
        data: {
          agents: [{ id: 'main', name: 'Main' }],
          ready: true,
          updatedAt: 3000,
        },
      });
    expect(subagentConfigProjection.setAgentModel).toHaveBeenCalledWith({ agentId: 'writer', model: undefined });
    expect(gatewayRpc.mock.calls.map(([method]) => method)).toEqual(['agents.list', 'agents.list']);
  });

  it('projects agent skill config through subagent target without exposing raw config', async () => {
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: {
        agents: {
          defaults: { skills: ['Web Search'] },
          list: [{ id: 'writer', skills: ['browser-flow'] }],
        },
      },
      revision: 'hash-1',
      updatedAt: 2000,
    });
    const status = vi.fn(async () => ({
      success: true,
      skills: [
        { skillKey: 'web-search', name: 'Web Search', description: 'Search the web', installed: true, disabled: false, source: 'managed' },
        { skillKey: 'browser-flow', name: 'Browser Flow', description: 'Run browser flows', installed: true, disabled: true },
      ],
    }));
    const resolveCanonicalSkillKeyMap = vi.fn(async () => ({ 'Web Search': 'web-search', 'browser-flow': 'browser-flow' }));
    const service = createAgentSkillConfigService({ subagentConfigProjection, status, resolveCanonicalSkillKeyMap });
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
    expect(subagentConfigProjection.readConfig).toHaveBeenCalledTimes(1);
  });

  it('treats missing agent skill allowlist as all selectable OpenClaw skills enabled', async () => {
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: {
        agents: {
          list: [{ id: 'writer', name: 'Writer' }],
        },
      },
      revision: 'hash-all-skills',
    });
    const status = vi.fn(async () => ({
      success: true,
      skills: [
        { skillKey: 'web-search', name: 'Web Search', description: 'Search the web', installed: true, disabled: false },
        { skillKey: 'browser-flow', name: 'Browser Flow', description: 'Run browser flows', installed: true, disabled: false },
        { skillKey: 'disabled-skill', name: 'Disabled Skill', description: 'Disabled', installed: true, disabled: true },
      ],
    }));
    const service = createAgentSkillConfigService({ subagentConfigProjection, status });
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
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: {
        agents: {
          list: [{ id: 'writer', name: 'Writer' }],
        },
      },
      revision: 'hash-missing-agent',
    });
    const status = vi.fn(async () => ({
      success: true,
      skills: [
        { skillKey: 'web-search', name: 'Web Search', description: 'Search the web', installed: true, disabled: false },
        { skillKey: 'browser-flow', name: 'Browser Flow', description: 'Run browser flows', installed: true, disabled: false },
      ],
    }));
    const service = createAgentSkillConfigService({ subagentConfigProjection, status });
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
    expect(subagentConfigProjection.replaceConfig).not.toHaveBeenCalled();
  });

  it('writes agent skill config through canonical projection and rejects stale revisions', async () => {
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: {
        other: true,
        agents: {
          defaults: { workspace: 'E:/workspace/main', skills: ['web-search'] },
          list: [{ id: 'writer', name: 'Writer', skills: ['browser-flow'] }],
        },
      },
      revision: 'hash-2',
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
    const service = createAgentSkillConfigService({ subagentConfigProjection, status, validateCanonicalSkillKeys });
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

    expect(subagentConfigProjection.replaceConfig).toHaveBeenLastCalledWith({
      revision: 'hash-2',
      config: {
        other: true,
        agents: {
          defaults: { workspace: 'E:/workspace/main', skills: ['web-search'] },
          list: [{ id: 'writer', name: 'Writer', skills: ['browser-flow'] }],
        },
      },
    });
    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'hash-3',
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

  it('projects agent tool config from OpenClaw agents list tools', async () => {
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: {
        agents: {
          list: [{
            id: 'writer',
            name: 'Writer',
            tools: { profile: 'custom', allow: ['read', 'group:web'], deny: ['exec'] },
          }],
        },
      },
      revision: 'hash-tools',
      updatedAt: 4000,
    });
    const service = createAgentToolConfigService({ subagentConfigProjection });
    const getRoute = agentToolConfigOperationRoute(service, 'agentToolConfig.get');

    await expect(getRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: {},
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        agentId: 'writer',
        support: { supportType: 'supported' },
        selectionMode: 'usesAgentToolPolicy',
        toolPolicy: { profile: 'custom', allow: ['read', 'group:web'], deny: ['exec'] },
        toolOptions: expect.arrayContaining([
          { toolKey: 'read', displayName: 'Read', optionType: 'tool' },
          { toolKey: 'exec', displayName: 'Exec', optionType: 'tool' },
          { toolKey: 'web_search', displayName: 'Web Search', optionType: 'tool' },
          { toolKey: 'sessions_spawn', displayName: 'Sessions Spawn', optionType: 'tool' },
          { toolKey: 'group:*', displayName: 'All tool groups', optionType: 'group' },
          { toolKey: 'group:web', displayName: 'Web tools', optionType: 'group' },
        ]),
        revision: 'hash-tools',
        updatedAt: 4000,
      },
    });
    expect(subagentConfigProjection.readConfig).toHaveBeenCalledTimes(1);
  });

  it('writes and inherits agent tool config through OpenClaw agents list tools', async () => {
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: {
        other: true,
        agents: {
          defaults: { workspace: 'E:/workspace/main' },
          list: [{ id: 'writer', name: 'Writer', tools: { profile: 'custom', allow: ['read'], deny: [] } }],
        },
      },
      revision: 'hash-tools-1',
    });
    const service = createAgentToolConfigService({ subagentConfigProjection });
    const setRoute = agentToolConfigOperationRoute(service, 'agentToolConfig.set');
    const target = { kind: 'subagent' as const, agentId: 'default', subagentId: 'writer' };

    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'stale-tools',
        selection: { selectionType: 'setAgentToolPolicy', profile: 'custom', allow: ['read'], deny: ['exec'] },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        resultType: 'staleRevision',
        latestView: expect.objectContaining({
          agentId: 'writer',
          selectionMode: 'usesAgentToolPolicy',
          revision: 'hash-tools-1',
        }),
      },
    });

    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'hash-tools-1',
        selection: { selectionType: 'setAgentToolPolicy', profile: 'custom', allow: ['read', 'group:web'], deny: ['exec'] },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        resultType: 'updated',
        view: expect.objectContaining({
          agentId: 'writer',
          selectionMode: 'usesAgentToolPolicy',
          toolPolicy: { profile: 'custom', allow: ['read', 'group:web'], deny: ['exec'] },
          revision: 'hash-tools-2',
        }),
      },
    });
    expect(subagentConfigProjection.replaceConfig).toHaveBeenLastCalledWith({
      revision: 'hash-tools-1',
      config: {
        other: true,
        agents: {
          defaults: { workspace: 'E:/workspace/main' },
          list: [{ id: 'writer', name: 'Writer', tools: { profile: 'custom', allow: ['read', 'group:web'], deny: ['exec'] } }],
        },
      },
    });

    await expect(setRoute.handle({
      target,
      domainInput: {
        revision: 'hash-tools-2',
        selection: { selectionType: 'inheritDefaultTools' },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        resultType: 'updated',
        view: expect.objectContaining({
          agentId: 'writer',
          selectionMode: 'inheritsDefaultTools',
          toolPolicy: null,
          revision: 'hash-tools-3',
        }),
      },
    });
    expect(subagentConfigProjection.replaceConfig).toHaveBeenLastCalledWith({
      revision: 'hash-tools-2',
      config: {
        other: true,
        agents: {
          defaults: { workspace: 'E:/workspace/main' },
          list: [{ id: 'writer', name: 'Writer' }],
        },
      },
    });
  });

  it('rejects unknown agent tool policy keys before writing OpenClaw config', async () => {
    const subagentConfigProjection = createTestSubagentConfigProjection({
      config: { agents: { list: [{ id: 'writer', name: 'Writer' }] } },
      revision: 'hash-tools',
    });
    const service = createAgentToolConfigService({ subagentConfigProjection });
    const setRoute = agentToolConfigOperationRoute(service, 'agentToolConfig.set');

    await expect(setRoute.handle({
      target: { kind: 'subagent', agentId: 'default', subagentId: 'writer' },
      domainInput: {
        revision: 'hash-tools',
        selection: { selectionType: 'setAgentToolPolicy', profile: 'custom', allow: ['read', 'unknown_tool'], deny: ['another_unknown'] },
      },
    } as never)).resolves.toEqual({
      status: 200,
      data: {
        resultType: 'invalidToolKeys',
        unknownToolKeys: ['unknown_tool', 'another_unknown'],
      },
    });
    expect(subagentConfigProjection.replaceConfig).not.toHaveBeenCalled();
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
