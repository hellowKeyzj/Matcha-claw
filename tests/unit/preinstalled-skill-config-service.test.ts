import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const hoisted = vi.hoisted(() => ({
  resourcesDir: '',
  requestMock: vi.fn(),
}));

vi.mock('../../electron/utils/paths', () => ({
  getResourcesDir: () => hoisted.resourcesDir,
  getOpenClawDir: () => hoisted.resourcesDir,
}));

vi.mock('../../electron/main/runtime-host-client', () => ({
  createDefaultRuntimeHostHttpClient: () => ({
    request: (...args: unknown[]) => hoisted.requestMock(...args),
  }),
}));

describe('preinstalled skill config service', () => {
  let tempRoot = '';
  let resourcesDir = '';
  let homeDir = '';
  let previousHome = '';
  let previousUserProfile = '';
  let previousHomeDrive = '';
  let previousHomePath = '';

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

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'matchaclaw-preinstalled-skills-'));
    resourcesDir = join(tempRoot, 'resources');
    homeDir = join(tempRoot, 'home');
    hoisted.resourcesDir = resourcesDir;
    previousHome = process.env.HOME ?? '';
    previousUserProfile = process.env.USERPROFILE ?? '';
    previousHomeDrive = process.env.HOMEDRIVE ?? '';
    previousHomePath = process.env.HOMEPATH ?? '';
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.HOMEDRIVE = '';
    process.env.HOMEPATH = '';
  });

  afterEach(async () => {
    process.env.HOME = previousHome;
    process.env.USERPROFILE = previousUserProfile;
    process.env.HOMEDRIVE = previousHomeDrive;
    process.env.HOMEPATH = previousHomePath;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('首装 autoEnable=false 的 preinstalled skill 会显式写 enabled=false', async () => {
    await writePreinstalledSkillSource('daily-news-briefing', false);
    hoisted.requestMock.mockImplementation(async (method: string, route: string, payload?: unknown) => {
      if (method === 'GET' && route === '/api/skills/configs') {
        return {};
      }
      if (method === 'PUT' && route === '/api/skills/state') {
        return { success: true, payload };
      }
      throw new Error(`Unexpected request: ${method} ${route}`);
    });

    const { ensurePreinstalledSkillsInstalled } = await import('../../electron/services/skills/skill-config-service');
    await ensurePreinstalledSkillsInstalled();

    expect(existsSync(join(homeDir, '.openclaw', 'skills', 'daily-news-briefing', 'SKILL.md'))).toBe(true);
    expect(hoisted.requestMock).toHaveBeenNthCalledWith(1, 'GET', '/api/skills/configs');
    expect(hoisted.requestMock).toHaveBeenNthCalledWith(2, 'PUT', '/api/skills/state', {
      skillKey: 'daily-news-briefing',
      enabled: false,
    });
  });

  it('已安装且状态缺失的 managed preinstalled skill 会回填显式 enabled=false', async () => {
    await writePreinstalledSkillSource('nuwa-skill', false);
    const targetDir = join(homeDir, '.openclaw', 'skills', 'nuwa-skill');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# nuwa\n', 'utf8');
    await writeFile(join(targetDir, '.clawx-preinstalled.json'), `${JSON.stringify({
      source: 'clawx-preinstalled',
      slug: 'nuwa-skill',
      version: '2026-05-01',
      installedAt: '2026-05-01T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');

    hoisted.requestMock.mockImplementation(async (method: string, route: string) => {
      if (method === 'GET' && route === '/api/skills/configs') {
        return {
          'nuwa-skill': {},
        };
      }
      if (method === 'PUT' && route === '/api/skills/state') {
        return { success: true };
      }
      throw new Error(`Unexpected request: ${method} ${route}`);
    });

    const { ensurePreinstalledSkillsInstalled } = await import('../../electron/services/skills/skill-config-service');
    await ensurePreinstalledSkillsInstalled();

    expect(hoisted.requestMock).toHaveBeenNthCalledWith(1, 'GET', '/api/skills/configs');
    expect(hoisted.requestMock).toHaveBeenNthCalledWith(2, 'PUT', '/api/skills/state', {
      skillKey: 'nuwa-skill',
      enabled: false,
    });
  });

  it('已有显式 enabled=false 的 managed preinstalled skill 不会被覆盖', async () => {
    await writePreinstalledSkillSource('nuwa-skill', false);
    const targetDir = join(homeDir, '.openclaw', 'skills', 'nuwa-skill');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'SKILL.md'), '# nuwa\n', 'utf8');
    await writeFile(join(targetDir, '.clawx-preinstalled.json'), `${JSON.stringify({
      source: 'clawx-preinstalled',
      slug: 'nuwa-skill',
      version: '2026-05-01',
      installedAt: '2026-05-01T00:00:00.000Z',
    }, null, 2)}\n`, 'utf8');

    hoisted.requestMock.mockImplementation(async (method: string, route: string) => {
      if (method === 'GET' && route === '/api/skills/configs') {
        return {
          'nuwa-skill': { enabled: false },
        };
      }
      throw new Error(`Unexpected request: ${method} ${route}`);
    });

    const { ensurePreinstalledSkillsInstalled } = await import('../../electron/services/skills/skill-config-service');
    await ensurePreinstalledSkillsInstalled();

    expect(hoisted.requestMock).toHaveBeenCalledTimes(1);
    expect(hoisted.requestMock).toHaveBeenCalledWith('GET', '/api/skills/configs');
    expect(await readFile(join(targetDir, '.clawx-preinstalled.json'), 'utf8')).toContain('"slug": "nuwa-skill"');
  });
});
