import { describe, expect, it, vi } from 'vitest';
import { skillsRoutes } from '../../runtime-host/api/routes/skills-routes';
import { SkillsService } from '../../runtime-host/application/skills/service';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestOpenClawEnvironmentRepository, createTestRuntimeSystemEnvironment } from './helpers/runtime-system-environment';

const clock = {
  nowMs: () => 2345,
  nowIso: () => '1970-01-01T00:00:02.345Z',
};

function createSkillsService(input: {
  getAllSkillConfigs?: () => Promise<Record<string, unknown>>;
  updateSkillConfig?: (skillKey: string, updates: Record<string, unknown>) => Promise<unknown>;
  setSkillEnabled?: (skillKey: string, enabled: boolean) => Promise<unknown>;
  listEffectiveSkills?: () => Promise<unknown>;
  gateway: {
    isGatewayRunning: () => Promise<boolean>;
    readGatewayConnectionState?: () => Promise<unknown>;
    gatewayRpc: (method: string, params?: unknown) => Promise<unknown>;
  };
  getPreviewRoots?: () => Promise<string[]>;
  readmePreview?: (skillKey: string, input: { filePath?: string; baseDir?: string }) => Promise<unknown>;
}) {
  const jobs = {
    submitRefreshStatus: vi.fn(() => ({
      success: true as const,
      job: {
        id: 'job-skills-refresh',
        type: 'skills.refreshStatus',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
    submitGatewayUpdate: vi.fn((payload: { readonly skillKey: string; readonly updates: Record<string, unknown> }) => ({
      success: true as const,
      job: {
        id: `job-${payload.skillKey}`,
        type: 'skills.syncGatewayUpdate',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
      },
    })),
    submitImportLocal: vi.fn((payload: { readonly sourcePath: string }) => ({
      success: true as const,
      job: {
        id: 'job-skill-import',
        type: 'skills.importLocal',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
        payload,
      },
    })),
    submitEnsurePreinstalled: vi.fn(() => ({
      success: true as const,
      job: {
        id: 'job-skills-preinstalled',
        type: 'skills.ensurePreinstalled',
        status: 'queued' as const,
        queuedAt: 1,
        attempts: 0,
        maxAttempts: 1,
      },
    })),
  };
  return new SkillsService({
    repository: {
      getAllConfigs: input.getAllSkillConfigs ?? (async () => ({})),
      updateConfig: input.updateSkillConfig ?? (async () => ({ success: true })),
      setEnabled: input.setSkillEnabled ?? (async () => ({ success: true })),
      listEffective: input.listEffectiveSkills ?? (async () => []),
    },
    readmePreviews: {
      read: input.readmePreview ?? (async () => ({
        status: 404,
        data: { success: false, error: 'Skill preview not found' },
      })),
    },
    gateway: input.gateway,
    jobs,
    clock,
    fileSystem: createTestRuntimeFileSystem(),
    commandExecutor: {
      execFile: vi.fn(async () => ({ stdout: '', stderr: '' })),
    },
    systemEnvironment: createTestRuntimeSystemEnvironment(),
    workspace: {
      getSkillsDir: () => 'C:\\openclaw\\skills',
    },
    environment: createTestOpenClawEnvironmentRepository(),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
}

describe('skills route state sync', () => {
  it('GET /api/skills/status 在 Gateway 未 ready 时只读快照，不提交刷新任务', async () => {
    const gatewayRpc = vi.fn(async () => ({
      skills: [{ skillKey: 'demo-skill', disabled: false }],
    }));
    const skillsService = createSkillsService({
      gateway: {
        isGatewayRunning: async () => true,
        readGatewayConnectionState: async () => ({
          state: 'disconnected',
          gatewayReady: false,
          portReachable: false,
        }),
        gatewayRpc,
      },
    });

    const response = await dispatchRuntimeRouteDefinition(skillsRoutes, 
      'GET',
      '/api/skills/status',
      undefined,
      { skillsService },
    );

    expect(response).toEqual({
      status: 200,
      data: {
        success: true,
        skills: [],
        ready: false,
        updatedAt: null,
        error: null,
      },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect((skillsService as any).deps.jobs.submitRefreshStatus).not.toHaveBeenCalled();
  });

  it('GET /api/skills/status 在 Gateway ready 后只提交后台刷新任务', async () => {
    const gatewayRpc = vi.fn(async () => ({
      skills: [{ skillKey: 'demo-skill', disabled: false }],
    }));
    const skillsService = createSkillsService({
      gateway: {
        isGatewayRunning: async () => true,
        readGatewayConnectionState: async () => ({
          state: 'connected',
          gatewayReady: true,
          portReachable: true,
        }),
        gatewayRpc,
      },
    });

    const response = await dispatchRuntimeRouteDefinition(skillsRoutes,
      'GET',
      '/api/skills/status',
      undefined,
      { skillsService },
    );

    expect(response.data).toMatchObject({
      success: true,
      ready: false,
      error: null,
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect((skillsService as any).deps.jobs.submitRefreshStatus).toHaveBeenCalledTimes(1);
  });

  it('POST /api/skills/status/refresh 在 Gateway ready 后直接返回最新快照', async () => {
    const gatewayRpc = vi.fn(async () => ({
      skills: [{ skillKey: 'demo-skill', disabled: false }],
    }));
    const skillsService = createSkillsService({
      gateway: {
        isGatewayRunning: async () => true,
        readGatewayConnectionState: async () => ({
          state: 'connected',
          gatewayReady: true,
          portReachable: true,
        }),
        gatewayRpc,
      },
    });

    const response = await dispatchRuntimeRouteDefinition(skillsRoutes,
      'POST',
      '/api/skills/status/refresh',
      undefined,
      { skillsService },
    );

    expect(response.data).toMatchObject({
      success: true,
      skills: [{ skillKey: 'demo-skill', disabled: false }],
      ready: true,
      error: null,
    });
    expect(gatewayRpc).toHaveBeenCalledTimes(1);
    expect(gatewayRpc).toHaveBeenCalledWith('skills.status');
  });

  it('refreshStatus 后台任务才调用 Gateway skills.status 并更新快照', async () => {
    const gatewayRpc = vi.fn(async () => ({
      skills: [{ skillKey: 'demo-skill', disabled: false }],
    }));
    const skillsService = createSkillsService({
      gateway: {
        isGatewayRunning: async () => true,
        readGatewayConnectionState: async () => ({
          state: 'connected',
          gatewayReady: true,
          portReachable: true,
        }),
        gatewayRpc,
      },
    });

    await expect(skillsService.refreshStatus()).resolves.toMatchObject({
      success: true,
      skills: [{ skillKey: 'demo-skill', disabled: false }],
    });

    const response = await dispatchRuntimeRouteDefinition(skillsRoutes, 
      'GET',
      '/api/skills/status',
      undefined,
      { skillsService },
    );

    expect(response?.data).toMatchObject({
      success: true,
      skills: [{ skillKey: 'demo-skill', disabled: false }],
      ready: true,
      error: null,
    });
    expect(gatewayRpc).toHaveBeenCalledTimes(1);
    expect(gatewayRpc).toHaveBeenCalledWith('skills.status');
  });

  it('refreshStatus 后台任务在 Gateway 未 ready 时不调用 RPC，也不缓存连接错误', async () => {
    const gatewayRpc = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:18789');
    });
    const skillsService = createSkillsService({
      gateway: {
        isGatewayRunning: async () => true,
        readGatewayConnectionState: async () => ({
          state: 'disconnected',
          gatewayReady: false,
          portReachable: false,
        }),
        gatewayRpc,
      },
    });

    await expect(skillsService.refreshStatus()).resolves.toEqual({
      success: true,
      skills: [],
      ready: false,
      updatedAt: null,
      error: null,
    });

    const response = await dispatchRuntimeRouteDefinition(skillsRoutes,
      'GET',
      '/api/skills/status',
      undefined,
      { skillsService },
    );

    expect(response.data).toMatchObject({
      success: true,
      ready: false,
      error: null,
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('PUT /api/skills/state 会先本地写 enabled，再提交 skills.update 后台同步任务', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const setSkillEnabled = vi.fn(async () => ({ success: true }));
    const skillsService = createSkillsService({
      setSkillEnabled,
      gateway: {
        isGatewayRunning: async () => true,
        gatewayRpc,
      },
    });

    const result = await dispatchRuntimeRouteDefinition(skillsRoutes, 
      'PUT',
      '/api/skills/state',
      {
        skillKey: 'multi-search-engine',
        enabled: true,
      },
      {
        skillsService,
      },
    );

    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: expect.objectContaining({ type: 'skills.syncGatewayUpdate' }),
      },
    });
    expect(setSkillEnabled).toHaveBeenCalledWith('multi-search-engine', true);
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect((skillsService as any).deps.jobs.submitGatewayUpdate).toHaveBeenCalledWith({
      skillKey: 'multi-search-engine',
      updates: {
      enabled: true,
      },
    });
  });

  it('PUT /api/skills/state 在 Gateway 未运行时仍只提交同一个后台同步任务', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const setSkillEnabled = vi.fn(async () => ({ success: true }));

    const result = await dispatchRuntimeRouteDefinition(skillsRoutes, 
      'PUT',
      '/api/skills/state',
      {
        skillKey: 'web-extract',
        enabled: false,
      },
      {
        skillsService: createSkillsService({
          setSkillEnabled,
          gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc,
          },
        }),
      },
    );

    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: expect.objectContaining({ type: 'skills.syncGatewayUpdate' }),
      },
    });
    expect(setSkillEnabled).toHaveBeenCalledWith('web-extract', false);
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('PUT /api/skills/config 会先本地写配置，再提交 skills.update 后台同步任务', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const updateSkillConfig = vi.fn(async () => ({ success: true }));
    const skillsService = createSkillsService({
      updateSkillConfig,
      gateway: {
        isGatewayRunning: async () => true,
        gatewayRpc,
      },
    });

    const result = await dispatchRuntimeRouteDefinition(skillsRoutes, 
      'PUT',
      '/api/skills/config',
      {
        skillKey: 'tavily-search',
        apiKey: 'tv-key',
        env: {
          TAVILY_SEARCH_DEPTH: 'advanced',
        },
      },
      {
        skillsService,
      },
    );

    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: expect.objectContaining({ type: 'skills.syncGatewayUpdate' }),
      },
    });
    expect(updateSkillConfig).toHaveBeenCalledWith('tavily-search', {
      apiKey: 'tv-key',
      env: {
        TAVILY_SEARCH_DEPTH: 'advanced',
      },
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect((skillsService as any).deps.jobs.submitGatewayUpdate).toHaveBeenCalledWith({
      skillKey: 'tavily-search',
      updates: {
      apiKey: 'tv-key',
      env: {
        TAVILY_SEARCH_DEPTH: 'advanced',
      },
      },
    });
  });

  it('PUT /api/skills/config 在 Gateway 未运行时会本地写配置', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const updateSkillConfig = vi.fn(async () => ({ success: true }));

    const result = await dispatchRuntimeRouteDefinition(skillsRoutes, 
      'PUT',
      '/api/skills/config',
      {
        skillKey: 'tavily-search',
        apiKey: 'tv-key',
      },
      {
        skillsService: createSkillsService({
          updateSkillConfig,
          gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc,
          },
        }),
      },
    );

    expect(result).toEqual({
      status: 202,
      data: {
        success: true,
        job: expect.objectContaining({ type: 'skills.syncGatewayUpdate' }),
      },
    });
    expect(updateSkillConfig).toHaveBeenCalledWith('tavily-search', {
      apiKey: 'tv-key',
    });
    expect(gatewayRpc).not.toHaveBeenCalled();
  });

  it('后台执行 Gateway 同步失败时返回 syncError，不影响本地写入路径', async () => {
    const gatewayRpc = vi.fn(async () => {
      throw new Error('gateway rpc unavailable');
    });
    const updateSkillConfig = vi.fn(async () => ({ success: true }));
    const skillsService = createSkillsService({
      updateSkillConfig,
      gateway: {
        isGatewayRunning: async () => true,
        gatewayRpc,
      },
    });

    const result = await skillsService.executeGatewayUpdate('tavily-search', { apiKey: 'tv-key' });

    expect(result).toBe('Error: gateway rpc unavailable');
    expect(updateSkillConfig).not.toHaveBeenCalled();
    expect(gatewayRpc).toHaveBeenCalledWith('skills.update', {
      skillKey: 'tavily-search',
      apiKey: 'tv-key',
    });
  });

  it('POST /api/skills/readme 只允许读取受控根目录内的 SKILL.md', async () => {
    const readmePreview = vi.fn(async () => ({
      status: 200,
      data: {
        success: true,
        content: '# Workspace Skill',
        filePath: 'C:\\workspace\\skills\\workspace-skill\\SKILL.md',
      },
    }));
    const result = await dispatchRuntimeRouteDefinition(skillsRoutes, 
      'POST',
      '/api/skills/readme',
      {
        skillKey: 'workspace-skill',
        filePath: 'C:\\workspace\\skills\\workspace-skill\\SKILL.md',
      },
      {
        skillsService: createSkillsService({
          readmePreview,
          gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc: vi.fn(async () => ({})),
          },
        }),
      },
    );

    expect(result?.status).toBe(200);
    expect(readmePreview).toHaveBeenCalledWith('workspace-skill', {
      filePath: 'C:\\workspace\\skills\\workspace-skill\\SKILL.md',
      baseDir: undefined,
    });
  });
});
