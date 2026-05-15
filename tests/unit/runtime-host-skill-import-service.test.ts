import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillsService } from '../../runtime-host/application/skills/service';
import { createTestRuntimeFileSystem } from './helpers/runtime-file-system';
import { createTestOpenClawEnvironmentRepository, createTestRuntimeSystemEnvironment } from './helpers/runtime-system-environment';

const tempDirs: string[] = [];
let skillsRoot = '';
let commandExecutorMock: ReturnType<typeof vi.fn>;

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createSkillsService(): SkillsService {
  commandExecutorMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
  return new SkillsService({
    repository: {
      getAllConfigs: async () => ({}),
      updateConfig: async () => ({ success: true }),
      setEnabled: async () => ({ success: true }),
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
      submitGatewayUpdate: vi.fn() as never,
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
      execFile: commandExecutorMock,
    },
    systemEnvironment: createTestRuntimeSystemEnvironment(),
    workspace: {
      getSkillsDir: () => skillsRoot,
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

beforeEach(async () => {
  skillsRoot = await createTempDir('matchaclaw-skills-root-');
  commandExecutorMock = vi.fn(async () => ({ stdout: '', stderr: '' }));
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('runtime-host skill import service', () => {
  it('imports a local skill directory into the OpenClaw skills root', async () => {
    const sourceRoot = await createTempDir('matchaclaw-skill-source-');
    const sourceDir = join(sourceRoot, 'demo-skill');
    await mkdir(join(sourceDir, 'prompts'), { recursive: true });
    await writeFile(
      join(sourceDir, 'SKILL.md'),
      [
        '---',
        'name: Demo Skill',
        'description: A local directory skill.',
        '---',
        '',
        '# Demo Skill',
      ].join('\n'),
      'utf8',
    );
    await writeFile(join(sourceDir, 'prompts', 'system.txt'), 'hello', 'utf8');

    const response = await createSkillsService().executeImportLocal({ sourcePath: sourceDir });

    expect(response).toMatchObject({
      success: true,
      skillKey: 'demo-skill',
      sourceKind: 'directory',
      installedPath: join(skillsRoot, 'demo-skill'),
    });
    await expect(readFile(join(skillsRoot, 'demo-skill', 'prompts', 'system.txt'), 'utf8')).resolves.toBe('hello');
  });

  it('rejects a local skill directory whose SKILL.md is missing required frontmatter', async () => {
    const sourceRoot = await createTempDir('matchaclaw-skill-source-');
    const sourceDir = join(sourceRoot, 'bad-skill');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'SKILL.md'), '# Bad Skill\n', 'utf8');

    await expect(createSkillsService().executeImportLocal({ sourcePath: sourceDir }))
      .rejects
      .toThrow('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
    await expect(readFile(join(skillsRoot, 'bad-skill', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('rejects a zip skill whose SKILL.md is missing required frontmatter', async () => {
    const sourceRoot = await createTempDir('matchaclaw-skill-zip-');
    const sourcePath = join(sourceRoot, 'bad-skill.zip');
    await writeFile(sourcePath, 'fake zip', 'utf8');
    const service = createSkillsService();
    commandExecutorMock.mockImplementationOnce(async (_command: string, args: string[]) => {
      const commandArg = args[args.indexOf('-Command') + 1];
      const destinationDir = commandArg.match(/-DestinationPath '([^']+)'/)?.[1] ?? args[args.length - 1];
      const skillDir = join(destinationDir, 'bad-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# Bad Skill\n', 'utf8');
      return { stdout: '', stderr: '' };
    });

    await expect(service.executeImportLocal({ sourcePath }))
      .rejects
      .toThrow('SKILL.md 格式不符合要求，缺少 YAML frontmatter 中的 name 和 description。');
    await expect(readFile(join(skillsRoot, 'bad-skill', 'SKILL.md'), 'utf8')).rejects.toThrow();
  });

  it('imports a standalone markdown skill file as SKILL.md', async () => {
    const sourceRoot = await createTempDir('matchaclaw-skill-markdown-');
    const sourcePath = join(sourceRoot, 'solo-skill.md');
    await writeFile(
      sourcePath,
      [
        '---',
        'name: Solo Skill',
        'description: A minimal local skill.',
        '---',
        '',
        '# Solo Skill',
      ].join('\n'),
      'utf8',
    );

    const response = await createSkillsService().executeImportLocal({ sourcePath });

    expect(response).toMatchObject({
      success: true,
      skillKey: 'solo-skill',
      sourceKind: 'markdown',
      installedPath: join(skillsRoot, 'solo-skill'),
    });
    await expect(readFile(join(skillsRoot, 'solo-skill', 'SKILL.md'), 'utf8')).resolves.toContain('name: Solo Skill');
  });
});
