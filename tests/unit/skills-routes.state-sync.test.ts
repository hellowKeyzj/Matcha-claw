import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { skillsRoutes } from '../../runtime-host/api/routes/skills-routes';
import type { RuntimePluginConfigProjectionPort, RuntimePluginConfigStorePort } from '../../runtime-host/application/plugins/runtime-plugin-service';
import { createSkillManagementCapabilityOperationRoutes } from '../../runtime-host/application/capabilities/skill/skill-management-capability';
import { SkillsService } from '../../runtime-host/application/skills/service';
import { LocalSkillImportWorkflow } from '../../runtime-host/application/workflows/skill-install/local-skill-import-workflow';
import { SkillBundleTransferWorkflow } from '../../runtime-host/application/workflows/skill-install/skill-bundle-transfer-workflow';
import { PreinstalledSkillsWorkflow } from '../../runtime-host/application/workflows/skill-install/preinstalled-skills-workflow';
import { SkillsOperationsWorkflow } from '../../runtime-host/application/workflows/skill-runtime/skills-operations-workflow';
import { SkillRuntimeWorkflow } from '../../runtime-host/application/workflows/skill-runtime/skill-runtime-workflow';
import { dispatchRuntimeRouteDefinition } from './helpers/runtime-route';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestRuntimeSystemEnvironment } from './helpers/runtime-system-environment';

const clock = {
  nowMs: () => 2345,
  nowIso: () => '1970-01-01T00:00:02.345Z',
};

async function executeSkillsRefreshStatus(skillsService: SkillsService) {
  const route = createSkillManagementCapabilityOperationRoutes({
    skillsService: skillsService as never,
    clawHubService: {
      install: vi.fn(),
      uninstall: vi.fn(),
    } as never,
  }).find((item) => item.operationId === 'skills.refreshStatus');
  if (!route) {
    throw new Error('skills.refreshStatus route not registered');
  }
  return await route.handle({});
}

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
  pluginConfigStore?: RuntimePluginConfigStorePort;
  pluginConfigProjection?: Pick<RuntimePluginConfigProjectionPort, 'readManuallyManagedPluginIds' | 'applyManuallyManagedPluginIds'>;
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
  const defaultKnownSkillConfigs = {
    'multi-search-engine': {},
    'web-extract': {},
    'tavily-search': {},
  };
  const workingDir = input.workingDir ?? join(input.skillsDir ?? 'C:\\openclaw\\skills', '..', 'workspace');
  const openClawDir = input.openClawDir ?? join(input.skillsDir ?? 'C:\\openclaw\\skills', '..', 'openclaw-package');
  const fileSystem = createTestRuntimeFileSystem();
  const commandExecutor = { execFile: vi.fn(async () => ({ stdout: '', stderr: '' })) };
  const systemEnvironment = createTestRuntimeSystemEnvironment();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const repository = {
    getAllConfigs: input.getAllSkillConfigs ?? (async () => defaultKnownSkillConfigs),
    updateConfig: input.updateSkillConfig ?? (async () => ({ success: true })),
    setEnabled: input.setSkillEnabled ?? (async () => ({ success: true })),
    setManyEnabled: input.setManySkillsEnabled ?? (async () => ({ success: true })),
    listEffective: input.listEffectiveSkills ?? (async () => []),
  };
  const pluginConfigStore = input.pluginConfigStore ?? {
    read: vi.fn(async () => ({})),
    updateDirty: vi.fn(async (mutate) => {
      const config: Record<string, unknown> = {};
      const update = await mutate(config);
      return update.result;
    }),
  };
  const pluginConfigProjection = input.pluginConfigProjection ?? {
    readManuallyManagedPluginIds: vi.fn(async () => []),
    applyManuallyManagedPluginIds: vi.fn(async (config: Record<string, unknown>) => config),
  };
  const skillRuntimeWorkflow = new SkillRuntimeWorkflow({
    gateway: {
      readGatewayConnectionState: async () => ({ state: 'connected', gatewayReady: true }),
      ...input.gateway,
    } as never,
    jobs,
    clock,
    repository,
    fileSystem,
    workspace: {
      getSkillsDir: () => input.skillsDir ?? 'C:\\openclaw\\skills',
      getBuiltinVisibleSkillsManifestCandidates: () => [
        join(workingDir, 'resources', 'skills', 'builtin-visible-skills.json'),
      ],
      getBuiltinSkillRootCandidates: () => [
        join(openClawDir, 'skills'),
        join(workingDir, 'build', 'openclaw', 'skills'),
      ],
    },
    logger,
  });
  const skillBundleTransferWorkflow = new SkillBundleTransferWorkflow({
    repository,
    jobs,
    clock,
    fileSystem,
    skillsRoot: () => input.skillsDir ?? 'C:\\openclaw\\skills',
  });
  const preinstalledSkillsWorkflow = new PreinstalledSkillsWorkflow({
    repository,
    jobs,
    clock,
    fileSystem,
    workspace: {
      getSkillsDir: () => input.skillsDir ?? 'C:\\openclaw\\skills',
      getPreinstalledManifestCandidates: () => [
        join(workingDir, 'resources', 'skills', 'preinstalled-manifest.json'),
      ],
      getPreinstalledSourceRootCandidates: () => [
        join(workingDir, 'build', 'preinstalled-skills'),
      ],
    },
    logger,
  });
  const localSkillImportWorkflow = new LocalSkillImportWorkflow({
    fileSystem,
    commandExecutor,
    systemEnvironment,
    clock,
    skillsRoot: () => input.skillsDir ?? 'C:\\openclaw\\skills',
    logger,
  });
  const service = new SkillsService({
    operationsWorkflow: new SkillsOperationsWorkflow({
      repository,
      readmePreviews: {
        read: input.readmePreview ?? (async () => ({
          status: 404,
          data: { success: false, error: 'Skill preview not found' },
        })),
      },
      jobs,
      skillRuntimeWorkflow,
      skillBundleTransferWorkflow,
      localSkillImportWorkflow,
      pluginConfigStore,
      pluginConfigProjection,
      logger,
    }),
    skillRuntimeWorkflow,
    skillBundleTransferWorkflow,
    preinstalledSkillsWorkflow,
  });
  return service;
}

async function dispatchSkillManagementCapability(
  skillsService: SkillsService,
  operationId: string,
  payload: Record<string, unknown>,
) {
  const route = createSkillManagementCapabilityOperationRoutes({
    skillsService,
    clawHubService: {
      install: vi.fn(),
      uninstall: vi.fn(),
    } as never,
  }).find((candidate) => candidate.operationId === operationId);
  if (!route) {
    throw new Error(`Missing skill management operation: ${operationId}`);
  }
  return await route.handle({ domainInput: payload });
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
    expect((skillsService as any).deps.operationsWorkflow.deps.jobs.submitRefreshStatus).not.toHaveBeenCalled();
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
    expect((skillsService as any).deps.operationsWorkflow.deps.jobs.submitRefreshStatus).toHaveBeenCalledTimes(1);
  });

  it('skill.management refreshStatus capability 在 Gateway ready 后直接返回最新快照', async () => {
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

      const response = await executeSkillsRefreshStatus(skillsService);

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

  it('skill.management refreshStatus capability 返回完整已安装清单，禁用项不因 Gateway 快照缺失而消失', async () => {
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

      const response = await executeSkillsRefreshStatus(skillsService);

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

  it('skill.management refreshStatus capability 保留已安装但当前不可用的技能，只过滤未安装配置项', async () => {
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

      const response = await executeSkillsRefreshStatus(skillsService);

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

  it('skill.management refreshStatus capability 启用后 eligible=false 的已安装技能不会从列表消失', async () => {
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

      const response = await executeSkillsRefreshStatus(skillsService);

      const returnedSkillKeys = ((response.data as any).skills as Array<{ skillKey: string }>).map((skill) => skill.skillKey);
      expect(returnedSkillKeys).toContain('image-gen');
      expect(returnedSkillKeys).not.toContain('config-only');
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('validateCanonicalSkillKeys 只接受 refreshStatus 中可展示的 installed skill', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-validate-gateway-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      const skillsService = createSkillsService({
        skillsDir,
        getAllSkillConfigs: async () => ({
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
                skillKey: 'pdf',
                name: 'PDF',
                description: 'Read PDF files.',
                disabled: false,
                installed: true,
                eligible: true,
              },
              {
                skillKey: 'not-installed',
                name: 'Not Installed',
                description: 'Mentioned by Gateway only.',
                disabled: false,
                installed: false,
                eligible: true,
              },
            ],
          })),
        },
      });

      await executeSkillsRefreshStatus(skillsService);
      const workflow = (skillsService as any).deps.skillRuntimeWorkflow as SkillRuntimeWorkflow;

      await expect(workflow.validateCanonicalSkillKeys(['pdf']))
        .resolves.toEqual({ ok: true, skillKeys: ['pdf'] });
      await expect(workflow.validateCanonicalSkillKeys(['not-installed']))
        .resolves.toEqual({ ok: false, unknownSkillKeys: ['not-installed'], nonCanonicalSkillKeys: [] });
      await expect(workflow.validateCanonicalSkillKeys(['config-only']))
        .resolves.toEqual({ ok: false, unknownSkillKeys: ['config-only'], nonCanonicalSkillKeys: [] });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skill.management refreshStatus capability 保留本地 manifest 展示信息，不被 Gateway 空字段覆盖', async () => {
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

      const response = await executeSkillsRefreshStatus(skillsService);

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

  it('skill.management refreshStatus capability 支持没有 frontmatter 的 Markdown 技能简介', async () => {
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

      const response = await executeSkillsRefreshStatus(skillsService);

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

  it('skill.management refreshStatus capability 只显示 manifest 配置的 OpenClaw 内置 skill', async () => {
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

      const response = await executeSkillsRefreshStatus(skillsService);

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

  it('skills.updateState capability 会先本地写 enabled，再提交 skills.update 后台同步任务', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-update-state-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'multi-search-engine');
      const gatewayRpc = vi.fn(async () => ({}));
      const setSkillEnabled = vi.fn(async () => ({ success: true }));
      const skillsService = createSkillsService({
        skillsDir,
        setSkillEnabled,
        gateway: {
          isGatewayRunning: async () => true,
          gatewayRpc,
        },
      });

      const result = await dispatchSkillManagementCapability(skillsService, 'skills.updateState', {
        skillKey: 'multi-search-engine',
        enabled: true,
      });

      expect(result).toEqual({
        status: 202,
        data: {
          success: true,
          job: expect.objectContaining({ type: 'skills.syncGatewayUpdate' }),
        },
      });
      expect(setSkillEnabled).toHaveBeenCalledWith('multi-search-engine', true);
      expect(gatewayRpc).not.toHaveBeenCalled();
      expect((skillsService as any).deps.operationsWorkflow.deps.jobs.submitGatewayUpdate).toHaveBeenCalledWith({
        skillKey: 'multi-search-engine',
        updates: {
        enabled: true,
        },
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skills.updateState capability 会同步刷新 team-runtime 依赖可用清单', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-plugin-projection-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'multi-search-engine');
      await writeSkillManifest(skillsDir, 'web-extract');
      const pluginConfig = {
        plugins: {
          allow: ['team-runtime'],
          entries: {
            'team-runtime': {
              enabled: true,
              config: {
                availableSkills: ['*'],
                availableTools: ['*'],
              },
            },
          },
        },
        skills: {
          entries: {
            'multi-search-engine': { enabled: false },
            'web-extract': { enabled: true },
          },
        },
      } as Record<string, unknown>;
      const pluginConfigStore = {
        read: vi.fn(async () => pluginConfig),
        updateDirty: vi.fn(async (mutate) => {
          const update = await mutate(pluginConfig);
          return update.result;
        }),
      };
      const pluginConfigProjection = {
        readManuallyManagedPluginIds: vi.fn(async () => ['team-runtime']),
        applyManuallyManagedPluginIds: vi.fn(async (config: Record<string, any>) => {
          const skills = config.skills?.entries ?? {};
          return {
            ...config,
            plugins: {
              ...config.plugins,
              entries: {
                ...config.plugins.entries,
                'team-runtime': {
                  ...config.plugins.entries['team-runtime'],
                  config: {
                    ...config.plugins.entries['team-runtime'].config,
                    availableSkills: Object.entries(skills)
                      .filter(([, entry]) => (entry as { enabled?: boolean }).enabled === true)
                      .map(([skillKey]) => skillKey),
                    availableTools: ['*'],
                  },
                },
              },
            },
          };
        }),
      };
      const setSkillEnabled = vi.fn(async (skillKey: string, enabled: boolean) => {
        ((pluginConfig.skills as any).entries as Record<string, { enabled?: boolean }>)[skillKey] = { enabled };
        return { success: true };
      });
      const skillsService = createSkillsService({
        skillsDir,
        getAllSkillConfigs: async () => (pluginConfig.skills as any).entries,
        setSkillEnabled,
        pluginConfigStore,
        pluginConfigProjection,
        gateway: {
          isGatewayRunning: async () => true,
          gatewayRpc: vi.fn(async () => ({})),
        },
      });

      await dispatchSkillManagementCapability(skillsService, 'skills.updateState', {
        skillKey: 'multi-search-engine',
        enabled: true,
      });

      expect(pluginConfigStore.updateDirty).toHaveBeenCalledTimes(1);
      expect(pluginConfigProjection.readManuallyManagedPluginIds).toHaveBeenCalledWith(pluginConfig);
      expect((pluginConfig.plugins as any).entries['team-runtime'].config.availableSkills).toEqual([
        'multi-search-engine',
        'web-extract',
      ]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skills.updateState capability 在 Gateway 未运行时仍只提交同一个后台同步任务', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-update-offline-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'web-extract');
      const gatewayRpc = vi.fn(async () => ({}));
      const setSkillEnabled = vi.fn(async () => ({ success: true }));

      const skillsService = createSkillsService({
        skillsDir,
        setSkillEnabled,
        gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc,
        },
      });
      const result = await dispatchSkillManagementCapability(skillsService, 'skills.updateState', {
        skillKey: 'web-extract',
        enabled: false,
      });

      expect(result).toEqual({
        status: 202,
        data: {
          success: true,
          job: expect.objectContaining({ type: 'skills.syncGatewayUpdate' }),
        },
      });
      expect(setSkillEnabled).toHaveBeenCalledWith('web-extract', false);
      expect(gatewayRpc).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skills.updateState capability/batch 会一次本地写入，不再通过 Gateway 逐项写配置', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-update-batch-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'multi-search-engine');
      await writeSkillManifest(skillsDir, 'web-extract');
      const gatewayRpc = vi.fn(async () => ({}));
      const setManySkillsEnabled = vi.fn(async () => ({ success: true }));
      const skillsService = createSkillsService({
        skillsDir,
        setManySkillsEnabled,
        gateway: {
          isGatewayRunning: async () => true,
          gatewayRpc,
        },
      });

      const result = await dispatchSkillManagementCapability(skillsService, 'skills.updateBatchState', {
        skillKeys: ['multi-search-engine', 'web-extract', 'multi-search-engine'],
        enabled: false,
      });

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
      expect((skillsService as any).deps.operationsWorkflow.deps.jobs.submitGatewayUpdate).not.toHaveBeenCalled();
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skills.updateConfig capability 会先本地写配置，再提交 skills.update 后台同步任务', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-update-config-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'tavily-search');
      const gatewayRpc = vi.fn(async () => ({}));
      const updateSkillConfig = vi.fn(async () => ({ success: true }));
      const skillsService = createSkillsService({
        skillsDir,
        updateSkillConfig,
        gateway: {
          isGatewayRunning: async () => true,
          gatewayRpc,
        },
      });

      const result = await dispatchSkillManagementCapability(skillsService, 'skills.updateConfig', {
        skillKey: 'tavily-search',
        apiKey: 'tv-key',
        env: {
          TAVILY_SEARCH_DEPTH: 'advanced',
        },
      });

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
      expect((skillsService as any).deps.operationsWorkflow.deps.jobs.submitGatewayUpdate).toHaveBeenCalledWith({
        skillKey: 'tavily-search',
        updates: {
        apiKey: 'tv-key',
        env: {
          TAVILY_SEARCH_DEPTH: 'advanced',
        },
        },
      });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skills.updateConfig capability 在 Gateway 未运行时会本地写配置', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-update-config-offline-'));
    try {
      const skillsDir = join(tempRoot, 'skills');
      await writeSkillManifest(skillsDir, 'tavily-search');
      const gatewayRpc = vi.fn(async () => ({}));
      const updateSkillConfig = vi.fn(async () => ({ success: true }));

      const skillsService = createSkillsService({
        skillsDir,
        updateSkillConfig,
        gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc,
        },
      });
      const result = await dispatchSkillManagementCapability(skillsService, 'skills.updateConfig', {
        skillKey: 'tavily-search',
        apiKey: 'tv-key',
      });

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
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('skills.update* capability 拒绝 unknown/noncanonical skillKey 且不写入本地配置', async () => {
    const gatewayRpc = vi.fn(async () => ({}));
    const updateSkillConfig = vi.fn(async () => ({ success: true }));
    const setSkillEnabled = vi.fn(async () => ({ success: true }));
    const setManySkillsEnabled = vi.fn(async () => ({ success: true }));
    const tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-canonical-'));
    const skillsDir = join(tempRoot, 'skills');
    await writeSkillManifest(skillsDir, 'web-search', { name: 'Web Search' });
    const skillsService = createSkillsService({
      skillsDir,
      getAllSkillConfigs: async () => ({
        'web-search': {},
      }),
      updateSkillConfig,
      setSkillEnabled,
      setManySkillsEnabled,
      gateway: {
        isGatewayRunning: async () => true,
        gatewayRpc,
      },
    });

    await expect(dispatchSkillManagementCapability(skillsService, 'skills.updateConfig', {
      skillKey: 'missing',
      apiKey: 'secret',
    })).resolves.toEqual({ status: 400, data: { success: false, error: 'Unknown skillKey: missing' } });
    await expect(dispatchSkillManagementCapability(skillsService, 'skills.updateState', {
      skillKey: 'Web Search',
      enabled: true,
    })).resolves.toEqual({ status: 400, data: { success: false, error: 'skillKey must be canonical: Web Search' } });
    await expect(dispatchSkillManagementCapability(skillsService, 'skills.updateBatchState', {
      skillKeys: ['web-search', 'missing'],
      enabled: false,
    })).resolves.toEqual({ status: 400, data: { success: false, error: 'Unknown skillKey: missing' } });

    expect(updateSkillConfig).not.toHaveBeenCalled();
    expect(setSkillEnabled).not.toHaveBeenCalled();
    expect(setManySkillsEnabled).not.toHaveBeenCalled();
    expect(gatewayRpc).not.toHaveBeenCalled();
    expect((skillsService as any).deps.operationsWorkflow.deps.jobs.submitGatewayUpdate).not.toHaveBeenCalled();
    await rm(tempRoot, { recursive: true, force: true });
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

  it('skills.exportBundles capability 打包 managed skill 文本文件', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-export-'));
    try {
      const skillsDir = join(tempDir, 'skills');
      const skillDir = join(skillsDir, 'web-search');
      await createTestRuntimeFileSystem().ensureDirectory(join(skillDir, 'scripts'));
      await writeFile(join(skillDir, 'SKILL.md'), '---\nname: Web Search\ndescription: Search web\n---\n', 'utf8');
      await writeFile(join(skillDir, 'scripts', 'run.py'), 'print("hi")\n', 'utf8');

      const skillsService = createSkillsService({
        skillsDir,
        gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc: vi.fn(async () => ({})),
        },
      });
      const result = await dispatchSkillManagementCapability(skillsService, 'skills.exportBundles', {
        skillKeys: ['web-search', 'missing-skill'],
      });

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

  it('skills.importBundles capability 安装技能包并启用技能', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'matchaclaw-skills-import-'));
    try {
      const skillsDir = join(tempDir, 'skills');
      const pluginConfig = {
        plugins: {
          allow: ['team-runtime'],
          entries: {
            'team-runtime': {
              enabled: true,
              config: {
                availableSkills: [],
                availableTools: ['*'],
              },
            },
          },
        },
        skills: {
          entries: {
            'web-search': { enabled: false },
          },
        },
      } as Record<string, unknown>;
      const pluginConfigStore = {
        read: vi.fn(async () => pluginConfig),
        updateDirty: vi.fn(async (mutate) => {
          const update = await mutate(pluginConfig);
          return update.result;
        }),
      };
      const pluginConfigProjection = {
        readManuallyManagedPluginIds: vi.fn(async () => ['team-runtime']),
        applyManuallyManagedPluginIds: vi.fn(async (config: Record<string, any>) => ({
          ...config,
          plugins: {
            ...config.plugins,
            entries: {
              ...config.plugins.entries,
              'team-runtime': {
                ...config.plugins.entries['team-runtime'],
                config: {
                  ...config.plugins.entries['team-runtime'].config,
                  availableSkills: Object.entries(config.skills?.entries ?? {})
                    .filter(([, entry]) => (entry as { enabled?: boolean }).enabled === true)
                    .map(([skillKey]) => skillKey),
                  availableTools: ['*'],
                },
              },
            },
          },
        })),
      };
      const setSkillEnabled = vi.fn(async (skillKey: string, enabled: boolean) => {
        ((pluginConfig.skills as any).entries as Record<string, { enabled?: boolean }>)[skillKey] = { enabled };
        return { success: true };
      });
      const skillsService = createSkillsService({
        skillsDir,
        setSkillEnabled,
        pluginConfigStore,
        pluginConfigProjection,
        gateway: {
          isGatewayRunning: async () => false,
          gatewayRpc: vi.fn(async () => ({})),
        },
      });

      const result = await dispatchSkillManagementCapability(skillsService, 'skills.importBundles', {
        skillBundles: [
          {
            skillKey: 'web-search',
            files: [
              { path: 'SKILL.md', content: '---\nname: Web Search\ndescription: Search web\n---\n' },
              { path: 'scripts/run.py', content: 'print("hi")\n' },
            ],
          },
        ],
      });

      expect(result).toEqual({
        status: 200,
        data: {
          ok: true,
          installed: ['web-search'],
        },
      });
      await expect(readFile(join(skillsDir, 'web-search', 'scripts', 'run.py'), 'utf8')).resolves.toBe('print("hi")\n');
      expect(setSkillEnabled).toHaveBeenCalledWith('web-search', true);
      expect(pluginConfigStore.updateDirty).toHaveBeenCalledTimes(1);
      expect(pluginConfigProjection.readManuallyManagedPluginIds).toHaveBeenCalledWith(pluginConfig);
      expect((pluginConfig.plugins as any).entries['team-runtime'].config.availableSkills).toEqual(['web-search']);
      expect((skillsService as any).deps.operationsWorkflow.deps.jobs.submitGatewayUpdate).toHaveBeenCalledWith({
        skillKey: 'web-search',
        updates: { enabled: true },
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('skills.importBundles capability 遇到已存在技能时跳过并保持静默成功', async () => {
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

      const result = await dispatchSkillManagementCapability(skillsService, 'skills.importBundles', {
        skillBundles: [
          {
            skillKey: 'web-search',
            files: [
              { path: 'SKILL.md', content: '---\nname: Incoming\ndescription: Incoming skill\n---\n' },
            ],
          },
        ],
      });

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
