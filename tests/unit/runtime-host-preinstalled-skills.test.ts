import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillsService } from '../../runtime-host/application/skills/service';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestOpenClawEnvironmentRepository, createTestRuntimeSystemEnvironment } from './helpers/runtime-system-environment';

describe('runtime-host preinstalled skills', () => {
  let tempRoot = '';
  let resourcesDir = '';
  let skillsRoot = '';
  let setEnabled: ReturnType<typeof vi.fn>;

  async function writePreinstalledSkillSource(slug: string, autoEnable: boolean) {
    const sourceDir = join(resourcesDir, 'preinstalled-skills', slug);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), `# ${slug}\n`, 'utf8');

    await mkdir(join(resourcesDir, 'skills'), { recursive: true });
    await writeFile(
      join(resourcesDir, 'skills', 'preinstalled-manifest.json'),
      `${JSON.stringify({
        skills: [
          {
            slug,
            version: '2026-05-01',
            autoEnable,
          },
        ],
      }, null, 2)}\n`,
      'utf8',
    );
  }

  function createSkillsService(configs: Record<string, Record<string, unknown>> = {}): SkillsService {
    setEnabled = vi.fn(async () => ({ success: true }));
    return new SkillsService({
      repository: {
        getAllConfigs: async () => configs,
        updateConfig: async () => ({ success: true }),
        setEnabled,
        listEffective: async () => [],
      },
      readmePreviews: {
        read: async () => ({ status: 404, data: { success: false, error: 'not found' } }),
      },
      gateway: {
        isGatewayRunning: async () => false,
        gatewayRpc: async () => ({}),
      },
      jobs: {
        submitRefreshStatus: vi.fn() as never,
        submitGatewayUpdate: vi.fn(() => ({
          success: true,
          job: {
            id: 'job-sync',
            type: 'skills.syncGatewayUpdate',
            status: 'queued',
            queuedAt: 1,
            attempts: 0,
            maxAttempts: 1,
          },
        })) as never,
        submitImportLocal: vi.fn() as never,
        submitEnsurePreinstalled: vi.fn() as never,
      },
      clock: {
        nowMs: () => 1234,
        nowIso: () => '2026-05-01T00:00:00.000Z',
        toIsoString: (ms) => new Date(ms).toISOString(),
      },
      fileSystem: createTestRuntimeFileSystem(),
      commandExecutor: {
        execFile: vi.fn(async () => ({ stdout: '', stderr: '' })),
      },
      systemEnvironment: createTestRuntimeSystemEnvironment({
        workingDir: tempRoot,
        homeDir: join(tempRoot, 'home'),
      }),
      workspace: {
        getSkillsDir: () => skillsRoot,
      },
      environment: createTestOpenClawEnvironmentRepository({
        workingDir: tempRoot,
        resourcesPath: resourcesDir,
        homeDir: join(tempRoot, 'home'),
      }),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
  }

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-preinstalled-skills-'));
    resourcesDir = join(tempRoot, 'resources');
    skillsRoot = join(tempRoot, 'home', '.openclaw', 'skills');
    setEnabled = vi.fn();
  });

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('首装 autoEnable=false 的 preinstalled skill 会显式写 enabled=false', async () => {
    await writePreinstalledSkillSource('daily-news-briefing', false);

    await createSkillsService().executeEnsurePreinstalled();

    expect(existsSync(join(skillsRoot, 'daily-news-briefing', 'SKILL.md'))).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith('daily-news-briefing', false);
  });

  it('已安装且状态缺失的 managed preinstalled skill 会回填显式 enabled=false', async () => {
    await writePreinstalledSkillSource('nuwa-skill', false);
    const targetDir = join(skillsRoot, 'nuwa-skill');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# nuwa\n', 'utf8');
    await writeFile(join(targetDir, '.matchaclaw-preinstalled.json'), `${JSON.stringify({
      source: 'matchaclaw-preinstalled',
      slug: 'nuwa-skill',
      version: '2026-05-01',
      installedAt: '2026-05-01T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');

    await createSkillsService({ 'nuwa-skill': {} }).executeEnsurePreinstalled();

    expect(setEnabled).toHaveBeenCalledWith('nuwa-skill', false);
  });

  it('已有显式 enabled=false 的 managed preinstalled skill 不会被覆盖', async () => {
    await writePreinstalledSkillSource('nuwa-skill', false);
    const targetDir = join(skillsRoot, 'nuwa-skill');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# nuwa\n', 'utf8');
    await writeFile(join(targetDir, '.matchaclaw-preinstalled.json'), `${JSON.stringify({
      source: 'matchaclaw-preinstalled',
      slug: 'nuwa-skill',
      version: '2026-05-01',
      installedAt: '2026-05-01T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');

    await createSkillsService({ 'nuwa-skill': { enabled: false } }).executeEnsurePreinstalled();

    expect(setEnabled).not.toHaveBeenCalled();
    expect(await readFile(join(targetDir, '.matchaclaw-preinstalled.json'), 'utf8')).toContain('"slug": "nuwa-skill"');
  });
});
