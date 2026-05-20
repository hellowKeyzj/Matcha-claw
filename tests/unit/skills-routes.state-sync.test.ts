import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  setManySkillsEnabled?: (skillKeys: readonly string[], enabled: boolean) => Promise<unknown>;
  listEffectiveSkills?: () => Promise<unknown>;
  skillsDir?: string;
  gateway: {
    isGatewayRunning: () => Promise<boolean>;
    readGatewayConnectionState?: () => Promise<unknown>;
    gatewayRpc: (method: string, params?: unknown) => Promise<unknown>;
  };
  getPreviewRoots?: () => Promise<string[]>;
  readmePreview?: (skillKey: string, input: { filePath?: string; baseDir?: string }) => Promise<unknown>;
  openClawDir?: string;
  workingDir?: string;
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
      setManyEnabled: input.setManySkillsEnabled ?? (async () => ({ success: true })),
      listEffective: input.listEffectiveSkills ?? (async () => []),
    },
    readmePreviews: {
      read: input.readmePreview ?? (async () => ({
        status: 404,
        data: { success: false, error: 'Skill preview not found' },
      })),
    },
    gateway: {
      readGatewayConnectionState: async () => ({ state: 'connected', gatewayReady: true }),
      ...input.gateway,
    },
    jobs,
    clock,
    fileSystem: createTestRuntimeFileSystem(),
    commandExecutor: {
      execFile: vi.fn(async () => ({ stdout: '', stderr: '' })),
    },
    systemEnvironment: createTestRuntimeSystemEnvironment(),
    workspace: {
      getSkillsDir: () => input.skillsDir ?? 'C:\\openclaw\\skills',
    },
    environment: createTestOpenClawEnvironmentRepository({
      workingDir: input.workingDir ?? join(input.skillsDir ?? 'C:\\openclaw\\skills', '..', 'workspace'),
      getEnv: (name) => (name === 'MATCHACLAW_OPENCLAW_DIR'
        ? input.openClawDir ?? join(input.skillsDir ?? 'C:\\openclaw\\skills', '..', 'openclaw-package')
        : ''),
    }),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  });
}

async function writeSkillManifest(root: string, slug: string, input: { name?: string; description?: string } = {}) {
  const skillDir = join(root, slug);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${input.name ?? slug}`,
      `description: ${input.description ?? `${slug} description`}`,
      '---',
      '',
    ].join('\n'),
    'utf8',
  );
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
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-refresh-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'demo-skill');
      const gatewayRpc = vi.fn(async () => ({
        skills: [{ skillKey: 'demo-skill', disabled: false }],
      }));
      const skillsService = createSkillsService({
        skillsDir,
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
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('refreshStatus 后台任务才调用 Gateway skills.status 并更新快照', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-refresh-cache-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'demo-skill');
      const gatewayRpc = vi.fn(async () => ({
        skills: [{ skillKey: 'demo-skill', disabled: false }],
      }));
      const skillsService = createSkillsService({
        skillsDir,
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
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('GET /api/skills/status/refresh 返回完整已安装清单，禁用项不因 Gateway 快照缺失而消失', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-inventory-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'pdf', {
        name: 'PDF',
        description: 'Read PDF files',
      });
      await writeSkillManifest(skillsDir, 'brave-web-search', {
        name: 'Brave Web Search',
        description: 'Search the web',
      });
      const gatewayRpc = vi.fn(async () => ({
        skills: [
          {
            skillKey: 'brave-web-search',
            name: 'Brave Web Search',
            description: 'Search the web',
            disabled: false,
            bundled: false,
            eligible: true,
          },
        ],
      }));
      const skillsService = createSkillsService({
        skillsDir,
        getAllSkillConfigs: async () => ({
          pdf: { enabled: false },
          'brave-web-search': { enabled: true },
        }),
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

      const response = await dispatchRuntimeRouteDefinition(
        skillsRoutes,
        'POST',
        '/api/skills/status/refresh',
        {},
        { skillsService },
      );

      expect(response.status).toBe(200);
      expect((response.data as any).skills).toEqual(expect.arrayContaining([
        expect.objectContaining({
          skillKey: 'brave-web-search',
          disabled: false,
          installed: true,
          eligible: true,
          name: 'Brave Web Search',
        }),
        expect.objectContaining({
          skillKey: 'pdf',
          disabled: true,
          installed: true,
          eligible: true,
          name: 'PDF',
          baseDir: join(skillsDir, 'pdf'),
          filePath: join(skillsDir, 'pdf', 'SKILL.md'),
        }),
      ]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('GET /api/skills/status/refresh 保留已安装但当前不可用的技能，只过滤未安装配置项', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-missing-filter-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'apple-notes', {
        name: 'Apple Notes',
        description: 'Manage Apple Notes.',
      });
      await writeSkillManifest(skillsDir, 'pdf', {
        name: 'PDF',
        description: 'Read PDF files.',
      });
      const skillsService = createSkillsService({
        skillsDir,
        getAllSkillConfigs: async () => ({
          'apple-notes': { enabled: false },
          pdf: { enabled: false },
        }),
        gateway: {
          isGatewayRunning: async () => true,
          readGatewayConnectionState: async () => ({
            state: 'connected',
            gatewayReady: true,
            portReachable: true,
          }),
          gatewayRpc: vi.fn(async () => ({
            skills: [
              {
                skillKey: 'apple-notes',
                disabled: true,
                eligible: false,
                missing: {
                  bins: ['memo'],
                  anyBins: [],
                  env: [],
                  config: [],
                  os: ['darwin'],
                },
              },
              {
                skillKey: 'pdf',
                disabled: true,
                eligible: false,
                missing: {
                  bins: [],
                  anyBins: [],
                  env: [],
                  config: [],
                  os: [],
                },
              },
            ],
          })),
        },
      });

      const response = await dispatchRuntimeRouteDefinition(
        skillsRoutes,
        'POST',
        '/api/skills/status/refresh',
        {},
        { skillsService },
      );

      const returnedSkillKeys = ((response.data as any).skills as Array<{ skillKey: string }>).map((skill) => skill.skillKey);
      expect(returnedSkillKeys).toContain('pdf');
      expect(returnedSkillKeys).toContain('apple-notes');
      expect((response.data as any).skills).toEqual(expect.arrayContaining([
        expect.objectContaining({
          skillKey: 'apple-notes',
          installed: true,
          eligible: false,
          missing: expect.objectContaining({
            bins: ['memo'],
            os: ['darwin'],
          }),
        }),
      ]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('GET /api/skills/status/refresh 启用后 eligible=false 的已安装技能不会从列表消失', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-enabled-ineligible-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'image-gen', {
        name: 'Image Gen',
        description: 'Generate images.',
      });
      const skillsService = createSkillsService({
        skillsDir,
        getAllSkillConfigs: async () => ({
          'image-gen': { enabled: true },
          'config-only': { enabled: true },
        }),
        gateway: {
          isGatewayRunning: async () => true,
          readGatewayConnectionState: async () => ({
            state: 'connected',
            gatewayReady: true,
            portReachable: true,
          }),
          gatewayRpc: vi.fn(async () => ({
            skills: [
              {
                skillKey: 'image-gen',
                disabled: false,
                eligible: false,
                missing: {
                  bins: ['python'],
                  anyBins: [],
                  env: [],
                  config: [],
                  os: [],
                },
              },
              {
                skillKey: 'config-only',
                disabled: false,
                eligible: true,
              },
            ],
          })),
        },
      });

      const response = await dispatchRuntimeRouteDefinition(
        skillsRoutes,
        'POST',
        '/api/skills/status/refresh',
        {},
        { skillsService },
      );

      const returnedSkillKeys = ((response.data as any).skills as Array<{ skillKey: string }>).map((skill) => skill.skillKey);
      expect(returnedSkillKeys).toContain('image-gen');
      expect(returnedSkillKeys).not.toContain('config-only');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('GET /api/skills/status/refresh 保留本地 manifest 展示信息，不被 Gateway 空字段覆盖', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-display-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'canvas', {
        name: 'Canvas Skill',
        description: 'Display HTML content on connected OpenClaw nodes.',
      });
      const skillsService = createSkillsService({
        skillsDir,
        gateway: {
          isGatewayRunning: async () => true,
          readGatewayConnectionState: async () => ({
            state: 'connected',
            gatewayReady: true,
            portReachable: true,
          }),
          gatewayRpc: vi.fn(async () => ({
            skills: [{
              skillKey: 'canvas',
              name: '',
              description: '',
              disabled: false,
              eligible: true,
            }],
          })),
        },
      });

      const response = await dispatchRuntimeRouteDefinition(
        skillsRoutes,
        'POST',
        '/api/skills/status/refresh',
        {},
        { skillsService },
      );

      expect((response.data as any).skills).toEqual(expect.arrayContaining([
        expect.objectContaining({
          skillKey: 'canvas',
          name: 'Canvas Skill',
          description: 'Display HTML content on connected OpenClaw nodes.',
          installed: true,
          eligible: true,
        }),
      ]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('GET /api/skills/status/refresh 支持没有 frontmatter 的 Markdown 技能简介', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-markdown-display-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      const skillDir = join(skillsDir, 'canvas');
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, 'SKILL.md'),
        [
          '# Canvas Skill',
          '',
          'Display HTML content on connected OpenClaw nodes.',
          '',
          '## Overview',
          '',
          'Extra details.',
        ].join('\n'),
        'utf8',
      );
      const skillsService = createSkillsService({
        skillsDir,
        gateway: {
          isGatewayRunning: async () => true,
          readGatewayConnectionState: async () => ({
            state: 'connected',
            gatewayReady: true,
            portReachable: true,
          }),
          gatewayRpc: vi.fn(async () => ({ skills: [] })),
        },
      });

      const response = await dispatchRuntimeRouteDefinition(
        skillsRoutes,
        'POST',
        '/api/skills/status/refresh',
        {},
        { skillsService },
      );

      expect((response.data as any).skills).toEqual(expect.arrayContaining([
        expect.objectContaining({
          skillKey: 'canvas',
          name: 'Canvas Skill',
          description: 'Display HTML content on connected OpenClaw nodes.',
        }),
      ]));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('GET /api/skills/status/refresh 只显示 manifest 配置的 OpenClaw 内置 skill', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-bundled-roots-'));
    try {
      const runtimeOpenClawDir = join(tempRoot, 'runtime-openclaw');
      const buildOpenClawSkillsDir = join(tempRoot, 'build', 'openclaw', 'skills');
      await writeSkillManifest(join(runtimeOpenClawDir, 'skills'), 'canvas', {
        name: 'Canvas Skill',
        description: 'Display HTML content.',
      });
      await writeSkillManifest(join(runtimeOpenClawDir, 'skills'), 'healthcheck', {
        name: 'Healthcheck',
        description: 'Check runtime health.',
      });
      await writeSkillManifest(join(tempRoot, 'home', '.openclaw', 'skills'), 'user-skill', {
        name: 'User Skill',
        description: 'Installed by user.',
      });
      await writeSkillManifest(join(tempRoot, 'home', '.openclaw', 'skills'), 'healthcheck', {
        name: 'User Healthcheck',
        description: 'User managed override.',
      });
      await writeSkillManifest(buildOpenClawSkillsDir, 'github', {
        name: 'GitHub',
        description: 'Work with GitHub.',
      });
      await writeSkillManifest(buildOpenClawSkillsDir, 'weather', {
        name: 'Weather',
        description: 'Get weather.',
      });
      await mkdir(join(tempRoot, 'resources', 'skills'), { recursive: true });
      await writeFile(
        join(tempRoot, 'resources', 'skills', 'builtin-visible-skills.json'),
        JSON.stringify({ skills: ['canvas', 'healthcheck'] }),
        'utf8',
      );
      const skillsService = createSkillsService({
        skillsDir: join(tempRoot, 'home', '.openclaw', 'skills'),
        openClawDir: runtimeOpenClawDir,
        workingDir: tempRoot,
        gateway: {
          isGatewayRunning: async () => true,
          readGatewayConnectionState: async () => ({
            state: 'connected',
            gatewayReady: true,
            portReachable: true,
          }),
          gatewayRpc: vi.fn(async () => ({ skills: [{ skillKey: 'canvas', disabled: false, eligible: true }] })),
        },
      });

      const response = await dispatchRuntimeRouteDefinition(
        skillsRoutes,
        'POST',
        '/api/skills/status/refresh',
        {},
        { skillsService },
      );

      const returnedSkillKeys = ((response.data as any).skills as Array<{ skillKey: string }>).map((skill) => skill.skillKey);
      expect(returnedSkillKeys).toEqual(['canvas', 'healthcheck', 'user-skill']);
      expect((response.data as any).skills).toEqual([
        expect.objectContaining({ skillKey: 'canvas', bundled: true, installed: true, eligible: true }),
        expect.objectContaining({
          skillKey: 'healthcheck',
          bundled: false,
          installed: true,
          eligible: true,
          name: 'User Healthcheck',
        }),
        expect.objectContaining({ skillKey: 'user-skill', bundled: false, installed: true, eligible: true }),
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
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

  it('PUT /api/skills/state/batch 会一次本地写入，不再通过 Gateway 逐项写配置', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const setManySkillsEnabled = vi.fn(async () => ({ success: true }));
    const skillsService = createSkillsService({
      setManySkillsEnabled,
      gateway: {
        isGatewayRunning: async () => true,
        gatewayRpc,
      },
    });

    const result = await dispatchRuntimeRouteDefinition(skillsRoutes,
      'PUT',
      '/api/skills/state/batch',
      {
        skillKeys: ['multi-search-engine', 'web-extract', 'multi-search-engine'],
        enabled: false,
      },
      {
        skillsService,
      },
    );

    expect(result).toEqual({
      status: 200,
      data: {
        success: true,
        updated: ['multi-search-engine', 'web-extract'],
        enabled: false,
      },
    });
    expect(setManySkillsEnabled).toHaveBeenCalledTimes(1);
    expect(setManySkillsEnabled).toHaveBeenCalledWith(['multi-search-engine', 'web-extract'], false);
    expect(gatewayRpc).toHaveBeenCalledTimes(1);
    expect(gatewayRpc).toHaveBeenCalledWith('skills.status');
    expect((skillsService as any).deps.jobs.submitGatewayUpdate).not.toHaveBeenCalled();
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

  it('POST /api/skills/bundles/export 打包 managed skill 文本文件', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-export-'));
    try {
      const skillsDir = join(tempDir, 'skills');
      const skillDir = join(skillsDir, 'web-search');
      await createTestRuntimeFileSystem().ensureDirectory(join(skillDir, 'scripts'));
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: Web Search\ndescription: Search web\n---\n', 'utf8');
      await writeFile(join(skillDir, 'scripts', 'run.py'), 'print("hi")\n', 'utf8');

      const result = await dispatchRuntimeRouteDefinition(skillsRoutes,
        'POST',
        '/api/skills/bundles/export',
        { skillKeys: ['web-search', 'missing-skill'] },
        {
          skillsService: createSkillsService({
            skillsDir,
            gateway: {
              isGatewayRunning: async () => false,
              gatewayRpc: vi.fn(async () => ({})),
            },
          }),
        },
      );

      expect(result).toEqual({
        status: 200,
        data: [
          {
            skillKey: 'web-search',
            files: [
              { path: 'scripts/run.py', content: 'print("hi")\n' },
              { path: 'SKILL.md', content: '---\nname: Web Search\ndescription: Search web\n---\n' },
            ],
          },
        ],
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/bundles/import 安装技能包并启用技能', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-import-'));
    try {
      const skillsDir = join(tempDir, 'skills');
      const setSkillEnabled = vi.fn(async () => ({ success: true }));
      const skillsService = createSkillsService({
        skillsDir,
        setSkillEnabled,
        gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc: vi.fn(async () => ({})),
        },
      });

      const result = await dispatchRuntimeRouteDefinition(skillsRoutes,
        'POST',
        '/api/skills/bundles/import',
        {
          skillBundles: [
            {
              skillKey: 'web-search',
              files: [
                { path: 'SKILL.md', content: '---\nname: Web Search\ndescription: Search web\n---\n' },
                { path: 'scripts/run.py', content: 'print("hi")\n' },
              ],
            },
          ],
        },
        { skillsService },
      );

      expect(result).toEqual({
        status: 200,
        data: {
          ok: true,
          installed: ['web-search'],
        },
      });
      await expect(readFile(join(skillsDir, 'web-search', 'scripts', 'run.py'), 'utf8')).resolves.toBe('print("hi")\n');
      expect(setSkillEnabled).toHaveBeenCalledWith('web-search', true);
      expect((skillsService as any).deps.jobs.submitGatewayUpdate).toHaveBeenCalledWith({
        skillKey: 'web-search',
        updates: { enabled: true },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/bundles/import 遇到已存在技能时跳过并保持静默成功', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-import-existing-'));
    try {
      const skillsDir = join(tempDir, 'skills');
      await mkdir(join(skillsDir, 'web-search'), { recursive: true });
      await writeFile(join(skillsDir, 'web-search', 'SKILL.md'), '---\nname: Existing\ndescription: Existing skill\n---\n', 'utf8');
      const setSkillEnabled = vi.fn(async () => ({ success: true }));
      const skillsService = createSkillsService({
        skillsDir,
        setSkillEnabled,
        gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc: vi.fn(async () => ({})),
        },
      });

      const result = await dispatchRuntimeRouteDefinition(skillsRoutes,
        'POST',
        '/api/skills/bundles/import',
        {
          skillBundles: [
            {
              skillKey: 'web-search',
              files: [
                { path: 'SKILL.md', content: '---\nname: Incoming\ndescription: Incoming skill\n---\n' },
              ],
            },
          ],
        },
        { skillsService },
      );

      expect(result).toEqual({
        status: 200,
        data: {
          ok: true,
          installed: [],
          skipped: ['web-search'],
        },
      });
      await expect(readFile(join(skillsDir, 'web-search', 'SKILL.md'), 'utf8')).resolves.toBe('---\nname: Existing\ndescription: Existing skill\n---\n');
      expect(setSkillEnabled).toHaveBeenCalledWith('web-search', true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
